'use strict';

const { streamChat: streamChatBase, fetchBalance } = require('./openai-client');

// Preset baseURLs and default models per provider.
// All use the OpenAI-compatible client — only the endpoint changes.
const PROVIDER_PRESETS = {
    //                                                                         streamOpts  parallelTools
    deepseek:   { baseUrl: 'https://api.deepseek.com',                                 defaultModel: 'deepseek-v4-pro',          streamOptions: true,  parallelTools: true  },
    openai:     { baseUrl: 'https://api.openai.com/v1',                                defaultModel: 'gpt-4o',                   streamOptions: true,  parallelTools: true  },
    groq:       { baseUrl: 'https://api.groq.com/openai/v1',                           defaultModel: 'llama-3.3-70b-versatile',  streamOptions: false, parallelTools: false },
    ollama:     { baseUrl: 'http://localhost:11434/v1',                                 defaultModel: 'llama3.2', noApiKey: true, streamOptions: false, parallelTools: false },
    gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.0-flash',         streamOptions: false, parallelTools: false },
    custom:     { streamOptions: false, parallelTools: false },
};

function shouldUseOverrideModel(provider, overrideModel) {
    if (!overrideModel) {
        return false;
    }

    if (provider === 'deepseek') {
        return true;
    }

    return overrideModel !== PROVIDER_PRESETS.deepseek.defaultModel;
}

function resolveProviderConfig(provider, overrideBaseUrl, overrideModel) {
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
    const model = shouldUseOverrideModel(provider, overrideModel)
        ? overrideModel
        : (preset.defaultModel || 'deepseek-chat');

    return {
        baseUrl:       overrideBaseUrl || preset.baseUrl || 'https://api.deepseek.com',
        model,
        noApiKey:      !!preset.noApiKey,
        streamOptions: preset.streamOptions !== false,
        parallelTools: preset.parallelTools !== false,
    };
}

// Reads provider from params,
// resolves the correct baseUrl/model/flags, then delegates to the OpenAI client.
function streamChat({ provider, apiKey, baseUrl, model, ...rest }, callbacks, abortSignal) {
    const resolved = resolveProviderConfig(provider, baseUrl, model);
    const effectiveApiKey = resolved.noApiKey ? 'ollama' : (apiKey || '');
    return streamChatBase(
        {
            ...rest,
            apiKey:        effectiveApiKey,
            baseUrl:       resolved.baseUrl,
            model:         resolved.model,
            streamOptions: resolved.streamOptions,
            parallelTools: resolved.parallelTools,
        },
        callbacks,
        abortSignal,
    );
}

module.exports = { streamChat, fetchBalance, PROVIDER_PRESETS, resolveProviderConfig };
