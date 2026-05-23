// run_shell: execute a shell command with dangerous-command guard.
'use strict';

const cp     = require('child_process');
const vscode = require('vscode');

const { wsRoot } = require('../utils/paths');
const { t, tf }      = require('../utils/i18n');
const { truncate } = require('./utils');
const { Logger }   = require('../logger');

// Issue #89: Cache normalized danger-command approvals for the current
// extension session. Once the user grants "Allow once" (or `auto-edit`
// implicitly approves via this cache), the same command will not re-prompt
// inside the same session. Survives reloads but not a full VS Code restart.
const _dangerCmdApprovals = new Set();
function _normCmd(cmd) { return String(cmd || '').replace(/\s+/g, ' ').trim(); }

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
        // Issue #89: align dangerous-command gate with `approvalMode` /
        // `autoApproveTools`, matching `ensurePathAllowed()` semantics.
        // - autopilot           → silently allow + audit log (user granted blanket approval by choosing the mode)
        // - autoApproveTools ⊇ run_shell → silently allow (explicit opt-in)
        // - session cache hit   → silently allow (don't re-prompt for the same command in the same session)
        // - otherwise           → modal confirm (existing manual / auto-edit behavior)
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        const approvalMode    = cfg.get('approvalMode') || 'manual';
        const autoApproveTools = cfg.get('autoApproveTools') || [];
        const cacheKey = _normCmd(command);

        if (approvalMode === 'autopilot') {
            try { Logger.info('SHELL_DANGER_AUTO_APPROVE', { reason: 'autopilot', command }); } catch {}
            _dangerCmdApprovals.add(cacheKey);
        } else if (Array.isArray(autoApproveTools) && autoApproveTools.includes('run_shell')) {
            try { Logger.info('SHELL_DANGER_AUTO_APPROVE', { reason: 'autoApproveTools', command }); } catch {}
            _dangerCmdApprovals.add(cacheKey);
        } else if (!_dangerCmdApprovals.has(cacheKey)) {
            const allowed = await confirmDangerous(command, ctx.abortSignal);
            if (!allowed) return `${t('dangerBlocked')}\n\nCommand: ${command}`;
            _dangerCmdApprovals.add(cacheKey);
        }
    }

    const MAX_BUF       = 10 * 1024 * 1024;
    const MAX_TIMEOUT_MS = 1_800_000;                                       // 30 min hard cap (raised from 5 min — issue #122; for tasks > 30 min use run_shell_bg)
    const STALL_PROBE_MS = 15_000;                                          // heartbeat every 15s when no output
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
            // Don't kill the process — hand control back to the agent and let
            // the process continue running.  The agent should switch to
            // run_shell_bg for tasks expected to exceed the timeout, or use
            // read_terminal to poll the VS Code integrated terminal.
            const partialOut = stdoutBuf.replace(/\s+$/, '');
            const partialErr = stderrBuf.replace(/\s+$/, '');
            const silentSec  = Math.round((Date.now() - lastOutputAt) / 1000);
            try { Logger.info('SHELL_TIMEOUT_BACKGROUND', { pid: proc.pid ?? null, timeoutMs, silentSec, command }); } catch {}
            settle({
                command,
                exitCode:   null,
                stdout:     partialOut,
                stderr:     partialErr,
                truncated:  combinedSize >= MAX_BUF,
                background: true,
                pid:        proc.pid ?? null,
                text: truncate(
                    `[run_shell] Command still running after ${timeoutMs}ms — control handed back.\n` +
                    `PID: ${proc.pid ?? 'unknown'} | silent for: ${silentSec}s\n` +
                    `Tip: for tasks longer than ${Math.round(timeoutMs / 60000)} min, use run_shell_bg instead.\n` +
                    (partialOut ? `\n--- partial stdout ---\n${partialOut}` : '') +
                    (partialErr ? `\n--- partial stderr ---\n${partialErr}` : ''),
                ),
            });
            // Process keeps running; we simply stop tracking it here.
            // stdout/stderr listeners remain for pipe-drain but append() guards
            // on `settled` so no further buffering or streaming occurs.
        }, timeoutMs);

        // Stall heartbeat: when the process produces no output for STALL_PROBE_MS,
        // push a synthetic notice through onStreamDelta so the webview tail shows
        // "still alive but silent" and the user knows where things are stuck.
        // Only create the interval when there is a stream consumer; otherwise
        // we'd be waking the event loop with no observer.
        if (onStreamDelta) {
            let stallCount = 0; // emit at most 1 notice — purely "still alive" signal
            stallTimer = setInterval(() => {
                if (settled) return;
                const silentMs = Date.now() - lastOutputAt;
                if (silentMs >= STALL_PROBE_MS) {
                    if (stallCount >= 1) return; // only one notice per silent run
                    stallCount++;
                    try { onStreamDelta('\n' + tf('shellNoOutput', { sec: Math.round(silentMs / 1000) }) + '\n'); } catch {}
                } else {
                    stallCount = 0; // reset when output resumes
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
            // After settle() (e.g. timeout handed back control), drain the pipe
            // to prevent backpressure but stop buffering and streaming.
            if (settled) return;
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
            if (killedByAbort) return settle('Error: aborted by user');
            // Note: killedByTimeout is no longer used (timeout now hands back
            // control without killing).  If the process closes after timeout
            // already settled, `settle()` is a no-op.
            const exitCode = (code == null && signal) ? `signal:${signal}` : code;
            // Build backward-compatible text field (same as the old string return value).
            let text;
            if (exitCode !== 0) text = truncate(`Exit ${exitCode}: ${stderr || stdout || '(no output)'}`);
            else if (!stdout && !stderr) text = '(no output, exit 0)';
            else if (!stdout && stderr)  text = truncate(`(stdout empty, exit 0)\n--- stderr ---\n${stderr}`);
            else text = truncate(stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout);
            // Return structured result so the model can clearly inspect exitCode,
            // stdout, stderr independently.  `text` preserves the old merged string
            // for backward-compat with compact / session-restore flows.
            return settle({
                command,
                exitCode,
                stdout,
                stderr,
                truncated: combinedSize >= MAX_BUF,
                text,
            });
        });
    });
}

module.exports = { toolRunShell, isDangerous, confirmDangerous, _normCmd, _dangerCmdApprovals };
