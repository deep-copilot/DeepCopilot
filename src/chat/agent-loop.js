// AgentLoop: the agentic while-loop that drives each turn.
//
// Receives its dependencies via constructor (dependency-injection) so the
// loop itself is decoupled from the webview, session storage, and tool layer.
// provider.js wires everything together at startup.
'use strict';

const vscode = require('vscode');

const path                 = require('path');
const { Logger }           = require('../logger');
const { friendlyError }    = require('../errors');
const { computeCost }      = require('../pricing');
const { buildSystemPrompt }= require('../prompts/system');
const { streamChat } = require('../api/adapter');
const { getProvider, getModel, resolveModel } = require('../providers');
const { getToolDefs }      = require('../tools/schema');
const { mcpManager }       = require('../mcp');
const { isZh }             = require('../utils/i18n');
const {
    estimateMessagesTokens, autoCompactIfNeeded, nuclearCompact, ToolArgsStreamer,
} = require('./compact');
const { _dropOrphanToolCallGroups } = require('./session-store');
const {
    onBgJobEnded, offBgJobEnded,
    getActiveBgJobsForSession, waitForNextBgJobEvent,
    cleanupStaleJobs, findTerminalByName, getRecentExecutions, wasSyncReturned,
} = require('../tools/terminal-monitor');

// ─── Skill injection helper (Issue #61 — Step 3) ─────────────────────────────
//
// Appends a synthetic `read_file` tool_call + tool_result pair to `messages`.
// Used by:
//   1. UI slash-command path (handleSend's `skillContent` parameter), and
//   2. the `skill_invoke` tool (Issue #61 — Step 4), so an agent-initiated
//      skill load looks identical to a user-initiated one.
//
// Each call uses a unique tool_call_id (`synthetic_skill_read_<rand>`) so
// nested or repeated skill loads in the same turn do not collide.
//
// @param {Array<{role:string, content:*}>} messages - run.messages array to push into
// @param {string}   skillName - human-readable skill name for the path
// @param {string}   body      - skill body (SKILL.md contents)
// @param {string}   [skillPath] - real on-disk SKILL.md path; if omitted,
//                                 falls back to the default deepcopilot dir.
//                                 Pass the real path so the model sees the
//                                 correct origin (e.g. ~/.claude/skills/...).
function injectSyntheticSkillRead(messages, skillName, body, skillPath) {
    const safeName = String(skillName || 'skill').replace(/[^a-z0-9-]/gi, '-');
    // Issue #94: never emit a literal "~/..." path — it cannot be re-resolved
    // by the model's real read_file call on Windows. Always use an absolute
    // path under the canonical skills directory (kept in sync with skills.js).
    const { DEEPCOPILOT_SKILLS_DIR } = require('../skills');
    const filePath = skillPath
        || path.join(DEEPCOPILOT_SKILLS_DIR, safeName, 'SKILL.md');
    const callId = `synthetic_skill_read_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
            id:       callId,
            type:     'function',
            function: {
                name:      'read_file',
                arguments: JSON.stringify({ path: filePath }),
            },
        }],
    });
    messages.push({
        role:         'tool',
        tool_call_id: callId,
        content:      String(body || ''),
    });
}

class AgentLoop {
    /**
     * @param {{
     *   context          : vscode.ExtensionContext,
     *   store            : import('./session-store').SessionStore,
     *   exec             : import('./tool-executor').ToolExecutor,
     *   getRun           : (sid: string) => object|undefined,
     *   newRun           : (sid: string, seed: object[]) => object,
     *   deleteRun        : (sid: string) => void,
     *   postToRun        : (run, msg) => void,
     *   post             : (msg) => void,
     *   postSessionList  : () => void,
     *   buildAttachment  : () => string|null,
     * }} opts
     */
    constructor(opts) {
        this._context        = opts.context;
        this._store          = opts.store;
        this._exec           = opts.exec;
        this._getRun         = opts.getRun;
        this._newRun         = opts.newRun;
        this._deleteRun      = opts.deleteRun;
        this._postToRun      = opts.postToRun;
        this._post           = opts.post;
        this._postSessionList = opts.postSessionList;
        this._buildAttachment = opts.buildAttachment;
    }

    // ─── Main entry ──────────────────────────────────────────────────────────

    async handleSend(text, attachments = [], skillContent = null) {
        // Allow attachment-only turns (e.g. user sent just `#symbol:Foo` with
        // no other text). Only reject when there is neither prose nor any
        // attachment payload to ground the model on.
        const hasText = !!(text && text.trim());
        const hasAtt  = Array.isArray(attachments) && attachments.length > 0;
        if (!hasText && !hasAtt) return;

        const existingActive = this._getRun(this._store.sessionId);
        if (existingActive && existingActive.busy) return;

        const cfg      = vscode.workspace.getConfiguration('deepseekAgent');
        const provider = cfg.get('provider') || 'deepseek';

        const apiKey = await this._context.secrets.get('deepseekAgent.apiKey');
        const needsKey = !getProvider(provider)?.noApiKey;
        if (needsKey && !apiKey) {
            this._post({ type: 'error', text: '请先设置 API Key — 点击工具栏 🔑 按钮' });
            return;
        }

        const sid = await this._store.ensure(text);
        let run = this._getRun(sid);
        if (!run) {
            const seed = this._store.loadApiMessages(sid);
            run = this._newRun(sid, seed);
        }
        run.busy = true;

        const model   = cfg.get('defaultModel') || 'deepseek-v4-pro';
        const baseUrl = (cfg.get('apiBaseUrl') || '').trim();
        const mode    = cfg.get('approvalMode') || 'manual';
        const modelCfg = getModel(provider, resolveModel(provider, model)) || { contextWindow: 65536, maxOutputTokens: 16384 };

        // Build attachment block (active editor context)
        const attachment = this._buildAttachment();
        let attachmentBlocks = attachment ? attachment + '\n\n' : '';
        // Separate text attachments from image attachments (imageData = base64 data URI).
        const imageAttachments = (attachments || []).filter(a => a && a.imageData);
        const textAttachments  = (attachments || []).filter(a => a && !a.imageData && a.path);
        if (textAttachments.length) {
            const MAX_TOTAL = 256 * 1024;
            let totalSize = 0;
            for (const a of textAttachments) {
                // Include line range attribute when the attachment is a selection
                const lineAttr = (a.startLine && a.endLine) ? ` lines="${a.startLine}-${a.endLine}"` : '';
                const block = `<attachment path="${a.path}"${lineAttr}>\n${a.content || '(empty)'}\n</attachment>`;
                if (totalSize + block.length > MAX_TOTAL) {
                    attachmentBlocks += `<attachment path="${a.path}">(truncated — total attachment budget exceeded)</attachment>\n\n`;
                    break;
                }
                attachmentBlocks += block + '\n\n';
                totalSize += block.length;
            }
        }
        // Skill injection: simulate a read_file tool call + result BEFORE the user message.
        // This mirrors exactly how GitHub Copilot works: the model "reads" the SKILL.md via
        // tool call, then acts on it as self-obtained instructions rather than user-injected text.
        // The synthetic messages are inserted into run.messages BEFORE the user turn.
        if (skillContent) {
            const skillName = skillContent._skillName || 'skill';
            const skillPath = skillContent._skillPath || null;
            const body      = typeof skillContent === 'string' ? skillContent : skillContent.body;
            injectSyntheticSkillRead(run.messages, skillName, body, skillPath);
        }
        const fullText = attachmentBlocks ? attachmentBlocks + text : text;

        // Build content: array (multimodal) when images present, plain string otherwise.
        // DeepSeek vision API accepts the standard OpenAI image_url content block format.
        let userContent;
        if (imageAttachments.length > 0) {
            userContent = [{ type: 'text', text: fullText }];
            for (const img of imageAttachments) {
                userContent.push({ type: 'image_url', image_url: { url: img.imageData } });
            }
        } else {
            userContent = fullText;
        }

        run.reply = { user: text, asst: '', thoughts: '' };
        run.messages.push({ role: 'user', content: userContent });

        Logger.info('USER_SEND', { sid, len: text.length, model, baseUrl, mode, text: text.slice(0, 2000) });
        this._postToRun(run, { type: 'userEcho', text });
        this._postToRun(run, { type: 'replyStart' });
        this._postSessionList();

        run.abortCtrl = new AbortController();
        const signal  = run.abortCtrl.signal;
        const runT0   = Date.now();

        // Helper: throw immediately if user pressed Stop.  Used at every
        // await-boundary so the loop can unwind on the first stop click
        // (issue #58 P0-2).
        const checkAbort = () => { if (signal.aborted) throw new Error('aborted'); };
        const postProgress = (phase, extra = {}) => {
            this._postToRun(run, {
                type: 'progress',
                phase,
                iter: run._iter || 0,
                elapsedMs: Date.now() - runT0,
                ...extra,
            });
        };

        const interactionMode = cfg.get('interactionMode') || 'agent';
        const sysPrompt = buildSystemPrompt({ includeWorkspaceInstructions: true, mode: interactionMode });
        const _itersRaw = Number(cfg.get('maxIterations'));
        // 0 (or unset) means "run until task is complete" — stagnation detection
        // (repeat-tool hints + ABAB cycle guard) is the real runaway guard.
        const MAX_ITERS = (_itersRaw > 0) ? Math.min(200, _itersRaw) : 9999;
        const COMPACT_BUDGET = Math.max(8000, Number(cfg.get('compactBudgetTokens')) || Math.floor(modelCfg.contextWindow * 0.5));
        const MODEL_CTX_HARD_LIMIT = Math.floor(modelCfg.contextWindow * 0.9);
        const askMode = interactionMode === 'ask';
        Logger.info('INTERACTION_MODE', { mode: interactionMode });

        // spawn_agent is included here so multiple sub-agent calls issued in the
        // same turn are dispatched concurrently (Phase 1), matching the behaviour of
        // read_file / grep_search.  Serial execution (Phase 2) was the reason
        // sub-agents appeared one after another instead of in parallel.
        const READ_ONLY = new Set(['read_file', 'list_dir', 'grep_search', 'find_files', 'web_search', 'web_fetch', 'spawn_agent']);

        // ── Issue #100: active verification nudge + failure safety valve ──────
        // wantsVerifyNudge: set when the user's message suggests a fix/debug intent.
        //   Cleared once run_shell is first called in this turn.
        // verifyNudgeEmitted: ensures we inject the reminder at most once per turn.
        // shellFailCounts: tracks consecutive failures per normalized command.
        const FIX_KEYWORDS = /修复|报错|不工作|失败|\bfix\b|\berror\b|\bbroken\b|\bfail\b/i;
        let wantsVerifyNudge  = FIX_KEYWORDS.test(typeof text === 'string' ? text : '');
        let verifyNudgeEmitted = false;
        const shellFailCounts = new Map();

        let iter = 0;
        const recentToolSig   = [];
        const repeatHintEmitted = new Set();
        let writeErrorCount   = 0;   // consecutive write-category failures (#40)
        let lastDeltaFlush = 0;
        let pendingDelta   = '';
        const flushDelta = () => {
            if (!pendingDelta) return;
            const txt = pendingDelta; pendingDelta = '';
            this._postToRun(run, { type: 'replyDelta', text: txt });
        };

        let lastUsage = null;
        let messagesSnapshot = null; // snapshot of run.messages before each API call; restored on protocol error

        // ── Bg-job end notifications (terminal-monitor push) ──────────────────
        // Collect events from background terminals; injected as system-reminders
        // at the top of each iteration so the model learns of completion promptly.
        // Session-scoped helper: only returns bg jobs started by THIS session so
        // that an unrelated session's long-running job doesn't trap this loop.
        const myBgJobs = () => getActiveBgJobsForSession(sid);
        run._pendingBgJobEvents = [];
        // Only accept job-end events for jobs that belong to THIS session.
        // Require an exact sessionId match so events without a sessionId (orphaned
        // terminals not registered via addActiveBgJob) are also dropped — this
        // ensures complete isolation between concurrent sessions.
        const _bgJobEndHandler = (payload) => {
            if (!payload || payload.sessionId !== sid) return;
            run._pendingBgJobEvents.push(payload);
        };
        onBgJobEnded(_bgJobEndHandler);

        // Clean up stale active-job entries from previous turns BEFORE starting
        // the loop.  Stale entries (job ended without SI event, or terminal closed
        // without firing onDidCloseTerminal) would cause the inner bg-wait loop to
        // spin forever if not removed here.
        cleanupStaleJobs();

        // Track the TOTAL bg-wait time accumulated across ALL outer iterations in
        // this turn.  MAX_WAIT_MS is the ceiling PER INNER LOOP; we need a separate
        // turn-level budget to prevent the outer loop from re-entering the inner loop
        // indefinitely when a job never fires its end event.
        const BG_WAIT_TURN_START  = Date.now();
        const MAX_BG_WAIT_PER_TURN = 4 * 60 * 60_000; // 4 h total per agent turn

        try { // P0-2: outer guard — run.busy is always cleared even if the catch handler itself throws
        try {
            while (iter++ < MAX_ITERS) {
                run._iter = iter;
                checkAbort();

                // ── Inject pending bg-job end notifications ───────────────────
                // terminal-monitor fires onBgJobEnded() when a deepseek-job-*
                // terminal finishes; events accumulate in run._pendingBgJobEvents
                // and are injected here so the model sees them on the next LLM call.
                if (run._pendingBgJobEvents && run._pendingBgJobEvents.length) {
                    const events = run._pendingBgJobEvents.splice(0);
                    for (const ev of events) {
                        // Skip events whose tool call already returned the
                        // final result synchronously (bg-shell early-exit).
                        if (wasSyncReturned(ev.jobId)) {
                            Logger.info('BG_JOB_END_SKIPPED_SYNC', { jobId: ev.jobId });
                            continue;
                        }
                        const exitLabel = ev.exitCode === 0 ? 'SUCCESS'
                            : ev.exitCode == null ? 'unknown' : 'FAILED';
                        const durSec = Math.round((ev.durationMs || 0) / 1000);
                        run.messages.push({
                            role: 'user',
                            content: [
                                '<system-reminder>',
                                `Background job "${ev.jobId}" has FINISHED.`,
                                `Exit code: ${ev.exitCode ?? 'unknown'} (${exitLabel}) | Duration: ${durSec}s`,
                                ev.output ? `Last output:\n${ev.output}` : '(no output captured)',
                                '</system-reminder>',
                            ].join('\n'),
                        });
                        Logger.info('BG_JOB_END_INJECTED', { jobId: ev.jobId, exitCode: ev.exitCode, durSec });
                    }
                }
                const compactApiConfig = { apiKey, baseUrl, model, provider };
                // Issue #142 P1-2: rolling proactive compaction.  Every 12
                // iterations we tighten the budget to 80% of normal so the
                // model performs an incremental summary instead of waiting
                // until we are already over budget.
                const proactiveBudget = (iter > 0 && iter % 12 === 0)
                    ? Math.floor(COMPACT_BUDGET * 0.8)
                    : COMPACT_BUDGET;
                const compactRes = await autoCompactIfNeeded(run.messages, proactiveBudget, 12, compactApiConfig);
                if (compactRes.compacted) {
                    // Issue #145: compaction may slice between an
                    // assistant{tool_calls} and its tool block. Drop any
                    // resulting orphan group before they reach the API.
                    const _before = compactRes.messages.length;
                    run.messages = _dropOrphanToolCallGroups(compactRes.messages);
                    if (run.messages.length !== _before) {
                        Logger.info('ORPHAN_TOOLCALL_DROPPED', { sid, iter, before: _before, after: run.messages.length, site: 'autocompact' });
                    }
                    Logger.info('AUTOCOMPACT', { sid, iter, dropped: compactRes.dropped, truncated: compactRes.truncated, deduped: compactRes.deduped, proactive: proactiveBudget !== COMPACT_BUDGET });
                    this._postToRun(run, { type: 'status', text: isZh() ? '🗜 压缩历史…' : 'Compacting history…' });
                    postProgress('compacting');
                }

                // Issue #142 P3-3 / #149: broadcast context usage so the webview can
                // render a real-time usage bar. With provider-aware tokenization
                // (tiktoken) this is no longer free, so we compute the count once
                // per iteration here and reuse it below for ITER_START logging and
                // the preflight cap when no plan/verify-nudge messages get appended
                // in between.
                const tokCtx = { provider, model };
                let ctxUsageMsgs = [{ role: 'system', content: sysPrompt }, ...run.messages];
                let ctxUsageTokens = 0;
                try {
                    ctxUsageTokens = estimateMessagesTokens(ctxUsageMsgs, tokCtx);
                    const ctxWindow = modelCfg.contextWindow || 65536;
                    this._postToRun(run, {
                        type: 'ctxUsage',
                        tokens: ctxUsageTokens,
                        window: ctxWindow,
                        pct: Math.min(100, Math.round(ctxUsageTokens / ctxWindow * 100)),
                    });
                } catch { /* never block the loop on a UI broadcast */ }
                checkAbort();

                // Plan nudge
                if (run.plan && Array.isArray(run.plan.steps) && run.plan.steps.length) {
                    const hasOpen  = run.plan.steps.some(s => s.status !== 'done');
                    const staleFor = iter - (run.planUpdatedIter || 0);
                    if (hasOpen && staleFor >= 4 && run._lastPlanNudgeIter !== run.planUpdatedIter) {
                        run._lastPlanNudgeIter = run.planUpdatedIter;
                        const lines = run.plan.steps.map((s, i) => {
                            const mark = s.status === 'done' ? '[x]'
                                : s.status === 'in_progress' ? '[~]'
                                : s.status === 'blocked' ? '[!]' : '[ ]';
                            return `  ${i + 1}. ${mark} ${s.title}`;
                        }).join('\n');
                        run.messages.push({
                            role: 'user',
                            content: `<system-reminder>\nActive plan (you set this earlier):\n${lines}\n\nUpdate it via \`update_plan\` whenever you finish a step or change scope. Exactly one step should be \`in_progress\`. If the plan is complete, mark all steps \`done\` and produce the final user-facing reply.\n</system-reminder>`,
                        });
                        Logger.info('PLAN_NUDGE_INJECTED', { sid, iter, staleFor });
                    }
                }

                // Issue #100 — active verification nudge
                // Inject once per turn when the user's request is fix/debug oriented and
                // run_shell has not yet been called.  Encourages the model to close the
                // "edit → verify" loop autonomously.
                if (wantsVerifyNudge && !verifyNudgeEmitted) {
                    verifyNudgeEmitted = true;
                    run.messages.push({
                        role: 'user',
                        content: `<system-reminder>\nThis is a fix or debug task. After every code change, proactively run the relevant tests / build / lint via \`run_shell\` to verify the fix. Do NOT ask the user to run commands manually unless they require interactive input.\n</system-reminder>`,
                    });
                    Logger.info('VERIFY_NUDGE_INJECTED', { sid, iter });
                }

                // effectiveSysPrompt: no longer modified per-iter; skill is now injected as
                // synthetic tool call + result in run.messages (see pre-loop section above).
                const effectiveSysPrompt = sysPrompt;
                const msgs = [{ role: 'system', content: effectiveSysPrompt }, ...run.messages];
                let assistantText = '';
                let reasoningText = '';
                // Issue #149: avoid tokenizing the same array twice. If no
                // plan / verify-nudge appended messages since ctxUsageMsgs was
                // built (and the system prompt is identical), reuse the count;
                // otherwise recompute.
                let msgsTokens;
                if (run.messages.length === ctxUsageMsgs.length - 1 && effectiveSysPrompt === sysPrompt) {
                    msgsTokens = ctxUsageTokens;
                } else {
                    msgsTokens = estimateMessagesTokens(msgs, tokCtx);
                }
                Logger.info('ITER_START', { sid, iter, msg_count: msgs.length, est_tokens: msgsTokens });

                // Pre-flight hard token cap — prevents HTTP 400 context-too-long errors.
                // MODEL_CTX_HARD_LIMIT is derived from the active model's contextWindow
                // (90% of capacity, computed above the while loop).
                //
                // Issue #142 P0-2: extended emergency compaction ladder + nuclear
                // fallback.  We NEVER bail out with a CTX_LIMIT error — if nothing
                // else fits, nuclearCompact() reduces history to {firstUser +
                // summary + lastUser} and we continue the turn.
                let preflightTokens = msgsTokens;
                if (preflightTokens > MODEL_CTX_HARD_LIMIT) {
                    // Aggressive ladder — try increasingly small tails before going nuclear.
                    const ladder = [8, 6, 4, 2, 1];
                    for (const emergencyKeepTail of ladder) {
                        // No LLM summarisation during emergency compaction — speed is critical.
                        // Pass provider/model so the modular token counter still picks the
                        // right tokenizer (issue #149).
                        const agg = await autoCompactIfNeeded(run.messages, Math.floor(MODEL_CTX_HARD_LIMIT * 0.6), emergencyKeepTail, { provider, model, noSummary: true });
                        if (agg.compacted) {
                            // Issue #145: never let a compaction-induced orphan
                            // group leak into the next API call.
                            const _before = agg.messages.length;
                            run.messages = _dropOrphanToolCallGroups(agg.messages);
                            if (run.messages.length !== _before) {
                                Logger.info('ORPHAN_TOOLCALL_DROPPED', { sid, iter, before: _before, after: run.messages.length, site: 'preflight_compact' });
                            }
                            Logger.info('PREFLIGHT_COMPACT', { sid, iter, before: preflightTokens, keepTail: emergencyKeepTail, dropped: agg.dropped, truncated: agg.truncated });
                            this._postToRun(run, { type: 'status', text: isZh() ? '⚠️ 上下文接近上限，已紧急压缩历史…' : 'Context near limit — emergency compaction applied…' });
                        }
                        const newTokens = estimateMessagesTokens([{ role: 'system', content: sysPrompt }, ...run.messages], tokCtx);
                        if (newTokens <= MODEL_CTX_HARD_LIMIT) { preflightTokens = newTokens; break; }
                        preflightTokens = newTokens;
                    }

                    // Issue #142 P0-2: nuclear fallback — ALWAYS continue, never break.
                    // If the ladder did not bring us under the hard limit, drop to
                    // {firstUser truncated + summary + lastUser}.  The session is
                    // preserved; the current turn loses interim tool history (rare
                    // edge case where the model is mid tool-call when nuking).
                    if (preflightTokens > MODEL_CTX_HARD_LIMIT) {
                        const before = preflightTokens;
                        // Issue #145: nuclearCompact synthesises a fresh
                        // {firstUser, summary, lastUser} — normally orphan-
                        // free, but defensively re-sanitize anyway.
                        const _nuked = nuclearCompact(run.messages);
                        run.messages = _dropOrphanToolCallGroups(_nuked);
                        if (run.messages.length !== _nuked.length) {
                            Logger.info('ORPHAN_TOOLCALL_DROPPED', { sid, iter, before: _nuked.length, after: run.messages.length, site: 'nuclear' });
                        }
                        const after = estimateMessagesTokens([{ role: 'system', content: sysPrompt }, ...run.messages], tokCtx);
                        Logger.info('NUCLEAR_COMPACT', { sid, iter, before, after });
                        this._postToRun(run, {
                            type: 'status',
                            text: isZh()
                                ? `🔥 上下文越限，已执行核弹级压缩（${Math.round(before / 1000)}K→${Math.round(after / 1000)}K tokens）…`
                                : `🔥 Nuclear compaction applied (${Math.round(before / 1000)}K→${Math.round(after / 1000)}K tokens)…`,
                        });
                        // preflightTokens is intentionally not re-read after this point;
                        // the next iteration recalculates it from scratch.
                    }
                }
                checkAbort();

                // Rebuild msgs in case pre-flight compaction modified run.messages
                // Issue #145: final guard — strip any orphan assistant{tool_calls}
                // group that may have survived compaction / a mid-turn crash before
                // we send the request. Cheap (single pass) and idempotent.
                const _sanitized = _dropOrphanToolCallGroups(run.messages);
                if (_sanitized.length !== run.messages.length) {
                    Logger.info('ORPHAN_TOOLCALL_DROPPED', {
                        sid, iter,
                        before: run.messages.length,
                        after:  _sanitized.length,
                        site:   'preflight',
                    });
                    run.messages = _sanitized;
                }
                const finalMsgs = [{ role: 'system', content: effectiveSysPrompt }, ...run.messages];

                // Snapshot current (valid) state before the API call. Restored in the
                // catch block if a protocol error (e.g. HTTP 400) corrupts run.messages.
                messagesSnapshot = [...run.messages];
                const iterT0 = Date.now();

                const argStreamers = new Map();
                if (!run._earlyStartedTools) run._earlyStartedTools = new Set();
                const STREAMABLE_TOOLS = new Set(['write_file', 'str_replace_in_file', 'apply_patch']);
                // Issue #142 P2-3: allow users to disable MCP tool injection
                // for sessions that don't need them — saves the prompt-side
                // tokens spent declaring them.
                const includeMcpTools = vscode.workspace
                    .getConfiguration('deepseekAgent')
                    .get('includeMcpTools', true);
                const mcpDefs  = includeMcpTools ? mcpManager.getToolDefs() : [];
                const allTools = getToolDefs(mcpDefs);

                postProgress('waiting_first_token');

                let _gotFirstToken = false;
                const { toolCalls, usage } = await streamChat(
                    { provider, apiKey, baseUrl, messages: finalMsgs, model, noTools: askMode, tools: allTools },
                    {
                        onDelta: (delta) => {
                            if (!_gotFirstToken) { _gotFirstToken = true; postProgress('streaming'); }
                            assistantText += delta; run.reply.asst += delta;
                            pendingDelta += delta;
                            const now = Date.now();
                            if (pendingDelta.length >= 256 || now - lastDeltaFlush >= 60) {
                                lastDeltaFlush = now;
                                flushDelta();
                            }
                        },
                        onThinking: (delta) => {
                            if (!_gotFirstToken) { _gotFirstToken = true; postProgress('thinking'); }
                            reasoningText += delta; run.reply.thoughts += delta;
                            Logger.thinking(delta);
                            this._postToRun(run, { type: 'thinkingDelta', text: delta });
                        },
                        onToolArgsDelta: (ev) => {
                            if (!ev || !ev.name || !STREAMABLE_TOOLS.has(ev.name)) return;
                            let s = argStreamers.get(ev.index);
                            if (!s) { s = new ToolArgsStreamer(); argStreamers.set(ev.index, s); }
                            const r = s.feed(ev.deltaArgs || '');
                            if (r.newPath && ev.id && !run._earlyStartedTools.has(ev.id)) {
                                run._earlyStartedTools.add(ev.id);
                                this._postToRun(run, {
                                    type: 'toolStart', id: ev.id, name: ev.name,
                                    args: JSON.stringify({ path: r.newPath }), streaming: true,
                                });
                            }
                            if (r.contentDelta) {
                                this._postToRun(run, { type: 'toolArgsDelta', id: ev.id, name: ev.name, contentDelta: r.contentDelta });
                            }
                        },
                    },
                    signal,
                );
                flushDelta();
                if (usage) lastUsage = usage;

                Logger.flush();
                Logger.info('ITER_END', {
                    sid, iter, elapsed_ms: Date.now() - iterT0,
                    assistant_chars: assistantText.length, reasoning_chars: reasoningText.length,
                    tool_calls: toolCalls.length, usage,
                });
                if (assistantText) Logger.info('ASSISTANT', assistantText.slice(0, 4000));

                if (usage) {
                    const { cost_cny, breakdown } = computeCost(model, usage);
                    this._postToRun(run, { type: 'usage', usage: { ...usage, cost_cny, breakdown, model } });
                }

                if (!toolCalls.length) {
                    run.messages.push({ role: 'assistant', content: assistantText, ...(reasoningText ? { reasoning_content: reasoningText } : {}) });

                    // ── Keep loop alive while bg jobs are running ─────────────────
                    // If the model produced a final reply but there are still active
                    // background jobs (run_shell_bg with shell integration), do NOT
                    // exit.  Enter a silent-wait inner loop that keeps the async
                    // context alive without burning API tokens on every poll.
                    //
                    // Inner loop behaviour:
                    //   - Polls every BG_POLL_MS for a job-end event.
                    //   - On event → queue it; break inner loop → outer continue →
                    //     event injected at top → ONE API call with real results.
                    //   - On BG_SNAPSHOT_MS timeout with no event → inject a progress
                    //     snapshot; break inner loop → ONE API call so model can
                    //     narrate progress if desired.
                    //   - MAX_WAIT_MS hard ceiling prevents eternal wait (e.g. 4 h).
                    if (myBgJobs().size > 0) {
                        // Remove stale entries before waiting so we don't spin on
                        // jobs that ended without firing their SI end event.
                        cleanupStaleJobs();

                        // Skip bg-wait when the model has produced a non-empty
                        // conclusive reply AND there are no pending job-end events
                        // to deliver.
                        //
                        // Rationale: if a bg job ended *during* the current API
                        // call, _bgJobEndHandler already queued its event in
                        // run._pendingBgJobEvents synchronously.  A non-empty
                        // _pendingBgJobEvents means the model should hear about
                        // that result → keep the loop alive for ONE more iteration.
                        //
                        // Conversely, if _pendingBgJobEvents is empty, the bg job
                        // is still running (dev server, watcher, etc.).  The model
                        // already knows — it just told the user about it.  There is
                        // nothing new to report, so exit the turn immediately rather
                        // than blocking for up to BG_SNAPSHOT_MS (4 min) or longer.
                        //
                        // NOTE: we intentionally do NOT gate on whether the model
                        // mentioned the jobId by name.  Models routinely include
                        // "terminal deepseek-job-X is running" in status summaries
                        // even when the task is fully complete, which would falsely
                        // bypass this guard if we used a text-match heuristic.
                        if (assistantText.trim()) {
                            const _hasPendingEvents = !!(run._pendingBgJobEvents && run._pendingBgJobEvents.length);
                            if (!_hasPendingEvents) {
                                Logger.info('BG_WAIT_SKIPPED_MODEL_DONE', { jobs: [...myBgJobs()] });
                                break;
                            }
                        }

                        // Honour the turn-level budget: if we have already waited
                        // MAX_BG_WAIT_PER_TURN in this turn (across multiple outer
                        // iterations), give up and exit the loop rather than
                        // re-entering the inner wait for another 4 hours.
                        const turnWaitRemaining = MAX_BG_WAIT_PER_TURN - (Date.now() - BG_WAIT_TURN_START);
                        if (turnWaitRemaining <= 0 || myBgJobs().size === 0) {
                            if (myBgJobs().size > 0) {
                                Logger.info('BG_WAIT_TURN_BUDGET_EXCEEDED', { jobs: [...myBgJobs()] });
                            }
                            break;
                        }

                        const BG_POLL_MS      = 15_000;
                        const BG_SNAPSHOT_MS  = 4 * 60_000;
                        const MAX_WAIT_MS     = Math.min(4 * 60 * 60_000, turnWaitRemaining);
                        const waitT0          = Date.now();
                        let   lastSnapshotAt  = waitT0;

                        while (Date.now() - waitT0 < MAX_WAIT_MS) {
                            checkAbort();
                            if (myBgJobs().size === 0) break; // all done

                            const elapsed = Math.round((Date.now() - waitT0) / 1000);
                            postProgress('bg_wait', { elapsed_s: elapsed, jobs: [...myBgJobs()] });

                            const ev = await waitForNextBgJobEvent(signal, BG_POLL_MS, sid);
                            if (ev) {
                                // A job ended — _bgJobEndHandler already pushed this
                                // event to run._pendingBgJobEvents synchronously when
                                // the SI end event fired.  Do NOT push again here or
                                // the model will see two identical <system-reminder>
                                // blocks for the same job completion.
                                break;
                            }

                            // Still running after BG_POLL_MS.  If enough time has
                            // passed since the last model interaction, inject a live
                            // snapshot so the model (and user) can see progress.
                            if (Date.now() - lastSnapshotAt >= BG_SNAPSHOT_MS) {
                                const snaps = [];
                                for (const jobId of myBgJobs()) {
                                    const t     = findTerminalByName(jobId);
                                    const execs = t ? getRecentExecutions(t, 1) : [];
                                    const last  = execs[execs.length - 1];
                                    const status = last
                                        ? (last.running ? '[running]' : `[exit ${last.exitCode ?? '?'}]`)
                                        : '[no data]';
                                    const tail = (last && last.output)
                                        ? last.output.slice(-512)
                                        : '(no output captured — shell integration may be unavailable)';
                                    snaps.push(`${jobId} ${status}:\n${tail}`);
                                }
                                run.messages.push({
                                    role: 'user',
                                    content: [
                                        '<system-reminder>',
                                        'Background job progress snapshot (still running):',
                                        snaps.join('\n---\n'),
                                        '</system-reminder>',
                                    ].join('\n'),
                                });
                                Logger.info('BG_SNAPSHOT_INJECTED', { jobs: [...myBgJobs()], elapsed_s: elapsed });
                                break; // exit inner loop → outer continue → API call
                            }
                            // else: keep waiting silently (no API call this iteration)
                        }
                        continue; // outer while — inject events / call API
                    }

                    break;
                }

                run.messages.push({
                    role: 'assistant',
                    content: assistantText || null,
                    ...(reasoningText ? { reasoning_content: reasoningText } : {}),
                    tool_calls: toolCalls.map(tc => ({
                        id: tc.id, type: 'function',
                        function: { name: tc.name, arguments: tc.args },
                    })),
                });

                this._postToRun(run, { type: 'newTurn' });

                // ── Parallel read / serial mutating dispatch ──────────────────
                const results = new Array(toolCalls.length);
                checkAbort();

                // Phase 1: read-only tools in parallel
                const parallelTasks = [];
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    if (!READ_ONLY.has(tc.name)) continue;
                    const args = this._exec.logToolStart(run, tc);
                    const tT0  = Date.now();
                    postProgress('tool_running', { activeTool: tc.name });
                    parallelTasks.push(
                        this._exec.execute(tc.name, args, mode, run, signal, tc.id)
                            .catch(e => `Error: ${e.message}`)
                            .then(res => {
                                results[i] = { tc, args, result: this._exec.logToolResult(run, tc, res, Date.now() - tT0) };
                            })
                    );
                }
                if (parallelTasks.length) await Promise.all(parallelTasks);
                checkAbort();

                // Phase 2: mutating tools serially
                // Regex to detect sleep/wait commands the model sometimes uses to poll bg jobs.
                // When pending bg-job events are already queued, skip the sleep entirely so the
                // failure (or success) is surfaced immediately on the next outer iteration instead
                // of after a 15-30 second unnecessary delay.
                const _BG_SLEEP_PAT = /^\s*(ping\s+-n\s+\d+\b|sleep\s+\d+|Start-Sleep\b)/i;
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    if (READ_ONLY.has(tc.name)) continue;
                    checkAbort();
                    const args = this._exec.logToolStart(run, tc);
                    const tT0  = Date.now();
                    postProgress('tool_running', { activeTool: tc.name });
                    let rawResult = '';
                    // If a bg-job event is already queued and the model is trying to sleep/wait,
                    // skip the sleep — the event will be injected at the top of the next iteration.
                    if (
                        tc.name === 'run_shell' &&
                        run._pendingBgJobEvents && run._pendingBgJobEvents.length > 0 &&
                        _BG_SLEEP_PAT.test(String((args && args.command) || ''))
                    ) {
                        rawResult = '[wait skipped: a background job has already finished — result details follow in the next message]';
                        Logger.info('SLEEP_SKIPPED_BGJOBEVENT', { command: args && args.command });
                    } else {
                        try { rawResult = await this._exec.execute(tc.name, args, mode, run, signal, tc.id); }
                        catch (e) { rawResult = `Error: ${e.message}`; }
                    }
                    results[i] = { tc, args, result: this._exec.logToolResult(run, tc, rawResult, Date.now() - tT0) };
                }
                checkAbort();

                // Phase 3: push tool messages + loop-guard checks
                // IMPORTANT: The API requires all tool result messages to form a contiguous
                // block immediately after their assistant{tool_calls} message — inserting
                // any other role mid-block causes HTTP 400. Hints (role:'user') are therefore
                // collected in pendingHints and appended only AFTER every tool result is pushed.
                const SHELL_ERROR_PAT = /error|failed|exception|unrecognized|unexpected token|cannot|access.?denied|not recognized|garbled|malformed/i;
                // Only dedicated file-write tools count toward write-category failures.
                // run_shell is intentionally excluded: compile/lint/check commands often
                // fail for environment reasons (missing headers, etc.) unrelated to writes.
                const WRITE_TOOLS = new Set(['write_file']);
                const pendingHints = []; // hints collected here; pushed after all tool messages
                for (let i = 0; i < toolCalls.length; i++) {
                    const { tc, result } = results[i];
                    run.messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });

                    const resStr  = String(result);
                    const lowInfo = resStr.length < 80 || /^\(no output/.test(resStr) || /^Exit \d+: ?$/.test(resStr.trim());
                    const key     = tc.name + '|' + (tc.args || '');
                    const sig     = resStr.slice(0, 60) + '||' + resStr.slice(-60);
                    recentToolSig.push({ key, sig, lowInfo });
                    if (recentToolSig.length > 8) recentToolSig.shift();

                    // (a) Same key+sig repeated → queue per-tool hint once
                    const sameKeySig = recentToolSig.filter(e => e.key === key && e.sig === sig && e.lowInfo);
                    if (sameKeySig.length >= 2 && !repeatHintEmitted.has(key)) {
                        repeatHintEmitted.add(key);
                        pendingHints.push({
                            role: 'user',
                            content: `<system-reminder>\nYou have called \`${tc.name}\` with the same arguments ${sameKeySig.length} times and received the same low-information result. STOP retrying this exact approach. Pick a fundamentally different strategy: (1) redirect command output to a file then read_file it back, (2) use a different tool (read_file/grep_search/list_dir/find_files), (3) split the operation into smaller verifiable steps, (4) ask the user for clarification. Do not repeat this call.\n</system-reminder>`,
                        });
                        Logger.info('REPEAT_HINT_INJECTED', { tool: tc.name, occurrences: sameKeySig.length });
                    }

                    // (b) ABAB cycle detection → queue hint once
                    if (recentToolSig.length >= 6 && !repeatHintEmitted.has('__cycle__')) {
                        const last6 = recentToolSig.slice(-6);
                        const ks = last6.map(e => e.key);
                        if (ks[0] === ks[2] && ks[2] === ks[4] && ks[1] === ks[3] && ks[3] === ks[5] && ks[0] !== ks[1]) {
                            repeatHintEmitted.add('__cycle__');
                            pendingHints.push({
                                role: 'user',
                                content: `<system-reminder>\nYou are oscillating between two tool calls without making progress. Stop the cycle. Either commit to one path with a fundamentally different argument set, or write a plain-text reply explaining what you found and ask the user how to proceed.\n</system-reminder>`,
                            });
                            Logger.info('CYCLE_HINT_INJECTED', { keys: [ks[0], ks[1]] });
                        }
                    }

                    // (c) Write-category error classification (#40)
                    // Detect consecutive write_file failures and queue a categorical-switch hint.
                    if (WRITE_TOOLS.has(tc.name) && SHELL_ERROR_PAT.test(resStr)) {
                        writeErrorCount++;
                        if (writeErrorCount >= 2 && !repeatHintEmitted.has('__write_category__')) {
                            repeatHintEmitted.add('__write_category__');
                            pendingHints.push({
                                role: 'user',
                                content: `<system-reminder>\nMultiple write operations have failed in a row. This is a CATEGORY failure — do not try another shell or write variant.\n\nClassify the error and switch category:\n- Garbled / missing chars / bad escaping → shell escape issue → use \`write_file\` (dedicated tool) with the exact content string\n- "Access Denied" / "Permission denied" → permissions → change the target path\n- "file in use" / "cannot access" → file lock → use a temp path\n- "not recognized" / "command not found" → missing tool → use a built-in alternative\n\nOne failure = entire category eliminated. If two categories have already failed, stop and ask the user.\n</system-reminder>`,
                            });
                            Logger.info('WRITE_CATEGORY_HINT_INJECTED', { tool: tc.name, writeErrorCount });
                        }
                    } else if (WRITE_TOOLS.has(tc.name) && !SHELL_ERROR_PAT.test(resStr)) {
                        // Successful write resets the counter
                        writeErrorCount = 0;
                    }

                    // (d) Context compression for large shell error results (#44).
                    // Restricted to run_shell to avoid compressing legitimate read_file
                    // content that merely contains words like "error" or "failed".
                    const COMPRESS_THRESHOLD = 2000;
                    if (tc.name === 'run_shell' && resStr.length > COMPRESS_THRESHOLD && SHELL_ERROR_PAT.test(resStr)) {
                        const lastMsg = run.messages[run.messages.length - 1];
                        if (lastMsg && lastMsg.role === 'tool' && lastMsg.tool_call_id === tc.id) {
                            // Compress the `text` field inside the JSON to preserve a valid
                            // structured payload; only fall back to raw-string slicing when
                            // the result is not a JSON object (old error-path strings).
                            let compressed = resStr;
                            try {
                                const parsed = JSON.parse(resStr);
                                if (parsed && typeof parsed.text === 'string' && parsed.text.length > COMPRESS_THRESHOLD) {
                                    const head = parsed.text.slice(0, 300);
                                    const tail = parsed.text.slice(-100);
                                    parsed.text = `${head}\n...[compressed: ${parsed.text.length} chars total]...\n${tail}`;
                                    compressed = JSON.stringify(parsed);
                                }
                            } catch {
                                // Plain string result (error/timeout path) — slice the raw string.
                                const head = resStr.slice(0, 300);
                                const tail = resStr.slice(-100);
                                compressed = `${head}\n...[error output compressed: ${resStr.length} chars total]...\n${tail}`;
                            }
                            lastMsg.content = compressed;
                            Logger.info('TOOL_RESULT_COMPRESSED', { tool: tc.name, original: resStr.length, compressed: lastMsg.content.length });
                        }
                    }

                    // (e) Issue #100 — failure safety valve: same command fails ≥ 3 times.
                    // Normalise the command string, track per-command failure count, and
                    // inject a "stop / switch strategy" hint once the threshold is reached.
                    if (tc.name === 'run_shell') {
                        // run_shell was invoked — no longer need the verify nudge
                        wantsVerifyNudge = false;
                        // Determine whether this invocation was a failure.
                        // shell.js returns a JSON object on normal exit and a plain string
                        // on error paths; check both representations.
                        const isShellFailure = (() => {
                            try { const p = JSON.parse(resStr); return p.exitCode !== 0; } catch {}
                            return /^(?:Exit |Error:)/.test(resStr);
                        })();
                        let cmdKey = '';
                        try {
                            const a = typeof tc.args === 'string' ? JSON.parse(tc.args || '{}') : (tc.args || {});
                            cmdKey = String(a.command || '').replace(/\s+/g, ' ').trim();
                        } catch {}
                        if (cmdKey) {
                            if (isShellFailure) {
                                const failCount = (shellFailCounts.get(cmdKey) || 0) + 1;
                                shellFailCounts.set(cmdKey, failCount);
                                const hintKey = '__shell_fail__' + cmdKey;
                                if (failCount >= 3 && !repeatHintEmitted.has(hintKey)) {
                                    repeatHintEmitted.add(hintKey);
                                    pendingHints.push({
                                        role: 'user',
                                        content: `<system-reminder>\nThe command \`${cmdKey}\` has failed ${failCount} consecutive times. Stop retrying this exact approach. Switch strategy — try a different command, a different fix, or explain clearly to the user what is blocking and suggest concrete next steps. Do not run the same failing command again.\n</system-reminder>`,
                                    });
                                    Logger.info('SHELL_FAIL_VALVE_INJECTED', { command: cmdKey, failCount });
                                }
                            } else {
                                shellFailCounts.delete(cmdKey); // reset on success
                            }
                        }
                    }
                } // end Phase 3 for-loop

                // Append deferred hints after all tool messages — preserves the required
                // API sequence: assistant{tool_calls} → N×tool → (optional) user hints.
                for (const hint of pendingHints) run.messages.push(hint);

                // update_plan is a pure UI action (sidebar only); it makes no task progress.
                // Reclaim the iteration slot so plan housekeeping doesn't eat into the real
                // work budget.  iter was already incremented by while(iter++ < MAX_ITERS),
                // so decrementing here brings the count back as if this loop body never ran.
                if (toolCalls.length > 0 && toolCalls.every(tc => tc.name === 'update_plan')) {
                    iter--;
                    Logger.info('PLAN_ONLY_ITER_RECLAIMED', { sid, iter });
                }
            } // end while

            // Force-final summary when iteration cap is hit with no reply yet
            if (iter > MAX_ITERS && !run.reply.asst.trim()) {
                Logger.info('FORCE_FINAL_SUMMARY', { iter });
                const compacted = await autoCompactIfNeeded(run.messages, Math.floor(COMPACT_BUDGET * 0.6), 12, { apiKey, baseUrl, model, provider });
                const _srcMsgs  = compacted.compacted ? compacted.messages : run.messages;
                const baseMsgs  = _dropOrphanToolCallGroups(_srcMsgs);
                if (baseMsgs.length !== _srcMsgs.length) {
                    Logger.info('ORPHAN_TOOLCALL_DROPPED', { sid, iter, before: _srcMsgs.length, after: baseMsgs.length, site: 'force_final_summary' });
                }
                const finalMsgs = [
                    { role: 'system', content: sysPrompt },
                    ...baseMsgs,
                    { role: 'user', content: '<system-reminder>\nYou have reached the tool-call iteration limit without producing a user-facing answer. Stop calling tools. Write a concise plain-text reply that: (1) summarises what you tried, (2) states what you found or could not find, (3) suggests a concrete next step the user can take.\n</system-reminder>' },
                ];
                let tail = '';
                await streamChat(
                    { provider, apiKey, baseUrl, messages: finalMsgs, model, noTools: true },
                    {
                        onDelta:    t => { tail += t; run.reply.asst += t; this._postToRun(run, { type: 'replyDelta', text: t }); },
                        onThinking: t => { run.reply.thoughts += t; this._postToRun(run, { type: 'thinkingDelta', text: t }); },
                    },
                    signal,
                ).catch(e => Logger.info('FORCE_FINAL_SUMMARY_ERROR', { message: e.message }));
                if (tail) run.messages.push({ role: 'assistant', content: tail });
            }
        } catch (e) {
            // Restore the last known-good message state to prevent persisting a
            // sequence that triggered an API protocol error (e.g. HTTP 400).
            if (messagesSnapshot) run.messages = messagesSnapshot;
            Logger.info('LOOP_ERROR', { sid, message: e.message, stack: (e.stack || '').slice(0, 1500) });
            if (e.message !== 'aborted') {
                const fe = friendlyError(e);
                this._postToRun(run, { type: 'error', title: fe.title, text: fe.tip, code: fe.code, retryable: fe.retryable, raw: fe.raw });
            }
        }

        Logger.info('SEND_END', { sid, iters: iter - 1, asst_chars: run.reply.asst.length });
        Logger.flush();

        try { flushDelta(); } catch {}
        const wasAborted = signal.aborted;
        this._postToRun(run, { type: 'replyEnd', empty: false, aborted: wasAborted });
        this._postToRun(run, { type: 'status', text: '' });
        if (wasAborted) this._postToRun(run, { type: 'stopped' });

        // Persist turn
        const r = run.reply;
        if (!run.discarded && (r.user || r.asst)) {
            let usageWithCost = null;
            if (lastUsage) {
                try {
                    const { cost_cny } = computeCost(model, lastUsage);
                    usageWithCost = Object.assign({}, lastUsage, { cost_cny });
                } catch { usageWithCost = lastUsage; }
            }
            await this._store.append(sid, r.user, r.asst, r.thoughts, usageWithCost, run.messages);
            this._store.maybeAutoName(
                sid, r.user, r.asst,
                () => this._context.secrets.get('deepseekAgent.apiKey'),
                () => {
                    const c = vscode.workspace.getConfiguration('deepseekAgent');
                    return (c.get('apiBaseUrl') || '').trim() || 'https://api.deepseek.com';
                },
            ).catch(() => {});
        }

        this._deleteRun(sid);
        this._postSessionList();
        } finally { // P0-2: guarantees busy flag is cleared on any exit path
            offBgJobEnded(_bgJobEndHandler);
            run.abortCtrl = null;
            run.busy = false;
        }
    }
}

module.exports = { AgentLoop, injectSyntheticSkillRead };
