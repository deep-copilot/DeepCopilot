// Anthropic token counter.
//
// Synchronous calls fall back to the heuristic — Anthropic's tokenizer is
// only reachable via the network `client.beta.messages.countTokens()` endpoint,
// which we cannot block compaction loops on. Async callers may use
// `countMessagesAsync()` when they have an API key + are willing to await.
'use strict';

const heuristic = require('./heuristic');
const { Logger } = require('../../logger');

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
        const client = new Anthropic({ apiKey, baseURL: baseUrl || undefined });
        // Convert OpenAI-style messages → Anthropic format using the existing helper.
        const { convertMessages } = require('../anthropic-client');
        const { system, messages: anthMsgs } = convertMessages(messages);
        const res = await client.beta.messages.countTokens({
            model,
            system,
            messages: anthMsgs,
        });
        if (res && typeof res.input_tokens === 'number') return res.input_tokens;
    } catch (e) {
        Logger.info('ANTHROPIC_COUNT_TOKENS_FAIL', { error: e.message });
    }
    return heuristic.countMessages(messages);
}

module.exports = { countText, countMessages, countMessagesAsync };
