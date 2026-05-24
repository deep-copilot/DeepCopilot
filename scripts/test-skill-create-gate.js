// Issue #146 — Verify the skill-creator quality gate on skill_create.
//
// Run with:   node scripts/test-skill-create-gate.js
//
// Exits 0 on success, non-zero on the first failure.
//
// Strategy:
//   - Stub `vscode` (skills.js → wsRoot() pulls config from it).
//   - Monkey-patch `discoverSkills` to control whether skill-creator is
//     "installed" without touching the user's real ~/.deepcopilot/skills.
//   - Monkey-patch `fs.writeFileSync` to assert that a rejected call never
//     reaches disk (and to avoid polluting the dev's home dir during tests).
'use strict';

const Module = require('module');
const path = require('path');
const fs   = require('fs');
const assert = require('assert');

// Patch the module resolver ONLY while requiring the modules that pull in
// `vscode`. Wrap in try/finally so the global resolver is restored even if a
// require throws — and is never left active when this file is loaded from
// another runner/harness (where `process.on('exit')` would be too late).
const origResolve = Module._resolveFilename;
let skillsMod, skillCreate;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return require.resolve('./_vscode-stub.js');
    return origResolve.call(this, request, parent, ...rest);
};
try {
    skillsMod    = require(path.join('..', 'src', 'skills'));
    ({ skillCreate } = require(path.join('..', 'src', 'tools', 'skill-tools')));
} finally {
    Module._resolveFilename = origResolve;
}

// ── harness ────────────────────────────────────────────────────────────────
let passed = 0;
let _writes = [];
const origWrite = fs.writeFileSync;
const origMkdir = fs.mkdirSync;
function installFsSpy() {
    _writes = [];
    fs.writeFileSync = (p, content) => { _writes.push({ path: String(p), bytes: Buffer.byteLength(content || '') }); };
    fs.mkdirSync = () => {};
}
function restoreFs() {
    fs.writeFileSync = origWrite;
    fs.mkdirSync = origMkdir;
}

const origDiscover = skillsMod.discoverSkills;
function stubDiscover(skills) {
    skillsMod.discoverSkills = () => skills;
}
function restoreDiscover() { skillsMod.discoverSkills = origDiscover; }

function test(name, fn) {
    installFsSpy();
    try { fn(); console.log(`\u2713 ${name}`); passed++; }
    catch (e) { console.error(`\u2717 ${name}\n   ${e.stack || e.message}`); restoreFs(); restoreDiscover(); process.exit(1); }
    restoreFs();
    restoreDiscover();
}

// ── fixtures ───────────────────────────────────────────────────────────────
const validArgs = {
    name: 'test-skill-xxxxxxxx',
    description: 'A unit-test skill for the gate.',
    body: '# Test\n\n1. Step one\n2. Step two\n3. Step three',
    source: 'self',
};

const skillCreatorStub = { name: 'skill-creator', dir: '/fake', source: 'self', trust: 'trusted', content: '' };

function userMsg(text)   { return { role: 'user', content: text }; }
function invokeCall(name){
    return { role: 'assistant', content: null, tool_calls: [{
        id: 'call_1', type: 'function',
        function: { name: 'skill_invoke', arguments: JSON.stringify({ name }) },
    }] };
}

// ── T1: gate blocks when creator installed but not invoked ────────────────
test('T1 rejects when skill-creator installed but not invoked this turn', () => {
    stubDiscover([skillCreatorStub]);
    const run = { messages: [userMsg('please make a skill that does X')] };
    const out = skillCreate(validArgs, run);
    assert.match(out, /^Error: skill_create is gated/);
    assert.match(out, /skill-creator/);
    assert.deepStrictEqual(_writes, [], 'must not write to disk on rejection');
});

// ── T2: gate passes when creator invoked earlier this turn ────────────────
test('T2 allows when skill_invoke({name:"skill-creator"}) appears this turn', () => {
    stubDiscover([skillCreatorStub]);
    const run = { messages: [
        userMsg('please make a skill that does X'),
        invokeCall('skill-creator'),
    ] };
    const out = skillCreate(validArgs, run);
    assert.match(out, /^Created skill/);
    assert.strictEqual(_writes.length, 1, 'must write SKILL.md exactly once');
});

// ── T3: prior-turn invocation does NOT satisfy gate ───────────────────────
test('T3 prior-turn invocation does not satisfy the gate', () => {
    stubDiscover([skillCreatorStub]);
    const run = { messages: [
        userMsg('earlier turn'),
        invokeCall('skill-creator'),     // belongs to a previous turn
        userMsg('now create the skill'), // new turn starts here
    ] };
    const out = skillCreate(validArgs, run);
    assert.match(out, /^Error: skill_create is gated/);
    assert.deepStrictEqual(_writes, []);
});

// ── T4: alternative name spellings accepted ───────────────────────────────
test('T4 accepts skill_creator and skillcreator spellings', () => {
    const variants = [
        { skill: 'skill_creator', testName: 'test-skill-variant-a' },
        { skill: 'skillcreator',  testName: 'test-skill-variant-b' },
    ];
    for (const { skill, testName } of variants) {
        stubDiscover([{ ...skillCreatorStub, name: skill }]);
        const run = { messages: [
            userMsg('make skill'),
            invokeCall(skill),
        ] };
        const out = skillCreate({ ...validArgs, name: testName }, run);
        assert.match(out, /^Created skill/, `variant ${skill} should pass; got: ${out}`);
    }
});

// ── T5: no skill-creator installed → soft-warn but allow ──────────────────
test('T5 missing skill-creator degrades to a soft warning', () => {
    stubDiscover([]); // no skills at all
    const run = { messages: [userMsg('make skill')] };
    const out = skillCreate(validArgs, run);
    assert.match(out, /^\[warning\]/);
    assert.match(out, /Created skill/);
    assert.strictEqual(_writes.length, 1);
});

// ── T6: no run context still applies degrade-or-block rule correctly ──────
test('T6 missing run context is treated as "not invoked"', () => {
    stubDiscover([skillCreatorStub]);
    const out = skillCreate(validArgs, null);
    assert.match(out, /^Error: skill_create is gated/);
    assert.deepStrictEqual(_writes, []);
});

// ── T7: rejection happens BEFORE field validation (most useful error) ─────
test('T7 gate fires before field validation', () => {
    stubDiscover([skillCreatorStub]);
    const bad = { name: '', description: '', body: '', source: 'self' };
    const out = skillCreate(bad, { messages: [userMsg('x')] });
    assert.match(out, /^Error: skill_create is gated/, 'gate error should come first, not field errors');
});

// ── T8: <system-reminder> user message is NOT a turn boundary ─────────────
// The agent loop injects synthetic user messages wrapping <system-reminder>
// (e.g. background job snapshots). These must not be treated as a new turn;
// the gate should look past them to find the real preceding user message.
test('T8 <system-reminder> user message is not a turn boundary', () => {
    stubDiscover([skillCreatorStub]);
    const run = { messages: [
        userMsg('please create a skill that does X'),
        invokeCall('skill-creator'),
        // Synthetic reminder injected mid-turn by agent-loop (NOT a new turn)
        { role: 'user', content: '<system-reminder>\nBackground job snapshot.\n</system-reminder>' },
    ] };
    const out = skillCreate(validArgs, run);
    assert.match(out, /^Created skill/, `gate should pass; got: ${out}`);
    assert.strictEqual(_writes.length, 1);
});

// ── T9: skill_invoke AFTER skill_create in same tool_calls is rejected ────
// If the model batches skill_create (first) and skill_invoke (second) in a
// single assistant message, the tool layer must reject skill_create because
// skill_invoke has not actually been executed yet at that point.
test('T9 skill_invoke appearing after skill_create in same message is rejected', () => {
    stubDiscover([skillCreatorStub]);
    const tcIdCreate = 'call_sc';
    const tcIdInvoke = 'call_si';
    const run = { messages: [
        userMsg('make a skill'),
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                // skill_create comes first — wrong order
                { id: tcIdCreate, type: 'function', function: { name: 'skill_create', arguments: JSON.stringify(validArgs) } },
                // skill_invoke comes second — not yet executed
                { id: tcIdInvoke, type: 'function', function: { name: 'skill_invoke', arguments: JSON.stringify({ name: 'skill-creator' }) } },
            ],
        },
    ] };
    // Gate receives the tcId of the skill_create call so it knows its position.
    const out = skillCreate(validArgs, run, tcIdCreate);
    assert.match(out, /^Error: skill_create is gated/, `gate should reject out-of-order batch; got: ${out}`);
    assert.deepStrictEqual(_writes, []);
});

// ── T10: invoking a *non-installed* variant name does NOT satisfy gate ────
// If skill_creator (underscore) is installed but the model invokes
// skill-creator (hyphen, not installed), skill_invoke itself would error,
// so the meta-skill never actually ran. The gate must reject the bypass.
test('T10 invoking a variant name that is not actually installed is rejected', () => {
    // Only `skill_creator` (underscore) is installed.
    stubDiscover([{ ...skillCreatorStub, name: 'skill_creator' }]);
    const run = { messages: [
        userMsg('make a skill'),
        // Model tries to satisfy the gate by invoking the hyphen spelling,
        // which is NOT installed locally — skill_invoke would have failed.
        invokeCall('skill-creator'),
    ] };
    const out = skillCreate(validArgs, run);
    assert.match(out, /^Error: skill_create is gated/, `bypass via uninstalled variant must be rejected; got: ${out}`);
    assert.deepStrictEqual(_writes, []);
});

// Final summary — printed once, after ALL tests have actually run.
console.log(`\nAll ${passed} tests passed (including T8/T9/T10 edge-case tests).`);
