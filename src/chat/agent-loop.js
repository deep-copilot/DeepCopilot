// AgentLoop: the agentic while-loop that drives each turn.
//
// Receives its dependencies via constructor (dependency-injection) so the
// loop itself is decoupled from the webview, session storage, and tool layer.
// provider.js wires everything together at startup.
'use strict';

const vscode = require('vscode');

const { Logger }           = require('../logger');
const { friendlyError }    = require('../errors');
const { computeCost }      = require('../pricing');
const { buildSystemPrompt }= require('../prompts/system');
const { streamDeepSeek }   = require('../api/deepseek');
const { getToolDefs }      = require('../tools/schema');
const { mcpManager }       = require('../mcp');
const { isZh }             = require('../utils/i18n');
const {
    estimateMessagesTokens, autoCompactIfNeeded, ToolArgsStreamer,
} = require('./compact');

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
    const filePath = skillPath || `~/.deepcopilot/skills/${safeName}/SKILL.md`;
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

        const apiKey = await this._context.secrets.get('deepseekAgent.apiKey');
        if (!apiKey) {
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

        const cfg     = vscode.workspace.getConfiguration('deepseekAgent');
        const model   = cfg.get('defaultModel') || 'deepseek-v4-pro';
        const baseUrl = (cfg.get('apiBaseUrl') || '').trim() || 'https://api.deepseek.com';
        const mode    = cfg.get('approvalMode') || 'manual';

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

        const sysPrompt = buildSystemPrompt({ includeWorkspaceInstructions: true });
        const _itersRaw = Number(cfg.get('maxIterations'));
        // 0 (or unset) means "run until task is complete" — stagnation detection
        // (repeat-tool hints + ABAB cycle guard) is the real runaway guard.
        const MAX_ITERS = (_itersRaw > 0) ? Math.min(200, _itersRaw) : 9999;
        const COMPACT_BUDGET = Math.max(8000, Number(cfg.get('compactBudgetTokens')) || 600000);
        const askMode = (cfg.get('interactionMode') || 'agent') === 'ask';
        Logger.info('INTERACTION_MODE', { mode: cfg.get('interactionMode') || 'agent' });

        // spawn_agent is included here so multiple sub-agent calls issued in the
        // same turn are dispatched concurrently (Phase 1), matching the behaviour of
        // read_file / grep_search.  Serial execution (Phase 2) was the reason
        // sub-agents appeared one after another instead of in parallel.
        const READ_ONLY = new Set(['read_file', 'list_dir', 'grep_search', 'find_files', 'web_search', 'web_fetch', 'spawn_agent']);

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
        try {
            while (iter++ < MAX_ITERS) {
                run._iter = iter;
                checkAbort();

                // Auto-compact
                const compactRes = autoCompactIfNeeded(run.messages, COMPACT_BUDGET);
                if (compactRes.compacted) {
                    run.messages = compactRes.messages;
                    Logger.info('AUTOCOMPACT', { sid, iter, dropped: compactRes.dropped });
                    this._postToRun(run, { type: 'status', text: isZh() ? '🗜 压缩历史…' : 'Compacting history…' });
                    postProgress('compacting');
                }
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

                // effectiveSysPrompt: no longer modified per-iter; skill is now injected as
                // synthetic tool call + result in run.messages (see pre-loop section above).
                const effectiveSysPrompt = sysPrompt;
                const msgs = [{ role: 'system', content: effectiveSysPrompt }, ...run.messages];
                let assistantText = '';
                let reasoningText = '';
                Logger.info('ITER_START', { sid, iter, msg_count: msgs.length, est_tokens: estimateMessagesTokens(msgs) });

                // Pre-flight hard token cap — prevents HTTP 400 context-too-long errors.
                // DeepSeek context window is 1M tokens; max output is 384K.
                // Guard at 900K to leave ~100K headroom for the response.
                // If still over after regular compaction, run aggressive passes.
                const MODEL_CTX_HARD_LIMIT = 900000;
                let preflightTokens = estimateMessagesTokens(msgs);
                let ctxLimitHit = false;
                if (preflightTokens > MODEL_CTX_HARD_LIMIT) {
                    for (const emergencyKeepTail of [6, 3]) {
                        const agg = autoCompactIfNeeded(run.messages, Math.floor(MODEL_CTX_HARD_LIMIT * 0.7), emergencyKeepTail);
                        if (agg.compacted) {
                            run.messages = agg.messages;
                            Logger.info('PREFLIGHT_COMPACT', { sid, iter, before: preflightTokens, keepTail: emergencyKeepTail, dropped: agg.dropped });
                            this._postToRun(run, { type: 'status', text: isZh() ? '⚠️ 上下文接近上限，已紧急压缩历史…' : 'Context near limit — emergency compaction applied…' });
                        }
                        const newTokens = estimateMessagesTokens([{ role: 'system', content: sysPrompt }, ...run.messages]);
                        if (newTokens <= MODEL_CTX_HARD_LIMIT) break;
                        preflightTokens = newTokens;
                    }

                    // Last resort: if still over the limit, refuse to call the API and tell the user
                    const finalTokens = estimateMessagesTokens([{ role: 'system', content: sysPrompt }, ...run.messages]);
                    if (finalTokens > MODEL_CTX_HARD_LIMIT) {
                        Logger.info('CTX_HARD_LIMIT_EXCEEDED', { sid, iter, tokens: finalTokens });
                        this._postToRun(run, {
                            type: 'error',
                            title: isZh() ? '上下文已达上限' : 'Context limit reached',
                            text: isZh()
                                ? `当前会话内容约 ${Math.round(finalTokens / 1000)}K tokens，超出模型上下文窗口。请按 Ctrl+K 清空会话后重新提问。`
                                : `Session is ~${Math.round(finalTokens / 1000)}K tokens — exceeds the model context window. Press Ctrl+K to clear the session and try again.`,
                            code: 'CTX_LIMIT',
                            retryable: false,
                        });
                        iter = MAX_ITERS + 1; // skip the force-final-summary path too
                        ctxLimitHit = true;
                    }
                }
                if (ctxLimitHit) break; // break while loop — do not call the API
                checkAbort();

                // Rebuild msgs in case pre-flight compaction modified run.messages
                const finalMsgs = [{ role: 'system', content: effectiveSysPrompt }, ...run.messages];

                // Snapshot current (valid) state before the API call. Restored in the
                // catch block if a protocol error (e.g. HTTP 400) corrupts run.messages.
                messagesSnapshot = [...run.messages];
                const iterT0 = Date.now();

                const argStreamers = new Map();
                if (!run._earlyStartedTools) run._earlyStartedTools = new Set();
                const STREAMABLE_TOOLS = new Set(['write_file', 'str_replace_in_file', 'apply_patch']);
                const allTools = getToolDefs(mcpManager.getToolDefs());

                postProgress('waiting_first_token');

                let _gotFirstToken = false;
                const { toolCalls, usage } = await streamDeepSeek(
                    { apiKey, baseUrl, messages: finalMsgs, model, noTools: askMode, tools: allTools },
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
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    if (READ_ONLY.has(tc.name)) continue;
                    checkAbort();
                    const args = this._exec.logToolStart(run, tc);
                    const tT0  = Date.now();
                    postProgress('tool_running', { activeTool: tc.name });
                    let rawResult = '';
                    try { rawResult = await this._exec.execute(tc.name, args, mode, run, signal, tc.id); }
                    catch (e) { rawResult = `Error: ${e.message}`; }
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
                            const head = resStr.slice(0, 300);
                            const tail = resStr.slice(-100);
                            lastMsg.content = `${head}\n...[error output compressed: ${resStr.length} chars total]...\n${tail}`;
                            Logger.info('TOOL_RESULT_COMPRESSED', { tool: tc.name, original: resStr.length, compressed: lastMsg.content.length });
                        }
                    }
                }

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
                const compacted = autoCompactIfNeeded(run.messages, Math.floor(COMPACT_BUDGET * 0.6));
                const baseMsgs  = compacted.compacted ? compacted.messages : run.messages;
                const finalMsgs = [
                    { role: 'system', content: sysPrompt },
                    ...baseMsgs,
                    { role: 'user', content: '<system-reminder>\nYou have reached the tool-call iteration limit without producing a user-facing answer. Stop calling tools. Write a concise plain-text reply that: (1) summarises what you tried, (2) states what you found or could not find, (3) suggests a concrete next step the user can take.\n</system-reminder>' },
                ];
                let tail = '';
                await streamDeepSeek(
                    { apiKey, baseUrl, messages: finalMsgs, model, noTools: true },
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
        run.abortCtrl = null;
        run.busy = false;

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
    }
}

module.exports = { AgentLoop, injectSyntheticSkillRead };
