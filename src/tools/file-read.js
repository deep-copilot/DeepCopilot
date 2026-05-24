// Read-only file tools: read_file, list_dir, grep_search, find_files.
// All use spawn (not shell) for external commands — injection-safe.
'use strict';

const fs       = require('fs');
const path     = require('path');
const cp       = require('child_process');
const readline = require('readline');
const vscode   = require('vscode');

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

// ─── Large-file helpers ───────────────────────────────────────────────────────

const MAX_DIRECT_READ  = 10 * 1024 * 1024; // 10 MB  — above this, use streaming
const MAX_OUTPUT_CHARS = 32000;             // matches truncate() default

/**
 * Stream-read only the requested line range — safe for files of any size.
 * Uses Node readline so it never loads the full file into memory.
 * The read is always O(end_line) in time but O(output size) in memory.
 */
function readLineRangeStreamed(fp, startLine, endLine) {
    const s = Math.max(0, (startLine || 1) - 1);
    const e = (endLine != null) ? endLine : Infinity;

    return new Promise((resolve, reject) => {
        let stream;
        try { stream = fs.createReadStream(fp, { encoding: 'utf8' }); }
        catch (err) { return reject(err); }

        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        let lineNum  = 0;
        const lines  = [];
        let outChars = 0;
        let capped   = false;

        const close = () => {
            try { if (!rl.closed) rl.close(); } catch {}
            try { if (!stream.destroyed) stream.destroy(); } catch {}
        };

        rl.on('line', (line) => {
            if (capped) return;
            if (lineNum >= s && lineNum < e) {
                const entry = `${lineNum + 1}: ${line}`;
                outChars += entry.length + 1;
                if (outChars > MAX_OUTPUT_CHARS) {
                    capped = true;
                    lines.push(`\n... [output capped at ${MAX_OUTPUT_CHARS} chars — narrow the range] ...`);
                    close();
                    return;
                }
                lines.push(entry);
            }
            lineNum++;
            if (lineNum >= e) close();
        });

        rl.on('close', () => resolve(lines.join('\n') || '(empty range)'));
        rl.on('error', reject);
        stream.on('error', reject);
    });
}

/**
 * Sample the first 64 KB to estimate total line count and detect binary files.
 * Returns { lines: number|null, binary: boolean }
 */
function estimateLineCount(fp, fileSize) {
    const SAMPLE = 65536;
    let fd;
    try {
        fd = fs.openSync(fp, 'r');
        const buf = Buffer.alloc(SAMPLE);
        const n   = fs.readSync(fd, buf, 0, SAMPLE, 0);
        if (n === 0) return { lines: 0, binary: false };
        // Binary detection: any null byte in the sample
        for (let i = 0; i < n; i++) if (buf[i] === 0) return { lines: null, binary: true };
        const sample  = buf.slice(0, n).toString('utf8');
        const nlCount = (sample.match(/\n/g) || []).length;
        if (nlCount === 0) return { lines: 1, binary: false }; // no newlines found
        const avgLineBytes = n / nlCount;
        return { lines: Math.round(fileSize / avgLineBytes), binary: false };
    } catch { return { lines: null, binary: false }; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// ─── read_file ───────────────────────────────────────────────────────────────

async function toolReadFile(args) {
    try {
        const fp = resolvePath(args.path);
        if (!await ensurePathAllowed(fp, 'read')) return t('blockedOutsideWs');

        let stat;
        try { stat = fs.statSync(fp); } catch { /* will fail below on readFileSync */ }

        const fileSize = stat ? stat.size : 0;
        const isLarge  = fileSize > MAX_DIRECT_READ;
        const hasRange = !!(args.start_line || args.end_line);

        // ── Large file + line range: stream, never load full file ────────
        if (isLarge && hasRange) {
            return await readLineRangeStreamed(fp, args.start_line, args.end_line);
        }

        // ── Large file, no range: return a structured plan for the agent ─
        if (isLarge && !hasRange) {
            const mb  = (fileSize / 1024 / 1024).toFixed(1);
            const { lines: estLines, binary } = estimateLineCount(fp, fileSize);

            if (binary) {
                return [
                    `[large-binary-file] ${path.basename(fp)} — ${mb} MB`,
                    ``,
                    `This appears to be a binary/non-text file. Strategies:`,
                    `  • grep_search — ripgrep handles binary files gracefully (text patterns)`,
                    `  • Describe the expected binary format so the agent can plan a hex/struct approach.`,
                ].join('\n');
            }

            const lineStr   = estLines != null ? `~${estLines.toLocaleString()} lines` : 'line count unknown';
            const N_AGENTS  = 8;
            const chunkSize = estLines ? Math.ceil(estLines / N_AGENTS) : null;
            const chunkHint = chunkSize
                ? Array.from({ length: N_AGENTS }, (_, i) => {
                      const sl = i * chunkSize + 1;
                      const el = (i + 1) * chunkSize;
                      return `    agent ${i + 1}: start_line=${sl} end_line=${el}`;
                  }).join('\n')
                : `    read_file path="${args.path}" start_line=1 end_line=50000  (then increment)`;

            return [
                `[large-file] ${path.basename(fp)} — ${mb} MB | ${lineStr}`,
                ``,
                `File is too large for a single read. Recommended strategies:`,
                ``,
                `1. grep_search — find specific content without reading the whole file:`,
                `   grep_search pattern="keyword" path="${args.path}"`,
                ``,
                `2. Read a specific range (streaming, no OOM risk at any file size):`,
                `   read_file path="${args.path}" start_line=1 end_line=1000`,
                ``,
                `3. Parallel sub-agents via spawn_agent (fastest for full coverage):`,
                `   Spawn ${N_AGENTS} agents, each reading a chunk of ${chunkSize ? chunkSize.toLocaleString() : '?'} lines:`,
                chunkHint,
                `   Each sub-agent summarises its chunk; main agent aggregates.`,
            ].join('\n');
        }

        // ── Normal path (file ≤ 10 MB) ────────────────────────────────────
        const text = fs.readFileSync(fp, 'utf8');
        if (args.start_line || args.end_line) {
            const lines = text.split('\n');
            const s = Math.max(0, (args.start_line || 1) - 1);
            const e = args.end_line || lines.length;
            return truncate(lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n'));
        }
        // Issue #142 P2-4: nudge the model toward sub-agents / ranged reads
        // for medium-large files that would otherwise burn a lot of context.
        if (fileSize > 50 * 1024) {
            const kb = Math.round(fileSize / 1024);
            const hint = `\n\n[hint] this file is ${kb} KB — consider \`spawn_agent\` (agent_type=explore) for analysis, or \`read_file\` with start_line/end_line to read a focused range, to save context.`;
            // Reserve hint length in the truncate budget so the combined output
            // still fits in MAX_OUTPUT_CHARS (Copilot review feedback).
            return truncate(text, MAX_OUTPUT_CHARS - hint.length) + hint;
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

// ─── get_diagnostics ────────────────────────────────────────────────────────

async function toolGetDiagnostics(args) {
    const sevName = s => ['Error', 'Warning', 'Info', 'Hint'][s] || 'Info';
    const lines = [];
    let totalErr = 0, totalWarn = 0;

    if (args && args.path) {
        let abs;
        try { abs = resolvePath(args.path); } catch (e) { return `Error: ${e.message}`; }
        const uri  = vscode.Uri.file(abs);
        const diags = vscode.languages.getDiagnostics(uri) || [];
        const filt  = diags.filter(d =>
            d.severity === vscode.DiagnosticSeverity.Error ||
            d.severity === vscode.DiagnosticSeverity.Warning);
        if (!filt.length) return `No errors or warnings found in ${args.path}.`;
        lines.push(`- ${args.path}:`);
        for (const d of filt) {
            const ln  = (d.range && d.range.start && d.range.start.line + 1) || '?';
            const src = d.source ? `[${d.source}] ` : '';
            const msg = String(d.message || '').replace(/\s+/g, ' ').slice(0, 200);
            if (d.severity === vscode.DiagnosticSeverity.Error) totalErr++;
            else totalWarn++;
            lines.push(`  L${ln} ${sevName(d.severity)}: ${src}${msg}`);
        }
    } else {
        const all = vscode.languages.getDiagnostics();
        for (const [uri, diags] of all) {
            const filt = diags.filter(d =>
                d.severity === vscode.DiagnosticSeverity.Error ||
                d.severity === vscode.DiagnosticSeverity.Warning).slice(0, 10);
            if (!filt.length) continue;
            const rel = vscode.workspace.asRelativePath(uri);
            lines.push(`- ${rel}:`);
            for (const d of filt) {
                const ln  = (d.range && d.range.start && d.range.start.line + 1) || '?';
                const src = d.source ? `[${d.source}] ` : '';
                const msg = String(d.message || '').replace(/\s+/g, ' ').slice(0, 200);
                if (d.severity === vscode.DiagnosticSeverity.Error) totalErr++;
                else totalWarn++;
                lines.push(`  L${ln} ${sevName(d.severity)}: ${src}${msg}`);
            }
        }
        if (!lines.length) return 'No errors or warnings found in workspace.';
    }
    return [`diagnostics: ${totalErr} error(s), ${totalWarn} warning(s)`, ...lines].join('\n');
}

module.exports = { toolReadFile, toolListDir, toolGrepSearch, toolFindFiles, toolGetDiagnostics };
