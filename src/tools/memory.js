// memory.js — Persistent project-level memory stored in .deep-copilot/memory.md.
// memory_read: read the whole file.
// memory_write: upsert a named section.
'use strict';

const fs   = require('fs');
const path = require('path');

const { wsRoot }   = require('../utils/paths');
const { truncate } = require('./utils');

function _memoryPath() {
    const root = wsRoot();
    if (!root) throw new Error('No workspace folder open.');
    return path.join(root, '.deep-copilot', 'memory.md');
}

/** Return the full contents of the project memory file. */
async function toolMemoryRead() {
    let p;
    try { p = _memoryPath(); } catch (e) { return `Error: ${e.message}`; }

    try {
        const content = fs.readFileSync(p, 'utf8');
        return truncate(content || '(memory file is empty)', 16000);
    } catch (e) {
        if (e.code === 'ENOENT') return '(No project memory yet. Use memory_write to add facts.)';
        return `Error: ${e.message}`;
    }
}

/**
 * Upsert a section in the project memory file.
 * args: { section: string, content: string }
 */
async function toolMemoryWrite(args) {
    if (!args || !args.section || !args.content)
        return 'Error: section and content are required.';

    let p;
    try { p = _memoryPath(); } catch (e) { return `Error: ${e.message}`; }

    // Ensure .deep-copilot/ directory exists
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* already exists */ }

    let existing = '';
    try { existing = fs.readFileSync(p, 'utf8'); } catch { /* file does not exist yet */ }

    const header   = `## ${args.section}`;
    const newBlock = `${header}\n\n${String(args.content).trim()}\n`;

    // Replace existing section if present, otherwise append
    const escaped  = args.section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRe = new RegExp(
        `## ${escaped}(?:[\\s\\S]*?)(?=(?:\\n## )|$)`, 'm'
    );

    let updated;
    if (sectionRe.test(existing)) {
        updated = existing.replace(sectionRe, newBlock.trimEnd());
    } else {
        const base = existing.trimEnd();
        updated    = (base ? base + '\n\n' : '# Project Memory\n\n') + newBlock;
    }

    try {
        fs.writeFileSync(p, updated, 'utf8');
        const root = wsRoot();
        const rel  = root ? path.relative(root, p).replace(/\\/g, '/') : p;
        return `Memory section "${args.section}" saved to ${rel}.`;
    } catch (e) {
        return `Error: ${e.message}`;
    }
}

module.exports = { toolMemoryRead, toolMemoryWrite };
