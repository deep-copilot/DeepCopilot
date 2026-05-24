// Self-contained sanity tests for _dropOrphanToolCallGroups.
//
// Run with:   node scripts/test-orphan-toolcalls.js
//
// Exits 0 on success, non-zero on the first failure.
//
// We import directly from session-store.js. That file does `require('vscode')`
// at module load, which fails outside the extension host \u2014 so we stub it
// before the require call. Only the sanitizer (a pure function) is exercised.
'use strict';

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return require.resolve('./_vscode-stub.js');
    return origResolve.call(this, request, parent, ...rest);
};

const path = require('path');
const assert = require('assert');

const { _dropOrphanToolCallGroups } =
    require(path.join('..', 'src', 'chat', 'session-store.js'));

// ── helpers ────────────────────────────────────────────────────────────────
const u   = (text)                  => ({ role: 'user',      content: text });
const a   = (text)                  => ({ role: 'assistant', content: text });
const ac  = (...ids)                => ({
    role: 'assistant', content: null,
    tool_calls: ids.map(id => ({
        id, type: 'function',
        function: { name: 'read_file', arguments: '{}' },
    })),
});
const t   = (id, body = 'ok')       => ({ role: 'tool', tool_call_id: id, content: body });

let passed = 0;
function test(name, fn) {
    try { fn(); console.log(`\u2713 ${name}`); passed++; }
    catch (e) { console.error(`\u2717 ${name}\n   ${e.stack || e.message}`); process.exit(1); }
}
const ids = (msgs) => msgs.map(m =>
    m.role === 'tool'      ? `tool(${m.tool_call_id})` :
    m.role === 'assistant' && m.tool_calls ? `asst{${m.tool_calls.map(c => c.id).join(',')}}` :
    m.role);

// ── T1 head orphan tool ───────────────────────────────────────────────────
test('T1 strips leading orphan tool message', () => {
    const input  = [t('x'), u('hi'), a('hello')];
    const output = _dropOrphanToolCallGroups(input);
    assert.deepStrictEqual(ids(output), ['user', 'assistant']);
});

// ── T2 tail orphan tool_calls ─────────────────────────────────────────────
test('T2 strips tail-only orphan assistant{tool_calls}', () => {
    const input  = [u('hi'), a('hello'), u('go'), ac('c1')];
    const output = _dropOrphanToolCallGroups(input);
    assert.deepStrictEqual(ids(output), ['user', 'assistant', 'user']);
});

// ── T3 MID-array orphan (the reported #145 case) ──────────────────────────
test('T3 strips MID-array orphan assistant{tool_calls}', () => {
    const input  = [u('q1'), ac('c1'), t('c1'), ac('c2'), u('continue')];
    const output = _dropOrphanToolCallGroups(input);
    assert.deepStrictEqual(ids(output), ['user', 'asst{c1}', 'tool(c1)', 'user']);
});

// ── T4 partial-coverage in middle ─────────────────────────────────────────
test('T4 strips assistant whose tool_calls are partially covered', () => {
    const input  = [u('q'), ac('c1', 'c2'), t('c1'), u('next')];
    const output = _dropOrphanToolCallGroups(input);
    assert.deepStrictEqual(ids(output), ['user', 'user']);
});

// ── T5 multiple broken groups ─────────────────────────────────────────────
test('T5 strips multiple consecutive broken groups', () => {
    const input  = [u('q'), ac('a'), ac('b'), u('go')];
    const output = _dropOrphanToolCallGroups(input);
    assert.deepStrictEqual(ids(output), ['user', 'user']);
});

// ── T6 complete sequence \u2014 untouched ────────────────────────────────────
test('T6 preserves a fully-paired sequence', () => {
    const input  = [u('q'), ac('c1', 'c2'), t('c1'), t('c2'), a('done')];
    const output = _dropOrphanToolCallGroups(input);
    assert.deepStrictEqual(ids(output),
        ['user', 'asst{c1,c2}', 'tool(c1)', 'tool(c2)', 'assistant']);
});

// ── T7 synthetic skill_read pair survives ─────────────────────────────────
test('T7 keeps synthetic skill-read assistant+tool pair', () => {
    const input = [
        u('use skill'),
        ac('synthetic_skill_read_abc'),
        t('synthetic_skill_read_abc', '<SKILL.md content>'),
        a('Got it.'),
    ];
    const output = _dropOrphanToolCallGroups(input);
    assert.strictEqual(output.length, 4);
});

// ── extra: idempotency ────────────────────────────────────────────────────
test('T8 sanitizer is idempotent', () => {
    const input  = [u('q1'), ac('c1'), t('c1'), ac('c2'), u('continue')];
    const once   = _dropOrphanToolCallGroups(input);
    const twice  = _dropOrphanToolCallGroups(once);
    assert.deepStrictEqual(ids(once), ids(twice));
});

// ── extra: original input not mutated ─────────────────────────────────────
test('T9 sanitizer does not mutate its input', () => {
    const input  = [u('q'), ac('c1'), u('x')];
    const snap   = JSON.stringify(input);
    _dropOrphanToolCallGroups(input);
    assert.strictEqual(JSON.stringify(input), snap);
});

console.log(`\nAll ${passed} orphan-tool-call sanitizer tests passed.`);
