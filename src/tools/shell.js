// run_shell: execute a shell command with dangerous-command guard.
'use strict';

const cp     = require('child_process');
const vscode = require('vscode');

const { wsRoot } = require('../utils/paths');
const { t }      = require('../utils/i18n');
const { truncate } = require('./utils');

// ─── Dangerous-command detection ─────────────────────────────────────────────

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
    /\bmkfs\b/, /\bdd\s+if=/i, /\bshutdown\b/i, /\breboot\b/i,
    /\bnpm\s+publish\b/i,
    /\bcurl\b[^|]*\|\s*(sh|bash|pwsh|powershell)/i,
    /\biwr\b[^|]*\|\s*iex\b/i,
    /Invoke-Expression\b/i,
    /:\s*\(\)\s*\{.*:\|:&\s*\}/,
];

function isDangerous(cmd) {
    return DANGEROUS_PATTERNS.some(re => re.test(cmd));
}

async function confirmDangerous(cmd, abortSignal) {
    const dialog = vscode.window.showWarningMessage(
        `${t('dangerCmdTitle')}\n\n${cmd}`,
        { modal: true },
        t('dangerAllowOnce'),
        t('dangerDeny'),
    );
    if (!abortSignal) return (await dialog) === t('dangerAllowOnce');
    return new Promise((resolve) => {
        let settled = false;
        const onAbort = () => { if (settled) return; settled = true; resolve(false); };
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
        dialog.then(
            (choice) => {
                if (settled) return; settled = true;
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
                resolve(choice === t('dangerAllowOnce'));
            },
            () => { if (settled) return; settled = true; resolve(false); },
        );
    });
}

// ─── run_shell ───────────────────────────────────────────────────────────────

async function toolRunShell(args, ctx = {}) {
    try {
        const command = args.command || '';
        if (isDangerous(command)) {
            const allowed = await confirmDangerous(command, ctx.abortSignal);
            if (!allowed) return `${t('dangerBlocked')}\n\nCommand: ${command}`;
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
        const code   = r.status;
        if (code !== 0) return truncate(`Exit ${code}: ${stderr || stdout || '(no output)'}`);
        if (!stdout && !stderr) return '(no output, exit 0)';
        if (!stdout && stderr)  return truncate(`(stdout empty, exit 0)\n--- stderr ---\n${stderr}`);
        return truncate(stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout);
    } catch (e) { return `Error: ${e.message}`; }
}

module.exports = { toolRunShell, isDangerous };
