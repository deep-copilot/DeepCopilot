// File-writing tools: write_file, str_replace_in_file, apply_patch.
// apply_patch is a self-contained unified-diff applicator — no npm dep.
'use strict';

const fs   = require('fs');
const path = require('path');

const { resolvePath }              = require('../utils/paths');
const { t }                        = require('../utils/i18n');
const { truncate, ensurePathAllowed } = require('./utils');

// ─── write_file ──────────────────────────────────────────────────────────────

async function toolWriteFile(args) {
    try {
        const fp = resolvePath(args.path);
        if (!await ensurePathAllowed(fp, 'write')) return t('blockedOutsideWs');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, args.content, 'utf8');
        return `OK: wrote ${args.content.length} chars to ${args.path}`;
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── str_replace_in_file ─────────────────────────────────────────────────────

async function toolStrReplaceInFile(args) {
    try {
        const fp = resolvePath(args.path);
        if (!await ensurePathAllowed(fp, 'write')) return t('blockedOutsideWs');
        const oldStr = String(args.old_string ?? '');
        const newStr = String(args.new_string ?? '');
        if (!oldStr) return 'Error: old_string is required and must not be empty.';
        const text     = fs.readFileSync(fp, 'utf8');
        const expected = Math.max(1, Number(args.expected_replacements) || 1);

        let count = 0, idx = 0;
        const indices = [];
        while ((idx = text.indexOf(oldStr, idx)) !== -1) {
            indices.push(idx);
            count++;
            idx += oldStr.length;
            if (count > 1000) break;
        }
        if (count === 0) {
            return `Error: old_string not found in ${args.path}. Check whitespace, indentation, and line endings — old_string must match exactly.`;
        }
        if (count !== expected) {
            return `Error: old_string matched ${count} times but expected_replacements=${expected}. To proceed, either include more surrounding context to make old_string unique, or set expected_replacements=${count} explicitly.`;
        }

        let updated = '';
        let cursor = 0;
        for (const at of indices) { updated += text.slice(cursor, at) + newStr; cursor = at + oldStr.length; }
        updated += text.slice(cursor);

        fs.writeFileSync(fp, updated, 'utf8');
        return `OK: ${count} replacement(s) in ${args.path} (${updated.length - text.length >= 0 ? '+' : ''}${updated.length - text.length} chars).`;
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── apply_patch (self-contained unified-diff applicator) ────────────────────

function _normalizeLines(text) {
    const hasCRLF = text.includes('\r\n');
    return { lines: text.replace(/\r\n/g, '\n').split('\n'), hasCRLF };
}

function _restoreEndings(lines, hasCRLF) {
    const joined = lines.join('\n');
    return hasCRLF ? joined.replace(/\n/g, '\r\n') : joined;
}

function _parsePatch(patchText) {
    const rawLines = patchText.replace(/\r\n/g, '\n').split('\n');
    const files = [];
    let cur = null, curHunk = null;
    for (const line of rawLines) {
        if (line.startsWith('--- ')) {
            cur = { oldPath: line.slice(4).trim().replace(/^a\//, ''), newPath: null, hunks: [] };
            curHunk = null;
        } else if (line.startsWith('+++ ') && cur) {
            cur.newPath = line.slice(4).trim().replace(/^b\//, '');
            files.push(cur);
        } else if (line.startsWith('@@ ') && cur) {
            const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (m) {
                curHunk = {
                    oldStart: parseInt(m[1], 10),
                    oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
                    newStart: parseInt(m[3], 10),
                    newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
                    lines: [],
                };
                cur.hunks.push(curHunk);
            }
        } else if (curHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')) {
            const prefix = line.length === 0 ? ' ' : line[0];
            const content = line.length === 0 ? '' : line.slice(1);
            if (prefix === '+' || prefix === '-' || prefix === ' ') curHunk.lines.push({ op: prefix, text: content });
        }
    }
    return files;
}

function _applyHunk(lines, hunk, fuzz = 0) {
    const contextAndRem = hunk.lines.filter(l => l.op === ' ' || l.op === '-').map(l => l.text);
    if (contextAndRem.length === 0 && hunk.oldCount === 0) {
        const insertAt = Math.max(0, Math.min(hunk.oldStart - 1 + fuzz, lines.length));
        const additions = hunk.lines.filter(l => l.op === '+').map(l => l.text);
        return { ok: true, lines: [...lines.slice(0, insertAt), ...additions, ...lines.slice(insertAt)] };
    }

    const anchorLine = hunk.oldStart - 1;
    const searchRadius = fuzz * 3 + 3;
    const searchStart = Math.max(0, anchorLine - searchRadius);
    const searchEnd   = Math.min(lines.length - contextAndRem.length, anchorLine + searchRadius);

    let bestMatch = -1, bestScore = -1;
    for (let start = searchStart; start <= searchEnd; start++) {
        let matches = 0;
        for (let i = 0; i < contextAndRem.length; i++) {
            const actual = lines[start + i] || '';
            const expected = contextAndRem[i];
            if (actual === expected) matches++;
            else if (fuzz > 0 && actual.trim() === expected.trim()) matches += 0.8;
        }
        const score = matches / Math.max(contextAndRem.length, 1);
        if (score > bestScore) { bestScore = score; bestMatch = start; }
    }

    const threshold = fuzz === 0 ? 1.0 : 0.75;
    if (bestScore < threshold) {
        return {
            ok: false,
            reason: `Could not find context at ~line ${hunk.oldStart} (best match score ${(bestScore * 100).toFixed(0)}%). ` +
                `Expected first context line: "${contextAndRem[0] || '(empty)'}". ` +
                `Actual lines ${hunk.oldStart - 1}–${hunk.oldStart + 2}: ` +
                lines.slice(Math.max(0, hunk.oldStart - 1), hunk.oldStart + 3).map(l => JSON.stringify(l)).join(', '),
        };
    }

    let pos = bestMatch;
    const result = [...lines.slice(0, pos)];
    for (const hl of hunk.lines) {
        if      (hl.op === ' ') result.push(lines[pos++]);
        else if (hl.op === '-') pos++;
        else if (hl.op === '+') result.push(hl.text);
    }
    result.push(...lines.slice(pos));
    return { ok: true, lines: result };
}

async function toolApplyPatch(args) {
    const patch = String(args.patch || '').trim();
    if (!patch) return 'Error: patch is empty.';

    let fileDiffs;
    try { fileDiffs = _parsePatch(patch); }
    catch (e) { return `Error: failed to parse patch — ${e.message}`; }
    if (fileDiffs.length === 0) return 'Error: patch parsed to 0 file diffs. Check the diff format.';

    const report = [];
    let anyFailed = false;

    for (const fileDiff of fileDiffs) {
        const relPath = (fileDiff.newPath && fileDiff.newPath !== '/dev/null')
            ? fileDiff.newPath : fileDiff.oldPath;
        const absPath = resolvePath(relPath);
        if (!await ensurePathAllowed(absPath, 'write')) {
            report.push(`❌ ${relPath}: denied (outside workspace)`);
            anyFailed = true; continue;
        }

        let originalText = '';
        let hasCRLF = false;
        const isNewFile = !fs.existsSync(absPath);
        if (!isNewFile) {
            try { originalText = fs.readFileSync(absPath, 'utf8'); }
            catch (e) { report.push(`❌ ${relPath}: read error — ${e.message}`); anyFailed = true; continue; }
        }
        const norm = _normalizeLines(originalText);
        let lines = norm.lines; hasCRLF = norm.hasCRLF;
        if (lines.length > 0 && lines[lines.length - 1] === '' && originalText.endsWith('\n')) lines = lines.slice(0, -1);

        const hunkReports = [];
        let ok = true;
        for (let hi = 0; hi < fileDiff.hunks.length; hi++) {
            const hunk = fileDiff.hunks[hi];
            let result = _applyHunk(lines, hunk, 0);
            if (!result.ok) result = _applyHunk(lines, hunk, 1);
            if (!result.ok) result = _applyHunk(lines, hunk, 2);
            if (!result.ok) {
                hunkReports.push(`  Hunk ${hi + 1}/@@ -${hunk.oldStart},${hunk.oldCount}: ${result.reason}`);
                ok = false;
            } else {
                lines = result.lines;
                hunkReports.push(`  Hunk ${hi + 1}/@@ -${hunk.oldStart},${hunk.oldCount}: ✓`);
            }
        }

        if (!ok) {
            report.push(`❌ ${relPath}:`); report.push(...hunkReports);
            anyFailed = true; continue;
        }

        try {
            const parentDir = path.dirname(absPath);
            if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
            const trailingNewline = originalText.endsWith('\n') || isNewFile;
            let output = _restoreEndings(lines, hasCRLF);
            if (trailingNewline && !output.endsWith(hasCRLF ? '\r\n' : '\n')) output += hasCRLF ? '\r\n' : '\n';
            fs.writeFileSync(absPath, output, 'utf8');
            report.push(`✓ ${relPath}: ${fileDiff.hunks.length} hunk(s) applied`);
            report.push(...hunkReports);
        } catch (e) { report.push(`❌ ${relPath}: write error — ${e.message}`); anyFailed = true; }
    }

    const okCount = report.filter(r => r.startsWith('✓')).length;
    const summary = anyFailed
        ? `apply_patch: ${fileDiffs.length - okCount} file(s) failed. See details:\n`
        : `apply_patch: ${fileDiffs.length} file(s) patched successfully.\n`;
    return summary + report.join('\n');
}

module.exports = { toolWriteFile, toolStrReplaceInFile, toolApplyPatch };
