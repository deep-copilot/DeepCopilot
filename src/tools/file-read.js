// Read-only file tools: read_file, list_dir, grep_search, find_files.
// All use spawn (not shell) for external commands — injection-safe.
'use strict';

const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const vscode = require('vscode');

const { wsRoot, resolvePath } = require('../utils/paths');
const { t }                   = require('../utils/i18n');
const { truncate, ensurePathAllowed } = require('./utils');

// ─── ripgrep detection ───────────────────────────────────────────────────────

function detectRipgrep() {
    try {
        const probe = process.platform === 'win32' ? 'where' : 'which';
        cp.execFileSync(probe, ['rg'], { stdio: 'pipe' });
        return 'rg';
    } catch { return null; }
}
let _RG_CACHE = null;
function rgPath() {
    if (_RG_CACHE === null) _RG_CACHE = detectRipgrep() || '';
    return _RG_CACHE || null;
}

function runArgv(file, argv, opts = {}) {
    return cp.spawnSync(file, argv, {
        cwd: opts.cwd || wsRoot(),
        timeout: opts.timeout || 15000,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        shell: false,
    });
}

// ─── read_file ───────────────────────────────────────────────────────────────

async function toolReadFile(args) {
    try {
        const fp = resolvePath(args.path);
        if (!await ensurePathAllowed(fp, 'read')) return t('blockedOutsideWs');
        const text = fs.readFileSync(fp, 'utf8');
        if (args.start_line || args.end_line) {
            const lines = text.split('\n');
            const s = Math.max(0, (args.start_line || 1) - 1);
            const e = args.end_line || lines.length;
            return truncate(lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n'));
        }
        return truncate(text);
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── list_dir ────────────────────────────────────────────────────────────────

async function toolListDir(args) {
    try {
        const dp = resolvePath(args.path || '.');
        if (!await ensurePathAllowed(dp, 'read')) return t('blockedOutsideWs');
        const entries = fs.readdirSync(dp, { withFileTypes: true });
        return truncate(entries.map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n') || '(empty)');
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── grep_search (shell-injection-safe) ─────────────────────────────────────

async function toolGrepSearch(args) {
    try {
        const root = resolvePath(args.path || '.');
        if (!await ensurePathAllowed(root, 'read')) return t('blockedOutsideWs');
        const pattern = String(args.pattern || '');
        if (!pattern) return 'Error: pattern is required';

        const rg = rgPath();
        let r;
        if (rg) {
            const argv = ['--line-number', '--max-count', '10', '--max-filesize', '1M'];
            if (!args.is_regex) argv.push('--fixed-strings');
            if (args.include) argv.push('--glob', String(args.include));
            argv.push('--', pattern, root);
            r = runArgv(rg, argv);
        } else if (process.platform === 'win32') {
            const flags = args.is_regex ? ['/s', '/n', '/i', '/r'] : ['/s', '/n', '/i'];
            r = runArgv('findstr', flags.concat([`/c:${pattern}`, path.join(root, '*')]));
        } else {
            const argv = ['-rn', '--max-count=3'];
            if (!args.is_regex) argv.push('-F');
            if (args.include) argv.push(`--include=${args.include}`);
            argv.push('--', pattern, root);
            r = runArgv('grep', argv);
        }

        if (r.error) return `Error: ${r.error.message}`;
        const out = (r.stdout || '').trim();
        if (!out) return '(no matches)';
        return truncate(out.split(/\r?\n/).slice(0, 200).join('\n'));
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── find_files ──────────────────────────────────────────────────────────────

async function toolFindFiles(args) {
    try {
        const root = resolvePath(args.path || '.');
        if (!await ensurePathAllowed(root, 'read')) return t('blockedOutsideWs');
        const pattern = String(args.pattern || '*');
        const max     = Math.max(1, Math.min(500, Number(args.max) || 100));

        const rg = rgPath();
        if (rg) {
            const r = runArgv(rg, ['--files', '--glob', pattern, '--max-filesize', '4M', '--', root]);
            if (r.error) return `Error: ${r.error.message}`;
            const lines = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(0, max);
            return truncate(lines.join('\n') || '(no matches)');
        }
        try {
            const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', max);
            return truncate(uris.map(u => u.fsPath).join('\n') || '(no matches)');
        } catch (e) { return `Error: ${e.message}`; }
    } catch (e) { return `Error: ${e.message}`; }
}

module.exports = { toolReadFile, toolListDir, toolGrepSearch, toolFindFiles };
