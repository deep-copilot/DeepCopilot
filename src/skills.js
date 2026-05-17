// Skill discovery — scans ~/.deepcopilot/skills, ~/.claude/skills and
// ~/.copilot/skills for SKILL.md files.
//
// Each valid skill directory must contain a SKILL.md with a YAML frontmatter
// block. Supported fields:
//   ---
//   name: <skill-name>                  required (or derived from dir name)
//   description: <one-line description> required (used for recall)
//   argument-hint: [optional hint shown in popup]
//   source: self | web | hybrid         optional (default: self)
//   trust:  trusted | untrusted         optional (default: trusted)
//   applies_to: ["package.json:vue",    optional, workspace gating
//                "**/*.vue"]
//   ---
//
// Skills from the first matching directory win (no overwrite by later dirs).
// Issue #61 — Step 1: stable sort + workspace gating + metadata exposure.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Default skills directory created by this extension on first activation.
const DEEPCOPILOT_SKILLS_DIR = path.join(os.homedir(), '.deepcopilot', 'skills');

// Directories scanned in order; first match wins for duplicate skill names.
const SKILL_DIRS = [
    DEEPCOPILOT_SKILLS_DIR,
    path.join(os.homedir(), '.claude',  'skills'),
    path.join(os.homedir(), '.copilot', 'skills'),
];

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Handles scalar strings and simple inline JSON-style arrays (e.g.
 *   applies_to: ["foo", "bar"]). No dependency on js-yaml.
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split('\n')) {
        // Match:  key: value   or   key: "value"   or   key: ["a", "b"]
        const kv = line.match(/^([\w-]+):\s*(.*?)\s*$/);
        if (!kv) continue;
        const key = kv[1];
        let val = kv[2];
        if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
        if (val.startsWith('[') && val.endsWith(']')) {
            try { out[key] = JSON.parse(val); continue; } catch { /* fall through */ }
        }
        out[key] = val;
    }
    return out;
}

// Shallow scan: do any top-level files in wsRoot (or src/) have this extension?
function hasFileWithExt(wsRoot, ext) {
    const want = ext.toLowerCase();
    try {
        const entries = fs.readdirSync(wsRoot, { withFileTypes: true });
        for (const e of entries) {
            if (e.isFile() && e.name.toLowerCase().endsWith(want)) return true;
        }
        const src = path.join(wsRoot, 'src');
        if (fs.existsSync(src)) {
            const sub = fs.readdirSync(src, { withFileTypes: true });
            for (const e of sub) {
                if (e.isFile() && e.name.toLowerCase().endsWith(want)) return true;
            }
        }
    } catch { /* ignore */ }
    return false;
}

/**
 * Return true if a skill (frontmatter) applies to the given workspace root.
 * Matching rules for entries in `applies_to`:
 *   - "filename"                 → file exists in wsRoot
 *   - "filename:substring"       → file exists AND contains substring
 *   - "**\/*.ext" or "*.ext"     → at least one matching file (shallow)
 * Missing/empty applies_to → always applies.
 * Falsy wsRoot → always applies (no workspace context).
 */
function matchesWorkspace(fm, wsRoot) {
    if (!wsRoot) return true;
    const list = Array.isArray(fm.applies_to) ? fm.applies_to : [];
    if (!list.length) return true;
    for (const rule of list) {
        if (typeof rule !== 'string' || !rule) continue;
        const globExt = rule.match(/^\*{1,2}\/?\*\.([\w.-]+)$/);
        if (globExt) {
            if (hasFileWithExt(wsRoot, '.' + globExt[1])) return true;
            continue;
        }
        const idx = rule.indexOf(':');
        if (idx > 0) {
            const file = rule.slice(0, idx);
            const needle = rule.slice(idx + 1);
            try {
                const p = path.join(wsRoot, file);
                if (fs.existsSync(p)) {
                    const txt = fs.readFileSync(p, 'utf8');
                    if (txt.includes(needle)) return true;
                }
            } catch { /* skip */ }
            continue;
        }
        try {
            if (fs.existsSync(path.join(wsRoot, rule))) return true;
        } catch { /* skip */ }
    }
    return false;
}

/**
 * Scan all SKILL_DIRS and return an array of discovered skills.
 * Stable alphabetical order by name — required for KV-cache hit rate
 * when the result is later injected into the system prompt.
 *
 * @param {string} [wsRoot] - if provided, filter by frontmatter.applies_to
 * @returns {{ name: string, desc: string, hint: string, content: string,
 *             source: string, trust: string, dir: string }[]}
 */
function discoverSkills(wsRoot) {
    const result = [];
    const seen   = new Set();

    for (const dir of SKILL_DIRS) {
        try { if (!fs.existsSync(dir)) continue; } catch { continue; }

        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const mdPath = path.join(dir, entry.name, 'SKILL.md');
            try {
                if (!fs.existsSync(mdPath)) continue;
                const content = fs.readFileSync(mdPath, 'utf8');
                const fm      = parseFrontmatter(content);
                const name    = String(fm.name || entry.name).trim();
                if (!name || seen.has(name)) continue;
                if (!matchesWorkspace(fm, wsRoot)) continue;
                seen.add(name);
                result.push({
                    name,
                    desc:    String(fm.description || ''),
                    hint:    String(fm['argument-hint'] || ''),
                    source:  String(fm.source || 'self'),
                    trust:   String(fm.trust || 'trusted'),
                    dir,
                    content,
                });
            } catch { /* skip broken entries silently */ }
        }
    }

    // Stable alphabetical order — critical for prompt cache stability.
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
}

module.exports = {
    discoverSkills,
    parseFrontmatter,
    matchesWorkspace,
    DEEPCOPILOT_SKILLS_DIR,
    SKILL_DIRS,
};
