// Provider registry — single source of truth for vendor/model definitions.
//
// Loads `*.json` files from this directory (built-in) at module load.
// Phase 4 will also load JSONs from a user-configured directory.
//
// IMPORTANT: We use fs.readFileSync + JSON.parse rather than require(),
// because esbuild inlines require()'d JSON at build time. To support runtime
// file discovery (and the eventual user providersDir), we copy
// src/providers/*.json -> out/providers/*.json in esbuild.config.js and
// read them with fs.readdirSync(__dirname). __dirname at runtime is out/.
'use strict';

const fs   = require('fs');
const path = require('path');

const { Logger } = require('../logger');

// Built-in provider directory. At build time `__dirname` is `src/providers`;
// at runtime (after esbuild) it is `out/` because the bundle is collapsed.
// `syncProviders()` in esbuild.config.js copies the JSONs to `out/providers/`.
const BUILTIN_DIR = path.join(__dirname, 'providers');

/** id -> provider object */
let PROVIDERS = {};

/**
 * Load every *.json (except files starting with `_`) from the given directory.
 * Returns a map { id: providerObj }. Malformed JSON or missing `id` is logged
 * and skipped — never throws (so a bad user file can't break the extension).
 */
function loadFromDir(dir) {
    const out = {};
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch (e) {
        Logger.info('PROVIDERS_DIR_MISSING', { dir, error: e.message });
        return out;
    }
    for (const f of entries) {
        if (!f.endsWith('.json') || f.startsWith('_')) continue;
        const fp = path.join(dir, f);
        try {
            const raw = fs.readFileSync(fp, 'utf8');
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string') {
                Logger.info('PROVIDER_INVALID', { file: fp, reason: 'missing id' });
                continue;
            }
            if (!Array.isArray(obj.models) || !obj.models.length) {
                Logger.info('PROVIDER_INVALID', { file: fp, reason: 'no models' });
                continue;
            }
            out[obj.id] = obj;
        } catch (e) {
            Logger.info('PROVIDER_LOAD_ERROR', { file: fp, error: e.message });
        }
    }
    return out;
}

/**
 * (Re)initialize the registry. Built-in providers always load first; any user
 * directories passed in override built-in entries by id (intentional, so users
 * can shadow a vendor's model list).
 */
function initRegistry(extraDirs = []) {
    PROVIDERS = loadFromDir(BUILTIN_DIR);
    for (const d of extraDirs) {
        if (!d) continue;
        Object.assign(PROVIDERS, loadFromDir(d));
    }
    Logger.info('PROVIDERS_LOADED', { count: Object.keys(PROVIDERS).length, ids: Object.keys(PROVIDERS) });
    return PROVIDERS;
}

// Eager init at module load. extension.js may call initRegistry([userDir])
// later to merge user-defined providers in Phase 4.
initRegistry();

// ─── Public API ─────────────────────────────────────────────────────────────

function getProvider(id) {
    return PROVIDERS[String(id || '')] || null;
}

function getModel(providerId, modelId) {
    const p = getProvider(providerId);
    if (!p) return null;
    return p.models.find(m => m.id === modelId) || null;
}

/**
 * Resolve the effective per-model + per-provider quirks. Model-level quirks
 * override provider-level (per Plan decision).
 */
function getEffectiveQuirks(providerId, modelId) {
    const p = getProvider(providerId);
    const m = p && p.models.find(x => x.id === modelId);
    return Object.assign({}, p?.quirks || {}, m?.quirks || {});
}

/**
 * Lightweight outward view of all providers — suitable to send to the webview.
 * Strips `quirks` and any internal-only fields.
 */
function listProviders() {
    // Explicit display order in the UI dropdown. Unknown ids fall after these
    // (still alphabetised) and `custom` is always last.
    const ORDER = ['deepseek', 'openai', 'anthropic'];
    const rank  = (id) => {
        if (id === 'custom') return 1e6;
        const i = ORDER.indexOf(id);
        return i === -1 ? 1e5 : i;
    };
    return Object.values(PROVIDERS)
        .slice()
        .sort((a, b) => {
            const ra = rank(a.id), rb = rank(b.id);
            return ra !== rb ? ra - rb : (a.id < b.id ? -1 : 1);
        })
        .map(p => ({
        id:           p.id,
        displayName:  p.displayName || p.id,
        baseUrl:      p.baseUrl || '',
        apiKeyUrl:    p.apiKeyUrl || '',
        protocol:     p.protocol,
        defaultModel: p.defaultModel,
        noApiKey:     !!p.noApiKey,
        models: (p.models || []).map(m => ({
            id:               m.id,
            displayName:      m.displayName || m.id,
            contextWindow:    m.contextWindow,
            maxOutputTokens:  m.maxOutputTokens,
            capabilities:     m.capabilities || {},
        })),
    }));
}

function listModels(providerId) {
    return getProvider(providerId)?.models || [];
}

/**
 * Apply provider-declared `stripInputFields` to a messages array.
 * Returns a NEW array; never mutates the input. The strip rule lives in the
 * provider JSON so a vendor's protocol quirks stay encapsulated.
 *
 * Example: DeepSeek 400s when the input contains `reasoning_content`.
 * deepseek.json sets quirks.stripInputFields: ["reasoning_content"], and this
 * function removes that field from each message before the API call.
 *
 * Exception: `reasoning_content` is never stripped for reasoning-capable models
 * (capabilities.reasoning === true) because DeepSeek's API requires it to be
 * passed back in subsequent turns — omitting it causes HTTP 400.
 */
function sanitizeMessages(providerId, messages, modelId) {
    if (!Array.isArray(messages) || !messages.length) return messages;
    const strip = getProvider(providerId)?.quirks?.stripInputFields;
    if (!Array.isArray(strip) || !strip.length) return messages;
    // Reasoning-capable models MUST have reasoning_content passed back to the
    // API; strip every other declared field but skip reasoning_content for them.
    const isReasoning = !!(modelId && getModel(providerId, modelId)?.capabilities?.reasoning);
    const effectiveStrip = isReasoning ? strip.filter(f => f !== 'reasoning_content') : strip;
    if (!effectiveStrip.length) return messages;
    return messages.map(m => {
        if (!m || typeof m !== 'object') return m;
        let copy = m;
        for (const k of effectiveStrip) {
            if (Object.prototype.hasOwnProperty.call(copy, k)) {
                if (copy === m) copy = Object.assign({}, m);
                delete copy[k];
            }
        }
        return copy;
    });
}

/**
 * Resolve the model that should be used for a given provider, given a user's
 * stored `defaultModel` setting. Falls back to provider.defaultModel when the
 * stored model doesn't belong to this provider (e.g. user had DeepSeek
 * selected, then switched to OpenAI — the stored "deepseek-v4-pro" no longer
 * applies and we want gpt-5.5 instead).
 */
function resolveModel(providerId, requestedModel) {
    const p = getProvider(providerId);
    if (!p) return requestedModel || '';
    if (requestedModel && p.models.some(m => m.id === requestedModel)) return requestedModel;
    return p.defaultModel || (p.models[0] && p.models[0].id) || '';
}

module.exports = {
    initRegistry,
    getProvider,
    getModel,
    getEffectiveQuirks,
    listProviders,
    listModels,
    sanitizeMessages,
    resolveModel,
};
