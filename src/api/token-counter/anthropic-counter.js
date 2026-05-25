// Anthropic token counter.
//
// Synchronous calls fall back to the heuristic — Anthropic's tokenizer is
// only reachable via the network `client.beta.messages.countTokens()` endpoint,
// which we cannot block compaction loops on. Async callers may use
// `countMessagesAsync()` when they have an API key + are willing to await.
'use strict';

const heuristic = require('./heuristic');

// Lazy, environment-agnostic logger — see tiktoken-counter.js for the
// rationale (avoids dragging `vscode` into the token-counter layer).
let _loggerCache = null;
let _loggerTried = false;
function _log(event, payload) {
    if (!_loggerTried) {
        _loggerTried = true;
        try { _loggerCache = require('../../logger').Logger; }
        catch { _loggerCache = null; }
    }
    if (_loggerCache) {
        try { _loggerCache.info(event, payload); } catch { /* ignore */ }
    }
}

function countText(text) {
    return heuristic.countText(text);
}

function countMessages(messages) {
    return heuristic.countMessages(messages);
}

// Async path: hits the official Anthropic SDK if api credentials are supplied.
// Falls back to the heuristic on any failure so callers never see an exception.
async function countMessagesAsync(messages, ctx = {}) {
    const { apiKey, baseUrl, model } = ctx || {};
    if (!apiKey || !model) return heuristic.countMessages(messages);
    try {
        // Lazy require — keeps cold-start cost out of the sync path.
        const Anthropic = require('@anthropic-ai/sdk');
        // Normalize baseURL the same way `src/api/anthropic-client.js` does
        // (strip trailing slash) so a stray `/` in user configuration cannot
        // produce a subtly different endpoint than the streaming client.
        const normalizedBaseUrl = baseUrl ? String(baseUrl).replace(/\/$/, '') : undefined;
        const client = new Anthropic({ apiKey, baseURL: normalizedBaseUrl });
        // Convert OpenAI-style messages → Anthropic format using the
        // pure converter (no `vscode` / logger side effects), so this
        // async path stays usable outside the extension host.
        const { convertMessages } = require('../anthropic-convert');
        const { system, messages: anthMsgs } = convertMessages(messages);
        const res = await client.beta.messages.countTokens({
            model,
            system,
            messages: anthMsgs,
        });
        if (res && typeof res.input_tokens === 'number') return res.input_tokens;
    } catch (e) {
        _log('ANTHROPIC_COUNT_TOKENS_FAIL', { error: e.message });
    }
    return heuristic.countMessages(messages);
}

module.exports = { countText, countMessages, countMessagesAsync };
