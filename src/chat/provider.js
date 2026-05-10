// ChatViewProvider: webview wiring, session management, agentic tool-calling loop.
'use strict';

const vscode = require('vscode');
const path = require('path');

const { Logger } = require('../logger');
const { friendlyError } = require('../errors');
const { computeCost } = require('../pricing');
const { buildSystemPrompt } = require('../prompts/system');
const { streamDeepSeek } = require('../api/deepseek');
const { wsRoot } = require('../utils/paths');
const {
    toolReadFile, toolListDir, toolGrepSearch, toolFindFiles,
    toolWriteFile, toolStrReplaceInFile, toolRunShell,
} = require('../tools/exec');
const { t, isZh } = require('../utils/i18n');
const { openFile } = require('./openFile');
const { buildWebviewHtml } = require('../webview/html');

// Approx token estimator — fast, no tokenizer dependency. ~3.6 chars/token
// is conservative for English+code; CJK is denser but DeepSeek's vocab
// matches that closely. Used for autoCompact triggers, never for billing.
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 3.6);
}
function estimateMessagesTokens(messages) {
    let n = 0;
    for (const m of messages) {
        if (typeof m.content === 'string') n += estimateTokens(m.content);
        else if (Array.isArray(m.content)) {
            for (const p of m.content) if (p && typeof p.text === 'string') n += estimateTokens(p.text);
        }
        if (m.tool_calls) for (const tc of m.tool_calls) n += estimateTokens(tc.function?.arguments || '');
        n += 8; // role / structural overhead
    }
    return n;
}

// Compact older tool messages when the conversation grows too large.
// Strategy (Claude-Code style, simplified):
//   - Keep the system prompt (added separately by the caller).
//   - Keep the most recent KEEP_TAIL messages verbatim.
//   - Replace older tool result bodies with a placeholder that preserves
//     tool_call_id linkage but drops the content. Older user/assistant
//     text is summarized into a single user-role <system-reminder>.
function autoCompactIfNeeded(messages, budgetTokens) {
    const total = estimateMessagesTokens(messages);
    if (total <= budgetTokens) return { messages, compacted: false, dropped: 0 };

    const KEEP_TAIL = 12;
    if (messages.length <= KEEP_TAIL + 2) return { messages, compacted: false, dropped: 0 };

    const tail = messages.slice(-KEEP_TAIL);
    const head = messages.slice(0, -KEEP_TAIL);

    // Always keep the FIRST user message verbatim (anchors the task).
    const firstUserIdx = head.findIndex(m => m.role === 'user');
    const firstUser = firstUserIdx >= 0 ? head[firstUserIdx] : null;

    let droppedToolBytes = 0;
    let droppedAsstChars = 0;
    let droppedUserChars = 0;
    for (const m of head) {
        if (m === firstUser) continue;
        if (m.role === 'tool') droppedToolBytes += String(m.content || '').length;
        else if (m.role === 'assistant') droppedAsstChars += String(m.content || '').length;
        else if (m.role === 'user') droppedUserChars += String(m.content || '').length;
    }

    const summary = {
        role: 'user',
        content: `<system-reminder>\nEarlier conversation auto-compacted to fit the context window. Original first user message preserved above. ${head.length - (firstUser ? 1 : 0)} earlier messages summarised: ${droppedAsstChars} chars assistant text, ${droppedUserChars} chars user text, ${droppedToolBytes} chars tool output. Refer to the user's most recent messages for current intent.\n</system-reminder>`,
    };

    const out = [];
    if (firstUser) out.push(firstUser);
    out.push(summary);
    out.push(...tail);
    return { messages: out, compacted: true, dropped: head.length - (firstUser ? 1 : 0) };
}

class ChatViewProvider {
    static viewType = 'deepseek.chatView';

    constructor(context) {
        this._context    = context;
        this._view       = null;
        this._panel      = null;
        this._includeCtx = false;
        // Foreground session id (currently displayed in the webview). null = empty/initial view.
        this._sessionId  = null;
        // Per-session in-flight runs. A run survives session switches and only ends
        // when the agentic loop completes or the user explicitly stops it.
        // Map<sessionId, { sessionId, messages, abortCtrl, reply, busy, events }>
        this._runs       = new Map();
    }

    // ─── Run helpers ───────────────────────────────────────────────────
    _newRun(sessionId) {
        const run = {
            sessionId,
            messages: [],
            abortCtrl: null,
            reply: { user: '', asst: '', thoughts: '' },
            busy: false,
            events: [],   // buffered webview events for replay on session switch
        };
        this._runs.set(sessionId, run);
        return run;
    }
    _runPost(run, msg) {
        // Buffer event so we can replay if the user switches away and comes back.
        run.events.push(msg);
        // Forward live only when this run's session is the foreground session.
        if (run.sessionId === this._sessionId) this._post(msg);
    }
    _activeRun() {
        return this._sessionId ? (this._runs.get(this._sessionId) || null) : null;
    }

    // ─── Sessions store (globalState) ──────────────────────────────────
    _currentWs() {
        const f = vscode.workspace.workspaceFolders;
        return (f && f[0] && f[0].uri && f[0].uri.fsPath) || '';
    }
    _sessionsAll() {
        return this._context.globalState.get('deepseekAgent.sessions', []);
    }
    async _sessionsSet(list) {
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        if (list.length > 100) list = list.slice(0, 100);
        await this._context.globalState.update('deepseekAgent.sessions', list);
    }
    async _appendToSession(sid, userText, asstText, thoughts, usage) {
        if (!sid) return;
        if (!userText && !asstText) return;
        const list = this._sessionsAll();
        let s = list.find(x => x.id === sid);
        if (!s) {
            s = { id: sid, title: (userText || t('sessionUntitled')).slice(0, 40), createdAt: Date.now(), updatedAt: Date.now(), ws: this._currentWs(), messages: [] };
            list.unshift(s);
        } else if (!s.ws) {
            s.ws = this._currentWs();
        }
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        s.model = cfg.get('defaultModel') || 'deepseek-v4-pro';
        s.mode  = cfg.get('approvalMode') || 'manual';
        if (userText) s.messages.push({ role: 'user', text: userText });
        if (asstText || thoughts) s.messages.push({ role: 'assistant', text: asstText || '', thoughts: thoughts || '' });
        if (s.messages.length > 200) s.messages = s.messages.slice(-200);
        const last = s.messages[s.messages.length - 1];
        s.preview   = (last && last.text || '').replace(/\s+/g, ' ').slice(0, 80);
        s.msgCount  = s.messages.length;
        s.updatedAt = Date.now();
        // Aggregate cost / token totals so users can review usage history.
        if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
            s.totals = s.totals || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_cny: 0, turns: 0 };
            s.totals.prompt_tokens     += Number(usage.prompt_tokens     || 0);
            s.totals.completion_tokens += Number(usage.completion_tokens || 0);
            s.totals.total_tokens      += Number(usage.total_tokens      || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
            s.totals.cost_cny          += Number(usage.cost_cny          || 0);
            s.totals.turns             += 1;
        }
        await this._sessionsSet(list);
        this._postSessionList();
    }
    // Create an empty session record up front so that long-running tasks have
    // a stable id even when the user switches away before completion.
    async _ensureSession(initialUserText) {
        if (this._sessionId) return this._sessionId;
        const id = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const list = this._sessionsAll();
        const s = {
            id,
            title: (initialUserText || t('sessionUntitled')).slice(0, 40),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ws: this._currentWs(),
            messages: [],
            preview: '',
            msgCount: 0,
        };
        list.unshift(s);
        this._sessionId = id;
        await this._sessionsSet(list);
        this._postSessionList();
        return id;
    }
    _postSessionList() {
        const runs = this._runs;
        this._post({
            type: 'sessions', currentWs: this._currentWs(),
            items: this._sessionsAll().map(s => ({
                id: s.id, title: s.title, preview: s.preview, msgCount: s.msgCount,
                model: s.model, mode: s.mode, ws: s.ws || '', createdAt: s.createdAt, updatedAt: s.updatedAt,
                busy: !!(runs.get(s.id) && runs.get(s.id).busy),
            })),
            activeId: this._sessionId,
        });
    }
    async _sessionLoad(id) {
        const s = this._sessionsAll().find(x => x.id === id);
        if (!s) return;
        this._sessionId = s.id;
        // Send persisted messages first so the webview rebuilds prior turns.
        this._post({ type: 'sessionLoaded', id: s.id, messages: s.messages || [] });
        this._postSessionList();
        // If this session has an in-flight run, replay all buffered events so the
        // user sees the live state (current user msg, deltas, tool cards, busy state).
        const run = this._runs.get(id);
        if (run) {
            for (const ev of run.events) this._post(ev);
        }
    }
    async _sessionNew() {
        // Switch foreground to "no session". Any running tasks in the background
        // continue independently and will be visible again when the user reopens
        // their session from the list.
        this._sessionId = null;
        this._post({ type: 'sessionLoaded', id: null, messages: [] });
        this._postSessionList();
    }
    async _sessionDelete(id) {
        // Abort any in-flight run for this session before deleting.
        const run = this._runs.get(id);
        if (run) {
            run.discarded = true;
            try { run.abortCtrl && run.abortCtrl.abort(); } catch {}
            this._runs.delete(id);
        }
        let list = this._sessionsAll().filter(x => x.id !== id);
        if (this._sessionId === id) { this._sessionId = null; }
        await this._sessionsSet(list);
        this._postSessionList();
        if (!this._sessionId) this._post({ type: 'sessionLoaded', id: null, messages: [] });
    }
    async _sessionRename(id, title) {
        const list = this._sessionsAll();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.title = String(title || '').slice(0, 80) || s.title;
        s.updatedAt = Date.now();
        await this._sessionsSet(list);
        this._postSessionList();
    }

    // ─── Webview wiring ────────────────────────────────────────────────
    get _activeWebview() {
        return this._panel?.webview || this._view?.webview || null;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
        };
        webviewView.webview.html = buildWebviewHtml(webviewView.webview, this._context.extensionUri);
        webviewView.webview.onDidReceiveMessage(msg => this._onMessage(msg));
    }

    bindPanel(panel) {
        this._panel = panel;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
        };
        panel.webview.html = buildWebviewHtml(panel.webview, this._context.extensionUri);
        panel.webview.onDidReceiveMessage(msg => this._onMessage(msg));
        panel.onDidDispose(() => { if (this._panel === panel) this._panel = null; });
    }

    _onMessage(msg) {
        switch (msg.type) {
            case 'ready': {
                const cfg = vscode.workspace.getConfiguration('deepseekAgent');
                this._post({ type: 'modelInfo', model: cfg.get('defaultModel') || 'deepseek-v4-pro', approvalMode: cfg.get('approvalMode') || 'manual' });
                this._postSessionList();
                // Always start with a fresh, empty conversation view on workspace open.
                // Previous sessions remain accessible via the session list panel.
                if (!this._sessionId) {
                    this._post({ type: 'sessionLoaded', id: null, messages: [] });
                }
                break;
            }
            case 'sessionList':   this._postSessionList(); break;
            case 'sessionLoad':   this._sessionLoad(msg.id); break;
            case 'sessionNew':    this._sessionNew(); break;
            case 'sessionDelete': this._sessionDelete(msg.id); break;
            case 'sessionRename': this._sessionRename(msg.id, msg.title); break;
            case 'setMode': {
                const cfg = vscode.workspace.getConfiguration('deepseekAgent');
                cfg.update('approvalMode', msg.mode, vscode.ConfigurationTarget.Global)
                    .then(() => this._post({ type: 'modelInfo', approvalMode: msg.mode }));
                break;
            }
            case 'setModel': {
                const cfg = vscode.workspace.getConfiguration('deepseekAgent');
                cfg.update('defaultModel', msg.model, vscode.ConfigurationTarget.Global)
                    .then(() => this._post({ type: 'modelInfo', model: msg.model }));
                break;
            }
            case 'openApiSettings':
                vscode.commands.executeCommand('deepseekAgent.showApiStatus');
                break;
            case 'openFile':
                openFile(msg.path, msg.line);
                break;
            case 'send':
                this._handleSend(msg.text);
                break;
            case 'stop': {
                // Only abort the foreground session's run; background runs keep going.
                const run = this._activeRun();
                if (run && run.abortCtrl) { run.abortCtrl.abort(); run.abortCtrl = null; }
                break;
            }
            case 'insert':
                this._insertToEditor(msg.code);
                break;
            case 'insertTerminal':
                this._sendToTerminal(msg.code, false);
                break;
            case 'runTerminal':
                this._sendToTerminal(msg.code, true);
                break;
            case 'copy':
                vscode.env.clipboard.writeText(msg.code)
                    .then(() => vscode.window.setStatusBarMessage('已复制到剪贴板', 2000));
                break;
            case 'clear':
                // Clear the foreground view only. Background runs are not aborted.
                this._sessionId = null;
                break;
            case 'contextToggle':
                this._includeCtx = !!msg.active;
                break;
            case 'regenerate': {
                const run = this._activeRun();
                if (run && run.busy) break;
                if (!run) break;
                let lastUser = '';
                while (run.messages.length) {
                    const last = run.messages[run.messages.length - 1];
                    if (last.role === 'user') {
                        const c = last.content;
                        if (typeof c === 'string') lastUser = c;
                        else if (Array.isArray(c)) {
                            const t = c.find(p => p && p.type === 'text');
                            lastUser = t ? (t.text || '') : '';
                        }
                        run.messages.pop();
                        break;
                    }
                    run.messages.pop();
                }
                const stripped = lastUser.replace(/^---\s*\n[\s\S]*?\n---\s*\n\n?/, '');
                if (stripped.trim()) this._handleSend(stripped);
                break;
            }
            case 'feedback':
                vscode.window.setStatusBarMessage(msg.value === 'up' ? '👍 已记录' : '👎 已记录', 1500);
                break;
        }
    }

    // ─── Agentic Loop ──────────────────────────────────────────────────
    async _handleSend(text) {
        if (!text?.trim()) return;
        // Reject if the foreground session is already running. Background sessions
        // keep their own busy state independently.
        const existingActive = this._activeRun();
        if (existingActive && existingActive.busy) return;

        const apiKey = await this._context.secrets.get('deepseekAgent.apiKey');
        if (!apiKey) {
            this._post({ type: 'error', text: '请先设置 API Key — 点击工具栏 🔑 按钮' });
            return;
        }

        // Ensure we have a session id BEFORE starting so that switching away mid-run
        // can find this run in `_runs` and resume rendering it.
        const sid = await this._ensureSession(text);
        let run = this._runs.get(sid);
        if (!run) run = this._newRun(sid);
        run.busy = true;

        const cfg     = vscode.workspace.getConfiguration('deepseekAgent');
        const model   = cfg.get('defaultModel') || 'deepseek-v4-pro';
        const baseUrl = (cfg.get('apiBaseUrl') || '').trim() || 'https://api.deepseek.com';
        const mode    = cfg.get('approvalMode') || 'manual';

        // Copilot-style attachment injection. Always include a lightweight
        // hint about what file the user is currently looking at — this is the
        // mechanism that keeps the model from blindly scanning the workspace,
        // because the relevant context is already on the table.
        //   - includeCtx OFF (default): file path + selection only (cheap)
        //   - includeCtx ON:            file path + selection + visible body
        const attachment = this._buildAttachmentBlock(this._includeCtx);
        const userContent = attachment ? attachment + '\n\n' + text : text;

        run.reply = { user: text, asst: '', thoughts: '' };
        run.messages.push({ role: 'user', content: userContent });

        Logger.info('USER_SEND', { sid, len: text.length, model, baseUrl, mode, includeCtx: this._includeCtx, text: text.slice(0, 2000) });

        // Echo the user message via the run's event stream so it survives session switches.
        this._runPost(run, { type: 'userEcho', text });
        this._runPost(run, { type: 'replyStart' });
        // Refresh session list so the active session shows a "busy" indicator
        // (GitHub Copilot–style) instead of a global "思考中" status banner.
        this._postSessionList();

        run.abortCtrl = new AbortController();
        const signal  = run.abortCtrl.signal;

        // Build the system prompt ONCE per send. Workspace instructions
        // (DEEPCOPILOT.md) are always included if the file exists — they are
        // user-curated and cheap. The system prompt itself never embeds the
        // workspace path or directory listing — that primes the model to scan.
        const sysPrompt = buildSystemPrompt({ includeWorkspaceInstructions: true });

        // Configurable iteration cap — hard ceiling for runaway loops.
        const MAX_ITERS = Math.max(1, Math.min(64, Number(cfg.get('maxIterations')) || 15));
        // Token budget for autoCompact. Conservative: keep ~70% of model's
        // window for the reply + system prompt headroom.
        const COMPACT_BUDGET = Math.max(8000, Number(cfg.get('compactBudgetTokens')) || 96000);

        // Mode dispatch (Copilot-style). The user picks Ask vs. Agent in the
        // webview header. In 'ask' mode tools are NEVER sent to the API — the
        // model physically cannot scan the workspace. In 'agent' mode the
        // prompt + tool descriptions + DeepSeek reminder do the gating.
        // No regex / heuristic per-message classifier — that approach is
        // fragile and was removed in 0.24.0.
        const interactionMode = cfg.get('interactionMode') || 'agent';
        const askMode = interactionMode === 'ask';
        Logger.info('INTERACTION_MODE', { mode: interactionMode });

        let iter = 0;
        const recentToolSig = [];
        const repeatHintEmitted = new Set(); // per (tool|argsHash) — emit at most once each
        let lastDeltaFlush = 0;
        let pendingDelta = '';
        const flushDelta = () => {
            if (!pendingDelta) return;
            const text = pendingDelta;
            pendingDelta = '';
            this._runPost(run, { type: 'replyDelta', text });
        };

        let lastUsage = null;
        try {
            while (iter++ < MAX_ITERS) {
                // autoCompact in place if we are blowing past the budget.
                const compactRes = autoCompactIfNeeded(run.messages, COMPACT_BUDGET);
                if (compactRes.compacted) {
                    run.messages = compactRes.messages;
                    Logger.info('AUTOCOMPACT', { sid, iter, dropped: compactRes.dropped });
                    this._runPost(run, { type: 'status', text: isZh() ? '🗜 压缩历史…' : 'Compacting history…' });
                }

                const msgs = [{ role: 'system', content: sysPrompt }, ...run.messages];
                let assistantText = '';
                let reasoningText = '';

                Logger.info('ITER_START', { sid, iter, msg_count: msgs.length, est_tokens: estimateMessagesTokens(msgs) });
                const iterT0 = Date.now();

                // Ask mode → no tools at all. Agent mode → all tools, model decides.
                const noTools = askMode;

                const { toolCalls, usage } = await streamDeepSeek(
                    { apiKey, baseUrl, messages: msgs, model, noTools },
                    {
                        onDelta: (delta) => {
                            assistantText += delta; run.reply.asst += delta;
                            // Throttle webview deltas: flush at most every 60ms or
                            // when the buffer crosses 256 chars. Fixes #20 jank.
                            pendingDelta += delta;
                            const now = Date.now();
                            if (pendingDelta.length >= 256 || now - lastDeltaFlush >= 60) {
                                lastDeltaFlush = now;
                                flushDelta();
                            }
                        },
                        onThinking: (delta) => { reasoningText += delta; run.reply.thoughts += delta; Logger.thinking(delta); this._runPost(run, { type: 'thinkingDelta', text: delta }); },
                    },
                    signal,
                );
                flushDelta();
                if (usage) lastUsage = usage;

                Logger.flush();
                Logger.info('ITER_END', {
                    sid, iter,
                    elapsed_ms: Date.now() - iterT0,
                    assistant_chars: assistantText.length,
                    reasoning_chars: reasoningText.length,
                    tool_calls: toolCalls.length,
                    usage,
                });
                if (assistantText) Logger.info('ASSISTANT', assistantText.slice(0, 4000));

                if (usage) {
                    const { cost_cny, breakdown } = computeCost(model, usage);
                    this._runPost(run, { type: 'usage', usage: { ...usage, cost_cny, breakdown, model } });
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

                this._runPost(run, { type: 'newTurn' });

                for (const tc of toolCalls) {
                    let args;
                    try { args = JSON.parse(tc.args || '{}'); } catch { args = {}; }
                    // Webview expects args as a JSON STRING (its shortArgs/toolMeta
                    // helpers call JSON.parse). Send the raw string, not the object.
                    const argsStr = tc.args || '{}';

                    Logger.info('TOOL_CALL', { id: tc.id, name: tc.name, args });
                    const tT0 = Date.now();

                    this._runPost(run, { type: 'toolStart', id: tc.id, name: tc.name, args: argsStr });

                    let result = '';
                    try {
                        result = await this._executeTool(tc.name, args, mode, run, signal);
                    } catch (e) {
                        result = `Error: ${e.message}`;
                    }
                    // Defensive: tools should return strings, but guard against
                    // accidental object/undefined returns so the UI never sees
                    // "[object Object]" or "undefined" as a tool output.
                    if (typeof result !== 'string') {
                        try { result = JSON.stringify(result); } catch { result = String(result); }
                    }

                    Logger.info('TOOL_RESULT', {
                        id: tc.id,
                        name: tc.name,
                        elapsed_ms: Date.now() - tT0,
                        ok: !String(result).startsWith('Error'),
                        output: String(result).slice(0, 2000),
                        truncated: String(result).length > 2000,
                    });

                    this._runPost(run, { type: 'toolResult', id: tc.id, name: tc.name, ok: !result.startsWith('Error'), output: result.slice(0, 600) });

                    run.messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: String(result),
                    });

                    const resStr = String(result);
                    const lowInfo = resStr.length < 80 || /^\(no output/.test(resStr) || /^Exit \d+: ?$/.test(resStr.trim());
                    const key = tc.name + '|' + (tc.args || '');
                    const sig = resStr.slice(0, 60) + '||' + resStr.slice(-60);
                    recentToolSig.push({ key, sig, lowInfo });
                    if (recentToolSig.length > 8) recentToolSig.shift();

                    // (a) Same key+sig repeated (low-info) → emit per-tool hint once.
                    const sameKeySig = recentToolSig.filter(e => e.key === key && e.sig === sig && e.lowInfo);
                    if (sameKeySig.length >= 2 && !repeatHintEmitted.has(key)) {
                        repeatHintEmitted.add(key);
                        // Use role:'user' with <system-reminder> tag — broader API
                        // compatibility than mid-conversation role:'system'.
                        const hint = `<system-reminder>\nYou have called \`${tc.name}\` with the same arguments ${sameKeySig.length} times and received the same low-information result. STOP retrying this exact approach. Pick a fundamentally different strategy: (1) redirect command output to a file then read_file it back, (2) use a different tool (read_file/grep_search/list_dir/find_files), (3) split the operation into smaller verifiable steps, (4) ask the user for clarification. Do not repeat this call.\n</system-reminder>`;
                        run.messages.push({ role: 'user', content: hint });
                        Logger.info('REPEAT_HINT_INJECTED', { tool: tc.name, occurrences: sameKeySig.length });
                    }

                    // (b) ABAB cycle: same two keys alternating ≥3 times each.
                    if (recentToolSig.length >= 6 && !repeatHintEmitted.has('__cycle__')) {
                        const last6 = recentToolSig.slice(-6);
                        const ks = last6.map(e => e.key);
                        if (ks[0] === ks[2] && ks[2] === ks[4] && ks[1] === ks[3] && ks[3] === ks[5] && ks[0] !== ks[1]) {
                            repeatHintEmitted.add('__cycle__');
                            const hint = `<system-reminder>\nYou are oscillating between two tool calls without making progress. Stop the cycle. Either commit to one path with a fundamentally different argument set, or write a plain-text reply explaining what you found and ask the user how to proceed.\n</system-reminder>`;
                            run.messages.push({ role: 'user', content: hint });
                            Logger.info('CYCLE_HINT_INJECTED', { keys: [ks[0], ks[1]] });
                        }
                    }
                }
            }

            if (iter > MAX_ITERS && !run.reply.asst.trim()) {
                Logger.info('FORCE_FINAL_SUMMARY', { iter });
                // Compact aggressively before the final wrap-up so we do not
                // re-send a giant payload only to be told to summarise.
                const compacted = autoCompactIfNeeded(run.messages, Math.floor(COMPACT_BUDGET * 0.6));
                const baseMsgs = compacted.compacted ? compacted.messages : run.messages;
                const finalMsgs = [
                    { role: 'system', content: sysPrompt },
                    ...baseMsgs,
                    { role: 'user', content: '<system-reminder>\nYou have reached the tool-call iteration limit without producing a user-facing answer. Stop calling tools. Write a concise plain-text reply that: (1) summarises what you tried, (2) states what you found or could not find, (3) suggests a concrete next step the user can take.\n</system-reminder>' },
                ];
                let tail = '';
                await streamDeepSeek(
                    { apiKey, baseUrl, messages: finalMsgs, model, noTools: true },
                    {
                        onDelta:    t => { tail += t; run.reply.asst += t; this._runPost(run, { type: 'replyDelta', text: t }); },
                        onThinking: t => { run.reply.thoughts += t; this._runPost(run, { type: 'thinkingDelta', text: t }); },
                    },
                    signal,
                ).catch(e => Logger.info('FORCE_FINAL_SUMMARY_ERROR', { message: e.message }));
                if (tail) run.messages.push({ role: 'assistant', content: tail });
            }
        } catch (e) {
            Logger.info('LOOP_ERROR', { sid, message: e.message, stack: (e.stack || '').slice(0, 1500) });
            if (e.message !== 'aborted') {
                const fe = friendlyError(e);
                this._runPost(run, { type: 'error', title: fe.title, text: fe.tip, code: fe.code, retryable: fe.retryable, raw: fe.raw });
            }
        }

        Logger.info('SEND_END', { sid, iters: iter - 1, asst_chars: run.reply.asst.length, thought_chars: run.reply.thoughts.length });
        Logger.flush();

        // Flush any deltas still in the throttle buffer before signalling end.
        try { flushDelta(); } catch {}

        this._runPost(run, { type: 'replyEnd', empty: false });
        this._runPost(run, { type: 'status', text: '' });
        run.abortCtrl = null;
        run.busy = false;

        const r = run.reply;
        if (!run.discarded && (r.user || r.asst)) {
            // Attach computed cost so totals aggregation reflects ¥ spend.
            let usageWithCost = null;
            if (lastUsage) {
                try {
                    const { cost_cny } = computeCost(model, lastUsage);
                    usageWithCost = Object.assign({}, lastUsage, { cost_cny });
                } catch { usageWithCost = lastUsage; }
            }
            await this._appendToSession(sid, r.user, r.asst, r.thoughts, usageWithCost);
            // Auto-name the session from the FIRST assistant reply (cheap,
            // local heuristic — no extra API call).
            this._maybeAutoName(sid, r.user, r.asst).catch(() => {});
        }

        // Run is finished — drop the in-memory run; future replays come from the
        // persisted session messages.
        this._runs.delete(sid);
        // Refresh session list so the busy indicator clears for this session.
        this._postSessionList();
    }

    // ─── Tool Dispatcher ───────────────────────────────────────────────
    async _executeTool(name, args, approvalMode, run, abortSignal) {
        // Per-extension auto-approve / deny lists override approvalMode.
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        const denyList = cfg.get('denyTools') || [];
        const autoApprove = cfg.get('autoApproveTools') || [];
        if (denyList.includes(name)) return `Denied by configuration: ${name} is in denyTools.`;

        const isMutating = (name === 'write_file' || name === 'run_shell' || name === 'str_replace_in_file');
        if (approvalMode === 'readonly' && isMutating) {
            return t('deniedReadonly');
        }

        const skipApproval = autoApprove.includes(name);

        if ((name === 'write_file' || name === 'str_replace_in_file') && approvalMode === 'manual' && !skipApproval) {
            const desc = name === 'write_file' ? `${t('writeFileLabel')}${args.path}` : `${t('writeFileLabel')}${args.path} (str_replace)`;
            const ok = await this._requestApproval(desc, abortSignal);
            if (!ok) return t('deniedByUser');
        }

        if (name === 'run_shell' && (approvalMode === 'manual' || approvalMode === 'auto-edit') && !skipApproval) {
            if (approvalMode === 'manual') {
                const ok = await this._requestApproval(`${t('runCmdLabel')}${args.command}`, abortSignal);
                if (!ok) return t('deniedByUser');
            }
        }

        switch (name) {
            case 'read_file':           return toolReadFile(args);
            case 'list_dir':            return toolListDir(args);
            case 'grep_search':         return toolGrepSearch(args);
            case 'find_files':          return toolFindFiles(args);
            case 'write_file':          return toolWriteFile(args);
            case 'str_replace_in_file': return toolStrReplaceInFile(args);
            case 'run_shell':           return toolRunShell(args, { abortSignal });
            case 'update_plan': {
                const normStatus = (status, done) => {
                    if (done === true) return 'done';
                    const s = String(status || '').toLowerCase();
                    if (s === 'completed' || s === 'complete' || s === 'done') return 'done';
                    if (s === 'inprogress') return 'in_progress';
                    if (s === 'in_progress') return 'in_progress';
                    if (s === 'blocked') return 'blocked';
                    return 'pending';
                };
                const normTitle = (item, idx) => {
                    const raw = item?.title ?? item?.text ?? item?.step ?? item?.content;
                    const text = String(raw || '').trim();
                    return text || `Step ${idx + 1}`;
                };

                const rawSteps = Array.isArray(args?.plan)
                    ? args.plan
                    : (Array.isArray(args?.steps) ? args.steps : []);
                const steps = rawSteps.map((item, idx) => ({
                    title: normTitle(item, idx),
                    status: normStatus(item?.status, item?.done),
                }));

                const rawTodos = Array.isArray(args?.todos) ? args.todos : [];
                const todos = rawTodos.map((item, idx) => ({
                    title: normTitle(item, idx),
                    status: normStatus(item?.status, item?.done),
                }));

                if (run) this._runPost(run, { type: 'plan', steps, todos });
                else this._post({ type: 'plan', steps, todos });
                return 'Plan updated.';
            }
            default:
                return `Unknown tool: ${name}`;
        }
    }

    async _requestApproval(description, abortSignal) {
        const dialog = vscode.window.showInformationMessage(
            `${t('approvalRequest')}${description}`,
            { modal: true },
            t('approvalApprove'),
            t('approvalDeny'),
        );
        if (!abortSignal) {
            return (await dialog) === t('approvalApprove');
        }
        // Race the dialog against the abort signal so the user can stop a
        // hung agent loop without dismissing every modal first.
        return new Promise((resolve) => {
            let settled = false;
            const onAbort = () => { if (settled) return; settled = true; resolve(false); };
            if (abortSignal.aborted) return onAbort();
            abortSignal.addEventListener('abort', onAbort, { once: true });
            dialog.then(
                (ans) => {
                    if (settled) return; settled = true;
                    try { abortSignal.removeEventListener('abort', onAbort); } catch {}
                    resolve(ans === t('approvalApprove'));
                },
                () => { if (settled) return; settled = true; resolve(false); },
            );
        });
    }

    /**
     * Produce a human-readable session title from the first turn, without
     * spending an extra API call. Heuristic:
     *  - Take the first non-trivial sentence of the assistant reply.
     *  - If too short, fall back to the user's first sentence.
     *  - Cap at 60 chars.
     */
    async _maybeAutoName(sid, userText, asstText) {
        const list = this._sessionsAll();
        const s = list.find(x => x.id === sid);
        if (!s) return;
        // Only auto-name on the first turn (1 user + 1 assistant just stored).
        if (s.msgCount > 2) return;
        // Respect manually-renamed titles: skip if title differs from the original prefix.
        const originalPrefix = (userText || '').slice(0, 40);
        if (s.title && s.title !== originalPrefix && s.title !== t('sessionUntitled')) return;

        const stripCode = (txt) => String(txt || '')
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/`[^`]*`/g, ' ');
        const firstSentence = (txt) => {
            const cleaned = stripCode(txt).replace(/\s+/g, ' ').trim();
            if (!cleaned) return '';
            const m = cleaned.match(/^(.{8,80}?)([。.!?！？\n]|$)/);
            return m ? m[1].trim() : cleaned.slice(0, 60);
        };
        let title = firstSentence(asstText);
        if (title.length < 8) title = firstSentence(userText);
        title = title.slice(0, 60).trim();
        if (!title) return;
        s.title = title;
        s.updatedAt = Date.now();
        await this._sessionsSet(list);
        this._postSessionList();
    }

    // ─── Helpers ───────────────────────────────────────────────────────
    // Copilot-style attachment block. Always includes a pointer to the active
    // editor so the model knows what the user is "looking at" — this is the
    // single biggest reason production agents don't blindly scan the workspace.
    //
    // Two modes:
    //   heavy=false (default): file path + selection text only. Cheap. Tells
    //                          the model "this is the file in focus" so it
    //                          doesn't need to list_dir to find context.
    //   heavy=true (📎 ON):    additionally embeds the visible viewport body
    //                          (~3 KB) inline. Used when the user explicitly
    //                          asks the model to "look at this".
    _buildAttachmentBlock(heavy) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return null;
        const doc  = editor.document;
        if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return null;
        const sel  = editor.selection;
        const lang = doc.languageId;
        const root = wsRoot();
        const abs  = doc.fileName;
        const rel  = root && abs.startsWith(root)
            ? path.relative(root, abs).replace(/\\/g, '/')
            : path.basename(abs);

        const lines = [];
        lines.push('<attachments>');
        lines.push(`The user is currently viewing \`${rel}\` (${lang}).`);

        if (!sel.isEmpty) {
            const selected = doc.getText(sel);
            const startL   = sel.start.line + 1;
            const endL     = sel.end.line   + 1;
            const capped   = selected.length > 4000 ? selected.slice(0, 4000) + '\n... [selection truncated]' : selected;
            lines.push(`Selection (${rel}:${startL}-${endL}):`);
            lines.push('```' + lang);
            lines.push(capped);
            lines.push('```');
        } else if (heavy) {
            const range   = editor.visibleRanges[0];
            const visible = doc.getText(range).substring(0, 3000);
            const startL  = range.start.line + 1;
            const endL    = range.end.line   + 1;
            lines.push(`Visible viewport (${rel}:${startL}-${endL}):`);
            lines.push('```' + lang);
            lines.push(visible);
            lines.push('```');
        }

        lines.push('Prefer this attachment over scanning the workspace if it answers the question.');
        lines.push('</attachments>');
        return lines.join('\n');
    }

    _insertToEditor(code) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('请先在编辑器中打开一个文件'); return; }
        editor.edit(b => b.replace(editor.selection, code));
        vscode.window.setStatusBarMessage('✓ 代码已插入编辑器', 2500);
    }

    _sendToTerminal(code, execute) {
        if (!code) return;
        const NAME = 'Deep Copilot';
        let term = vscode.window.terminals.find(t => t.name === NAME);
        if (!term) term = vscode.window.createTerminal({ name: NAME, cwd: wsRoot() });
        term.show(true);
        const cleaned = code.split(/\r?\n/).map(l => l.replace(/^\s*(?:PS\s*[A-Za-z]?:?[^>]*>\s*|[#$]\s+)/, '')).join('\n');
        term.sendText(cleaned, !!execute);
    }

    _post(msg) {
        const wv = this._activeWebview;
        if (wv) wv.postMessage(msg);
    }

    postToWebview(type, payload) {
        this._post(Object.assign({ type }, payload || {}));
    }
}

module.exports = { ChatViewProvider };
