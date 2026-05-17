// Stream a chat completion via the OpenAI-compatible client.
// Works with DeepSeek, OpenAI, Groq, Together, OpenRouter, and any other
// OpenAI-compatible provider — swap baseUrl + model and it just works.
'use strict';

const { OpenAI } = require('openai');
const https = require('https');
const http = require('http');

const { Logger } = require('../logger');
const { TOOL_DEFS } = require('../tools/schema');

/**
 * @returns Promise<{ toolCalls: Array<{id, name, args}>, usage: object }>
 */
async function streamChat({ apiKey, baseUrl, messages, model, noTools, toolChoice, tools, httpAgent, streamOptions, parallelTools }, callbacks, abortSignal) {
    const client = new OpenAI({
        apiKey,
        baseURL: (baseUrl || 'https://api.deepseek.com').replace(/\/$/, ''),
        ...(httpAgent ? { httpAgent } : {}),
    });

    const reqPayload = {
        model: model || 'deepseek-chat',
        messages,
        stream: true,
        max_tokens: 32768,
    };
    if (streamOptions !== false) reqPayload.stream_options = { include_usage: true };
    if (!noTools) {
        reqPayload.tools = tools || TOOL_DEFS;
        reqPayload.tool_choice = toolChoice || 'auto';
        if (parallelTools !== false) reqPayload.parallel_tool_calls = true;
    }

    const startedAt = Date.now();
    let firstByteAt = 0;
    let chunkCount = 0;
    const toolCalls = {};
    let usage = null;

    Logger.info('HTTP_REQUEST', { url: client.baseURL, model, msg_count: messages.length });

    function normalizeError(err) {
        if (err.name === 'AbortError' || err.message === 'aborted') return new Error('aborted');
        if (err.status) {
            const detail = err.error
                ? (typeof err.error === 'object' ? JSON.stringify(err.error) : String(err.error))
                : '';
            Logger.info('HTTP_ERROR', { status: err.status, body: detail || err.message });
            const apiErr = new Error(`API ${err.status}: ${err.message}${detail ? '\n\n' + detail : ''}`);
            apiErr.statusCode = err.status;
            apiErr.body = detail || err.message;
            return apiErr;
        }
        return err;
    }

    // Acquire the stream — auto-retry without tools if the provider rejects tool use.
    let stream;
    try {
        stream = await client.chat.completions.create(reqPayload, { signal: abortSignal });
    } catch (err) {
        const isToolErr = err.status === 404 && /tool/i.test(err.message + JSON.stringify(err.error || ''));
        if (isToolErr && reqPayload.tools) {
            Logger.info('TOOL_USE_UNSUPPORTED', { status: err.status, retrying: true });
            delete reqPayload.tools;
            delete reqPayload.tool_choice;
            delete reqPayload.parallel_tool_calls;
            try {
                stream = await client.chat.completions.create(reqPayload, { signal: abortSignal });
            } catch (retryErr) {
                throw normalizeError(retryErr);
            }
        } else {
            throw normalizeError(err);
        }
    }

    try {
        for await (const chunk of stream) {
            if (!firstByteAt) firstByteAt = Date.now();
            chunkCount++;

            if (chunk.usage) usage = chunk.usage;

            const choice = chunk.choices?.[0];
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

        }
    } catch (err) {
        throw normalizeError(err);
    }

    Logger.info('STREAM_DONE', {
        elapsed_ms: Date.now() - startedAt,
        ttfb_ms: firstByteAt ? firstByteAt - startedAt : null,
        chunks: chunkCount,
        tool_calls: Object.values(toolCalls).length,
    });

    return { toolCalls: Object.values(toolCalls), usage };
}

/**
 * Query account balance from DeepSeek /user/balance.
 * Returns null silently unless an explicit official DeepSeek base URL is configured.
 * @returns {Promise<{available: boolean, balance_cny: number, balance_usd: number, topped_up_cny: number, granted_cny: number}|null>}
 */
function fetchBalance({ apiKey, baseUrl }) {
    return new Promise((resolve) => {
        const base = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/$/, '') : '';
        if (!base) { resolve(null); return; }
        let urlObj;
        try { urlObj = new URL('/user/balance', base); } catch { resolve(null); return; }
        const hostname = (urlObj.hostname || '').toLowerCase();
        // Only query official DeepSeek endpoints; 3rd-party APIs may not support this route.
        if (!(hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com'))) { resolve(null); return; }
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

module.exports = { streamChat, fetchBalance };
