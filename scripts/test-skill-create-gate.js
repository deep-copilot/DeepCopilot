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
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return require.resolve('./_vscode-stub.js');
    return origResolve.call(this, request, parent, ...rest);
};

const path = require('path');
const fs   = require('fs');
const assert = require('assert');

const skillsMod = require(path.join('..', 'src', 'skills'));
const { skillCreate } = require(path.join('..', 'src', 'tools', 'skill-tools'));

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

console.log(`\nAll ${passed} tests passed.`);
