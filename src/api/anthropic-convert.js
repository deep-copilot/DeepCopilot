'use strict';

// Pure conversion helpers between the extension's internal OpenAI-format
// messages/tools and Anthropic's native format.
//
// IMPORTANT: this module must remain free of side effects and must NOT
// require `vscode`, the logger, the Anthropic SDK, or anything else that
// pulls in the VS Code extension host. It is shared by:
//   - `src/api/anthropic-client.js`     (streaming Claude path)
//   - `src/api/token-counter/anthropic-counter.js` (async exact-count path)
// The token-counter layer is designed to run in plain Node (tests,
// sub-agent processes), so adding heavyweight requires here would
// silently re-introduce the very dependency we removed in PR #155.

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

module.exports = { convertTools, convertMessages };
