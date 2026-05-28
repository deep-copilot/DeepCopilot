// web_search: multi-backend web search.
// Backends:
//   - Tavily (requires API key, best quality)
//   - Bing   (no API key required, uses Bing RSS endpoint)
//
// Active backend is determined by the 'deepseekAgent.webSearchProvider' setting.
// Supported providers in this module are Tavily and Bing.
'use strict';

const https  = require('https');
const http   = require('http');
const { truncate } = require('./utils');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _request(opts, body, timeoutMs = 20000, abortSignal = null) {
    return new Promise((resolve, reject) => {
        if (abortSignal && abortSignal.aborted) return reject(new Error('aborted'));
        const mod = opts.protocol === 'http:' ? http : https;
        const req = mod.request(opts, (res) => {
            let chunks = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
        if (abortSignal) {
            const onAbort = () => { try { req.destroy(new Error('aborted')); } catch {} reject(new Error('aborted')); };
            abortSignal.addEventListener('abort', onAbort, { once: true });
            req.once('close', () => { try { abortSignal.removeEventListener('abort', onAbort); } catch {} });
        }
        req.setTimeout(timeoutMs);
        if (body) req.write(body);
        req.end();
    });
}

// ─── Tavily backend ────────────────────────────────────────────────────────────

async function _tavilySearch(query, { apiKey, max = 5, depth = 'basic', include_answer = true, abortSignal } = {}) {
    const body = JSON.stringify({
        api_key: apiKey, query, max_results: max,
        search_depth: depth, include_answer,
        include_raw_content: false, include_images: false,
    });
    const res = await _request({
        method: 'POST', hostname: 'api.tavily.com', path: '/search',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, body, 20000, abortSignal);

    if (res.status < 200 || res.status >= 300)
        throw new Error(`Tavily HTTP ${res.status}: ${res.body.slice(0, 200)}`);

    const data = JSON.parse(res.body);
    const lines = [`Query: ${query}`];
    if (data.answer) lines.push('', '## Synthesized answer', data.answer);
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
        lines.push('', '(No results.)');
    } else {
        lines.push('', `## Top ${results.length} result(s)`);
        results.forEach((r, i) => {
            lines.push('', `### ${i + 1}. ${(r.title || '').replace(/\s+/g, ' ').trim()}`);
            if (r.url) lines.push(r.url);
            if (r.content) lines.push(r.content.replace(/\s+/g, ' ').trim());
        });
    }
    return truncate(lines.join('\n'));
}

// ─── Bing RSS backend (no API key) ────────────────────────────────────────────
// Uses Bing's ?format=rss endpoint which returns stable XML — no bot detection,
// no HTML scraping fragility.

function _decodeXmlEntities(s) {
    return String(s || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, '&')
        .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function _parseBingRss(xml) {
    const results = [];
    const items = xml.split('<item>').slice(1);
    for (const item of items) {
        const titleM = item.match(/<title>([\s\S]*?)<\/title>/i);
        const linkM  = item.match(/<link>([\s\S]*?)<\/link>/i)
                    || item.match(/<link\s+[^>]*href="([^"]+)"/i);
        const descM  = item.match(/<description>([\s\S]*?)<\/description>/i);
        if (titleM && linkM) {
            results.push({
                title:   _decodeXmlEntities(titleM[1]).slice(0, 120),
                url:     _decodeXmlEntities(linkM[1]).trim(),
                snippet: descM ? _decodeXmlEntities(descM[1]).slice(0, 300) : '',
            });
        }
    }
    return results;
}

async function _bingSearch(query, { max = 5, abortSignal } = {}) {
    const q   = encodeURIComponent(query);
    const res = await _request({
        method:   'GET',
        hostname: 'www.bing.com',
        path:     `/search?q=${q}&format=rss&count=${max}`,
        headers:  {
            'User-Agent':      'Mozilla/5.0 (compatible; DeepCopilot/1.0)',
            'Accept':          'application/rss+xml, text/xml, */*',
            'Accept-Encoding': 'identity',
        },
    }, null, 15000, abortSignal);

    if (res.status < 200 || res.status >= 300)
        throw new Error(`Bing HTTP ${res.status}`);

    const results = _parseBingRss(res.body);
    if (!results.length) return `Query: ${query}\n\n(No results from Bing.)`;

    const lines = [`Query: ${query}`, '', `## Top ${results.length} result(s)`];
    results.slice(0, max).forEach((r, i) => {
        lines.push('', `### ${i + 1}. ${r.title}`);
        if (r.url) lines.push(r.url);
        if (r.snippet) lines.push(r.snippet);
    });
    return truncate(lines.join('\n'));
}

// ─── Main dispatch ─────────────────────────────────────────────────────────────

async function toolWebSearch(args, ctx = {}) {
    try {
        const query = String(args.query || '').trim();
        if (!query) return 'Error: query is empty.';

        const vscode   = require('vscode');
        const cfg      = vscode.workspace.getConfiguration('deepseekAgent');
        const provider = cfg.get('webSearchProvider') || 'tavily';
        const max      = Math.max(1, Math.min(10, Number.isFinite(args.max_results) ? args.max_results : 5));
        const abortSignal = ctx && ctx.abortSignal;

        if (provider === 'bing') {
            return await _bingSearch(query, { max, abortSignal });
        }

        // Default: Tavily (requires key)
        const secrets = ctx && ctx.secrets;
        if (!secrets) return 'Error: SecretStorage unavailable (internal).';
        const apiKey  = await secrets.get('deepseekAgent.tavilyKey');
        if (!apiKey) {
            return 'Error: Tavily API key not configured. Run command "Deep Copilot: Set Tavily API Key" or switch to Bing in settings (no key required).';
        }
        const depth = args.search_depth === 'advanced' ? 'advanced' : 'basic';
        const include_answer = args.include_answer === false ? false : true;
        return await _tavilySearch(query, { apiKey, max, depth, include_answer, abortSignal });

    } catch (e) { return `Error: ${e.message || String(e)}`; }
}

module.exports = { toolWebSearch };
