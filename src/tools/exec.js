// Tool implementations: read_file / list_dir / grep_search / write_file /
// run_shell / str_replace_in_file / find_files.
//
// Hardening:
//  - All tool outputs go through `truncate(32K)` to bound context spend.
//  - All filesystem-touching tools enforce the workspace boundary
//    (override only via interactive user approval). This blocks the LLM
//    from reading ~/.ssh, writing system32, or escaping with ../..
//  - grep_search and find_files NEVER pass model-supplied strings through
//    a shell. We use child_process.spawn with an argv array so injection
//    via "; rm -rf ~" is impossible.
//  - run_shell still uses shell:true (necessary), but a regex blocklist
//    triggers a modal user confirm.
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const vscode = require('vscode');

const { wsRoot, resolvePath, isInsideWorkspace } = require('../utils/paths');
const { t } = require('../utils/i18n');

// ---------- output truncation ----------
const MAX_OUTPUT = 32000;

function truncate(text, max = MAX_OUTPUT) {
    if (typeof text !== 'string') text = String(text);
    if (text.length <= max) return text;
    const headLen = Math.floor(max * 0.6);
    const tailLen = Math.floor(max * 0.3);
    const head = text.slice(0, headLen);
    const tail = text.slice(text.length - tailLen);
    const dropped = text.length - headLen - tailLen;
    return `${head}\n\n... [${dropped} chars truncated] ...\n\n${tail}`;
}

// ---------- workspace boundary ----------
const _outsideWsApprovals = new Set();

async function ensurePathAllowed(absPath, intent /* 'read' | 'write' */) {
    if (isInsideWorkspace(absPath)) return true;
    if (_outsideWsApprovals.has(absPath)) return true;
    try {
        const choice = await vscode.window.showWarningMessage(
            `${t('pathOutsideWsConfirm')}\n\n${absPath}\n\n(${intent})`,
            { modal: true },
            t('dangerAllowOnce'),
            t('dangerDeny'),
        );
        if (choice === t('dangerAllowOnce')) {
            _outsideWsApprovals.add(absPath);
            return true;
        }
    } catch { /* fall through */ }
    return false;
}

// ---------- dangerous shell command gate ----------
const DANGEROUS_PATTERNS = [
    /\brm\s+-rf?\b/i,
    /\brmdir\s+\/s\b/i,
    /\bRemove-Item\b[^\n]*-Recurse/i,
    /\bdel\s+\/[fsq]/i,
    /\bgit\s+push\b[^\n]*--force\b/i,
    /\bgit\s+push\b[^\n]*\s-f(\s|$)/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-[fdx]+\b/i,
    /\bgit\s+branch\s+-D\b/i,
    /\bdrop\s+(table|database|schema)\b/i,
    /\btruncate\s+table\b/i,
    /\bmkfs\b/i, /\bdd\s+if=/i, /\bshutdown\b/i, /\breboot\b/i,
    /\bnpm\s+publish\b/i,
    /\bcurl\b[^|]*\|\s*(sh|bash|pwsh|powershell)/i,
    /\biwr\b[^|]*\|\s*iex\b/i,
    /Invoke-Expression\b/i,
    /:\s*\(\)\s*\{.*:\|:&\s*\}/,
];

function isDangerous(cmd) {
    return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}

async function confirmDangerous(cmd, abortSignal) {
    const dialog = vscode.window.showWarningMessage(
        `${t('dangerCmdTitle')}\n\n${cmd}`,
        { modal: true },
        t('dangerAllowOnce'),
        t('dangerDeny'),
    );
    if (!abortSignal) {
        return (await dialog) === t('dangerAllowOnce');
    }
    return new Promise((resolve) => {
        let settled = false;
        const onAbort = () => {
            if (settled) return;
            settled = true;
            resolve(false);
        };
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
        dialog.then(
            (choice) => {
                if (settled) return;
                settled = true;
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
                resolve(choice === t('dangerAllowOnce'));
            },
            () => {
                if (settled) return;
                settled = true;
                resolve(false);
            },
        );
    });
}

// ---------- helpers ----------

function detectRipgrep() {
    try {
        const probe = process.platform === 'win32' ? 'where' : 'which';
        cp.execFileSync(probe, ['rg'], { stdio: 'pipe' });
        return 'rg';
    } catch {
        return null;
    }
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

// ---------- read_file ----------

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

// ---------- list_dir ----------

async function toolListDir(args) {
    try {
        const dp = resolvePath(args.path || '.');
        if (!await ensurePathAllowed(dp, 'read')) return t('blockedOutsideWs');
        const entries = fs.readdirSync(dp, { withFileTypes: true });
        return truncate(entries.map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n') || '(empty)');
    } catch (e) { return `Error: ${e.message}`; }
}

// ---------- grep_search (shell-injection-safe) ----------

async function toolGrepSearch(args) {
    try {
        const root = resolvePath(args.path || '.');
        if (!await ensurePathAllowed(root, 'read')) return t('blockedOutsideWs');
        const pattern = String(args.pattern || '');
        if (!pattern) return 'Error: pattern is required';

        const rg = rgPath();
        let r;
        if (rg) {
            const argv = ['--line-number', '--max-count', '3', '--max-filesize', '1M'];
            if (!args.is_regex) argv.push('--fixed-strings');
            if (args.include) { argv.push('--glob', String(args.include)); }
            argv.push('--', pattern, root);
            r = runArgv(rg, argv);
        } else if (process.platform === 'win32') {
            const flags = args.is_regex ? ['/s', '/n', '/i', '/r'] : ['/s', '/n', '/i'];
            const argv = flags.concat([`/c:${pattern}`, path.join(root, '*')]);
            r = runArgv('findstr', argv);
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
        const lines = out.split(/\r?\n/).slice(0, 50);
        return truncate(lines.join('\n'));
    } catch (e) { return `Error: ${e.message}`; }
}

// ---------- find_files ----------

async function toolFindFiles(args) {
    try {
        const root = resolvePath(args.path || '.');
        if (!await ensurePathAllowed(root, 'read')) return t('blockedOutsideWs');
        const pattern = String(args.pattern || '*');
        const max = Math.max(1, Math.min(500, Number(args.max) || 100));

        const rg = rgPath();
        if (rg) {
            const argv = ['--files', '--glob', pattern, '--max-filesize', '4M', '--', root];
            const r = runArgv(rg, argv);
            if (r.error) return `Error: ${r.error.message}`;
            const lines = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(0, max);
            return truncate(lines.join('\n') || '(no matches)');
        }
        try {
            const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', max);
            const lines = uris.map(u => u.fsPath);
            return truncate(lines.join('\n') || '(no matches)');
        } catch (e) {
            return `Error: ${e.message}`;
        }
    } catch (e) { return `Error: ${e.message}`; }
}

// ---------- write_file ----------

async function toolWriteFile(args) {
    try {
        const fp = resolvePath(args.path);
        if (!await ensurePathAllowed(fp, 'write')) return t('blockedOutsideWs');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, args.content, 'utf8');
        return `OK: wrote ${args.content.length} chars to ${args.path}`;
    } catch (e) { return `Error: ${e.message}`; }
}

// ---------- str_replace_in_file ----------

async function toolStrReplaceInFile(args) {
    try {
        const fp = resolvePath(args.path);
        if (!await ensurePathAllowed(fp, 'write')) return t('blockedOutsideWs');
        const oldStr = String(args.old_string ?? '');
        const newStr = String(args.new_string ?? '');
        if (!oldStr) return 'Error: old_string is required and must not be empty.';
        const text = fs.readFileSync(fp, 'utf8');
        const expected = Math.max(1, Number(args.expected_replacements) || 1);

        let count = 0;
        let idx = 0;
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
        for (const at of indices) {
            updated += text.slice(cursor, at) + newStr;
            cursor = at + oldStr.length;
        }
        updated += text.slice(cursor);

        fs.writeFileSync(fp, updated, 'utf8');
        const delta = updated.length - text.length;
        return `OK: ${count} replacement(s) in ${args.path} (${delta >= 0 ? '+' : ''}${delta} chars).`;
    } catch (e) { return `Error: ${e.message}`; }
}

// ---------- run_shell ----------

async function toolRunShell(args, ctx = {}) {
    try {
        const command = args.command || '';
        if (isDangerous(command)) {
            const allowed = await confirmDangerous(command, ctx.abortSignal);
            if (!allowed) {
                return `${t('dangerBlocked')}\n\nCommand: ${command}`;
            }
        }
        const r = cp.spawnSync(command, [], {
            cwd: wsRoot(),
            timeout: args.timeout_ms || 30000,
            encoding: 'utf8',
            shell: true,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        });
        if (r.error) return `Error: ${r.error.message}`;
        const stdout = (r.stdout || '').replace(/\s+$/, '');
        const stderr = (r.stderr || '').replace(/\s+$/, '');
        const code = r.status;
        if (code !== 0) {
            const body = stderr || stdout || '(no output)';
            return truncate(`Exit ${code}: ${body}`);
        }
        if (!stdout && !stderr) return '(no output, exit 0)';
        if (!stdout && stderr)  return truncate(`(stdout empty, exit 0)\n--- stderr ---\n${stderr}`);
        return truncate(stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout);
    } catch (e) { return `Error: ${e.message}`; }
}

// ---------- web_search (Tavily) ----------
//
// Uses Node's built-in https — no npm dependency. The Tavily API key must
// be stored in VS Code SecretStorage under 'deepseekAgent.tavilyKey'.
// Endpoint: https://api.tavily.com/search

const https = require('https');

function _tavilyRequest(payload, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = https.request({
            method: 'POST',
            hostname: 'api.tavily.com',
            path: '/search',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: timeoutMs,
        }, (res) => {
            let chunks = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`Tavily HTTP ${res.statusCode}: ${chunks.slice(0, 500)}`));
                }
                try { resolve(JSON.parse(chunks)); }
                catch (e) { reject(new Error(`Tavily JSON parse failed: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('Tavily request timeout')); });
        req.write(body);
        req.end();
    });
}

async function toolWebSearch(args, ctx = {}) {
    try {
        const query = String(args.query || '').trim();
        if (!query) return 'Error: query is empty.';

        const secrets = ctx && ctx.secrets;
        if (!secrets) return 'Error: SecretStorage unavailable (internal).';
        const apiKey = await secrets.get('deepseekAgent.tavilyKey');
        if (!apiKey) {
            return 'Error: Tavily API key not configured. Run command "Deep Copilot: Set Tavily API Key" (or 飞 Tavily 官方 https://app.tavily.com 注册免费 1000 次/月)，然后重试。';
        }

        const max = Math.max(1, Math.min(10, Number.isFinite(args.max_results) ? args.max_results : 5));
        const depth = (args.search_depth === 'advanced') ? 'advanced' : 'basic';
        const includeAnswer = (args.include_answer !== false);

        const payload = {
            api_key: apiKey,
            query,
            max_results: max,
            search_depth: depth,
            include_answer: includeAnswer,
            include_raw_content: false,
            include_images: false,
        };

        const data = await _tavilyRequest(payload);

        const lines = [];
        lines.push(`Query: ${query}`);
        if (includeAnswer && data.answer) {
            lines.push('');
            lines.push('## Synthesized answer');
            lines.push(data.answer);
        }
        const results = Array.isArray(data.results) ? data.results : [];
        if (results.length === 0) {
            lines.push('');
            lines.push('(No results.)');
        } else {
            lines.push('');
            lines.push(`## Top ${results.length} result(s)`);
            results.forEach((r, i) => {
                const title = (r.title || '(no title)').replace(/\s+/g, ' ').trim();
                const url = r.url || '';
                const snippet = (r.content || '').replace(/\s+/g, ' ').trim();
                lines.push('');
                lines.push(`### ${i + 1}. ${title}`);
                if (url) lines.push(url);
                if (snippet) lines.push(snippet);
            });
        }
        return truncate(lines.join('\n'));
    } catch (e) {
        return `Error: ${e.message || String(e)}`;
    }
}

module.exports = {
    toolReadFile,
    toolListDir,
    toolGrepSearch,
    toolFindFiles,
    toolWriteFile,
    toolStrReplaceInFile,
    toolRunShell,
    toolWebSearch,
    truncate,
    isDangerous,
};
