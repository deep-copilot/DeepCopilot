// Stream a chat completion from DeepSeek (OpenAI-compatible).
'use strict';

const https = require('https');
const http = require('http');

const { Logger } = require('../logger');
const { TOOL_DEFS } = require('../tools/schema');

/**
 * @returns Promise<{ toolCalls: Array<{id, name, args}>, usage: object }>
 */
function streamDeepSeek({ apiKey, baseUrl, messages, model, noTools, toolChoice }, callbacks, abortSignal) {
    return new Promise((resolve, reject) => {
        const base = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
        const urlObj = new URL('/chat/completions', base);
        const isHttps = urlObj.protocol === 'https:';

        const reqPayload = {
            model: model || 'deepseek-chat',
            messages,
            stream: true,
            max_tokens: 8192,
        };
        if (!noTools) {
            reqPayload.tools = TOOL_DEFS;
            // Hard API-level switch: 'none' means the model CANNOT emit tool
            // calls this turn. 'auto' is default. Used by the conversational
            // intent classifier to physically gate exploration on greetings.
            reqPayload.tool_choice = toolChoice || 'auto';
        }
        const body = JSON.stringify(reqPayload);

        const reqOpts = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + (urlObj.search || ''),
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                'Content-Length': Buffer.byteLength(body),
            },
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

        Logger.info('HTTP_REQUEST', { url: urlObj.href, model, msg_count: messages.length, body_bytes: Buffer.byteLength(body) });

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
                            if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
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

module.exports = { streamDeepSeek };
