// Stream a chat completion from DeepSeek (OpenAI-compatible).
'use strict';

const https = require('https');
const http = require('http');

const { Logger } = require('../logger');
const { TOOL_DEFS } = require('../tools/schema');

/**
 * @returns Promise<{ toolCalls: Array<{id, name, args}>, usage: object }>
 */
function streamDeepSeek({ apiKey, baseUrl, messages, model, noTools, toolChoice, tools, httpAgent }, callbacks, abortSignal) {
    return new Promise((resolve, reject) => {
        const base = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
        const urlObj = new URL('/chat/completions', base);
        const isHttps = urlObj.protocol === 'https:';

        const reqPayload = {
            model: model || 'deepseek-chat',
            messages,
            stream: true,
            max_tokens: 32768,
        };
        if (!noTools) {
            reqPayload.tools = tools || TOOL_DEFS;
            // Hard API-level switch: 'none' means the model CANNOT emit tool
            // calls this turn. 'auto' is default. Used by the conversational
            // intent classifier to physically gate exploration on greetings.
            reqPayload.tool_choice = toolChoice || 'auto';
            // Allow the model to emit multiple tool calls in one turn.
            // Read-only tools will be executed in parallel; mutating tools
            // are still serialized in the agent loop (provider.js).
            reqPayload.parallel_tool_calls = true;
        }
        const body = JSON.stringify(reqPayload);
        const bodyBytes = Buffer.byteLength(body);

        const reqOpts = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + (urlObj.search || ''),
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                'Content-Length': bodyBytes,
            },
            // Reuse an existing keep-alive HTTPS agent when provided (e.g. from
            // SubAgentRunner) to avoid a full TLS handshake on every API call.
            ...(httpAgent ? { agent: httpAgent } : {}),
        };

        const mod = isHttps ? https : http;
        let buf = '';
        const toolCalls = {};
        let usage = null;
        let settled = false;
        const startedAt = Date.now();
        let firstByteAt = 0;
        let chunkCount = 0;

        function settle(val) {
            if (!settled) {
                settled = true;
                if (abortSignal && _onAbort) {
                    try { abortSignal.removeEventListener('abort', _onAbort); } catch {}
                }
                Logger.info('STREAM_DONE', {
                    elapsed_ms: Date.now() - startedAt,
                    ttfb_ms: firstByteAt ? firstByteAt - startedAt : null,
                    chunks: chunkCount,
                    tool_calls: (val.toolCalls || []).length,
                });
                resolve(val);
            }
        }
        function fail(err) {
            if (settled) return;
            settled = true;
            if (abortSignal && _onAbort) {
                try { abortSignal.removeEventListener('abort', _onAbort); } catch {}
            }
            reject(err);
        }
        let _onAbort = null;

        Logger.info('HTTP_REQUEST', { url: urlObj.href, model, msg_count: messages.length, body_bytes: bodyBytes });

        const req = mod.request(reqOpts, (res) => {
            if (res.statusCode !== 200) {
                let errBody = '';
                res.on('data', c => { errBody += c; });
                res.on('end', () => {
                    Logger.info('HTTP_ERROR', { status: res.statusCode, body: errBody.slice(0, 1500) });
                    const err = new Error(`DeepSeek API ${res.statusCode}: ${errBody.slice(0, 500)}`);
                    err.statusCode = res.statusCode;
                    err.body = errBody;
                    reject(err);
                });
                return;
            }
            res.setEncoding('utf8');
            res.on('data', chunk => {
                if (!firstByteAt) firstByteAt = Date.now();
                chunkCount++;
                buf += chunk;
                let idx;
                while ((idx = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') { settle({ toolCalls: Object.values(toolCalls), usage }); return; }
                    let obj;
                    try { obj = JSON.parse(data); } catch { continue; }
                    if (obj.usage) usage = obj.usage;
                    const choice = obj.choices?.[0];
                    if (!choice) continue;
                    const delta = choice.delta || {};
                    if (delta.content)           callbacks.onDelta?.(delta.content);
                    if (delta.reasoning_content) callbacks.onThinking?.(delta.reasoning_content);
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const i = tc.index ?? 0;
                            if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', args: '' };
                            if (tc.id)                  toolCalls[i].id   = tc.id;
                            if (tc.function?.name)      toolCalls[i].name = tc.function.name;
                            if (tc.function?.arguments) {
                                toolCalls[i].args += tc.function.arguments;
                                callbacks.onToolArgsDelta?.({
                                    index: i,
                                    id: toolCalls[i].id,
                                    name: toolCalls[i].name,
                                    deltaArgs: tc.function.arguments,
                                    accArgs: toolCalls[i].args,
                                });
                            }
                        }
                    }
                    if (choice.finish_reason === 'stop') { settle({ toolCalls: [], usage }); return; }
                }
            });
            res.on('end', () => settle({ toolCalls: Object.values(toolCalls), usage }));
            res.on('error', fail);
        });

        if (abortSignal) {
            _onAbort = () => { try { req.destroy(); } catch {} fail(new Error('aborted')); };
            if (abortSignal.aborted) {
                process.nextTick(_onAbort);
            } else {
                abortSignal.addEventListener('abort', _onAbort, { once: true });
            }
        }

        req.on('error', fail);
        req.write(body);
        req.end();
    });
}

/**
 * Query account balance from DeepSeek /user/balance.
 * Returns null silently for non-deepseek.com base URLs (3rd-party compatible APIs).
 * @returns {Promise<{available: boolean, balance_cny: number, balance_usd: number, topped_up_cny: number, granted_cny: number}|null>}
 */
function fetchBalance({ apiKey, baseUrl }) {
    return new Promise((resolve) => {
        const base = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
        // Only query official DeepSeek endpoint; 3rd-party APIs may not support this route.
        if (!base.includes('deepseek.com')) { resolve(null); return; }
        let urlObj;
        try { urlObj = new URL('/user/balance', base); } catch { resolve(null); return; }
        const isHttps = urlObj.protocol === 'https:';
        const reqOpts = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json',
            },
            timeout: 8000,
        };
        const mod = isHttps ? https : http;
        const req = mod.request(reqOpts, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    if (!data || typeof data.is_available === 'undefined') { resolve(null); return; }
                    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
                    const cnyInfo = infos.find(i => i.currency === 'CNY') || {};
                    const usdInfo = infos.find(i => i.currency === 'USD') || {};
                    resolve({
                        available:    !!data.is_available,
                        balance_cny:  parseFloat(cnyInfo.total_balance  || '0'),
                        topped_up_cny: parseFloat(cnyInfo.topped_up_balance || '0'),
                        granted_cny:  parseFloat(cnyInfo.granted_balance || '0'),
                        balance_usd:  parseFloat(usdInfo.total_balance  || '0'),
                    });
                } catch { resolve(null); }
            });
            res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// ─── FIM completion (Issue #60) ────────────────────────────────────────────
// Non-streaming fill-in-the-middle completion against DeepSeek's beta endpoint.
// Powers the InlineCompletionItemProvider (src/completion/provider.js).
//
// API:    POST {baseUrl}/beta/completions
// Schema: OpenAI legacy /v1/completions with `prompt` (prefix) + `suffix`.
//
// Returns the completion text, or null on any failure (silent — inline
// completion must never throw user-visible errors).
function fimComplete({ apiKey, baseUrl, model, prefix, suffix, maxTokens, temperature }, abortSignal) {
    return new Promise((resolve) => {
        const base = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');

        // Parse the URL first so we can do hostname-based whitelisting.
        // FIM is only documented for the official DeepSeek API; third-party
        // proxies may not implement /beta/completions. We MUST check the
        // parsed hostname rather than a substring of the raw string — see
        // CodeQL js/incomplete-url-substring-sanitization: a substring check
        // would falsely accept hosts like `deepseek.com.attacker.com`,
        // `evil.com/?x=deepseek.com`, etc., leaking the API key.
        let urlObj;
        try { urlObj = new URL('/beta/completions', base); } catch { resolve(null); return; }
        const host = (urlObj.hostname || '').toLowerCase();
        if (host !== 'deepseek.com' && host !== 'api.deepseek.com' && !host.endsWith('.deepseek.com')) {
            resolve(null);
            return;
        }
        const isHttps = urlObj.protocol === 'https:';

        const body = JSON.stringify({
            model:       model || 'deepseek-chat',
            prompt:      prefix || '',
            suffix:      suffix || '',
            max_tokens:  maxTokens  || 64,
            temperature: temperature == null ? 0.2 : temperature,
            stream:      false,
        });

        const reqOpts = {
            hostname: urlObj.hostname,
            port:     urlObj.port || (isHttps ? 443 : 80),
            path:     urlObj.pathname,
            method:   'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type':  'application/json',
                'Accept':        'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 15000,
        };

        const mod = isHttps ? https : http;
        const req = mod.request(reqOpts, (res) => {
            if (res.statusCode !== 200) {
                let errBody = '';
                res.on('data', c => { errBody += c; });
                res.on('end', () => {
                    // Sanitize untrusted upstream body before logging
                    // (CodeQL js/http-to-file-access): strip CR/LF/control
                    // chars so a malicious proxy cannot inject log lines,
                    // and cap length so logs cannot be ballooned.
                    const safeBody = String(errBody)
                        .slice(0, 300)
                        .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ');
                    Logger.info('FIM_HTTP_ERROR', { status: res.statusCode, body: safeBody });
                    resolve(null);
                });
                return;
            }
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    const text = (data && data.choices && data.choices[0] && data.choices[0].text) || '';
                    resolve(text);
                } catch { resolve(null); }
            });
            res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { try { req.destroy(); } catch {}; resolve(null); });
        if (abortSignal) {
            const onAbort = () => { try { req.destroy(); } catch {}; resolve(null); };
            if (abortSignal.aborted) { onAbort(); return; }
            abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        req.write(body);
        req.end();
    });
}

module.exports = { streamDeepSeek, fetchBalance, fimComplete };
