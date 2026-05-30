// Wake-scheduler: registers declarative "watchers" that auto-resume an agent
// session when a condition fires (bg-job end, output match, output silent,
// time elapsed, or a `first_of` composition). The model uses the `watch` +
// `yield_turn` tools to declare these; the scheduler owns lifecycle, polling,
// rate-limiting, and routing the trigger evidence back through Provider.autoResume.
//
// Scope notes (v1, intentional simplifications):
//   - In-memory only; watchers do NOT survive an extension reload (logged as
//     SCHEDULER_VOLATILE_WARN on register).
//   - Fixed 5s poll interval (no exponential backoff yet).
//   - Rate limit is a flat per-hour cap per session (default 12, configurable
//     via deepseekAgent.autoResumeMaxPerHour).
//   - No quiet-hours / file-changed / port-open conditions in v1.
'use strict';

const vscode = require('vscode');
const { Logger } = require('../logger');
const {
    onBgJobEnded,
    offBgJobEnded,
    findTerminalByName,
    getRecentExecutions,
} = require('../tools/terminal-monitor');
const { buildDigest } = require('./digest');

let _provider = null;
const _watchers = new Map();    // watcherId -> Watcher
const _bySession = new Map();   // sessionId -> Set<watcherId>
const _resumeHistory = new Map(); // sessionId -> [timestamps]
let _seq = 0;

const MAX_WATCHERS_PER_SESSION = 8;
const POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_RESUMES_PER_HOUR = 12;
// Trailing window kept from a job's joined output on each poll tick. Bounds the
// per-tick allocation (was up to ~1.28MB) since only recent output is scanned.
const MAX_OUTPUT_TAIL = 200 * 1024;
// Size of the trailing slice used as an activity signature. Once the joined
// output saturates MAX_OUTPUT_TAIL its length stops growing, so _pollOutput
// compares this tail slice to detect output that is still moving, and uses it
// as the regex haystack in that capped case.
const TAIL_SIG_BYTES = 4 * 1024;

function attach(provider) { _provider = provider; }
function isAttached() { return !!_provider; }

function _maxResumesPerHour() {
    try {
        const v = vscode.workspace
            .getConfiguration('deepseekAgent')
            .get('autoResumeMaxPerHour');
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RESUMES_PER_HOUR;
    } catch { return DEFAULT_MAX_RESUMES_PER_HOUR; }
}

function _newId() { return `w_${Date.now().toString(36)}_${(++_seq).toString(36)}`; }

function _flattenLeaves(cond) {
    if (!cond) return [];
    if (cond.kind === 'first_of' && Array.isArray(cond.any)) {
        return cond.any.flatMap(_flattenLeaves);
    }
    return [cond];
}

function _checkRateLimit(sessionId) {
    const now = Date.now();
    const hist = _resumeHistory.get(sessionId) || [];
    const cutoff = now - 3600_000;
    const recent = hist.filter(t => t > cutoff);
    _resumeHistory.set(sessionId, recent);
    return recent.length < _maxResumesPerHour();
}

function _recordResume(sessionId) {
    const hist = _resumeHistory.get(sessionId) || [];
    hist.push(Date.now());
    _resumeHistory.set(sessionId, hist);
}

// Milliseconds until the session frees a rate-limit slot, i.e. when the
// oldest in-window resume ages past the 1-hour cutoff. Used to re-arm a
// throttled watcher instead of dropping it. Floored at 1s.
function _msUntilRateSlot(sessionId) {
    const hist = (_resumeHistory.get(sessionId) || []).slice().sort((a, b) => a - b);
    const max = _maxResumesPerHour();
    if (hist.length < max) return 1000;
    const idx = hist.length - max; // oldest timestamp that must expire
    const freeAt = hist[idx] + 3600_000;
    return Math.max(1000, freeAt - Date.now() + 100);
}

function _arm(w) {
    const conds = _flattenLeaves(w.spec.condition);
    const pollNeeded = conds.some(c =>
        c.kind === 'output_match' || c.kind === 'output_silent' || c.kind === 'progress_at',
    );
    const bgEndJobs = new Set(
        conds.filter(c => c.kind === 'job_end' && c.job).map(c => c.job),
    );

    for (const c of conds) {
        if (c.kind === 'time_elapsed') {
            // Round (not bitwise-truncate) so fractional seconds behave
            // predictably and large values aren't mangled by 32-bit coercion
            // (e.g. 5.9s → 6s, not 5s; 86400s stays 86400s).
            const ms = Math.max(1000, Math.round(Number(c.seconds) || 0) * 1000);
            const t = setTimeout(() => _fire(w, { kind: 'time_elapsed' }), ms);
            w._timers.push(t);
        }
    }

    if (bgEndJobs.size) {
        const handler = (ev) => {
            if (!ev || !bgEndJobs.has(ev.jobId)) return;
            _fire(w, {
                kind: 'job_end',
                jobId: ev.jobId,
                exitCode: ev.exitCode,
                duration: ev.durationMs,
                output: ev.output,
            });
        };
        onBgJobEnded(handler);
        w._offBgEnd = () => offBgJobEnded(handler);
    }

    if (pollNeeded) {
        const poll = setInterval(() => _pollOutput(w, conds), POLL_INTERVAL_MS);
        w._poll = poll;
    }
}

function _readJobOutput(jobId) {
    const term = findTerminalByName(jobId);
    if (!term) return null;
    const recs = getRecentExecutions(term, 20);
    let text = recs.map(r => r.output || '').join('\n');
    // Tail-cap the joined text: up to 20×64KB (~1.28MB) is re-allocated on every
    // poll tick per watcher (5s × up to 8 watchers/session). Downstream logic
    // (regex checks + digest builder) only needs recent output, so keep just the
    // trailing window. Truncation is reported separately below, so dropping the
    // head here does not lose the saturation signal.
    if (text.length > MAX_OUTPUT_TAIL) text = text.slice(-MAX_OUTPUT_TAIL);
    return {
        text,
        // True when the most-recent execution saturated the capture cap
        // (terminal-monitor stops appending past MAX_BYTES_PER_EXECUTION).
        // Its captured output then stops growing even though the job keeps
        // emitting — so a flat length must NOT be read as "went silent".
        truncated: recs.length > 0 && !!recs[recs.length - 1].truncated,
    };
}

function _pollOutput(w, conds) {
    if (w.firedAt) return;
    for (const c of conds) {
        if (!c.job) continue;
        const res = _readJobOutput(c.job);
        if (res == null) continue;
        const out = res.text;

        const prevLen = w._lastSeenLen.get(c.job) || 0;
        // Signature of the trailing window. Once the joined output saturates
        // MAX_OUTPUT_TAIL, out.length stops growing even while fresh lines slide
        // through the tail — so a length delta alone misses ongoing activity.
        // Comparing the tail content catches that "capped but still moving" case.
        const tailSig = out.length > TAIL_SIG_BYTES ? out.slice(-TAIL_SIG_BYTES) : out;
        const prevSig = w._lastTailSig.get(c.job);
        const grew = out.length > prevLen;
        const shrank = out.length < prevLen;
        const tailChanged = prevSig !== undefined && tailSig !== prevSig;
        const newSlice = grew ? out.slice(prevLen) : '';
        if (grew || shrank || tailChanged) {
            // Any of: more bytes, buffer shrank/reset (ring-buffer drop or job
            // restart), or the tail content moved while length was capped — all
            // count as activity, so re-baseline length+signature and refresh the
            // idle clock to keep output_silent from firing spuriously.
            w._lastSeenLen.set(c.job, out.length);
            w._lastTailSig.set(c.job, tailSig);
            w._lastOutputChangeAt.set(c.job, Date.now());
        }

        if (c.kind === 'output_match' && c.regex) {
            try {
                const re = new RegExp(c.regex, c.flags || 'i');
                // When length is capped but the tail moved, newSlice is empty —
                // fall back to scanning the recent tail so matches still fire.
                const hay = newSlice || (tailChanged ? tailSig : '');
                if (re.test(hay) || (prevLen === 0 && re.test(out))) {
                    return _fire(w, {
                        kind: 'output_match',
                        jobId: c.job,
                        regex: c.regex,
                        output: out,
                        lastSeenLen: prevLen,
                    });
                }
            } catch (e) {
                Logger.info('WATCHER_REGEX_ERROR', { id: w.id, regex: c.regex, error: e.message });
            }
        } else if (c.kind === 'output_silent' && c.seconds) {
            // When the capture saturated (hit the byte cap) the output length
            // freezes even though the job is still chatty — treat that as
            // "still active", keep the idle clock fresh, and do NOT fire.
            if (res.truncated) {
                w._lastOutputChangeAt.set(c.job, Date.now());
                continue;
            }
            const last = w._lastOutputChangeAt.get(c.job) || w.createdAt;
            if (Date.now() - last > Number(c.seconds) * 1000) {
                return _fire(w, {
                    kind: 'output_silent',
                    jobId: c.job,
                    idleSec: Math.round((Date.now() - last) / 1000),
                    output: out,
                    lastSeenLen: prevLen,
                });
            }
        } else if (c.kind === 'progress_at' && c.regex) {
            try {
                const re = new RegExp(c.regex, c.flags || 'i');
                const hay = newSlice || (tailChanged ? tailSig : '');
                if (hay && re.test(hay)) {
                    return _fire(w, {
                        kind: 'progress_at',
                        jobId: c.job,
                        output: out,
                        lastSeenLen: prevLen,
                    });
                }
            } catch (e) {
                Logger.info('WATCHER_REGEX_ERROR', { id: w.id, regex: c.regex, error: e.message });
            }
        }
    }
}

function _cleanupWatcher(w) {
    for (const t of w._timers || []) { try { clearTimeout(t); } catch {} }
    w._timers = [];
    if (w._poll) { try { clearInterval(w._poll); } catch {} w._poll = null; }
    if (w._offBgEnd) { try { w._offBgEnd(); } catch {} w._offBgEnd = null; }
    _watchers.delete(w.id);
    const set = _bySession.get(w.sessionId);
    if (set) {
        set.delete(w.id);
        if (!set.size) _bySession.delete(w.sessionId);
    }
}

function _fire(w, evidence) {
    if (w.firedAt) return;

    // Check the rate limit BEFORE committing (firedAt) and BEFORE cleanup.
    // Previously the watcher was torn down first and only then rate-checked,
    // so a throttled wake permanently destroyed the watcher — leaving the
    // suspended session with nothing left to ever resume it. Instead, keep
    // the watcher armed and re-arm a retry for when a slot frees up.
    if (!_checkRateLimit(w.sessionId)) {
        const retryMs = _msUntilRateSlot(w.sessionId);
        Logger.info('WATCHER_RATE_LIMITED', {
            sessionId: w.sessionId,
            id: w.id,
            trigger: evidence.kind,
            retryMs,
        });
        w._timers = w._timers || [];
        w._timers.push(setTimeout(() => _fire(w, evidence), retryMs));
        return;
    }

    w.firedAt = Date.now();
    _cleanupWatcher(w);
    _recordResume(w.sessionId);

    const digest = buildDigest({
        trigger: evidence.kind,
        watcherId: w.id,
        watcherDesc: w.spec.description || '',
        jobId: evidence.jobId,
        exitCode: evidence.exitCode,
        durationMs: evidence.duration,
        output: evidence.output || '',
        lastSeenLen: evidence.lastSeenLen,
    });

    Logger.info('WATCHER_FIRED', {
        sessionId: w.sessionId,
        id: w.id,
        trigger: evidence.kind,
        digestLen: digest.length,
    });

    if (_provider && typeof _provider.autoResume === 'function') {
        try {
            _provider.autoResume(w.sessionId, {
                watcherId: w.id,
                trigger: evidence.kind,
                digest,
            });
        } catch (e) {
            Logger.info('WATCHER_AUTORESUME_ERROR', { id: w.id, error: e.message });
        }
    } else {
        Logger.info('WATCHER_NO_PROVIDER', { id: w.id });
    }
}

function registerWatcher(sessionId, spec) {
    if (!sessionId) return { ok: false, error: 'sessionId required' };
    if (!spec || !spec.condition) return { ok: false, error: 'spec.condition required' };

    const existing = _bySession.get(sessionId) || new Set();
    if (existing.size >= MAX_WATCHERS_PER_SESSION) {
        return {
            ok: false,
            error: `Max ${MAX_WATCHERS_PER_SESSION} active watchers per session — cancel one first.`,
        };
    }

    const id = _newId();
    const w = {
        id,
        sessionId,
        spec,
        createdAt: Date.now(),
        firedAt: null,
        _timers: [],
        _poll: null,
        _offBgEnd: null,
        _lastSeenLen: new Map(),
        _lastTailSig: new Map(),
        _lastOutputChangeAt: new Map(),
    };
    _watchers.set(id, w);
    existing.add(id);
    _bySession.set(sessionId, existing);

    try { _arm(w); }
    catch (e) {
        _cleanupWatcher(w);
        Logger.info('WATCHER_ARM_ERROR', { id, error: e.message });
        return { ok: false, error: `arming failed: ${e.message}` };
    }

    Logger.info('WATCHER_REGISTERED', {
        sessionId, id,
        condition: spec.condition,
        description: spec.description || '',
    });
    Logger.info('SCHEDULER_VOLATILE_WARN', { id });
    return { ok: true, watcherId: id };
}

function cancel(sessionId, watcherId) {
    if (!watcherId) return false;
    const w = _watchers.get(watcherId);
    if (!w || w.sessionId !== sessionId) return false;
    _cleanupWatcher(w);
    return true;
}

function cancelAll(sessionId) {
    const set = _bySession.get(sessionId);
    if (!set) return 0;
    let n = 0;
    for (const id of [...set]) { if (cancel(sessionId, id)) n++; }
    return n;
}

function listActive(sessionId) {
    const set = _bySession.get(sessionId);
    if (!set) return [];
    return [...set].map(id => {
        const w = _watchers.get(id);
        return {
            id,
            createdAt: w.createdAt,
            condition: w.spec.condition,
            description: w.spec.description || '',
        };
    });
}

module.exports = {
    attach,
    isAttached,
    registerWatcher,
    cancel,
    cancelAll,
    listActive,
};
