// Tools exposed to the model for the "watch + yield" auto-resume primitive.
//
//   watch(condition, description?)  — register a trigger, return a watcherId
//   yield_turn(reason)              — end the current agent turn cleanly
//
// Typical usage:
//   1. run_shell_bg(...)  → returns jobId
//   2. watch({ condition: { kind: 'first_of', any: [
//        { kind: 'job_end', job: jobId },
//        { kind: 'output_match', job: jobId, regex: 'OOM|nan|Traceback' },
//        { kind: 'output_silent', job: jobId, seconds: 600 },
//        { kind: 'time_elapsed', seconds: 1800 }       // safety bound
//      ]}})
//   3. yield_turn({ reason: 'training ~30min, will resume on completion or anomaly' })
//
// The session auto-resumes when any condition fires; wake-scheduler builds a
// digest from the job output and Provider.autoResume re-enters agent-loop.
'use strict';

const scheduler = require('../chat/wake-scheduler');

const VALID_KINDS = new Set([
    'time_elapsed',
    'job_end',
    'output_match',
    'output_silent',
    'progress_at',
    'first_of',
]);

function _validateCondition(cond, depth = 0) {
    if (!cond || typeof cond !== 'object') return 'condition must be an object';
    if (depth > 3) return 'condition nesting too deep (max depth 3)';
    if (!VALID_KINDS.has(cond.kind)) {
        return `invalid condition kind "${cond.kind}" — valid: ${[...VALID_KINDS].join(', ')}`;
    }
    if (cond.kind === 'first_of') {
        if (!Array.isArray(cond.any) || cond.any.length === 0) {
            return 'first_of requires a non-empty `any` array';
        }
        if (cond.any.length > 6) return 'first_of supports at most 6 sub-conditions';
        for (const c of cond.any) {
            const e = _validateCondition(c, depth + 1);
            if (e) return e;
        }
    } else if (cond.kind === 'time_elapsed') {
        const s = Number(cond.seconds);
        if (!Number.isFinite(s) || s < 5 || s > 86400) {
            return 'time_elapsed.seconds must be a number in [5, 86400]';
        }
    } else if (cond.kind === 'job_end') {
        if (!cond.job || typeof cond.job !== 'string') return 'job_end requires `job` (string)';
    } else if (cond.kind === 'output_match' || cond.kind === 'progress_at') {
        if (!cond.job || typeof cond.job !== 'string') return `${cond.kind} requires \`job\` (string)`;
        if (!cond.regex || typeof cond.regex !== 'string') return `${cond.kind} requires \`regex\` (string)`;
        try { new RegExp(cond.regex, cond.flags || 'i'); }
        catch (e) { return `invalid regex: ${e.message}`; }
    } else if (cond.kind === 'output_silent') {
        if (!cond.job || typeof cond.job !== 'string') return 'output_silent requires `job` (string)';
        const s = Number(cond.seconds);
        if (!Number.isFinite(s) || s < 30 || s > 86400) {
            return 'output_silent.seconds must be a number in [30, 86400]';
        }
    }
    return null;
}

function _hasTimeBound(cond) {
    if (!cond) return false;
    if (cond.kind === 'time_elapsed') return true;
    if (cond.kind === 'first_of') return (cond.any || []).some(_hasTimeBound);
    return false;
}

async function toolWatch(args, run) {
    if (!args || !args.condition) {
        return JSON.stringify({ ok: false, error: '`condition` is required' });
    }
    const err = _validateCondition(args.condition);
    if (err) return JSON.stringify({ ok: false, error: err });
    if (!_hasTimeBound(args.condition)) {
        return JSON.stringify({
            ok: false,
            error: 'condition MUST include a `time_elapsed` safety bound (directly or inside `first_of`). Wrap your existing condition in `first_of` and add `{ kind: "time_elapsed", seconds: N }` so the session cannot get stuck forever.',
        });
    }
    if (!run || !run.sessionId) {
        return JSON.stringify({ ok: false, error: 'no active session context' });
    }
    if (!scheduler.isAttached()) {
        return JSON.stringify({ ok: false, error: 'wake-scheduler not attached (extension init issue)' });
    }
    const result = scheduler.registerWatcher(run.sessionId, {
        condition: args.condition,
        description: typeof args.description === 'string' ? args.description : '',
    });
    if (!result.ok) return JSON.stringify(result);
    return JSON.stringify({
        ok: true,
        watcherId: result.watcherId,
        message: 'Watcher armed. Call `yield_turn` next to release this turn — the session will auto-resume when any condition fires.',
    });
}

async function toolYieldTurn(args, run) {
    if (!run) return JSON.stringify({ ok: false, error: 'no active run context' });
    const reason = (args && typeof args.reason === 'string') ? args.reason : 'yielding turn';

    run._yieldCount = (run._yieldCount || 0) + 1;
    if (run._yieldCount > 6) {
        return JSON.stringify({
            ok: false,
            error: 'too many consecutive yields in this turn (>6). Produce a normal user-facing reply or escalate to the user; do not yield again.',
        });
    }

    const active = scheduler.listActive(run.sessionId) || [];
    if (!active.length) {
        return JSON.stringify({
            ok: false,
            error: 'no active watchers registered for this session — call `watch(...)` first, otherwise yielding would suspend the session forever.',
        });
    }

    run._yieldRequested = {
        reason,
        at: Date.now(),
        watcherIds: active.map(w => w.id),
    };
    return JSON.stringify({
        ok: true,
        suspended: true,
        reason,
        activeWatchers: active.length,
        message: `Turn yielded — ${active.length} watcher(s) armed. Conversation will auto-resume when any condition fires.`,
    });
}

module.exports = { toolWatch, toolYieldTurn };
