'use strict';

// Anthropic (Claude) streaming client.
// The Anthropic API is NOT OpenAI-compatible, so this is a separate implementation
// that converts between the extension's internal OpenAI-format messages and
// Anthropic's native message format, then streams back in the same shape as
// openai-client.js so the rest of the codebase is unaffected.

const Anthropic = require('@anthropic-ai/sdk');
const { Logger } = require('../logger');

// Convert OpenAI-format tool definitions → Anthropic format
function convertTools(openaiTools) {
    if (!Array.isArray(openaiTools)) return [];
    return openaiTools.map(t => {
        const fn = t.function || {};
        return {
            name:         fn.name        || '',
            description:  fn.description || '',
            input_schema: fn.parameters  || { type: 'object', properties: {} },
        };
    });
}

// Convert OpenAI-format messages → Anthropic format.
// Returns { system: string|undefined, messages: array }
//
// Key differences:
//   - system role → top-level `system` parameter
//   - role:'tool' messages → grouped into a single user message with tool_result blocks
//   - assistant tool_calls → content blocks of type 'tool_use'
//   - image_url content → Anthropic base64 image blocks
function convertMessages(openaiMessages) {
    let system;
    const result = [];
    let i = 0;

    while (i < openaiMessages.length) {
        const msg = openaiMessages[i];

        if (msg.role === 'system') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            system = system ? system + '\n\n' + text : text;
            i++;
            continue;
        }

        // Group consecutive tool result messages into one user message.
        // Anthropic requires all tool results after an assistant turn to be
        // in a single user message as an array of tool_result blocks.
        if (msg.role === 'tool') {
            const toolResults = [];
            while (i < openaiMessages.length && openaiMessages[i].role === 'tool') {
                const t = openaiMessages[i];
                toolResults.push({
                    type:        'tool_result',
                    tool_use_id: t.tool_call_id,
                    content:     String(t.content || ''),
                });
                i++;
            }
            result.push({ role: 'user', content: toolResults });
            continue;
        }

        if (msg.role === 'assistant') {
            const content = [];
            // reasoning_content (DeepSeek thinking) is intentionally dropped here.
            // Anthropic only accepts thinking blocks when extended thinking is enabled,
            // so injecting them from a prior DeepSeek session would cause an API error.
            if (msg.content) {
                content.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : String(msg.content) });
            }
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    let input = {};
                    try {
                        const raw = tc.function ? tc.function.arguments : (tc.args || '{}');
                        input = JSON.parse(raw);
                    } catch { /* malformed args — leave as empty object */ }
                    content.push({
                        type:  'tool_use',
                        id:    tc.id,
                        name:  tc.function ? tc.function.name : (tc.name || ''),
                        input,
                    });
                }
            }
            // Anthropic rejects empty content arrays
            if (!content.length) content.push({ type: 'text', text: '' });
            result.push({ role: 'assistant', content });
            i++;
            continue;
        }

        if (msg.role === 'user') {
            let content;
            if (Array.isArray(msg.content)) {
                content = msg.content.map(block => {
                    if (block.type === 'text') return { type: 'text', text: block.text };
                    if (block.type === 'image_url') {
                        const url = block.image_url && block.image_url.url;
                        if (url && url.startsWith('data:')) {
                            const match = url.match(/^data:([^;]+);base64,(.+)$/);
                            if (match) {
                                return {
                                    type:   'image',
                                    source: { type: 'base64', media_type: match[1], data: match[2] },
                                };
                            }
                        }
                        return { type: 'text', text: '[image unavailable]' };
                    }
                    return block;
                });
            } else {
                content = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
            }
            result.push({ role: 'user', content });
            i++;
            continue;
        }

        i++;
    }

    return { system, messages: result };
}

/**
 * Stream a chat completion via the Anthropic SDK.
 * Signature matches openai-client.js so adapter.js can call either transparently.
 *
 * @returns {Promise<{ toolCalls: Array<{id,name,args}>, usage: object|null }>}
 */
async function streamChat({ apiKey, baseUrl, messages, model, noTools, tools, maxOutputTokens }, callbacks, abortSignal) {
    const client = new Anthropic({
        apiKey:  apiKey || '',
        ...(baseUrl ? { baseURL: baseUrl.replace(/\/$/, '') } : {}),
    });

    const { system, messages: anthropicMessages } = convertMessages(messages);

    const reqPayload = {
        model:      model || 'claude-sonnet-4-6',
        max_tokens: maxOutputTokens || 16000,
        messages:   anthropicMessages,
    };
    // Issue #142 P2-1: Anthropic prompt caching.
    // Convert `system` (string) into a content-block array with cache_control
    // on the last block so Anthropic caches the (large, stable) system prompt
    // across turns.  Caches expire after 5 min of idle — typically ≥90% hit
    // rate for active conversations, with ~10x cheaper cache-read pricing.
    if (system) {
        reqPayload.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (!noTools && Array.isArray(tools) && tools.length) {
        const converted = convertTools(tools);
        // Cache tool definitions too (they rarely change within a session).
        if (converted.length > 0) {
            converted[converted.length - 1] = { ...converted[converted.length - 1], cache_control: { type: 'ephemeral' } };
        }
        reqPayload.tools       = converted;
        reqPayload.tool_choice = { type: 'auto' };
    }

    const startedAt  = Date.now();
    let firstByteAt  = 0;
    let chunkCount   = 0;
    const toolCalls  = {};  // keyed by block index
    let usage        = null;

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
            apiErr.body       = detail || err.message;
            return apiErr;
        }
        return err;
    }

    let stream;
    try {
        stream = await client.messages.create(
            { ...reqPayload, stream: true },
            { signal: abortSignal },
        );
    } catch (err) {
        throw normalizeError(err);
    }

    try {
        for await (const event of stream) {
            if (!firstByteAt) firstByteAt = Date.now();
            chunkCount++;

            if (event.type === 'message_start' && event.message && event.message.usage) {
                usage = {
                    prompt_tokens:           event.message.usage.input_tokens  || 0,
                    completion_tokens:       0,
                    prompt_cache_hit_tokens: event.message.usage.cache_read_input_tokens || 0,
                    total_tokens:            event.message.usage.input_tokens  || 0,
                };
                continue;
            }

            if (event.type === 'content_block_start') {
                const block = event.content_block;
                if (block && block.type === 'tool_use') {
                    toolCalls[event.index] = { id: block.id, name: block.name, args: '' };
                }
                continue;
            }

            if (event.type === 'content_block_delta') {
                const delta = event.delta;
                if (!delta) continue;

                if (delta.type === 'text_delta' && delta.text) {
                    callbacks.onDelta && callbacks.onDelta(delta.text);
                } else if (delta.type === 'thinking_delta' && delta.thinking) {
                    callbacks.onThinking && callbacks.onThinking(delta.thinking);
                } else if (delta.type === 'input_json_delta' && delta.partial_json != null) {
                    const tc = toolCalls[event.index];
                    if (tc) {
                        tc.args += delta.partial_json;
                        callbacks.onToolArgsDelta && callbacks.onToolArgsDelta({
                            index:     event.index,
                            id:        tc.id,
                            name:      tc.name,
                            deltaArgs: delta.partial_json,
                            accArgs:   tc.args,
                        });
                    }
                }
                continue;
            }

            if (event.type === 'message_delta' && event.usage) {
                if (!usage) usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0 };
                usage.completion_tokens = event.usage.output_tokens || 0;
                usage.total_tokens      = (usage.prompt_tokens || 0) + usage.completion_tokens;
            }
        }
    } catch (err) {
        throw normalizeError(err);
    }

    Logger.info('STREAM_DONE', {
        elapsed_ms: Date.now() - startedAt,
        ttfb_ms:    firstByteAt ? firstByteAt - startedAt : null,
        chunks:     chunkCount,
        tool_calls: Object.values(toolCalls).length,
    });

    return { toolCalls: Object.values(toolCalls), usage };
}

/**
 * Test an Anthropic API key by making a minimal non-streaming messages call.
 * Returns { ok: true } on success or { ok: false, error: string } on failure.
 */
async function testConnection({ apiKey, baseUrl, model }) {
    const client = new Anthropic({
        apiKey:  apiKey || '',
        ...(baseUrl ? { baseURL: baseUrl.replace(/\/$/, '') } : {}),
    });
    try {
        await client.messages.create({
            model:     model || 'claude-sonnet-4-6',
            max_tokens: 64,
            messages:  [{ role: 'user', content: 'hi' }],
        });
        return { ok: true };
    } catch (err) {
        const detail = err.error
            ? (typeof err.error === 'object' ? JSON.stringify(err.error) : String(err.error))
            : '';
        return { ok: false, error: err.message || detail || `HTTP ${err.status || 'unknown'}` };
    }
}

module.exports = { streamChat, testConnection };
