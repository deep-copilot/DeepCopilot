// Pricing — all numbers live in the provider JSONs (`pricing` block on each
// model, optionally with `discount.until` ISO timestamp). This module is just
// the lookup + cost arithmetic.
'use strict';

const { listProviders, getModel } = require('./providers');

/**
 * Find a model's pricing record across every registered provider. Returns the
 * raw `pricing` object as-declared in JSON (so callers can read `discount`,
 * `currency`, etc.) or `null` if the model is unknown.
 */
function _findModelPricing(model) {
    if (typeof model !== 'string' || !model) return null;
    for (const p of listProviders()) {
        const m = getModel(p.id, model);
        if (m && m.pricing) return m.pricing;
    }
    return null;
}

/**
 * Resolve the *effective* pricing for a model (applies an active discount if
 * its `until` timestamp hasn't passed).
 */
function getModelPricing(model) {
    const raw = _findModelPricing(model);
    if (!raw) return null;
    const d = raw.discount;
    if (d && d.until) {
        const until = Date.parse(d.until);
        if (!Number.isNaN(until) && Date.now() < until) {
            return {
                input:     d.input     ?? raw.input,
                cache_hit: d.cache_hit ?? raw.cache_hit,
                output:    d.output    ?? raw.output,
                discount:  d.label || true,
            };
        }
    }
    return { input: raw.input, cache_hit: raw.cache_hit, output: raw.output };
}

function computeCost(model, usage) {
    if (!usage) return { cost_cny: 0 };
    const p          = getModelPricing(model);
    const prompt     = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    const cacheHit   = usage.prompt_cache_hit_tokens || 0;
    const cacheMiss  = (usage.prompt_cache_miss_tokens != null)
        ? usage.prompt_cache_miss_tokens
        : Math.max(prompt - cacheHit, 0);
    if (!p) {
        return {
            cost_cny: 0,
            breakdown: {
                cache_hit_tokens:  cacheHit,
                cache_miss_tokens: cacheMiss,
                completion_tokens: completion,
                prompt_tokens:     prompt,
                total_tokens:      usage.total_tokens || (prompt + completion),
                pricing:           null,
            },
        };
    }
    const cost =
        (cacheHit   / 1e6) * p.cache_hit +
        (cacheMiss  / 1e6) * p.input +
        (completion / 1e6) * p.output;
    return {
        cost_cny: cost,
        breakdown: {
            cache_hit_tokens:  cacheHit,
            cache_miss_tokens: cacheMiss,
            completion_tokens: completion,
            prompt_tokens:     prompt,
            total_tokens:      usage.total_tokens || (prompt + completion),
            pricing:           p,
        },
    };
}

/**
 * Return a warning when *any* registered model has an active discount that
 * expires within 7 days, or has already expired. Used by the status bar /
 * extension.js boot warning. The first such model wins (the UI shows a single
 * banner).
 */
function getDiscountWarning() {
    const now = Date.now();
    let nearest = null;          // {until, label, expired}
    for (const p of listProviders()) {
        for (const m of (p.models || [])) {
            const raw = getModel(p.id, m.id)?.pricing;
            const until = raw?.discount?.until && Date.parse(raw.discount.until);
            if (!until || Number.isNaN(until)) continue;
            if (!nearest || until < nearest.until) {
                nearest = { until, label: raw.discount.label || '', expired: now >= until };
            }
        }
    }
    if (!nearest) return { expired: false, expiring: false };
    if (nearest.expired) return { expired: true, expiring: false, label: nearest.label };
    const daysLeft = Math.ceil((nearest.until - now) / (24 * 60 * 60 * 1000));
    if (daysLeft <= 7) return { expired: false, expiring: true, days: daysLeft, label: nearest.label };
    return { expired: false, expiring: false };
}

module.exports = { getModelPricing, computeCost, getDiscountWarning };
