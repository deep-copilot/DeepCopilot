// run_shell_bg: launch a long-running command in a named VS Code integrated
// terminal and return immediately.  The caller (agent) polls progress via
// read_terminal(terminal: jobId).  Designed for model training, long builds,
// and other tasks that outlast run_shell's hard timeout.
//
// Design notes:
//   - Terminal name = "deepseek-job-<seq>" — stable, unique, poll-able.
//   - terminal-monitor.js already subscribes to shell-integration events, so
//     read_terminal() works out-of-the-box once the terminal is created.
//   - Dangerous-command gate reused from shell.js (same session cache).
'use strict';

const vscode = require('vscode');

const { t }                                              = require('../utils/i18n');
const { Logger }                                         = require('../logger');
const { isDangerous, confirmDangerous, _normCmd,
        _dangerCmdApprovals }                            = require('./shell');

let _jobSeq = 0;

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
    const jobId = `deepseek-job-${++_jobSeq}`;
    let terminal;
    try {
        terminal = vscode.window.createTerminal({ name: jobId });
    } catch (e) {
        return JSON.stringify({ error: 'terminal_create_failed', message: e.message });
    }

    // Show the terminal panel but don't steal editor focus (preserveFocus=true).
    terminal.show(/* preserveFocus */ true);
    terminal.sendText(command);

    try {
        Logger.info('BG_SHELL_START', { jobId, command });
    } catch {}

    return JSON.stringify({
        jobId,
        terminalName: jobId,
        status: 'running',
        hint: [
            `Background job "${jobId}" started.`,
            `Poll output : read_terminal(terminal: "${jobId}")`,
            `When "running" becomes false the job has finished and you can read the exit code.`,
            `To cancel    : ask the user to close the terminal named "${jobId}".`,
        ].join('\n'),
    });
}

module.exports = { toolRunShellBg };
