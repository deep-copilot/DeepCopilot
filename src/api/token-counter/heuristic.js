// Heuristic char-based token estimator.
// Used as a universal fallback when a provider-specific tokenizer is unavailable.
//
// CJK characters (Chinese / Japanese / Korean) tokenize at ~1 token/char;
// Latin text and code at ~3.6 chars/token.
// Never used for billing — only for compaction triggers.
'use strict';

const PER_MESSAGE_OVERHEAD = 8; // role marker + structural overhead

function countText(text) {
    if (!text) return 0;
    const str = String(text);
    const cjkCount = (str.match(/[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) || []).length;
    const otherCount = str.length - cjkCount;
    return Math.ceil(cjkCount / 1.0 + otherCount / 3.6);
}

function countMessages(messages) {
    if (!Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) {
        if (!m) continue;
        if (typeof m.content === 'string') n += countText(m.content);
        else if (Array.isArray(m.content)) {
            for (const p of m.content) if (p && typeof p.text === 'string') n += countText(p.text);
        }
        if (m.tool_calls) {
            for (const tc of m.tool_calls) n += countText(tc.function?.arguments || '');
        }
        n += PER_MESSAGE_OVERHEAD;
    }
    return n;
}

module.exports = { countText, countMessages, PER_MESSAGE_OVERHEAD };
