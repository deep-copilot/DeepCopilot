// web_search: Tavily-backed web search.
// API key stored in VS Code SecretStorage under 'deepseekAgent.tavilyKey'.
'use strict';

const https = require('https');
const { truncate } = require('./utils');

function _tavilyRequest(payload, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req  = https.request({
            method: 'POST',
            hostname: 'api.tavily.com',
            path: '/search',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: timeoutMs,
        }, (res) => {
            let chunks = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error(`Tavily HTTP ${res.statusCode}: ${chunks.slice(0, 500)}`));
                try { resolve(JSON.parse(chunks)); }
                catch (e) { reject(new Error(`Tavily JSON parse failed: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('Tavily request timeout')); });
        req.write(body);
        req.end();
    });
}

async function toolWebSearch(args, ctx = {}) {
    try {
        const query = String(args.query || '').trim();
        if (!query) return 'Error: query is empty.';

        const secrets = ctx && ctx.secrets;
        if (!secrets) return 'Error: SecretStorage unavailable (internal).';
        const apiKey  = await secrets.get('deepseekAgent.tavilyKey');
        if (!apiKey) {
            return 'Error: Tavily API key not configured. Run command "Deep Copilot: Set Tavily API Key" (or visit https://app.tavily.com to get a free key), then retry.';
        }

        const max          = Math.max(1, Math.min(10, Number.isFinite(args.max_results) ? args.max_results : 5));
        const depth        = args.search_depth === 'advanced' ? 'advanced' : 'basic';
        const includeAnswer = args.include_answer !== false;

        const data = await _tavilyRequest({
            api_key: apiKey, query, max_results: max,
            search_depth: depth, include_answer: includeAnswer,
            include_raw_content: false, include_images: false,
        });

        const lines = [`Query: ${query}`];
        if (includeAnswer && data.answer) { lines.push('', '## Synthesized answer', data.answer); }
        const results = Array.isArray(data.results) ? data.results : [];
        if (!results.length) {
            lines.push('', '(No results.)');
        } else {
            lines.push('', `## Top ${results.length} result(s)`);
            results.forEach((r, i) => {
                lines.push('', `### ${i + 1}. ${(r.title || '(no title)').replace(/\s+/g, ' ').trim()}`);
                if (r.url) lines.push(r.url);
                if (r.content) lines.push((r.content).replace(/\s+/g, ' ').trim());
            });
        }
        return truncate(lines.join('\n'));
    } catch (e) { return `Error: ${e.message || String(e)}`; }
}

module.exports = { toolWebSearch };
