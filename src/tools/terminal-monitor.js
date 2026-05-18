// Terminal shell-execution monitor.
//
// Issue #99: the model needs to read the user's integrated-terminal output
// on demand (not via run_shell, which spawns its own child process). This
// module subscribes to VS Code's stable shell-integration events and keeps
// a small in-memory ring buffer per terminal so `read_terminal` can serve
// requests without re-running anything.
//
// Privacy: buffers live only in memory; nothing is persisted to disk.
// On extension deactivate (or stop()) all state is cleared.
'use strict';

const vscode = require('vscode');
const { Logger } = require('../logger');

// Per-terminal cap (most recent N executions kept) and per-execution byte cap.
const MAX_EXECUTIONS_PER_TERMINAL = 20;
const MAX_BYTES_PER_EXECUTION     = 64 * 1024;

// terminalId (string, derived from Terminal object identity) -> Execution[]
//   { id, command, cwd, exitCode, startedAt, endedAt, output, running }
const _buffers      = new WeakMap();  // Terminal   -> Execution[]
const _execToRec    = new WeakMap();  // TerminalShellExecution -> rec  (for precise end-event matching)
const _terminalIds  = new WeakMap();  // Terminal   -> stable string id
let   _idSeq = 0;

let _disposables = [];
let _started = false;

function _terminalId(terminal) {
    let id = _terminalIds.get(terminal);
    if (!id) {
        _idSeq += 1;
        id = `t${_idSeq}`;
        _terminalIds.set(terminal, id);
    }
    return id;
}

function _isEnabled() {
    try {
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        return cfg.get('terminal.captureHistory', true) !== false;
    } catch { return true; }
}

function _push(terminal, execution) {
    let list = _buffers.get(terminal);
    if (!list) { list = []; _buffers.set(terminal, list); }
    list.push(execution);
    while (list.length > MAX_EXECUTIONS_PER_TERMINAL) list.shift();
}

function start(context) {
    if (_started) return;
    _started = true;

    // onDidStartTerminalShellExecution is stable since VS Code 1.93.
    // Older runtimes simply lack the event — degrade silently.
    if (typeof vscode.window.onDidStartTerminalShellExecution !== 'function') {
        Logger.info('TERMINAL_MONITOR_UNAVAILABLE', { reason: 'no shellIntegration events' });
        return;
    }

    const startSub = vscode.window.onDidStartTerminalShellExecution(async (e) => {
        if (!_isEnabled()) return;
        try {
            const terminal  = e.terminal;
            const execution = e.execution;
            const cmdLine   = (execution && execution.commandLine && execution.commandLine.value) || '';
            const cwd       = execution && execution.cwd && execution.cwd.fsPath ? execution.cwd.fsPath : '';
            const rec = {
                id:        ++_idSeq,
                command:   String(cmdLine || ''),
                cwd,
                exitCode:  null,
                startedAt: Date.now(),
                endedAt:   null,
                output:    '',
                running:   true,
            };
            _push(terminal, rec);
            // Register execution → rec mapping for precise end-event lookup.
            if (execution) _execToRec.set(execution, rec);

            // Stream stdout/stderr into the record. read() yields strings.
            // Break immediately once the byte cap is reached — continuing to
            // iterate over a large stream wastes CPU with no benefit.
            try {
                const stream = execution.read();
                for await (const chunk of stream) {
                    const remain = MAX_BYTES_PER_EXECUTION - rec.output.length;
                    if (remain <= 0) break;
                    const s = typeof chunk === 'string' ? chunk : String(chunk || '');
                    rec.output += s.length > remain ? s.slice(0, remain) : s;
                }
            } catch (err) {
                Logger.info('TERMINAL_MONITOR_READ_ERROR', { message: String(err && err.message || err) });
            }
        } catch (err) {
            Logger.info('TERMINAL_MONITOR_START_ERROR', { message: String(err && err.message || err) });
        }
    });

    const endSub = (typeof vscode.window.onDidEndTerminalShellExecution === 'function')
        ? vscode.window.onDidEndTerminalShellExecution((e) => {
            try {
                // Prefer WeakMap lookup for O(1) exact match; fall back to
                // "most-recent running" for robustness against edge cases where
                // the execution object differs (e.g. proxy wrapping).
                let rec = e.execution ? _execToRec.get(e.execution) : null;
                if (!rec) {
                    const list = _buffers.get(e.terminal);
                    if (!list || !list.length) return;
                    for (let i = list.length - 1; i >= 0; i--) {
                        if (list[i].running) { rec = list[i]; break; }
                    }
                }
                if (!rec) return;
                rec.running  = false;
                rec.endedAt  = Date.now();
                rec.exitCode = typeof e.exitCode === 'number' ? e.exitCode : null;
                if (e.execution) try { _execToRec.delete(e.execution); } catch {}
            } catch { /* non-fatal */ }
        })
        : null;

    const closeSub = vscode.window.onDidCloseTerminal((terminal) => {
        try { _buffers.delete(terminal); _terminalIds.delete(terminal); } catch {}
    });

    _disposables.push(startSub);
    if (endSub)   _disposables.push(endSub);
    _disposables.push(closeSub);

    if (context && Array.isArray(context.subscriptions)) {
        for (const d of _disposables) context.subscriptions.push(d);
    }
    Logger.info('TERMINAL_MONITOR_STARTED', {});
}

function stop() {
    for (const d of _disposables) { try { d.dispose(); } catch {} }
    _disposables = [];
    _started = false;
}

/**
 * Return the most-recent executions for a specific terminal, or for the
 * active terminal when `terminal` is null/undefined. Newest last.
 *
 * @param {vscode.Terminal|null} terminal
 * @param {number} lastN
 * @returns {Array<{id:number,command:string,cwd:string,exitCode:?number,startedAt:number,endedAt:?number,output:string,running:boolean,terminalName:string,terminalId:string}>}
 */
function getRecentExecutions(terminal, lastN = 3) {
    const t = terminal || vscode.window.activeTerminal;
    if (!t) return [];
    const list = _buffers.get(t) || [];
    const n = Math.max(1, Math.min(MAX_EXECUTIONS_PER_TERMINAL, lastN | 0 || 3));
    const slice = list.slice(-n);
    return slice.map(r => ({
        ...r,
        terminalName: t.name || '',
        terminalId:   _terminalId(t),
    }));
}

/**
 * Find a terminal by display name. Returns null if no match.
 */
function findTerminalByName(name) {
    if (!name) return null;
    for (const t of vscode.window.terminals) {
        if (t.name === name) return t;
    }
    // Case-insensitive fallback
    const lc = String(name).toLowerCase();
    for (const t of vscode.window.terminals) {
        if (t.name && t.name.toLowerCase() === lc) return t;
    }
    return null;
}

function listTerminals() {
    return vscode.window.terminals.map(t => ({
        name:    t.name || '',
        id:      _terminalId(t),
        active:  t === vscode.window.activeTerminal,
        hasShellIntegration: !!t.shellIntegration,
    }));
}

module.exports = {
    start,
    stop,
    getRecentExecutions,
    findTerminalByName,
    listTerminals,
    MAX_EXECUTIONS_PER_TERMINAL,
    MAX_BYTES_PER_EXECUTION,
};
