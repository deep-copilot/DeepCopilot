'use strict';
// Probe: which reasoning_content placeholder values does DeepSeek thinking-mode
// accept on round-trip WITHOUT returning HTTP 400?
//
// Background
// ----------
// DeepSeek thinking-mode enforces: once any assistant message in history carries
// non-empty reasoning_content, every SUBSEQUENT assistant message must also carry a
// non-empty reasoning_content — otherwise the API rejects with HTTP 400
// ("reasoning_content in the thinking mode must be passed back to the API").
//
// src/providers/index.js backfills a fixed placeholder string to satisfy this rule.
// That fixed string, repeated across many turns, can become a strong in-context
// pattern that the model mimics (it just re-emits the placeholder and stops),
// which manifests as a "ghost" empty turn. We want to swap the placeholder for a
// generic / guiding string — but ONLY if the new value still passes the 400 gate.
//
// This probe constructs the minimal multi-turn history that ARMS the invariant
// (a first assistant with REAL reasoning_content), then a second assistant whose
// reasoning_content is the candidate-under-test, then asks for a tiny completion.
// A 200 means the candidate is accepted; a 400 means it is rejected.
//
// Usage:
//   PowerShell:  $env:DEEPSEEK_KEY="sk-..."; node scripts/probe-reasoning-placeholder.js
//   bash:        DEEPSEEK_KEY=sk-... node scripts/probe-reasoning-placeholder.js

const https = require('https');

const KEY = process.env.DEEPSEEK_KEY;
if (!KEY) {
  console.error('Set DEEPSEEK_KEY env var first (the key is never printed).');
  process.exit(1);
}

// Reasoning-capable, cheapest model — keeps the probe nearly free.
const MODEL = 'deepseek-v4-flash';

// label -> candidate placeholder string
const CANDIDATES = {
  'baseline (current)':      '(no thoughts surfaced for this step)',
  'single space':           ' ',
  'dash':                   '-',
  'ellipsis':               '...',
  'guide-en':               'Continue with the next concrete step.',
  'guide-zh':               '继续执行下一步。',
};

// Build the minimal history that arms the thinking-mode invariant and then
// carries `placeholder` on a later assistant message.
function buildMessages(placeholder) {
  return [
    { role: 'user', content: 'Say hi and think a little.' },
    // (1) first assistant WITH real reasoning_content → arms the invariant
    {
      role: 'assistant',
      content: 'Hi there!',
      reasoning_content: 'The user greeted me and asked me to think a little; I will respond politely.',
    },
    { role: 'user', content: 'Now continue to the next step.' },
    // (2) second assistant carrying the CANDIDATE placeholder under test
    {
      role: 'assistant',
      content: 'Continuing.',
      reasoning_content: placeholder,
    },
    { role: 'user', content: 'Final: just reply with the word OK.' },
  ];
}

// Index-variant: several assistant turns, each with a DISTINCT placeholder, to
// confirm that varying (non-repeating) values still pass the 400 gate. The base
// text stays identical; only a per-message suffix differs.
function buildIndexVariantMessages(baseText) {
  const msgs = [{ role: 'user', content: 'Start a multi-step task.' }];
  for (let i = 1; i <= 3; i++) {
    msgs.push({ role: 'user', content: `Do sub-step ${i}.` });
    msgs.push({
      role: 'assistant',
      content: `Done sub-step ${i}.`,
      // i===1 carries real-ish reasoning to arm the invariant; rest are variants.
      reasoning_content: i === 1
        ? 'Planning the first sub-step in detail before acting.'
        : `${baseText} (step ${i})`,
    });
  }
  msgs.push({ role: 'user', content: 'Final: just reply with the word OK.' });
  return msgs;
}

function post(messages) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: MODEL, max_tokens: 5, messages });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let msg = '';
        try {
          const j = JSON.parse(raw);
          if (j.error) msg = j.error.message || j.error.code || 'error';
          else if (j.choices) msg = 'OK';
          else msg = raw.slice(0, 120);
        } catch { msg = raw.slice(0, 120); }
        resolve({ status: res.statusCode, msg });
      });
    });
    req.on('error', e => resolve({ status: 'ERR', msg: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', msg: '' }); });
    req.write(body);
    req.end();
  });
}

function icon(status) {
  if (status === 200) return '✅';
  if (status === 400) return '❌(400)';
  if (status === 401) return '🔑(401)';
  if (status === 429) return '⚡(429)';
  return `⚠️(${status})`;
}

(async () => {
  console.log(`Probing reasoning_content placeholders on ${MODEL}...\n`);
  for (const [label, placeholder] of Object.entries(CANDIDATES)) {
    const r = await post(buildMessages(placeholder));
    const preview = JSON.stringify(placeholder);
    console.log(`${icon(r.status).padEnd(8)} ${label.padEnd(20)} ${preview.padEnd(40)} ${r.msg}`);
  }
  // Index-variant test (varying, non-repeating placeholders)
  const rv = await post(buildIndexVariantMessages('(no thoughts surfaced for this step)'));
  console.log(`${icon(rv.status).padEnd(8)} ${'index-variant'.padEnd(20)} ${'"…(step N)"'.padEnd(40)} ${rv.msg}`);
  console.log('\nLegend: ✅=accepted (safe to use)  ❌(400)=rejected by thinking-mode gate');
})();
