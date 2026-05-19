'use strict';

const { streamChat: streamChatBase, fetchBalance } = require('./openai-client');
const { streamChat: streamChatAnthropic }          = require('./anthropic-client');

// Preset configuration per provider.
// streamOptions: whether to send stream_options.include_usage (true = supported).
// parallelTools: whether to send parallel_tool_calls (true = supported).
// noApiKey:      provider does not require an API key (e.g. local Ollama).
// isAnthropic:   routes to the native Anthropic SDK client instead of OpenAI-compatible.
const PROVIDER_PRESETS = {
  deepseek:  { baseUrl: 'https://api.deepseek.com',                               defaultModel: 'deepseek-v4-pro',         streamOptions: true,  parallelTools: true  },
  openai:    { baseUrl: 'https://api.openai.com/v1',                              defaultModel: 'gpt-4o',                  streamOptions: true,  parallelTools: true  },
  groq:      { baseUrl: 'https://api.groq.com/openai/v1',                         defaultModel: 'llama-3.3-70b-versatile', streamOptions: false, parallelTools: false },
  ollama:    { baseUrl: 'http://localhost:11434/v1',                              defaultModel: 'llama3.2',                streamOptions: false, parallelTools: false, noApiKey: true },
  gemini:    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.0-flash',      streamOptions: false, parallelTools: false },
  anthropic: { baseUrl: 'https://api.anthropic.com',                              defaultModel: 'claude-sonnet-4-6',       isAnthropic: true,   streamOptions: false, parallelTools: false },
  custom:    { streamOptions: false, parallelTools: false },
};

/**
 * Decide whether to use the stored override model for a given provider.
 * Prevents passing a DeepSeek-specific model name to OpenAI/Groq/Gemini.
 */
function shouldUseOverrideModel(provider, overrideModel) {
  if (!overrideModel) return false;
  const m = String(overrideModel);
  // Ignore provider-specific model names when the provider doesn't match.
  if (provider !== 'deepseek'  && m.startsWith('deepseek-'))  return false;
  if (provider !== 'anthropic' && m.startsWith('claude-'))    return false;
  return true;
}

/**
 * Resolve the effective baseUrl, model, and flags for a given provider.
 * @param {string} provider - one of the PROVIDER_PRESETS keys
 * @param {string} overrideBaseUrl - user-set base URL override (may be empty)
 * @param {string} overrideModel   - deepseekAgent.defaultModel setting value
 */
function resolveProviderConfig(provider, overrideBaseUrl, overrideModel) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const model = shouldUseOverrideModel(provider, overrideModel)
    ? overrideModel
    : (preset.defaultModel || 'deepseek-chat');

  return {
    baseUrl:      overrideBaseUrl || preset.baseUrl || 'https://api.deepseek.com',
    model,
    noApiKey:     !!preset.noApiKey,
    streamOptions: preset.streamOptions !== false,
    parallelTools: preset.parallelTools !== false,
  };
}

/**
 * Route a chat streaming request through the correct provider configuration.
 * Anthropic uses its own native SDK client; all others use the OpenAI-compatible client.
 */
function streamChat({ provider, apiKey, baseUrl, model, ...rest }, callbacks, abortSignal) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;

  if (preset.isAnthropic) {
    const effectiveModel  = shouldUseOverrideModel(provider, model) ? model : (preset.defaultModel || 'claude-sonnet-4-6');
    const effectiveUrl    = baseUrl || preset.baseUrl;
    return streamChatAnthropic(
      { ...rest, apiKey: apiKey || '', baseUrl: effectiveUrl, model: effectiveModel },
      callbacks,
      abortSignal,
    );
  }

  const resolved = resolveProviderConfig(provider || 'deepseek', baseUrl, model);
  // For providers that don't need an API key (Ollama), use a dummy value
  // so the OpenAI SDK doesn't reject the request.
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
