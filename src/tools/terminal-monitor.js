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

// Subscribers notified when a deepseek-job-* terminal completes.
const _bgJobEndCallbacks = new Set();
function onBgJobEnded(cb)  { _bgJobEndCallbacks.add(cb); }
function offBgJobEnded(cb) { _bgJobEndCallbacks.delete(cb); }

// Active bg-job registry — populated by bg-shell.js on start, cleared here on end.
// Keyed by jobId; value is the sessionId that started the job.  Scoping by session
// prevents unrelated sessions from entering the bg-wait loop for someone else's job.
const _activeBgJobs = new Map(); // jobId → sessionId
function addActiveBgJob(jobId, sessionId) { _activeBgJobs.set(jobId, sessionId || null); }
// Returns all active job IDs across all sessions (used internally by cleanupStaleJobs).
function getActiveBgJobs() { return new Set(_activeBgJobs.keys()); }
// Returns job IDs owned by a specific session (used by agent-loop.js).
function getActiveBgJobsForSession(sessionId) {
    const jobs = new Set();
    for (const [jobId, sid] of _activeBgJobs) {
        if (sid === sessionId) jobs.add(jobId);
    }
    return jobs;
}

// Jobs whose end event was already consumed synchronously by the tool itself
// (e.g. bg-shell early-exit window). Agent-loop should skip these when
// injecting bg-job-end <system-reminder> blocks so the model doesn't see the
// same finish event twice. Entries auto-expire after 5 minutes.
const _syncReturnedJobs = new Map(); // jobId -> expiresAt
function markSyncReturnedJob(jobId) {
    if (!jobId) return;
    _syncReturnedJobs.set(jobId, Date.now() + 5 * 60_000);
}
function wasSyncReturned(jobId) {
    if (!jobId) return false;
    const exp = _syncReturnedJobs.get(jobId);
    if (!exp) return false;
    if (Date.now() > exp) { _syncReturnedJobs.delete(jobId); return false; }
    return true;
}
function _gcSyncReturnedJobs() {
    const now = Date.now();
    for (const [k, v] of _syncReturnedJobs) { if (now > v) _syncReturnedJobs.delete(k); }
}

/**
 * Returns a Promise that resolves with the next bg-job-end payload, or null
 * on timeout / abort.  Designed for agent-loop.js to `await` without spinning.
 *
 * @param {AbortSignal|null} signal  - AbortController signal to cancel the wait
 * @param {number} timeoutMs         - max wait in ms (default 15 s)
 * @param {string|null} sessionId    - when provided, only resolve for events from
 *                                     this session; events from other sessions are
 *                                     ignored so concurrent sessions don't
 *                                     contaminate each other's bg-wait loops.
 */
function waitForNextBgJobEvent(signal, timeoutMs = 15_000, sessionId = null) {
    return new Promise(resolve => {
        let settled = false;
        const done = (value) => {
            if (settled) return;
            settled = true;
            offBgJobEnded(onEvent);
            clearTimeout(timer);
            if (signal) try { signal.removeEventListener('abort', onAbort); } catch {}
            resolve(value);
        };
        const onEvent = (payload) => {
            // Cross-session guard: ignore events that belong to a different session.
            if (sessionId && payload && payload.sessionId !== sessionId) return;
            done(payload);
        };
        onBgJobEnded(onEvent);
        const timer = setTimeout(() => done(null), timeoutMs);
        const onAbort = () => done(null);
        if (signal) try { signal.addEventListener('abort', onAbort, { once: true }); } catch {}
    });
}

/**
 * Remove stale entries from _activeBgJobs.
 *
 * A job is considered stale when:
 *   a) Its terminal no longer exists in vscode.window.terminals (was closed
 *      without triggering onDidCloseTerminal — e.g. VS Code restart).
 *   b) Its terminal exists but the last buffered execution is no longer
 *      running (process exited but onDidEndTerminalShellExecution didn't fire).
 *
 * Fires callbacks with exitCode: null for each removed entry so that any
 * `await waitForNextBgJobEvent()` callers can unblock.
 *
 * Safe to call at any time; no-op if _activeBgJobs is empty.
 */
function cleanupStaleJobs() {
    if (_activeBgJobs.size === 0) return;
    const liveNames = new Set(
        [...(vscode.window.terminals || [])].map(t => t.name).filter(Boolean),
    );
    for (const jobId of [..._activeBgJobs.keys()]) {
        let stale = false;
        if (!liveNames.has(jobId)) {
            // Terminal no longer exists at all
            stale = true;
        } else {
            // Terminal exists — check if the last recorded execution already finished
            const t    = findTerminalByName(jobId);
            const list = t ? (_buffers.get(t) || []) : [];
            if (list.length > 0) {
                const last = list[list.length - 1];
                if (!last.running) {
                    stale = true; // ended without event
                } else if (last.startedAt && Date.now() - last.startedAt > 4 * 60 * 60_000) {
                    // Still flagged as running after 4 h — onDidEndTerminalShellExecution
                    // was dropped (VS Code shell integration reliability issue).
                    stale = true;
                }
            } else {
                // Terminal exists but has no buffered executions.  This can happen
                // when onDidStartTerminalShellExecution never fired (SI race) even
                // though addActiveBgJob was already called.  We cannot confirm the
                // job is still running, so treat it as stale to unblock the loop.
                stale = true;
            }
        }
        if (stale) {
            const sessionId = _activeBgJobs.get(jobId);
            _activeBgJobs.delete(jobId);
            const payload = { jobId, exitCode: null, output: '', durationMs: 0, stale: true, sessionId };
            for (const cb of _bgJobEndCallbacks) { try { cb(payload); } catch {} }
            try { Logger.info('BG_JOB_STALE_CLEANED', { jobId }); } catch {}
        }
    }
}

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
                truncated: false,
            };
            _push(terminal, rec);
            // Register execution → rec mapping for precise end-event lookup.
            if (execution) _execToRec.set(execution, rec);

            // Stream stdout/stderr into the record. read() yields strings.
            // Break immediately once the byte cap is reached — continuing to
            // iterate over a large stream wastes CPU with no benefit. Mark the
            // record as `truncated` so consumers (e.g. the wake-scheduler's
            // output_silent watcher) know the capture saturated and that a
            // subsequent lack of growth does NOT mean the job went quiet.
            try {
                const stream = execution.read();
                for await (const chunk of stream) {
                    const remain = MAX_BYTES_PER_EXECUTION - rec.output.length;
                    if (remain <= 0) { rec.truncated = true; break; }
                    const s = typeof chunk === 'string' ? chunk : String(chunk || '');
                    if (s.length > remain) { rec.output += s.slice(0, remain); rec.truncated = true; }
                    else { rec.output += s; }
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
                // Notify bg-job subscribers when a deepseek-job-* terminal completes.
                // Guard with .has() so only jobs we actually registered (with a known
                // sessionId) produce payloads — prevents orphan terminals from emitting
                // events with sessionId === undefined and leaking into other sessions.
                if (e.terminal.name && e.terminal.name.startsWith('deepseek-job-') &&
                    _activeBgJobs.has(e.terminal.name)) {
                    const sessionId = _activeBgJobs.get(e.terminal.name);
                    _activeBgJobs.delete(e.terminal.name);
                    const payload = {
                        jobId:      e.terminal.name,
                        exitCode:   rec.exitCode,
                        output:     rec.output.length > 2048 ? rec.output.slice(-2048) : rec.output,
                        durationMs: rec.endedAt - rec.startedAt,
                        sessionId,
                    };
                    for (const cb of _bgJobEndCallbacks) { try { cb(payload); } catch {} }
                }
            } catch { /* non-fatal */ }
        })
        : null;

    const closeSub = vscode.window.onDidCloseTerminal((terminal) => {
        try {
            // If a deepseek-job-* terminal is closed by the user before the process
            // ends naturally, onDidEndTerminalShellExecution will never fire.
            // Synthesise a completion event (exitCode: null = unknown) so that
            // agent-loop.js waitForNextBgJobEvent() can resolve and the loop exits.
            if (terminal.name && terminal.name.startsWith('deepseek-job-') && _activeBgJobs.has(terminal.name)) {
                const sessionId = _activeBgJobs.get(terminal.name);
                _activeBgJobs.delete(terminal.name);
                const list = _buffers.get(terminal) || [];
                const last = list[list.length - 1];
                const payload = {
                    jobId:      terminal.name,
                    exitCode:   null,
                    output:     last && last.output ? last.output.slice(-2048) : '',
                    durationMs: last ? Date.now() - last.startedAt : 0,
                    closedByUser: true,
                    sessionId,
                };
                for (const cb of _bgJobEndCallbacks) { try { cb(payload); } catch {} }
            }
            _buffers.delete(terminal);
            _terminalIds.delete(terminal);
        } catch {}
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
    onBgJobEnded,
    offBgJobEnded,
    addActiveBgJob,
    getActiveBgJobs,
    getActiveBgJobsForSession,
    waitForNextBgJobEvent,
    cleanupStaleJobs,
    markSyncReturnedJob,
    wasSyncReturned,
    MAX_EXECUTIONS_PER_TERMINAL,
    MAX_BYTES_PER_EXECUTION,
};
