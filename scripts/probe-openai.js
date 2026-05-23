'use strict';
// One-shot probe: test each OpenAI model ID with a minimal chat request.
// Usage: node scripts/probe-openai.js  (key read from OPENAI_KEY env var)
const https = require('https');

const KEY = process.env.OPENAI_KEY;
if (!KEY) { console.error('Set OPENAI_KEY env var first.'); process.exit(1); }

const MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5',
  'gpt-4o',
];

function probe(model) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      max_completion_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let msg = '';
        try {
          const j = JSON.parse(raw);
          if (j.error) msg = j.error.message || j.error.code || 'error';
          else if (j.choices) msg = 'OK — reply: ' + (j.choices[0]?.message?.content || '').slice(0, 40);
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
  console.log('Probing OpenAI models...\n');
  for (const m of MODELS) {
    const r = await probe(m);
    const icon = r.status === 200 ? '✅' : r.status === 404 ? '❌(404 not found)' : r.status === 429 ? '⚡(429 rate)' : r.status === 401 ? '🔑(401 auth)' : `⚠️ (${r.status})`;
    console.log(`${icon}  ${r.model.padEnd(28)} ${r.msg}`);
  }
})();
