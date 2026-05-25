// Modular token counter — see issue #149.
//
// Why modular: each LLM provider tokenizes inputs differently. Estimating
// with a single char-based heuristic causes context-compaction to fire too
// early on dense code (over-counting) or too late on CJK text (under-counting),
// which manifests as wasted budget or HTTP 400 "context_length_exceeded".
//
// Each provider-specific counter implements `{ countText, countMessages }`
// and optionally `countMessagesAsync` (when an exact count requires a
// network call, e.g. Anthropic's beta endpoint).
//
// IMPORTANT: synchronous counters NEVER make network calls. Concretely:
//   - OpenAI-compatible providers run a local `js-tiktoken` BPE pass.
//   - Anthropic's sync path uses the char heuristic; only `countMessagesAsync`
//     hits `client.beta.messages.countTokens()` for an exact count.
// Callers that absolutely need accuracy for Claude should `await
// countMessagesAsync(...)` instead of relying on the sync API.
//
// Dispatcher contract:
//   countText(text, { provider, model })           → number       (sync, never throws)
//   countMessages(messages, { provider, model })   → number       (sync, never throws)
//   countMessagesAsync(messages, { provider, model, apiKey, baseUrl }) → Promise<number>
//
// Adding a new provider:
//   1. Create `src/api/token-counter/<name>-counter.js` exposing
//      `countText(text, ctx)` / `countMessages(messages, ctx)`.
//   2. Register it below in `_REGISTRY` keyed by provider id.
//   3. (Optional) Implement `countMessagesAsync` for exact counts.
//
// All counters MUST fall back to the heuristic on any internal failure so
// the compaction loop never sees an exception.
'use strict';

const heuristic = require('./heuristic');
const tiktoken  = require('./tiktoken-counter');
const anthropic = require('./anthropic-counter');

// Provider id → counter. Aliases share one module by referencing the same
// object — keeps the table compact and the intent obvious.
const _REGISTRY = Object.freeze({
    deepseek:  tiktoken,
    openai:    tiktoken,
    groq:      tiktoken,
    gemini:    tiktoken,
    custom:    tiktoken,   // assume OpenAI-compatible by default
    anthropic: anthropic,
});

function _resolve(providerId) {
    if (!providerId) return heuristic;
    return _REGISTRY[String(providerId).toLowerCase()] || heuristic;
}

function countText(text, ctx) {
    const c = _resolve(ctx && ctx.provider);
    try { return c.countText(text, ctx || {}); }
    catch { return heuristic.countText(text); }
}

function countMessages(messages, ctx) {
    const c = _resolve(ctx && ctx.provider);
    try { return c.countMessages(messages, ctx || {}); }
    catch { return heuristic.countMessages(messages); }
}

async function countMessagesAsync(messages, ctx) {
    const c = _resolve(ctx && ctx.provider);
    if (typeof c.countMessagesAsync === 'function') {
        try { return await c.countMessagesAsync(messages, ctx || {}); }
        catch { /* fall through */ }
    }
    return countMessages(messages, ctx);
}

module.exports = {
    countText,
    countMessages,
    countMessagesAsync,
    // Re-exports for tests / debugging.
    _heuristic: heuristic,
};
