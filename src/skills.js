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
/**
 * Parse a YAML-style inline flow array like [foo, "bar", 'baz'].
 * JSON.parse fails on unquoted strings, so we use a hand-written splitter.
 * @param {string} val - string starting with '[' and ending with ']'
 * @returns {string[]}
 */
function parseYamlArray(val) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    // Split on commas not inside quotes.
    const items = [];
    let current = '';
    let inQuote = null;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (!inQuote && (ch === '"' || ch === "'")) { inQuote = ch; continue; }
        if (inQuote && ch === inQuote) { inQuote = null; continue; }
        if (!inQuote && ch === ',') { items.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    if (current.trim()) items.push(current.trim());
    return items.filter(Boolean);
}

function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out = {};
    // Fix: split on \r?\n so Windows CRLF files parse correctly.
    for (const line of m[1].split(/\r?\n/)) {
        // Match:  key: value   or   key: "value"   or   key: ["a", "b"]
        const kv = line.match(/^([\w-]+):\s*(.*?)\s*$/);
        if (!kv) continue;
        const key = kv[1];
        let val = kv[2];
        if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
        if (val.startsWith('[') && val.endsWith(']')) {
            out[key] = parseYamlArray(val);
            continue;
        }
        out[key] = val;
    }
    return out;
}

/**
 * Recursively scan `dir` up to `maxDepth` levels deep for any file whose
 * name ends with `ext`. Bounded to avoid blocking on large workspaces.
 * @param {string} dir
 * @param {string} ext  — e.g. '.vue'
 * @param {number} [maxDepth=4]
 * @returns {boolean}
 */
function hasFileWithExt(dir, ext, maxDepth = 4) {
    const want = ext.toLowerCase();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase().endsWith(want)) return true;
        if (e.isDirectory() && maxDepth > 0) {
            if (hasFileWithExt(path.join(dir, e.name), ext, maxDepth - 1)) return true;
        }
    }
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
        // Match both "*.ext" (single-star) and "**/*.ext" (double-star recursive).
        // Regex: optional (**/ or */) prefix, then *.ext
        const globExt = rule.match(/^(?:\*{1,2}\/)?\*\.([\w.-]+)$/);
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
                // Verify it exists AND is a regular file (not a directory).
                const stat = fs.statSync(p);
                if (stat.isFile()) {
                    // Guard against reading huge files (e.g. lockfiles): cap at 256 KB.
                    const MAX_READ = 256 * 1024;
                    const buf = Buffer.alloc(Math.min(MAX_READ, stat.size));
                    const fd = fs.openSync(p, 'r');
                    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
                    if (buf.toString('utf8').includes(needle)) return true;
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
