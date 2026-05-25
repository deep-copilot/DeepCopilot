// Tiktoken-based counter for OpenAI-compatible providers
// (DeepSeek / OpenAI / Groq / Gemini / Custom-OpenAI).
//
// Uses the pure-JS `js-tiktoken` package (no native build / no WASM startup cost
// once the encoder is cached). If the package isn't installed at runtime, we
// fall back to the heuristic estimator — never throw.
//
// Encoding selection:
//   - gpt-4o / gpt-4.x / gpt-5.x family → o200k_base
//   - everything else                   → cl100k_base
// Both are reasonable approximations for the supported OpenAI-compatible
// vendors; for billing the API's reported usage is always authoritative.
'use strict';

const heuristic = require('./heuristic');
const { Logger } = require('../../logger');

let _tiktoken = null;       // resolved js-tiktoken module (or null if missing)
let _tiktokenLoaded = false;
const _encoderCache = new Map(); // encodingName -> encoder

function _loadTiktoken() {
    if (_tiktokenLoaded) return _tiktoken;
    _tiktokenLoaded = true;
    try {
        _tiktoken = require('js-tiktoken');
        Logger.info('TIKTOKEN_LOADED', { ok: true });
    } catch (e) {
        Logger.info('TIKTOKEN_UNAVAILABLE', { reason: e.message });
        _tiktoken = null;
    }
    return _tiktoken;
}

function _pickEncoding(model) {
    const m = String(model || '').toLowerCase();
    if (/(^|[-/])gpt-?(4o|4\.\d|5(\.\d)?|o\d)/.test(m)) return 'o200k_base';
    return 'cl100k_base';
}

function _getEncoder(encodingName) {
    if (_encoderCache.has(encodingName)) return _encoderCache.get(encodingName);
    const tk = _loadTiktoken();
    if (!tk) return null;
    try {
        const enc = tk.getEncoding(encodingName);
        _encoderCache.set(encodingName, enc);
        return enc;
    } catch (e) {
        Logger.info('TIKTOKEN_ENCODING_FAIL', { encodingName, error: e.message });
        return null;
    }
}

function _encodeLen(enc, text) {
    if (!text) return 0;
    try { return enc.encode(String(text)).length; }
    catch { return heuristic.countText(text); }
}

function countText(text, ctx = {}) {
    const enc = _getEncoder(_pickEncoding(ctx.model));
    if (!enc) return heuristic.countText(text);
    return _encodeLen(enc, text);
}

function countMessages(messages, ctx = {}) {
    if (!Array.isArray(messages)) return 0;
    const enc = _getEncoder(_pickEncoding(ctx.model));
    if (!enc) return heuristic.countMessages(messages);

    let n = 0;
    for (const m of messages) {
        if (!m) continue;
        if (typeof m.content === 'string') {
            n += _encodeLen(enc, m.content);
        } else if (Array.isArray(m.content)) {
            for (const p of m.content) {
                if (p && typeof p.text === 'string') n += _encodeLen(enc, p.text);
            }
        }
        if (m.tool_calls) {
            for (const tc of m.tool_calls) {
                const name = tc.function?.name || '';
                const args = tc.function?.arguments || '';
                if (name) n += _encodeLen(enc, name);
                if (args) n += _encodeLen(enc, args);
            }
        }
        if (m.name)         n += _encodeLen(enc, m.name);
        if (m.tool_call_id) n += _encodeLen(enc, m.tool_call_id);
        // Per-message structural overhead — approximation of OpenAI's
        // <|im_start|>role…<|im_end|> framing (~3-4 tokens per message).
        n += heuristic.PER_MESSAGE_OVERHEAD;
    }
    return n;
}

module.exports = { countText, countMessages };
