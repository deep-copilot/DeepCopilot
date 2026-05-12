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
     *   buildAttachment  : (heavy: boolean) => string|null,
     *   getIncludeCtx    : () => boolean,
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
        this._getIncludeCtx  = opts.getIncludeCtx;
    }

    // ─── Main entry ──────────────────────────────────────────────────────────

    async handleSend(text, attachments = []) {
        if (!text?.trim()) return;

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
        const attachment = this._buildAttachment(this._getIncludeCtx());
        let attachmentBlocks = attachment ? attachment + '\n\n' : '';
        if (attachments && attachments.length) {
            const MAX_TOTAL = 256 * 1024;
            let totalSize = 0;
            for (const a of attachments) {
                if (!a || !a.path) continue;
                const block = `<attachment path="${a.path}">\n${a.content || '(empty)'}\n</attachment>`;
                if (totalSize + block.length > MAX_TOTAL) {
                    attachmentBlocks += `<attachment path="${a.path}">(truncated — total attachment budget exceeded)</attachment>\n\n`;
                    break;
                }
                attachmentBlocks += block + '\n\n';
                totalSize += block.length;
            }
        }
        const userContent = attachmentBlocks ? attachmentBlocks + text : text;

        run.reply = { user: text, asst: '', thoughts: '' };
        run.messages.push({ role: 'user', content: userContent });

        Logger.info('USER_SEND', { sid, len: text.length, model, baseUrl, mode, text: text.slice(0, 2000) });
        this._postToRun(run, { type: 'userEcho', text });
        this._postToRun(run, { type: 'replyStart' });
        this._postSessionList();

        run.abortCtrl = new AbortController();
        const signal  = run.abortCtrl.signal;

        const sysPrompt = buildSystemPrompt({ includeWorkspaceInstructions: true });
        const MAX_ITERS = Math.max(1, Math.min(64, Number(cfg.get('maxIterations')) || 15));
        const COMPACT_BUDGET = Math.max(8000, Number(cfg.get('compactBudgetTokens')) || 96000);
        const askMode = (cfg.get('interactionMode') || 'agent') === 'ask';
        Logger.info('INTERACTION_MODE', { mode: cfg.get('interactionMode') || 'agent' });

        const READ_ONLY = new Set(['read_file', 'list_dir', 'grep_search', 'find_files', 'web_search']);

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
        try {
            while (iter++ < MAX_ITERS) {
                run._iter = iter;

                // Auto-compact
                const compactRes = autoCompactIfNeeded(run.messages, COMPACT_BUDGET);
                if (compactRes.compacted) {
                    run.messages = compactRes.messages;
                    Logger.info('AUTOCOMPACT', { sid, iter, dropped: compactRes.dropped });
                    this._postToRun(run, { type: 'status', text: isZh() ? '🗜 压缩历史…' : 'Compacting history…' });
                }

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

                const msgs = [{ role: 'system', content: sysPrompt }, ...run.messages];
                let assistantText = '';
                let reasoningText = '';
                Logger.info('ITER_START', { sid, iter, msg_count: msgs.length, est_tokens: estimateMessagesTokens(msgs) });

                // Pre-flight hard token cap — prevents HTTP 400 context-too-long errors.
                // DeepSeek context window is 128K tokens. We guard at 60K (conservative)
                // to leave room for the response. If still over after regular compaction,
                // run an aggressive pass (keepTail=6), then an emergency pass (keepTail=3).
                const MODEL_CTX_HARD_LIMIT = 60000;
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

                // Rebuild msgs in case pre-flight compaction modified run.messages
                const finalMsgs = [{ role: 'system', content: sysPrompt }, ...run.messages];

                const iterT0 = Date.now();

                const argStreamers = new Map();
                if (!run._earlyStartedTools) run._earlyStartedTools = new Set();
                const STREAMABLE_TOOLS = new Set(['write_file', 'str_replace_in_file', 'apply_patch']);
                const allTools = getToolDefs(mcpManager.getToolDefs());

                const { toolCalls, usage } = await streamDeepSeek(
                    { apiKey, baseUrl, messages: finalMsgs, model, noTools: askMode, tools: allTools },
                    {
                        onDelta: (delta) => {
                            assistantText += delta; run.reply.asst += delta;
                            pendingDelta += delta;
                            const now = Date.now();
                            if (pendingDelta.length >= 256 || now - lastDeltaFlush >= 60) {
                                lastDeltaFlush = now;
                                flushDelta();
                            }
                        },
                        onThinking: (delta) => {
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

                // Phase 1: read-only tools in parallel
                const parallelTasks = [];
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    if (!READ_ONLY.has(tc.name)) continue;
                    const args = this._exec.logToolStart(run, tc);
                    const tT0  = Date.now();
                    parallelTasks.push(
                        this._exec.execute(tc.name, args, mode, run, signal)
                            .catch(e => `Error: ${e.message}`)
                            .then(res => {
                                results[i] = { tc, args, result: this._exec.logToolResult(run, tc, res, Date.now() - tT0) };
                            })
                    );
                }
                if (parallelTasks.length) await Promise.all(parallelTasks);

                // Phase 2: mutating tools serially
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    if (READ_ONLY.has(tc.name)) continue;
                    const args = this._exec.logToolStart(run, tc);
                    const tT0  = Date.now();
                    let rawResult = '';
                    try { rawResult = await this._exec.execute(tc.name, args, mode, run, signal); }
                    catch (e) { rawResult = `Error: ${e.message}`; }
                    results[i] = { tc, args, result: this._exec.logToolResult(run, tc, rawResult, Date.now() - tT0) };
                }

                // Phase 3: push tool messages + loop-guard checks
                for (let i = 0; i < toolCalls.length; i++) {
                    const { tc, result } = results[i];
                    run.messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });

                    const resStr  = String(result);
                    const lowInfo = resStr.length < 80 || /^\(no output/.test(resStr) || /^Exit \d+: ?$/.test(resStr.trim());
                    const key     = tc.name + '|' + (tc.args || '');
                    const sig     = resStr.slice(0, 60) + '||' + resStr.slice(-60);
                    recentToolSig.push({ key, sig, lowInfo });
                    if (recentToolSig.length > 8) recentToolSig.shift();

                    // (a) Same key+sig repeated → emit per-tool hint once
                    const sameKeySig = recentToolSig.filter(e => e.key === key && e.sig === sig && e.lowInfo);
                    if (sameKeySig.length >= 2 && !repeatHintEmitted.has(key)) {
                        repeatHintEmitted.add(key);
                        run.messages.push({
                            role: 'user',
                            content: `<system-reminder>\nYou have called \`${tc.name}\` with the same arguments ${sameKeySig.length} times and received the same low-information result. STOP retrying this exact approach. Pick a fundamentally different strategy: (1) redirect command output to a file then read_file it back, (2) use a different tool (read_file/grep_search/list_dir/find_files), (3) split the operation into smaller verifiable steps, (4) ask the user for clarification. Do not repeat this call.\n</system-reminder>`,
                        });
                        Logger.info('REPEAT_HINT_INJECTED', { tool: tc.name, occurrences: sameKeySig.length });
                    }

                    // (b) ABAB cycle detection
                    if (recentToolSig.length >= 6 && !repeatHintEmitted.has('__cycle__')) {
                        const last6 = recentToolSig.slice(-6);
                        const ks = last6.map(e => e.key);
                        if (ks[0] === ks[2] && ks[2] === ks[4] && ks[1] === ks[3] && ks[3] === ks[5] && ks[0] !== ks[1]) {
                            repeatHintEmitted.add('__cycle__');
                            run.messages.push({
                                role: 'user',
                                content: `<system-reminder>\nYou are oscillating between two tool calls without making progress. Stop the cycle. Either commit to one path with a fundamentally different argument set, or write a plain-text reply explaining what you found and ask the user how to proceed.\n</system-reminder>`,
                            });
                            Logger.info('CYCLE_HINT_INJECTED', { keys: [ks[0], ks[1]] });
                        }
                    }

                    // (c) Write-category error classification (#40)
                    // Detect consecutive failures across write-class tools and inject a
                    // categorical-switch hint instead of letting the model try another variant.
                    const WRITE_TOOLS = new Set(['write_file', 'run_shell']);
                    const SHELL_ERROR_PAT = /error|failed|exception|unrecognized|unexpected token|cannot|access.?denied|not recognized|garbled|malformed/i;
                    if (WRITE_TOOLS.has(tc.name) && SHELL_ERROR_PAT.test(resStr)) {
                        writeErrorCount++;
                        if (writeErrorCount >= 2 && !repeatHintEmitted.has('__write_category__')) {
                            repeatHintEmitted.add('__write_category__');
                            run.messages.push({
                                role: 'user',
                                content: `<system-reminder>\nMultiple write operations have failed in a row. This is a CATEGORY failure — do not try another shell or write variant.\n\nClassify the error and switch category:\n- Garbled / missing chars / bad escaping → shell escape issue → use \`write_file\` (dedicated tool) with the exact content string\n- "Access Denied" / "Permission denied" → permissions → change the target path\n- "file in use" / "cannot access" → file lock → use a temp path\n- "not recognized" / "command not found" → missing tool → use a built-in alternative\n\nOne failure = entire category eliminated. If two categories have already failed, stop and ask the user.\n</system-reminder>`,
                            });
                            Logger.info('WRITE_CATEGORY_HINT_INJECTED', { tool: tc.name, writeErrorCount });
                        }
                    } else if (!SHELL_ERROR_PAT.test(resStr) && WRITE_TOOLS.has(tc.name)) {
                        // Successful write resets the counter
                        writeErrorCount = 0;
                    }

                    // (d) Context compression for large error results (#44)
                    // When a failed tool result is very large (e.g. file content echoed back with
                    // corruption), replace the stored message content with a compact summary so the
                    // context window does not fill with repeated identical payload.
                    const COMPRESS_THRESHOLD = 2000;
                    if (resStr.length > COMPRESS_THRESHOLD && SHELL_ERROR_PAT.test(resStr)) {
                        const lastMsg = run.messages[run.messages.length - 1];
                        if (lastMsg && lastMsg.role === 'tool' && lastMsg.tool_call_id === tc.id) {
                            const head = resStr.slice(0, 300);
                            const tail = resStr.slice(-100);
                            lastMsg.content = `${head}\n...[error output compressed: ${resStr.length} chars total]...\n${tail}`;
                            Logger.info('TOOL_RESULT_COMPRESSED', { tool: tc.name, original: resStr.length, compressed: lastMsg.content.length });
                        }
                    }
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
            Logger.info('LOOP_ERROR', { sid, message: e.message, stack: (e.stack || '').slice(0, 1500) });
            if (e.message !== 'aborted') {
                const fe = friendlyError(e);
                this._postToRun(run, { type: 'error', title: fe.title, text: fe.tip, code: fe.code, retryable: fe.retryable, raw: fe.raw });
            }
        }

        Logger.info('SEND_END', { sid, iters: iter - 1, asst_chars: run.reply.asst.length });
        Logger.flush();

        try { flushDelta(); } catch {}
        this._postToRun(run, { type: 'replyEnd', empty: false });
        this._postToRun(run, { type: 'status', text: '' });
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

module.exports = { AgentLoop };
