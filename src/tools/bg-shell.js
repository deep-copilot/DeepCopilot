// run_shell_bg: launch a long-running command in a named VS Code integrated
// terminal and return immediately.  The caller (agent) polls progress via
// read_terminal(terminal: jobId).  Designed for model training, long builds,
// and other tasks that outlast run_shell's hard timeout.
//
// Design notes:
//   - Terminal name = "deepseek-job-<seq>" — stable, unique, poll-able.
//   - When VS Code shell integration is available (pwsh/bash/zsh/fish), the
//     command is launched via shellIntegration.executeCommand() so that
//     terminal-monitor.js receives start/output/end events automatically.
//     Falls back to sendText() on shells without integration.
//   - Dangerous-command gate reused from shell.js (same session cache).
'use strict';

const vscode = require('vscode');

const { t }                                              = require('../utils/i18n');
const { Logger }                                         = require('../logger');
const { isDangerous, confirmDangerous, _normCmd,
        _dangerCmdApprovals }                            = require('./shell');
const { addActiveBgJob, onBgJobEnded, offBgJobEnded, markSyncReturnedJob } = require('./terminal-monitor');

let _jobSeq = 0;

// On Windows the integrated terminal defaults to PowerShell, which does not
// support bash-style && chaining.  Automatically convert && → ; so that
// commands like `cd path && python train.py` work without the model needing
// to know the shell dialect.  The semantic difference (conditional vs
// unconditional) is acceptable for typical cd/build/train sequences.
function _adaptCommandForShell(command) {
    if (process.platform === 'win32') {
        return command.replace(/\s*&&\s*/g, '; ');
    }
    return command;
}

// Return a terminal name that doesn't collide with any currently open terminal.
// _jobSeq is incremented until a name is free, so after a reload it won't
// accidentally pick the same id as a terminal the user already has open.
function _uniqueJobId() {
    const existing = new Set((vscode.window.terminals || []).map(t => t.name));
    let id;
    do {
        id = `deepseek-job-${++_jobSeq}`;
    } while (existing.has(id));
    return id;
}

async function toolRunShellBg(args, ctx = {}) {
    const command = (args.command || '').trim();
    if (!command) return JSON.stringify({ error: 'empty_command', hint: 'Provide a non-empty command.' });

    // ── Dangerous-command gate (mirrors shell.js logic) ──────────────────
    if (isDangerous(command)) {
        const cfg             = vscode.workspace.getConfiguration('deepseekAgent');
        const approvalMode    = cfg.get('approvalMode') || 'manual';
        const autoApproveTools = cfg.get('autoApproveTools') || [];
        const cacheKey        = _normCmd(command);

        if (approvalMode === 'autopilot') {
            try { Logger.info('BG_SHELL_DANGER_AUTO_APPROVE', { reason: 'autopilot', command }); } catch {}
            _dangerCmdApprovals.add(cacheKey);
        } else if (Array.isArray(autoApproveTools) && autoApproveTools.includes('run_shell_bg')) {
            try { Logger.info('BG_SHELL_DANGER_AUTO_APPROVE', { reason: 'autoApproveTools', command }); } catch {}
            _dangerCmdApprovals.add(cacheKey);
        } else if (!_dangerCmdApprovals.has(cacheKey)) {
            const allowed = await confirmDangerous(command, ctx.abortSignal);
            if (!allowed) return JSON.stringify({ error: 'blocked', hint: `${t('dangerBlocked')}\n\nCommand: ${command}` });
            _dangerCmdApprovals.add(cacheKey);
        }
    }

    // ── Create named terminal and send the command ────────────────────────
    const jobId = _uniqueJobId();
    const adaptedCommand = _adaptCommandForShell(command);
    const cwdPath = (args.cwd || '').trim() || undefined;
    let terminal;
    try {
        terminal = vscode.window.createTerminal({ name: jobId, cwd: cwdPath });
    } catch (e) {
        return JSON.stringify({ error: 'terminal_create_failed', message: e.message });
    }

    // Show the terminal panel but don't steal editor focus (preserveFocus=true).
    terminal.show(/* preserveFocus */ true);

    // Prefer shellIntegration.executeCommand() over sendText() so that
    // terminal-monitor.js can track the full process lifecycle (start / output
    // stream / exit code).  Shell integration may not be ready immediately after
    // createTerminal(), so we wait up to SI_WAIT_MS for it to initialise.
    const SI_WAIT_MS = 3000;
    let siReady = !!terminal.shellIntegration;
    if (!siReady && typeof vscode.window.onDidChangeTerminalShellIntegration === 'function') {
        siReady = await new Promise(resolve => {
            const d = vscode.window.onDidChangeTerminalShellIntegration(e => {
                if (e.terminal === terminal) { d.dispose(); resolve(true); }
            });
            setTimeout(() => { d.dispose(); resolve(false); }, SI_WAIT_MS);
        });
    }

    const usedSI = siReady && !!terminal.shellIntegration;
    if (usedSI) {
        terminal.shellIntegration.executeCommand(adaptedCommand);
    } else {
        terminal.sendText(adaptedCommand);
    }

    try {
        Logger.info('BG_SHELL_START', { jobId, command: adaptedCommand, shellIntegration: usedSI });
    } catch {}

    // Register in active-job tracker so agent-loop.js can keep the loop alive
    // until this job completes (removed automatically by terminal-monitor when
    // onDidEndTerminalShellExecution fires).
    // IMPORTANT: only register when shell integration is in use — without SI,
    // onDidEndTerminalShellExecution never fires and the job would never be
    // removed, causing agent-loop to spin indefinitely.
    if (usedSI) {
        addActiveBgJob(jobId, ctx.sessionId || null);
        // Issue #167: tell agent-loop this jobId was started in THIS run, so
        // its BG_WAIT_SKIPPED_MODEL_DONE early-exit guard refuses to end the
        // turn while the freshly spawned job is still alive.
        try { ctx.registerBgJob && ctx.registerBgJob(jobId); } catch {}
    }

    // ── Early-failure capture: many commands fail within ~1–2 s (missing
    //    executable, bad cwd, import error, syntax error). If we return
    //    {status:'running'} immediately, the model only sees the failure on
    //    the next turn via injected bg-job-end events, which feels like the
    //    agent "slacked off" between submit and discovery. So we briefly
    //    block here: if the SI end event fires within EARLY_WAIT_MS, fold
    //    the real exit code + tail output into the synchronous tool result.
    if (usedSI) {
        const EARLY_WAIT_MS = 2500;
        const earlyResult = await new Promise(resolve => {
            let settled = false;
            const done = (payload) => {
                if (settled) return;
                settled = true;
                offBgJobEnded(handler);
                clearTimeout(timer);
                resolve(payload);
            };
            const handler = (p) => { if (p && p.jobId === jobId) done(p); };
            onBgJobEnded(handler);
            const timer = setTimeout(() => done(null), EARLY_WAIT_MS);
        });

        if (earlyResult) {
            // Job finished inside the early window — return the actual result
            // synchronously so the model sees the failure on this very turn.
            markSyncReturnedJob(jobId); // suppress duplicate <system-reminder>
            const exitCode  = earlyResult.exitCode;
            const tailOut   = earlyResult.output || '';
            const durSec    = Math.round((earlyResult.durationMs || 0) / 1000);
            const tooFast   = (earlyResult.durationMs || 0) < EARLY_WAIT_MS;
            const isFailure = exitCode !== 0 && exitCode !== null;
            try {
                Logger.info('BG_SHELL_EARLY_EXIT', { jobId, exitCode, durSec, isFailure });
            } catch {}
            return JSON.stringify({
                jobId,
                terminalName: jobId,
                status: isFailure ? 'failed' : 'completed',
                exitCode,
                durationSec: durSec,
                output: tailOut,
                earlyExit: true,
                hint: isFailure
                    ? `Job "${jobId}" exited with code ${exitCode} in ${durSec}s. Diagnose the error from the output above before retrying.`
                    : `Job "${jobId}" finished cleanly in ${durSec}s.${tooFast ? ' (very quick — verify it actually did the intended work)' : ''}`,
            });
        }
    }

    return JSON.stringify({
        jobId,
        terminalName: jobId,
        status: 'running',
        shellIntegrationAvailable: usedSI,
        // Issue #167: the previous hint promised the agent it would be
        // "automatically woken when this job ends" and instructed it to
        // "simply end your turn". That contract was incomplete — the agent
        // loop used to break out of its wait the moment the model produced
        // ANY closing sentence, leaving the just-spawned job orphaned. The
        // loop now refuses to end while one of this run's own bg jobs is
        // still alive, so the model MUST stay on duty. We restate the
        // contract honestly here to discourage the model from emitting
        // pseudo-completion messages like "I'll tell you when it's done".
        hint: [
            `Background job "${jobId}" started.`,
            usedSI
                ? [
                    `Shell integration active — agent-loop will KEEP YOU ON DUTY until this job ends.`,
                    `You CANNOT close this turn by saying "I'll let you know later": the loop ignores any such promise while this job is alive and will re-invoke you with the real exit code + tail output as a <system-reminder> when the process exits.`,
                    `CRITICAL: do NOT call ping, sleep, Start-Sleep, or any wait/poll command — it wastes time and blocks failure detection.`,
                    `CRITICAL: do NOT call read_terminal now — the system delivers the final result automatically. Either narrate genuine progress, or stay silent until you receive the end-of-job system-reminder.`,
                  ].join('\n')
                : [
                    `Shell integration unavailable — agent-loop CANNOT track this job's exit automatically; you must poll manually:`,
                    `  1. Wait: run_shell(command: "ping -n 16 127.0.0.1 > nul")  ← ~15 s pause on Windows`,
                    `  2. Check: read_terminal(terminal: "${jobId}")`,
                    `  Output shows "[exit N]" or "[finished]" when done; "[running]" means still active.`,
                    `Do NOT tell the user "I'll notify you when it's done" in this branch — there is no automatic notification.`,
                  ].join('\n'),
            `To cancel: ask the user to close the terminal named "${jobId}".`,
        ].join('\n'),
    });
}

module.exports = { toolRunShellBg };
