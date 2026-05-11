// ChatViewProvider: webview wiring, session management, agentic tool-calling loop.
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const { Logger } = require('../logger');
const { friendlyError } = require('../errors');
const { computeCost } = require('../pricing');
const { buildSystemPrompt } = require('../prompts/system');
const { streamDeepSeek } = require('../api/deepseek');
const { wsRoot, resolvePath } = require('../utils/paths');
const {
    toolReadFile, toolListDir, toolGrepSearch, toolFindFiles,
    toolWriteFile, toolStrReplaceInFile, toolApplyPatch, toolRunShell, toolWebSearch,
} = require('../tools/exec');
const { runHooks }   = require('../hooks');
const { mcpManager } = require('../mcp');
const { getToolDefs } = require('../tools/schema');
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

/**
 * Incrementally extracts `path` and the body of `content` (or `new_string` /
 * `new_content` / `text`) fields from a tool-call arguments JSON string that
 * arrives in chunks. Lets us surface "Editing foo.py" the instant the path
 * field is finished streaming and then forward the file body as it streams —
 * mirroring GitHub Copilot's live edit preview. */
class ToolArgsStreamer {
    constructor() {
        this.acc = '';
        this.pathEmitted = false;
        this.path = '';
        this.inContent = false;
        this.contentEnded = false;
        this.contentReadPos = 0;
        this.escapePending = false;
    }
    feed(chunk) {
        this.acc += chunk;
        const out = { newPath: null, contentDelta: '' };
        if (!this.pathEmitted) {
            const m = this.acc.match(/"(?:path|file|file_path|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m) {
                let p;
                try { p = JSON.parse('"' + m[1] + '"'); } catch { p = m[1]; }
                this.pathEmitted = true;
                this.path = p;
                out.newPath = p;
            }
        }
        if (!this.inContent && !this.contentEnded) {
            const sm = this.acc.match(/"(?:content|new_string|new_content|text)"\s*:\s*"/);
            if (sm) {
                this.inContent = true;
                this.contentReadPos = sm.index + sm[0].length;
            }
        }
        if (this.inContent && !this.contentEnded) {
            let i = this.contentReadPos;
            let buf = '';
            const len = this.acc.length;
            while (i < len) {
                if (this.escapePending) {
                    const c = this.acc[i];
                    let resolved = c;
                    if      (c === 'n') resolved = '\n';
                    else if (c === 't') resolved = '\t';
                    else if (c === 'r') resolved = '\r';
                    else if (c === '"') resolved = '"';
                    else if (c === '\\') resolved = '\\';
                    else if (c === '/') resolved = '/';
                    else if (c === 'b') resolved = '\b';
                    else if (c === 'f') resolved = '\f';
                    else if (c === 'u') {
                        if (i + 4 >= len) break;
                        const hex = this.acc.slice(i + 1, i + 5);
                        const code = parseInt(hex, 16);
                        resolved = Number.isNaN(code) ? '' : String.fromCharCode(code);
                        i += 4;
                    }
                    buf += resolved;
                    this.escapePending = false;
                    i++;
                    continue;
                }
                const c = this.acc[i];
                if (c === '\\') {
                    if (i + 1 >= len) break;
                    this.escapePending = true;
                    i++;
                    continue;
                }
                if (c === '"') { this.contentEnded = true; i++; break; }
                buf += c;
                i++;
            }
            this.contentReadPos = i;
            out.contentDelta = buf;
        }
        return out;
    }
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
        // Map<sessionId, { sessionId, messages, abortCtrl, reply, busy, events, toolCache }>
        this._runs       = new Map();
        // Initialize MCP servers in background (non-blocking).
        const _wsR = wsRoot();
        if (_wsR) mcpManager.init(_wsR).catch(e => Logger.info('MCP_INIT_ERROR', { message: e.message }));
    }

    // ─── Run helpers ───────────────────────────────────────────────────
    _newRun(sessionId, seedMessages = []) {
        const run = {
            sessionId,
            messages: seedMessages.length ? seedMessages.slice() : [],
            abortCtrl: null,
            reply: { user: '', asst: '', thoughts: '' },
            busy: false,
            events: [],   // buffered webview events for replay on session switch
            // Per-session tool result cache. Key: `${toolName}::${argsHash}`.
            // Read-only tools (read_file, grep_search, find_files, list_dir, web_search)
            // are cached; mutating tools invalidate relevant entries.
            toolCache: new Map(),
            // Per-turn file snapshots for revert_last_turn.
            // Key: absolute path, Value: original content string | null (null = file didn't exist).
            turnSnapshots: new Map(),
            // Latest plan/todos the model published via update_plan. Reinjected
            // as a <system-reminder> when the model goes ≥ N iterations without
            // touching it, so it does not forget the active checklist.
            plan: null,             // { steps:[{title,status}], todos:[{title,status}] } | null
            planUpdatedIter: -1,    // iter index when plan was last updated
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
            s = { id: sid, title: (userText || t('sessionUntitled')).slice(0, 15), createdAt: Date.now(), updatedAt: Date.now(), ws: this._currentWs(), messages: [] };
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
        // Persist API-format messages so next turn restores full history for the model.
        if (arguments[5] !== undefined) {
            const apiMsgs = arguments[5];
            const MAX_API = 200;
            const stripped = Array.isArray(apiMsgs) ? apiMsgs.map(m => {
                if (!m.reasoning_content) return m;
                const { reasoning_content, ...rest } = m; // eslint-disable-line no-unused-vars
                return rest;
            }) : [];
            s.apiMessages = stripped.length > MAX_API ? stripped.slice(-MAX_API) : stripped;
        }
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
    // Return persisted API-format messages for a session (for cross-turn context restore).
    _loadApiMessages(sid) {
        const s = this._sessionsAll().find(x => x.id === sid);
        return (s && Array.isArray(s.apiMessages)) ? s.apiMessages : [];
    }

    async _ensureSession(initialUserText) {
        if (this._sessionId) return this._sessionId;
        const id = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const list = this._sessionsAll();
        const s = {
            id,
            title: (initialUserText || t('sessionUntitled')).slice(0, 15),
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
            items: this._sessionsAll().filter(s => !s.archived).map(s => ({
                id: s.id, title: s.title, preview: s.preview, msgCount: s.msgCount,
                model: s.model, mode: s.mode, ws: s.ws || '', createdAt: s.createdAt, updatedAt: s.updatedAt,
                busy: !!runs.get(s.id)?.busy,
                pinned: !!s.pinned, unread: !!s.unread,
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
    async _sessionPin(id) {
        const list = this._sessionsAll();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.pinned = !s.pinned;
        await this._sessionsSet(list);
        this._postSessionList();
    }
    async _sessionUnread(id) {
        const list = this._sessionsAll();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.unread = !s.unread;
        await this._sessionsSet(list);
        this._postSessionList();
    }
    async _sessionArchive(id) {
        const list = this._sessionsAll();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.archived = !s.archived;
        if (this._sessionId === id && s.archived) {
            this._sessionId = null;
            this._post({ type: 'sessionLoaded', id: null, messages: [] });
        }
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

    async _onMessage(msg) {
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
            case 'sessionPin':    this._sessionPin(msg.id); break;
            case 'sessionUnread': this._sessionUnread(msg.id); break;
            case 'sessionArchive': this._sessionArchive(msg.id); break;
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
                this._handleSend(msg.text, msg.attachments || []);
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
            case 'codeBlockApply':
                await this._applyCodeBlock(msg.code, msg.lang);
                break;
            case 'codeBlockCreate':
                await this._createFileFromCodeBlock(msg.code, msg.lang);
                break;
            case 'clear':
                // Clear the foreground view only. Background runs are not aborted.
                this._sessionId = null;
                break;
            case 'contextToggle':
                this._includeCtx = !!msg.active;
                break;
            case 'regenerate': {
                let run = this._activeRun();
                if (run && run.busy) break;
                let lastUser = '';
                if (run) {
                    // In-flight run still in memory: pop trailing messages
                    // until the last user turn (inclusive).
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
                } else if (this._sessionId) {
                    // Run was reaped after replyEnd. Rebuild from persisted session.
                    const list = this._sessionsAll();
                    const s = list.find(x => x.id === this._sessionId);
                    if (!s) break;
                    // Pop trailing assistant (if any) from UI messages, then the last user.
                    const uiMsgs = s.messages || [];
                    if (!uiMsgs.length) break;
                    const tail = uiMsgs[uiMsgs.length - 1];
                    if (tail && tail.role === 'assistant') uiMsgs.pop();
                    const userTail = uiMsgs[uiMsgs.length - 1];
                    if (!userTail || userTail.role !== 'user') break;
                    lastUser = userTail.text || '';
                    uiMsgs.pop();
                    s.messages = uiMsgs;
                    s.msgCount = s.messages.length;
                    s.updatedAt = Date.now();
                    // Also drop the last user turn from apiMessages (and any trailing
                    // assistant/tool messages that followed it).
                    if (Array.isArray(s.apiMessages) && s.apiMessages.length) {
                        let lastUserIdx = -1;
                        for (let i = s.apiMessages.length - 1; i >= 0; i--) {
                            if (s.apiMessages[i].role === 'user') { lastUserIdx = i; break; }
                        }
                        if (lastUserIdx >= 0) s.apiMessages = s.apiMessages.slice(0, lastUserIdx);
                    }
                    await this._sessionsSet(list);
                    // Seed a fresh run with the retained API history (includes tool calls).
                    const seed = Array.isArray(s.apiMessages) ? s.apiMessages : [];
                    run = this._newRun(this._sessionId, seed);
                    this._postSessionList();
                }
                if (!lastUser) break;
                const stripped = lastUser
                    .replace(/^---\s*\n[\s\S]*?\n---\s*\n\n?/, '')
                    .replace(/^<attachments>[\s\S]*?<\/attachments>\s*\n*/, '')
                    .replace(/^(?:<attachment\b[\s\S]*?<\/attachment>\s*\n*)+/, '');
                if (stripped.trim()) this._handleSend(stripped);
                break;
            }
            case 'editUserMessage': {
                // Truncate run.messages to just before the message at the given index,
                // then echo the original text back to the webview for the user to edit.
                const run = this._activeRun();
                if (!run || run.busy) break;
                const idx = Number(msg.index);
                if (!Number.isFinite(idx) || idx < 0 || idx >= run.messages.length) break;
                // Find the idx-th user message in run.messages
                let userCount = -1;
                let spliceAt = -1;
                for (let i = 0; i < run.messages.length; i++) {
                    if (run.messages[i].role === 'user') {
                        userCount++;
                        if (userCount === idx) { spliceAt = i; break; }
                    }
                }
                if (spliceAt < 0) break;
                const m = run.messages[spliceAt];
                let text = '';
                if (typeof m.content === 'string') text = m.content;
                else if (Array.isArray(m.content)) {
                    const tp = m.content.find(p => p && p.type === 'text');
                    text = tp ? (tp.text || '') : '';
                }
                // Strip attachment blocks prepended to the content
                text = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n\n?/, '');
                text = text.replace(/<attachment path="[^"]*">[\s\S]*?<\/attachment>\n\n?/g, '').trim();
                // Truncate messages up to (but not including) this user message
                run.messages.splice(spliceAt);
                // Clear run events back to just before userEcho for this index so replays are clean
                this._post({ type: 'editFillInput', text });
                break;
            }
            case 'editUserSubmit': {
                // Inline edit submission: truncate history at the given user-message
                // index, then immediately resend with the new text. (GH Copilot inline mode.)
                const idx = Number(msg.index);
                const newText = String(msg.text || '').trim();
                if (!newText) break;
                if (!Number.isFinite(idx) || idx < 0) break;
                const run = this._activeRun();
                // 1) If a run is in flight, stop it first so we can resend cleanly.
                if (run && run.busy && run.abortCtrl) {
                    try { run.abortCtrl.abort(); } catch (_) {}
                    run.busy = false;
                }
                // 2) Truncate run.messages (API history) at the edited user index.
                if (run) {
                    let userCount = -1;
                    let spliceAt = -1;
                    for (let i = 0; i < run.messages.length; i++) {
                        if (run.messages[i].role === 'user') {
                            userCount++;
                            if (userCount === idx) { spliceAt = i; break; }
                        }
                    }
                    if (spliceAt >= 0) run.messages.splice(spliceAt);
                    // 3) Trim buffered events so session-switch replays are clean.
                    if (Array.isArray(run.events)) {
                        let echoCount = -1;
                        let cutAt = -1;
                        for (let i = 0; i < run.events.length; i++) {
                            const ev = run.events[i];
                            if (ev && ev.type === 'userEcho') {
                                echoCount++;
                                if (echoCount === idx) { cutAt = i; break; }
                            }
                        }
                        if (cutAt >= 0) run.events.splice(cutAt);
                    }
                }
                // 4) Also trim the persisted session messages so the DOM-rebuilt
                //    history on next load matches what the model will see.
                if (this._sessionId) {
                    const list = this._sessionsAll();
                    const s = list.find(x => x.id === this._sessionId);
                    if (s) {
                        // Trim UI messages at the edited user-message boundary.
                        if (Array.isArray(s.messages)) {
                            let userCount = -1;
                            let cutAt = -1;
                            for (let i = 0; i < s.messages.length; i++) {
                                if (s.messages[i].role === 'user') {
                                    userCount++;
                                    if (userCount === idx) { cutAt = i; break; }
                                }
                            }
                            if (cutAt >= 0) s.messages.splice(cutAt);
                        }
                        // Trim apiMessages at the same user-message boundary.
                        if (Array.isArray(s.apiMessages)) {
                            let apiUserCount = -1;
                            let apiCutAt = -1;
                            for (let i = 0; i < s.apiMessages.length; i++) {
                                if (s.apiMessages[i].role === 'user') {
                                    apiUserCount++;
                                    if (apiUserCount === idx) { apiCutAt = i; break; }
                                }
                            }
                            if (apiCutAt >= 0) s.apiMessages.splice(apiCutAt);
                        }
                        s.updatedAt = Date.now();
                        await this._sessionsSet(list);
                    }
                }
                this._handleSend(newText);
                break;
            }
            case 'feedback':
                vscode.window.setStatusBarMessage(msg.value === 'up' ? '👍 已记录' : '👎 已记录', 1500);
                break;
            case 'fileSearch': {
                // Webview asks for workspace file list matching a query (for @file popup).
                const q = String(msg.query || '').toLowerCase();
                const root = wsRoot();
                let files = [];
                try {
                    const found = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/.vscode/**}', 200);
                    files = found
                        .map(u => vscode.workspace.asRelativePath(u, false))
                        .filter(r => !q || r.toLowerCase().includes(q))
                        .slice(0, 30);
                } catch { /* ignore */ }
                this._post({ type: 'fileSearchResults', query: msg.query, files });
                break;
            }
            case 'fileContent': {
                // Webview wants file content for an attachment chip.
                const rel = String(msg.path || '');
                let content = '';
                let error = '';
                try {
                    const abs = path.join(wsRoot(), rel);
                    content = fs.readFileSync(abs, 'utf8');
                    const MAX = 64 * 1024;
                    if (content.length > MAX) content = content.slice(0, MAX) + '\n... [truncated]';
                } catch (e) { error = e.message; }
                this._post({ type: 'fileContentResult', path: rel, content, error });
                break;
            }
        }
    }

    // ─── Agentic Loop ──────────────────────────────────────────────────
    async _handleSend(text, attachments = []) {
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
        if (!run) {
            // Restore persisted API history so the model sees prior turns.
            const seed = this._loadApiMessages(sid);
            run = this._newRun(sid, seed);
        }
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

        // @file chips: prepend each attached file's content as a <attachment> block
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
                run._iter = iter;
                // autoCompact in place if we are blowing past the budget.
                const compactRes = autoCompactIfNeeded(run.messages, COMPACT_BUDGET);
                if (compactRes.compacted) {
                    run.messages = compactRes.messages;
                    Logger.info('AUTOCOMPACT', { sid, iter, dropped: compactRes.dropped });
                    this._runPost(run, { type: 'status', text: isZh() ? '🗜 压缩历史…' : 'Compacting history…' });
                }

                // Plan reminder: if a plan exists with incomplete steps and the
                // model has not touched it for ≥ 4 iterations, re-inject the
                // current checklist so it doesn't drift / forget. Emitted at
                // most once per stale window via a per-run watermark.
                if (run.plan && Array.isArray(run.plan.steps) && run.plan.steps.length) {
                    const hasOpen = run.plan.steps.some(s => s.status !== 'done');
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
                const iterT0 = Date.now();

                // Ask mode → no tools at all. Agent mode → all tools, model decides.
                const noTools = askMode;

                // Per-iteration streaming-args state. Lets us emit `toolStart`
                // as soon as the model finishes streaming the `path` field
                // (instead of waiting for the entire arguments JSON to land)
                // and forward `content` deltas to the webview live.
                const argStreamers = new Map();
                if (!run._earlyStartedTools) run._earlyStartedTools = new Set();
                const STREAMABLE_TOOLS = new Set(['write_file', 'str_replace_in_file', 'apply_patch']);

                const allTools = getToolDefs(mcpManager.getToolDefs());
                const { toolCalls, usage } = await streamDeepSeek(
                    { apiKey, baseUrl, messages: msgs, model, noTools, tools: allTools },
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
                        onToolArgsDelta: (ev) => {
                            if (!ev || !ev.name || !STREAMABLE_TOOLS.has(ev.name)) return;
                            let s = argStreamers.get(ev.index);
                            if (!s) { s = new ToolArgsStreamer(); argStreamers.set(ev.index, s); }
                            const r = s.feed(ev.deltaArgs || '');
                            if (r.newPath && ev.id && !run._earlyStartedTools.has(ev.id)) {
                                run._earlyStartedTools.add(ev.id);
                                this._runPost(run, {
                                    type: 'toolStart',
                                    id: ev.id,
                                    name: ev.name,
                                    args: JSON.stringify({ path: r.newPath }),
                                    streaming: true,
                                });
                            }
                            if (r.contentDelta) {
                                this._runPost(run, {
                                    type: 'toolArgsDelta',
                                    id: ev.id,
                                    name: ev.name,
                                    contentDelta: r.contentDelta,
                                });
                            }
                        },
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

                // ── Parallel / serial dispatch ─────────────────────────────────
                // Read-only tools can run in parallel; mutating tools are always
                // serialized to avoid workspace race conditions.
                const READ_ONLY = new Set(['read_file', 'list_dir', 'grep_search', 'find_files', 'web_search']);

                // Partition: parallel batch (read-only), then serial (mutating)
                // While preserving the original order for message assembly.
                const results = new Array(toolCalls.length);

                // Phase 1: launch all read-only tools concurrently
                const parallelTasks = [];
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    if (!READ_ONLY.has(tc.name)) continue;
                    const args = this._logToolStart(run, tc);
                    const tT0 = Date.now();
                    parallelTasks.push(
                        this._executeTool(tc.name, args, mode, run, signal)
                            .catch(e => `Error: ${e.message}`)
                            .then(res => {
                                const result = this._logToolResult(run, tc, res, Date.now() - tT0);
                                results[i] = { tc, args, result };
                            })
                    );
                }
                if (parallelTasks.length) await Promise.all(parallelTasks);

                // Phase 2: run mutating tools serially (in original order)
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    if (READ_ONLY.has(tc.name)) continue;
                    const args = this._logToolStart(run, tc);
                    const tT0 = Date.now();
                    let rawResult = '';
                    try { rawResult = await this._executeTool(tc.name, args, mode, run, signal); }
                    catch (e) { rawResult = `Error: ${e.message}`; }
                    const result = this._logToolResult(run, tc, rawResult, Date.now() - tT0);
                    results[i] = { tc, args, result };
                }

                // Phase 3: push all tool messages in original order + repetition detection
                for (let i = 0; i < toolCalls.length; i++) {
                    const { tc, result } = results[i];
                    run.messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });

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
            await this._appendToSession(sid, r.user, r.asst, r.thoughts, usageWithCost, run.messages);
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

    // Stable hash for tool args (cache key generation).
    _argsHash(name, args) {
        // Simple deterministic JSON hash — sufficient since we're in the same JS runtime.
        try { return `${name}::${JSON.stringify(args, Object.keys(args || {}).sort())}`; }
        catch { return `${name}::${String(args)}`; }
    }

    // CACHEABLE read-only tools whose results are stable unless the workspace changes.
    static _CACHEABLE = new Set(['read_file', 'grep_search', 'find_files', 'list_dir', 'web_search']);

    // MUTATING tools — after these run we must invalidate file-based cache entries.
    static _MUTATING = new Set(['write_file', 'str_replace_in_file', 'apply_patch', 'run_shell']);

    _invalidateCacheForMutation(run, name, args) {
        if (!run || !run.toolCache) return;
        // For file-writing tools we know the path; invalidate read_file cache for that path.
        const paths = new Set();
        if (args && args.path) paths.add(String(args.path));
        if (name === 'apply_patch' && args && args.patch) {
            // Extract paths from diff headers
            const matches = String(args.patch).matchAll(/^\+\+\+ (?:b\/)?(.+)/gm);
            for (const m of matches) paths.add(m[1].trim());
        }
        // For run_shell we can't know what changed; clear all file-based entries.
        if (name === 'run_shell' || paths.size === 0) {
            // Remove all read_file / list_dir / find_files / grep_search cache entries
            for (const key of run.toolCache.keys()) {
                if (key.startsWith('read_file::') || key.startsWith('list_dir::') ||
                    key.startsWith('find_files::') || key.startsWith('grep_search::')) {
                    run.toolCache.delete(key);
                }
            }
        } else {
            // Targeted invalidation by path
            for (const key of run.toolCache.keys()) {
                for (const p of paths) {
                    if (key.includes(p)) { run.toolCache.delete(key); break; }
                }
            }
        }
    }

    // ─── Tool logging helpers ──────────────────────────────────────────
    // Parse tc.args JSON, emit TOOL_CALL log + toolStart webview event.
    // Returns the parsed args object (used by both parallel and serial phases).
    _logToolStart(run, tc) {
        let args;
        try { args = JSON.parse(tc.args || '{}'); } catch { args = {}; }
        Logger.info('TOOL_CALL', { id: tc.id, name: tc.name, args });
        const already = run._earlyStartedTools && run._earlyStartedTools.has(tc.id);
        if (already) {
            // We already opened the tool card from the streaming args. Just
            // ship the finalized full args so the webview can refresh any
            // display that depends on them (line counts, target, etc).
            this._runPost(run, { type: 'toolArgsFinal', id: tc.id, name: tc.name, args: tc.args || '{}' });
        } else {
            this._runPost(run, { type: 'toolStart', id: tc.id, name: tc.name, args: tc.args || '{}' });
        }
        return args;
    }

    // Normalize result to string, emit TOOL_RESULT log + toolResult webview event.
    // Returns the normalized string so callers can store it in results[].
    _logToolResult(run, tc, result, elapsedMs) {
        if (typeof result !== 'string') {
            try { result = JSON.stringify(result); } catch { result = String(result); }
        }
        const ok = !result.startsWith('Error');
        Logger.info('TOOL_RESULT', { id: tc.id, name: tc.name, elapsed_ms: elapsedMs, ok, output: result.slice(0, 2000) });
        this._runPost(run, { type: 'toolResult', id: tc.id, name: tc.name, ok, output: result.slice(0, 600) });
        return result;
    }

    async _executeTool(name, args, approvalMode, run, abortSignal) {
        // Per-extension auto-approve / deny lists override approvalMode.
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        const denyList = cfg.get('denyTools') || [];
        const autoApprove = cfg.get('autoApproveTools') || [];
        if (denyList.includes(name)) return `Denied by configuration: ${name} is in denyTools.`;

        const isMutating = (name === 'write_file' || name === 'run_shell' || name === 'str_replace_in_file' || name === 'apply_patch');
        if (approvalMode === 'readonly' && isMutating) {
            return t('deniedReadonly');
        }

        const skipApproval = autoApprove.includes(name);

        if ((name === 'write_file' || name === 'str_replace_in_file' || name === 'apply_patch') && approvalMode === 'manual' && !skipApproval) {
            const desc = name === 'write_file' ? `${t('writeFileLabel')}${args.path}` : name === 'apply_patch' ? `${t('writeFileLabel')}(patch)` : `${t('writeFileLabel')}${args.path} (str_replace)`;
            const ok = await this._requestApproval(desc, abortSignal);
            if (!ok) return t('deniedByUser');
        }

        if (name === 'run_shell' && (approvalMode === 'manual' || approvalMode === 'auto-edit') && !skipApproval) {
            if (approvalMode === 'manual') {
                const ok = await this._requestApproval(`${t('runCmdLabel')}${args.command}`, abortSignal);
                if (!ok) return t('deniedByUser');
            }
        }

        // ── Cache lookup (read-only tools only) ───────────────────────
        const cache = run && run.toolCache;
        if (cache && ChatViewProvider._CACHEABLE.has(name)) {
            const cacheKey = this._argsHash(name, args);
            if (cache.has(cacheKey)) {
                const entry = cache.get(cacheKey);
                // File-based tools: revalidate via mtime
                if (name === 'read_file' && args.path) {
                    try {
                        const mtime = fs.statSync(resolvePath(args.path)).mtimeMs;
                        if (entry.mtime === mtime) {
                            return entry.result + '\n(cached)';
                        }
                        // mtime changed → fall through to fresh read, then re-cache below
                        cache.delete(cacheKey);
                    } catch { /* file gone or unreadable — fall through */ }
                } else {
                    return entry.result + '\n(cached)';
                }
            }
        }

        // ── Pre-edit snapshot for revert_last_turn ──────────────────
        if (run && run.turnSnapshots &&
            (name === 'write_file' || name === 'str_replace_in_file' || name === 'apply_patch')) {
            this._snapshotForEdit(run, name, args);
        }

        const result = await this._dispatchTool(name, args, run, abortSignal);

        // ── Cache store ───────────────────────────────────────────────
        if (cache && ChatViewProvider._CACHEABLE.has(name) && typeof result === 'string' && !result.startsWith('Error:')) {
            const cacheKey = this._argsHash(name, args);
            const entry = { result };
            if (name === 'read_file' && args.path) {
                try {
                    entry.mtime = fs.statSync(resolvePath(args.path)).mtimeMs;
                } catch { /* ignore */ }
            }
            cache.set(cacheKey, entry);
        }

        // ── Cache invalidation (mutating tools) ───────────────────────
        if (ChatViewProvider._MUTATING.has(name)) {
            this._invalidateCacheForMutation(run, name, args);
        }

        // ── After-tool hooks ──────────────────────────────────────────
        if (typeof result === 'string' && !result.startsWith('Error')) {
            const wsR = wsRoot();
            if (wsR) {
                try {
                    const hookOut = await runHooks('after_tool', name, wsR);
                    if (hookOut) return result + '\n\n[hooks]\n' + hookOut;
                } catch (e) {
                    Logger.info('HOOK_ERROR', { name, message: e.message });
                }
            }
        }

        // ── Post-edit diagnostics (best-effort) ───────────────────────
        // After a successful edit, append the current Error/Warning
        // diagnostics so the model can self-verify before reporting success.
        // Disabled via setting `deepseekAgent.postEditDiagnostics: false`.
        if (typeof result === 'string'
            && !result.startsWith('Error')
            && (name === 'write_file' || name === 'str_replace_in_file' || name === 'apply_patch')) {
            const cfg2 = vscode.workspace.getConfiguration('deepseekAgent');
            if (cfg2.get('postEditDiagnostics', true)) {
                try {
                    const diagBlock = await this._collectPostEditDiagnostics(name, args);
                    if (diagBlock) return result + '\n\n' + diagBlock;
                } catch (e) {
                    Logger.info('POST_EDIT_DIAG_ERROR', { message: e.message });
                }
            }
        }

        return result;
    }

    // Collect VS Code language-server diagnostics for files just edited.
    // Returns a compact markdown block or '' if no notable issues.
    async _collectPostEditDiagnostics(name, args) {
        const paths = [];
        if (name === 'write_file' || name === 'str_replace_in_file') {
            if (args && args.path) paths.push(args.path);
        } else if (name === 'apply_patch') {
            const patch = String(args && args.patch || '');
            const re = /^\+\+\+ (?:b\/)?(\S+)/gm;
            let m;
            while ((m = re.exec(patch)) !== null) {
                if (m[1] && m[1] !== '/dev/null') paths.push(m[1]);
                if (paths.length >= 6) break;
            }
        }
        if (!paths.length) return '';

        // Give language servers a moment to reanalyze the file.
        await new Promise(r => setTimeout(r, 500));

        const sevName = (s) => ['Error', 'Warning', 'Info', 'Hint'][s] || 'Info';
        const lines = [];
        let totalErr = 0, totalWarn = 0;
        for (const rel of paths) {
            let abs;
            try { abs = resolvePath(rel); } catch { continue; }
            let uri;
            try { uri = vscode.Uri.file(abs); } catch { continue; }
            const diags = vscode.languages.getDiagnostics(uri) || [];
            if (!diags.length) continue;
            // Keep only Errors and Warnings; cap at 8 per file.
            const filt = diags
                .filter(d => d.severity === vscode.DiagnosticSeverity.Error
                          || d.severity === vscode.DiagnosticSeverity.Warning)
                .slice(0, 8);
            if (!filt.length) continue;
            lines.push(`- ${rel}:`);
            for (const d of filt) {
                const sev = sevName(d.severity);
                const ln = (d.range && d.range.start && (d.range.start.line + 1)) || '?';
                const src = d.source ? `[${d.source}] ` : '';
                const msg = String(d.message || '').replace(/\s+/g, ' ').slice(0, 200);
                if (d.severity === vscode.DiagnosticSeverity.Error) totalErr++;
                else totalWarn++;
                lines.push(`    L${ln} ${sev}: ${src}${msg}`);
            }
        }
        if (!lines.length) return '';
        const header = `--- post-edit diagnostics (${totalErr} error, ${totalWarn} warning) ---`;
        const footer = totalErr > 0
            ? 'ACTION: fix the errors above before reporting the task complete.'
            : 'Warnings only — review and fix if related to your change.';
        return [header, ...lines, footer].join('\n');
    }

    // Snapshot file content before a mutating edit so revert_last_turn can restore it.
    // Called once per file per turn — subsequent edits to the same file keep the original.
    _snapshotForEdit(run, name, args) {
        const paths = [];
        if ((name === 'write_file' || name === 'str_replace_in_file') && args && args.path) {
            paths.push(String(args.path));
        } else if (name === 'apply_patch' && args && args.patch) {
            const re = /^\+\+\+ (?:b\/)?(\S+)/gm;
            let m;
            while ((m = re.exec(String(args.patch))) !== null) {
                const p = m[1].trimEnd();
                if (p && p !== '/dev/null') paths.push(p);
                if (paths.length >= 20) break;
            }
        }
        for (const rel of paths) {
            let abs;
            try { abs = resolvePath(rel); } catch { continue; }
            if (run.turnSnapshots.has(abs)) continue; // already captured this turn
            try { run.turnSnapshots.set(abs, fs.readFileSync(abs, 'utf8')); }
            catch { run.turnSnapshots.set(abs, null); } // null = file didn't exist
        }
    }

    async _dispatchTool(name, args, run, abortSignal) {
        switch (name) {
            case 'read_file':           return toolReadFile(args);
            case 'list_dir':            return toolListDir(args);
            case 'grep_search':         return toolGrepSearch(args);
            case 'find_files':          return toolFindFiles(args);
            case 'write_file':          return toolWriteFile(args);
            case 'str_replace_in_file': return toolStrReplaceInFile(args);
            case 'apply_patch':         return toolApplyPatch(args);
            case 'run_shell':           return toolRunShell(args, { abortSignal });
            case 'web_search':          return toolWebSearch(args, { secrets: this._context.secrets });
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
                if (run) {
                    run.plan = { steps, todos };
                    run.planUpdatedIter = run._iter ?? -1;
                }
                return 'Plan updated.';
            }
            case 'revert_last_turn': {
                if (!run || !run.turnSnapshots || run.turnSnapshots.size === 0) {
                    return 'No file changes recorded for this turn. Nothing to revert.';
                }
                const reverted = [], failed = [];
                const root = wsRoot() || process.cwd();
                for (const [absPath, original] of run.turnSnapshots) {
                    try {
                        if (original === null) {
                            if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
                        } else {
                            fs.writeFileSync(absPath, original, 'utf8');
                        }
                        reverted.push(path.relative(root, absPath));
                    } catch (e) {
                        failed.push(`${path.relative(root, absPath)}: ${e.message}`);
                    }
                }
                run.turnSnapshots.clear();
                let revertMsg = `Reverted ${reverted.length} file(s) to pre-turn state: ${reverted.join(', ')}`;
                if (failed.length) revertMsg += `\nFailed to revert: ${failed.join('; ')}`;
                return revertMsg;
            }
            default:
                if (mcpManager.isMcpTool(name)) {
                    try { return await mcpManager.callTool(name, args); }
                    catch (e) { return `Error: ${e.message}`; }
                }
                return `Unknown tool: ${name}`;
        }
    }

    // Public: prompt user to confirm and revert all file edits made in the current agent turn.
    async revertLastTurn() {
        const run = this._activeRun();
        if (!run || !run.turnSnapshots || run.turnSnapshots.size === 0) {
            vscode.window.showInformationMessage(
                isZh() ? 'Deep Copilot：本轮没有可回滚的文件修改。'
                       : 'Deep Copilot: No file changes to revert in this turn.'
            );
            return;
        }
        const count = run.turnSnapshots.size;
        const ok = await vscode.window.showWarningMessage(
            isZh() ? `回滚本轮 Agent 对 ${count} 个文件的修改？`
                   : `Revert ${count} file change(s) from this agent turn?`,
            { modal: true },
            isZh() ? '确认回滚' : 'Revert All',
        );
        const confirmLabel = isZh() ? '确认回滚' : 'Revert All';
        if (ok !== confirmLabel) return;

        const reverted = [], failed = [];
        for (const [absPath, original] of run.turnSnapshots) {
            try {
                if (original === null) {
                    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
                } else {
                    fs.writeFileSync(absPath, original, 'utf8');
                }
                reverted.push(path.basename(absPath));
            } catch (e) {
                failed.push(path.basename(absPath));
            }
        }
        run.turnSnapshots.clear();

        const msg = isZh()
            ? `已回滚 ${reverted.length} 个文件：${reverted.join('、')}`
            : `Reverted ${reverted.length} file(s): ${reverted.join(', ')}`;
        if (failed.length) {
            vscode.window.showWarningMessage(
                msg + (isZh() ? `；失败：${failed.join('、')}` : `; Failed: ${failed.join(', ')}`)
            );
        } else {
            vscode.window.showInformationMessage(msg);
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
     * Produce a human-readable session title from the first turn.
     * Strategy: fire a tiny non-streaming LLM call (max_tokens=20) to get a
     * concise Chinese title; fall back to heuristic if the call fails/times out.
     */
    async _maybeAutoName(sid, userText, asstText) {
        const list = this._sessionsAll();
        const s = list.find(x => x.id === sid);
        if (!s) return;
        // Only auto-name on the first turn (1 user + 1 assistant just stored).
        if (s.msgCount > 2) return;
        // Respect manually-renamed titles.
        const originalPrefix = (userText || '').slice(0, 40);
        if (s.title && s.title !== originalPrefix && s.title !== t('sessionUntitled')) return;

        let title = null;

        // ── LLM-powered title (small agent) ──────────────────────────────
        try {
            const apiKey = await this._context.secrets.get('deepseekAgent.apiKey');
            if (apiKey) {
                const cfg = vscode.workspace.getConfiguration('deepseekAgent');
                const baseUrl = (cfg.get('apiBaseUrl') || '').trim() || 'https://api.deepseek.com';
                title = await this._llmTitle(apiKey, baseUrl, userText, asstText);
            }
        } catch (_) { /* fall through to heuristic */ }

        // ── Heuristic fallback ────────────────────────────────────────────
        if (!title) {
            const stripCode = (txt) => String(txt || '')
                .replace(/```[\s\S]*?```/g, ' ')
                .replace(/`[^`]*`/g, ' ');
            const firstSentence = (txt) => {
                const cleaned = stripCode(txt).replace(/\s+/g, ' ').trim();
                if (!cleaned) return '';
                const m = cleaned.match(/^(.{8,80}?)([。.!?！？\n]|$)/);
                return m ? m[1].trim() : cleaned.slice(0, 60);
            };
            title = firstSentence(asstText);
            if (title.length < 8) title = firstSentence(userText);
            title = title.slice(0, 15).trim();
        }

        if (!title) return;
        s.title = title;
        s.updatedAt = Date.now();
        await this._sessionsSet(list);
        this._postSessionList();
    }

    /**
     * Fire a tiny non-streaming API call to generate a ≤15-char session title.
     * Uses deepseek-chat (fast/cheap). Resolves with null on any error.
     */
    async _llmTitle(apiKey, baseUrl, userText, asstText) {
        const https = require('https');
        const http  = require('http');
        const base  = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
        const urlObj = new URL('/chat/completions', base);
        const isHttps = urlObj.protocol === 'https:';

        const strip = (t) => String(t || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`[^`]*`/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300);

        const prompt =
            '请用不超过10个汉字概括下方对话的主题，只输出标题，不加任何标点和解释：\n' +
            `用户：${strip(userText)}\n助手：${strip(asstText)}`;

        const body = JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            max_tokens: 20,
            temperature: 0.3,
        });

        return new Promise((resolve) => {
            const mod = isHttps ? https : http;
            const req = mod.request({
                hostname: urlObj.hostname,
                port:     urlObj.port || (isHttps ? 443 : 80),
                path:     urlObj.pathname + (urlObj.search || ''),
                method:   'POST',
                headers: {
                    'Authorization':  `Bearer ${apiKey}`,
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 8000,
            }, (res) => {
                let raw = '';
                res.on('data', (d) => { raw += d; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(raw);
                        const text = (data?.choices?.[0]?.message?.content || '').trim();
                        // Strip punctuation & limit length
                        const clean = text
                            .replace(/["""''「」『』【】《》<>（）()\[\]{}\.\!\?。！？，,、；;：:\-—\s]/g, '')
                            .slice(0, 15);
                        resolve(clean || null);
                    } catch (_) { resolve(null); }
                });
            });
            req.on('error',   () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
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

    /** Apply code block to the active editor using apply_patch logic or direct replace. */
    async _applyCodeBlock(code, lang) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('请先在编辑器中打开目标文件'); return; }
        // If the code looks like a unified diff, try apply_patch
        if (/^---\s/m.test(code) && /^\+\+\+\s/m.test(code)) {
            const { toolApplyPatch } = require('../tools/exec');
            const result = await toolApplyPatch({ patch: code });
            vscode.window.setStatusBarMessage(result.success ? '✓ Patch 已应用' : '✗ Patch 应用失败', 3000);
            return;
        }
        // Otherwise replace the full selection (or whole file if no selection)
        const sel = editor.selection;
        if (sel.isEmpty) {
            // Replace entire file
            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length)
            );
            editor.edit(b => b.replace(fullRange, code));
        } else {
            editor.edit(b => b.replace(sel, code));
        }
        vscode.window.setStatusBarMessage('✓ 代码已应用到编辑器', 2500);
    }

    /** Create a new untitled file with the given code. */
    async _createFileFromCodeBlock(code, lang) {
        const langMap = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'shellscript', bash: 'shellscript', css: 'css', html: 'html', json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml', c: 'c', cpp: 'cpp', java: 'java', go: 'go', rs: 'rust' };
        const languageId = langMap[lang] || lang || 'plaintext';
        const doc = await vscode.workspace.openTextDocument({ content: code, language: languageId });
        await vscode.window.showTextDocument(doc);
        vscode.window.setStatusBarMessage('✓ 已在新文件中打开代码', 2500);
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
