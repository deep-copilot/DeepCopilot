'use strict';
// Probe Anthropic model IDs via native Messages API.
// Usage: node scripts/probe-anthropic.js  (key from ANTHROPIC_KEY env var)
const https = require('https');

const KEY = process.env.ANTHROPIC_KEY;
if (!KEY) { console.error('Set ANTHROPIC_KEY env var first.'); process.exit(1); }

const MODELS = [
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

function probe(model) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 20000,
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let msg = '';
        try {
          const j = JSON.parse(raw);
          if (j.error) msg = j.error.message || j.error.type || 'error';
          else if (j.content) msg = 'OK — reply: ' + (j.content[0]?.text || '').slice(0, 40);
        } catch { msg = raw.slice(0, 80); }
        resolve({ model, status: res.statusCode, msg });
      });
    });
    req.on('error', e => resolve({ model, status: 'ERR', msg: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ model, status: 'TIMEOUT', msg: '' }); });
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('Probing Anthropic models...\n');
  for (const m of MODELS) {
    const r = await probe(m);
    const icon = r.status === 200 ? '✅' : r.status === 404 ? '❌(404 not found)' : r.status === 429 ? '⚡(429 rate)' : r.status === 401 ? '🔑(401 auth)' : `⚠️ (${r.status})`;
    console.log(`${icon}  ${r.model.padEnd(32)} ${r.msg}`);
  }
})();
