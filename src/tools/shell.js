// run_shell: execute a shell command with dangerous-command guard.
'use strict';

const cp     = require('child_process');
const vscode = require('vscode');

const { wsRoot } = require('../utils/paths');
const { t, tf }      = require('../utils/i18n');
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
//
// Streams stdout/stderr chunks via ctx.onStreamDelta(delta) as they arrive,
// enabling the webview to render a live tail of the running command
// (GitHub Copilot terminal-card convention).  Returns the final combined
// output string (truncated) just like the original spawnSync implementation.

async function toolRunShell(args, ctx = {}) {
    const command = args.command || '';
    if (isDangerous(command)) {
        const allowed = await confirmDangerous(command, ctx.abortSignal);
        if (!allowed) return `${t('dangerBlocked')}\n\nCommand: ${command}`;
    }

    const MAX_BUF       = 10 * 1024 * 1024;
    const MAX_TIMEOUT_MS = 300_000;                                         // 5 min hard cap — issue #69
    const STALL_PROBE_MS = 15_000;                                          // heartbeat every 15s when no output
    const KILL_GRACE_MS  = 5_000;                                           // SIGTERM → SIGKILL grace period — issue #69 follow-up
    // Normalize args.timeout_ms: tolerate strings, NaN, negatives, etc.
    // Falls back to 30000ms default, clamps to (0, MAX_TIMEOUT_MS].
    const requestedRaw = Number(args.timeout_ms);
    const requestedTimeout = (Number.isFinite(requestedRaw) && requestedRaw > 0)
        ? requestedRaw
        : 30000;
    const timeoutMs     = Math.min(requestedTimeout, MAX_TIMEOUT_MS);
    const onStreamDelta = typeof ctx.onStreamDelta === 'function' ? ctx.onStreamDelta : null;
    const abortSignal   = ctx.abortSignal;

    return new Promise((resolve) => {
        let proc;
        try {
            proc = cp.spawn(command, [], {
                cwd: wsRoot(),
                shell: true,
                windowsHide: true,
                env: process.env,
            });
        } catch (e) { return resolve(`Error: ${e.message}`); }

        let stdoutBuf = '';
        let stderrBuf = '';
        let combinedSize = 0;
        let killedByTimeout = false;
        let killedByAbort   = false;
        let settled         = false;
        let lastOutputAt    = Date.now();                                   // for stall heartbeat — issue #69
        // Declared up-front so settle() can safely reference it even if
        // settle() is invoked before the interval is assigned. Stays null
        // when onStreamDelta is absent (no consumer → no point waking up).
        let stallTimer      = null;

        const settle = (val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (stallTimer) clearInterval(stallTimer);
            if (abortSignal && onAbort) {
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
            }
            resolve(val);
        };

        const timer = setTimeout(() => {
            killedByTimeout = true;
            try { proc.kill('SIGTERM'); } catch {}
            // If the process ignores SIGTERM (or kill() failed), escalate
            // to SIGKILL after a short grace period and force-settle so
            // run_shell can never hang indefinitely.
            setTimeout(() => {
                if (settled) return;
                try { proc.kill('SIGKILL'); } catch {}
                // Last-resort settle in case 'close' never fires.
                setTimeout(() => {
                    if (!settled) settle(truncate(`Error: command timed out after ${timeoutMs}ms and did not terminate after SIGTERM+SIGKILL`));
                }, 1000);
            }, KILL_GRACE_MS);
        }, timeoutMs);

        // Stall heartbeat: when the process produces no output for STALL_PROBE_MS,
        // push a synthetic notice through onStreamDelta so the webview tail shows
        // "still alive but silent" and the user knows where things are stuck.
        // Only create the interval when there is a stream consumer; otherwise
        // we'd be waking the event loop with no observer.
        if (onStreamDelta) {
            stallTimer = setInterval(() => {
                if (settled) return;
                const silentMs = Date.now() - lastOutputAt;
                if (silentMs >= STALL_PROBE_MS) {
                    try { onStreamDelta('\n' + tf('shellNoOutput', { sec: Math.round(silentMs / 1000) }) + '\n'); } catch {}
                }
            }, STALL_PROBE_MS);
        }

        const onAbort = () => {
            killedByAbort = true;
            try { proc.kill('SIGTERM'); } catch {}
        };
        if (abortSignal) {
            if (abortSignal.aborted) onAbort();
            else abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        const append = (which, chunk) => {
            const txt = chunk.toString('utf8');
            if (combinedSize + txt.length > MAX_BUF) {
                // truncate hard once we exceed buffer; keep reading silently
                if (which === 'out') stdoutBuf += txt.slice(0, Math.max(0, MAX_BUF - combinedSize));
                else                  stderrBuf += txt.slice(0, Math.max(0, MAX_BUF - combinedSize));
                combinedSize = MAX_BUF;
            } else {
                if (which === 'out') stdoutBuf += txt;
                else                  stderrBuf += txt;
                combinedSize += txt.length;
            }
            lastOutputAt = Date.now();
            if (onStreamDelta) {
                try { onStreamDelta(txt); } catch {}
            }
        };

        proc.stdout && proc.stdout.on('data', (c) => append('out', c));
        proc.stderr && proc.stderr.on('data', (c) => append('err', c));

        proc.on('error', (err) => settle(`Error: ${err.message}`));

        proc.on('close', (code, signal) => {
            const stdout = stdoutBuf.replace(/\s+$/, '');
            const stderr = stderrBuf.replace(/\s+$/, '');
            if (killedByAbort)   return settle('Error: aborted by user');
            if (killedByTimeout) {
                const silentMs = Date.now() - lastOutputAt;
                const stallNote = silentMs >= STALL_PROBE_MS
                    ? '\n' + tf('shellSilentTimeout', { sec: Math.round(silentMs / 1000) })
                    : '';
                return settle(truncate(`Error: command timed out after ${timeoutMs}ms${stallNote}\n${stdout}${stderr ? '\n--- stderr ---\n' + stderr : ''}`));
            }
            const exitCode = (code == null && signal) ? `signal:${signal}` : code;
            if (exitCode !== 0) return settle(truncate(`Exit ${exitCode}: ${stderr || stdout || '(no output)'}`));
            if (!stdout && !stderr) return settle('(no output, exit 0)');
            if (!stdout && stderr)  return settle(truncate(`(stdout empty, exit 0)\n--- stderr ---\n${stderr}`));
            return settle(truncate(stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout));
        });
    });
}

module.exports = { toolRunShell, isDangerous };
