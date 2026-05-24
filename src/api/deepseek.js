// FIM completion for DeepSeek's /beta/completions endpoint.
// Chat streaming has moved to src/api/openai-client.js (via adapter.js).
'use strict';

const https = require('https');
const http = require('http');

const { Logger } = require('../logger');

// ─── FIM completion (Issue #60) ────────────────────────────────────────────
// Non-streaming fill-in-the-middle completion against DeepSeek's beta endpoint.
// Powers the InlineCompletionItemProvider (src/completion/provider.js).
//
// API:    POST {baseUrl}/beta/completions
// Schema: OpenAI legacy /v1/completions with `prompt` (prefix) + `suffix`.
//
// Returns the completion text, or null on any failure (silent — inline
// completion must never throw user-visible errors).
function fimComplete({ apiKey, baseUrl, model, prefix, suffix, maxTokens, temperature }, abortSignal) {
    return new Promise((resolve) => {
        const base = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');

        // Parse the URL first so we can do hostname-based whitelisting.
        // FIM is only documented for the official DeepSeek API; third-party
        // proxies may not implement /beta/completions. We MUST check the
        // parsed hostname rather than a substring of the raw string — see
        // CodeQL js/incomplete-url-substring-sanitization: a substring check
        // would falsely accept hosts like `deepseek.com.attacker.com`,
        // `evil.com/?x=deepseek.com`, etc., leaking the API key.
        let urlObj;
        try { urlObj = new URL('/beta/completions', base); } catch { resolve(null); return; }
        const host = (urlObj.hostname || '').toLowerCase();
        if (host !== 'deepseek.com' && host !== 'api.deepseek.com' && !host.endsWith('.deepseek.com')) {
            resolve(null);
            return;
        }
        const isHttps = urlObj.protocol === 'https:';

        const body = JSON.stringify({
            model:       model || 'deepseek-chat',
            prompt:      prefix || '',
            suffix:      suffix || '',
            max_tokens:  maxTokens  || 64,
            temperature: temperature == null ? 0.2 : temperature,
            stream:      false,
        });

        const reqOpts = {
            hostname: urlObj.hostname,
            port:     urlObj.port || (isHttps ? 443 : 80),
            path:     urlObj.pathname,
            method:   'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type':  'application/json',
                'Accept':        'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 15000,
        };

        const mod = isHttps ? https : http;
        const req = mod.request(reqOpts, (res) => {
            if (res.statusCode !== 200) {
                let errBody = '';
                res.on('data', c => { errBody += c; });
                res.on('end', () => {
                    // Sanitize untrusted upstream body before logging
                    // (CodeQL js/http-to-file-access): strip CR/LF/control
                    // chars so a malicious proxy cannot inject log lines,
                    // and cap length so logs cannot be ballooned.
                    const safeBody = String(errBody)
                        .slice(0, 300)
                        .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ');
                    Logger.info('FIM_HTTP_ERROR', { status: res.statusCode, body: safeBody });
                    resolve(null);
                });
                return;
            }
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    const text = (data && data.choices && data.choices[0] && data.choices[0].text) || '';
                    resolve(text);
                } catch { resolve(null); }
            });
            res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { try { req.destroy(); } catch {}; resolve(null); });
        if (abortSignal) {
            const onAbort = () => { try { req.destroy(); } catch {}; resolve(null); };
            if (abortSignal.aborted) { onAbort(); return; }
            abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        req.write(body);
        req.end();
    });
}

module.exports = { fimComplete };
