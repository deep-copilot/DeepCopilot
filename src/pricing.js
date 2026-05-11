// DeepSeek pricing (CNY per 1M tokens).
//   - v4-flash: input miss ¥1 / cache hit ¥0.02 / output ¥2
//   - v4-pro:   input miss ¥12 / cache hit ¥0.1 / output ¥24
//               (2.5折优惠至 2026-05-31 23:59 北京时间: ¥3 / ¥0.025 / ¥6)
//   - reasoner: 兼容别名 = v4-flash 思考模式，同 v4-flash 价格
'use strict';

const V4_PRO_DISCOUNT_END = Date.UTC(2026, 4, 31, 15, 59, 0); // 2026-05-31 23:59 Beijing (UTC+8)

function getModelPricing(model) {
    if (model === 'deepseek-v4-flash' || model === 'deepseek-reasoner' || model === 'deepseek-chat') {
        return { input: 1.0, cache_hit: 0.02, output: 2.0 };
    }
    if (Date.now() < V4_PRO_DISCOUNT_END) {
        return { input: 3.0, cache_hit: 0.025, output: 6.0, discount: '2.5折' };
    }
    return { input: 12.0, cache_hit: 0.1, output: 24.0 };
}

function computeCost(model, usage) {
    if (!usage) return { cost_cny: 0 };
    const p = getModelPricing(model);
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    const cacheHit = usage.prompt_cache_hit_tokens || 0;
    const cacheMiss = (usage.prompt_cache_miss_tokens != null)
        ? usage.prompt_cache_miss_tokens
        : Math.max(prompt - cacheHit, 0);
    const cost =
        (cacheHit  / 1e6) * p.cache_hit +
        (cacheMiss / 1e6) * p.input +
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

module.exports = { getModelPricing, computeCost, V4_PRO_DISCOUNT_END, getDiscountWarning };

function getDiscountWarning() {
    const now = Date.now();
    if (now >= V4_PRO_DISCOUNT_END) return { expired: true, expiring: false };
    const daysLeft = Math.ceil((V4_PRO_DISCOUNT_END - now) / (24 * 60 * 60 * 1000));
    if (daysLeft <= 7) return { expired: false, expiring: true, days: daysLeft };
    return { expired: false, expiring: false };
}
