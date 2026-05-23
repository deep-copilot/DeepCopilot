// Adapter: thin routing layer between higher-level callers and the per-protocol
// API clients (OpenAI-compatible vs native Anthropic). All vendor/model data
// now lives in src/providers/*.json — consult `src/providers/index.js`.
'use strict';

const { streamChat: streamChatBase, fetchBalance } = require('./openai-client');
const { streamChat: streamChatAnthropic }          = require('./anthropic-client');

const {
    getProvider,
    getModel,
    getEffectiveQuirks,
    sanitizeMessages,
    resolveModel,
} = require('../providers');

const MODEL_CONFIG_DEFAULT = { contextWindow: 65536, maxOutputTokens: 16384 };

/**
 * Resolve everything `chat/provider.js` needs to issue a one-shot HTTP request
 * (connection test, balance refresh): protocol-level URL, the actual model id,
 * and the relevant quirks. Higher-level callers (`streamChat`) inline these
 * lookups themselves.
 */
function resolveProviderConfig(provider, overrideBaseUrl, overrideModel) {
    const p     = getProvider(provider) || getProvider('custom');
    const pid   = p ? p.id : (provider || 'deepseek');
    const model = resolveModel(pid, overrideModel);
    const cfg   = getModel(pid, model) || MODEL_CONFIG_DEFAULT;
    const quirks = getEffectiveQuirks(pid, model);
    // Built-in providers (openai/anthropic/deepseek) ship their canonical baseUrl in
    // their JSON; the global `apiBaseUrl` setting only applies when the provider has
    // no built-in baseUrl (i.e. the `custom` provider). Otherwise a stale override
    // from a previous provider selection would silently misroute requests.
    return {
        baseUrl:                p?.baseUrl || overrideBaseUrl || 'https://api.deepseek.com',
        model,
        noApiKey:               !!p?.noApiKey,
        streamOptions:          quirks.streamOptions !== false,
        parallelTools:          quirks.parallelTools !== false,
        useMaxCompletionTokens: !!quirks.useMaxCompletionTokens,
        testConnectionMaxTokens: quirks.testConnectionMaxTokens ?? null,
        balanceEndpoint:        quirks.balanceEndpoint || null,
        reasoningField:         quirks.reasoningField  || null,
        contextWindow:          cfg.contextWindow,
        maxOutputTokens:        cfg.maxOutputTokens,
    };
}

// ─── streamChat: the only routing entry point ────────────────────────────

function streamChat({ provider, apiKey, baseUrl, model, messages, ...rest }, callbacks, abortSignal) {
    const providerId = provider || 'deepseek';
    const p          = getProvider(providerId) || getProvider('custom');
    const pid        = p ? p.id : providerId;
    const effProtocol = p?.protocol || 'openai';
    const effModel    = resolveModel(pid, model);
    // Same precedence rule as `resolveProviderConfig`: built-in baseUrl wins to
    // prevent a stale global override from misrouting cross-provider requests.
    const effBaseUrl  = p?.baseUrl || baseUrl || 'https://api.deepseek.com';
    const modelCfg    = getModel(pid, effModel) || MODEL_CONFIG_DEFAULT;
    const quirks      = getEffectiveQuirks(pid, effModel);

    // Apply provider-declared input sanitisation (e.g. DeepSeek strips
    // `reasoning_content` for non-reasoning models; reasoning models are exempt
    // because the API requires reasoning_content to be passed back each turn).
    const cleanMessages = sanitizeMessages(pid, messages, effModel);

    if (effProtocol === 'anthropic') {
        return streamChatAnthropic(
            {
                ...rest,
                apiKey:           apiKey || '',
                baseUrl:          effBaseUrl,
                model:            effModel,
                messages:         cleanMessages,
                maxOutputTokens:  modelCfg.maxOutputTokens,
            },
            callbacks,
            abortSignal,
        );
    }

    // OpenAI-compatible path (DeepSeek / OpenAI / Custom / etc.)
    const effApiKey = p?.noApiKey ? 'no-key' : (apiKey || '');
    return streamChatBase(
        {
            ...rest,
            apiKey:                effApiKey,
            baseUrl:               effBaseUrl,
            model:                 effModel,
            messages:              cleanMessages,
            streamOptions:         quirks.streamOptions !== false,
            parallelTools:         quirks.parallelTools !== false,
            useMaxCompletionTokens: !!quirks.useMaxCompletionTokens,
            reasoningField:        quirks.reasoningField || null,
            maxOutputTokens:       modelCfg.maxOutputTokens,
        },
        callbacks,
        abortSignal,
    );
}

module.exports = {
    streamChat,
    fetchBalance,
    resolveProviderConfig,
};
