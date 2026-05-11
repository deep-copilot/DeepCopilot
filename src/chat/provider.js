// ChatViewProvider: thin coordinator that wires SessionStore, ToolExecutor,
// and AgentLoop together and owns the VS Code webview/panel binding.
//
// Architecture (hot-pluggable, DI-style):
//
//   ChatViewProvider
//     +-- SessionStore   (src/chat/session-store.js)   -- persistence
//     +-- ToolExecutor   (src/chat/tool-executor.js)   -- tool registry
//     +-- AgentLoop      (src/chat/agent-loop.js)      -- agentic while-loop
//
// To swap any layer, replace the class and pass it via constructor opts.
'use strict';

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

const { Logger }           = require('../logger');
const { wsRoot }           = require('../utils/paths');
const { isZh }             = require('../utils/i18n');
const { openFile }         = require('./openFile');
const { buildWebviewHtml } = require('../webview/html');
const { mcpManager }       = require('../mcp');

const { SessionStore } = require('./session-store');
const { ToolExecutor } = require('./tool-executor');
const { AgentLoop }    = require('./agent-loop');

class ChatViewProvider {
    static viewType = 'deepseek.chatView';

    constructor(context) {
        this._context    = context;
        this._view       = null;
        this._panel      = null;
        this._includeCtx = false;
        this._runs       = new Map();

        this._store = new SessionStore(context.globalState, {
            getCurrentWs: () => this._currentWs(),
            post:         (msg) => this._post(msg),
            getBusy:      (id)  => !!this._runs.get(id)?.busy,
            onDeleteRun:  (id)  => {
                const run = this._runs.get(id);
                if (run) { run.discarded = true; try { run.abortCtrl?.abort(); } catch {} this._runs.delete(id); }
            },
        });

        this._exec = new ToolExecutor(context, {
            postToRun: (run, msg) => this._runPost(run, msg),
            post:      (msg)      => this._post(msg),
        });

        this._loop = new AgentLoop({
            context,
            store:           this._store,
            exec:            this._exec,
            getRun:          (sid) => this._runs.get(sid),
            newRun:          (sid, seed) => this._newRun(sid, seed),
            deleteRun:       (sid) => this._runs.delete(sid),
            postToRun:       (run, msg) => this._runPost(run, msg),
            post:            (msg) => this._post(msg),
            postSessionList: () => this._store.postList(),
            buildAttachment: (heavy) => this._buildAttachmentBlock(heavy),
            getIncludeCtx:   () => this._includeCtx,
        });

        const wsR = wsRoot();
        if (wsR) mcpManager.init(wsR).catch(e => Logger.info('MCP_INIT_ERROR', { message: e.message }));
    }

    _newRun(sessionId, seedMessages = []) {
        const run = {
            sessionId,
            messages:      seedMessages.length ? seedMessages.slice() : [],
            abortCtrl:     null,
            reply:         { user: '', asst: '', thoughts: '' },
            busy:          false,
            events:        [],
            toolCache:     new Map(),
            turnSnapshots: new Map(),
            plan:          null,
            planUpdatedIter: -1,
        };
        this._runs.set(sessionId, run);
        return run;
    }

    _runPost(run, msg) {
        run.events.push(msg);
        if (run.sessionId === this._store.sessionId) this._post(msg);
    }

    _activeRun() {
        const sid = this._store.sessionId;
        return sid ? (this._runs.get(sid) || null) : null;
    }

    _currentWs() {
        const f = vscode.workspace.workspaceFolders;
        return (f && f[0]?.uri?.fsPath) || '';
    }

    get _activeWebview() { return this._panel?.webview || this._view?.webview || null; }

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
                this._store.postList();
                if (!this._store.sessionId) this._post({ type: 'sessionLoaded', id: null, messages: [] });
                break;
            }
            case 'sessionList':    this._store.postList(); break;
            case 'sessionLoad':    await this._loadSession(msg.id); break;
            case 'sessionNew':     this._store.newSession(); break;
            case 'sessionDelete':  this._store.delete(msg.id); break;
            case 'sessionRename':  this._store.rename(msg.id, msg.title); break;
            case 'sessionPin':     this._store.pin(msg.id); break;
            case 'sessionUnread':  this._store.unread(msg.id); break;
            case 'sessionArchive': this._store.archive(msg.id); break;
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
            case 'openApiSettings': vscode.commands.executeCommand('deepseekAgent.showApiStatus'); break;
            case 'openFile':        openFile(msg.path, msg.line); break;
            case 'send':   this._loop.handleSend(msg.text, msg.attachments || []); break;
            case 'stop': {
                const run = this._activeRun();
                if (run?.abortCtrl) { run.abortCtrl.abort(); run.abortCtrl = null; }
                break;
            }
            case 'insert':         this._insertToEditor(msg.code); break;
            case 'insertTerminal': this._sendToTerminal(msg.code, false); break;
            case 'runTerminal':    this._sendToTerminal(msg.code, true); break;
            case 'copy':
                vscode.env.clipboard.writeText(msg.code)
                    .then(() => vscode.window.setStatusBarMessage('已复制到剪贴板', 2000));
                break;
            case 'codeBlockApply':  await this._applyCodeBlock(msg.code, msg.lang); break;
            case 'codeBlockCreate': await this._createFileFromCodeBlock(msg.code, msg.lang); break;
            case 'clear':           this._store.sessionId = null; break;
            case 'contextToggle':   this._includeCtx = !!msg.active; break;
            case 'regenerate':      await this._handleRegenerate(); break;
            case 'editUserMessage': this._handleEditUserMessage(msg); break;
            case 'editUserSubmit':  await this._handleEditUserSubmit(msg); break;
            case 'feedback':
                vscode.window.setStatusBarMessage(msg.value === 'up' ? '👍 已记录' : '👎 已记录', 1500);
                break;
            case 'fileSearch': {
                const q = String(msg.query || '').toLowerCase();
                let files = [];
                try {
                    const found = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/.vscode/**}', 200);
                    files = found.map(u => vscode.workspace.asRelativePath(u, false))
                        .filter(r => !q || r.toLowerCase().includes(q)).slice(0, 30);
                } catch { /* ignore */ }
                this._post({ type: 'fileSearchResults', query: msg.query, files });
                break;
            }
            case 'fileContent': {
                const rel = String(msg.path || '');
                let content = '', error = '';
                try {
                    content = fs.readFileSync(path.join(wsRoot(), rel), 'utf8');
                    if (content.length > 65536) content = content.slice(0, 65536) + '\n... [truncated]';
                } catch (e) { error = e.message; }
                this._post({ type: 'fileContentResult', path: rel, content, error });
                break;
            }
        }
    }

    async _loadSession(id) {
        await this._store.load(id);
        const run = this._runs.get(id);
        if (run) for (const ev of run.events) this._post(ev);
    }

    async _handleRegenerate() {
        let run = this._activeRun();
        if (run && run.busy) return;
        let lastUser = '';

        if (run) {
            while (run.messages.length) {
                const last = run.messages[run.messages.length - 1];
                if (last.role === 'user') {
                    const c = last.content;
                    if (typeof c === 'string') lastUser = c;
                    else if (Array.isArray(c)) { const tp = c.find(p => p?.type === 'text'); lastUser = tp?.text || ''; }
                    run.messages.pop(); break;
                }
                run.messages.pop();
            }
        } else if (this._store.sessionId) {
            const list = this._store.all();
            const s    = list.find(x => x.id === this._store.sessionId);
            if (!s) return;
            const uiMsgs = s.messages || [];
            if (!uiMsgs.length) return;
            if (uiMsgs[uiMsgs.length - 1]?.role === 'assistant') uiMsgs.pop();
            const userTail = uiMsgs[uiMsgs.length - 1];
            if (!userTail || userTail.role !== 'user') return;
            lastUser = userTail.text || '';
            uiMsgs.pop();
            s.messages = uiMsgs; s.msgCount = s.messages.length; s.updatedAt = Date.now();
            if (Array.isArray(s.apiMessages)) {
                for (let i = s.apiMessages.length - 1; i >= 0; i--) {
                    if (s.apiMessages[i].role === 'user') { s.apiMessages = s.apiMessages.slice(0, i); break; }
                }
            }
            await this._store.set(list);
            run = this._newRun(this._store.sessionId, Array.isArray(s.apiMessages) ? s.apiMessages : []);
            this._store.postList();
        }

        if (!lastUser) return;
        const stripped = lastUser
            .replace(/^---\s*\n[\s\S]*?\n---\s*\n\n?/, '')
            .replace(/^<attachments>[\s\S]*?<\/attachments>\s*\n*/, '')
            .replace(/^(?:<attachment\b[\s\S]*?<\/attachment>\s*\n*)+/, '');
        if (stripped.trim()) this._loop.handleSend(stripped);
    }

    _handleEditUserMessage(msg) {
        const run = this._activeRun();
        if (!run || run.busy) return;
        const idx = Number(msg.index);
        if (!Number.isFinite(idx) || idx < 0) return;
        let userCount = -1, spliceAt = -1;
        for (let i = 0; i < run.messages.length; i++) {
            if (run.messages[i].role === 'user') { userCount++; if (userCount === idx) { spliceAt = i; break; } }
        }
        if (spliceAt < 0) return;
        const m = run.messages[spliceAt];
        let text = typeof m.content === 'string' ? m.content
            : (Array.isArray(m.content) ? (m.content.find(p => p?.type === 'text')?.text || '') : '');
        text = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n\n?/, '')
                   .replace(/<attachment path="[^"]*">[\s\S]*?<\/attachment>\n\n?/g, '').trim();
        run.messages.splice(spliceAt);
        this._post({ type: 'editFillInput', text });
    }

    async _handleEditUserSubmit(msg) {
        const idx     = Number(msg.index);
        const newText = String(msg.text || '').trim();
        if (!newText || !Number.isFinite(idx) || idx < 0) return;

        const run = this._activeRun();
        if (run?.busy && run?.abortCtrl) { try { run.abortCtrl.abort(); } catch {} run.busy = false; }

        if (run) {
            let userCount = -1, spliceAt = -1;
            for (let i = 0; i < run.messages.length; i++) {
                if (run.messages[i].role === 'user') { userCount++; if (userCount === idx) { spliceAt = i; break; } }
            }
            if (spliceAt >= 0) run.messages.splice(spliceAt);
            if (Array.isArray(run.events)) {
                let echoCount = -1, cutAt = -1;
                for (let i = 0; i < run.events.length; i++) {
                    if (run.events[i]?.type === 'userEcho') { echoCount++; if (echoCount === idx) { cutAt = i; break; } }
                }
                if (cutAt >= 0) run.events.splice(cutAt);
            }
        }

        if (this._store.sessionId) {
            const list = this._store.all();
            const s    = list.find(x => x.id === this._store.sessionId);
            if (s) {
                const trimAt = (arr) => {
                    if (!Array.isArray(arr)) return;
                    let uc = -1, cut = -1;
                    for (let i = 0; i < arr.length; i++) {
                        if (arr[i].role === 'user') { uc++; if (uc === idx) { cut = i; break; } }
                    }
                    if (cut >= 0) arr.splice(cut);
                };
                trimAt(s.messages); trimAt(s.apiMessages);
                s.updatedAt = Date.now();
                await this._store.set(list);
            }
        }
        this._loop.handleSend(newText);
    }

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
        const lines = ['<attachments>'];
        lines.push(`The user is currently viewing \`${rel}\` (${lang}).`);
        if (!sel.isEmpty) {
            const selected = doc.getText(sel);
            const capped   = selected.length > 4000 ? selected.slice(0, 4000) + '\n... [selection truncated]' : selected;
            lines.push(`Selection (${rel}:${sel.start.line + 1}-${sel.end.line + 1}):`);
            lines.push('`' + '`' + '`' + lang, capped, '`' + '`' + '`');
        } else if (heavy) {
            const range   = editor.visibleRanges[0];
            const visible = doc.getText(range).substring(0, 3000);
            lines.push(`Visible viewport (${rel}:${range.start.line + 1}-${range.end.line + 1}):`);
            lines.push('`' + '`' + '`' + lang, visible, '`' + '`' + '`');
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

    async _applyCodeBlock(code, lang) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('请先在编辑器中打开目标文件'); return; }
        if (/^---\s/m.test(code) && /^\+\+\+\s/m.test(code)) {
            const { toolApplyPatch } = require('../tools/exec');
            const result = await toolApplyPatch({ patch: code });
            vscode.window.setStatusBarMessage(result.success ? '✓ Patch 已应用' : '✗ Patch 应用失败', 3000);
            return;
        }
        const sel = editor.selection;
        if (sel.isEmpty) {
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

    async _createFileFromCodeBlock(code, lang) {
        const langMap = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'shellscript', bash: 'shellscript', css: 'css', html: 'html', json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml', c: 'c', cpp: 'cpp', java: 'java', go: 'go', rs: 'rust' };
        const doc = await vscode.workspace.openTextDocument({ content: code, language: langMap[lang] || lang || 'plaintext' });
        await vscode.window.showTextDocument(doc);
        vscode.window.setStatusBarMessage('✓ 已在新文件中打开代码', 2500);
    }

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
        if (ok !== (isZh() ? '确认回滚' : 'Revert All')) return;
        const reverted = [], failed = [];
        for (const [absPath, original] of run.turnSnapshots) {
            try {
                if (original === null) { if (fs.existsSync(absPath)) fs.unlinkSync(absPath); }
                else fs.writeFileSync(absPath, original, 'utf8');
                reverted.push(path.basename(absPath));
            } catch { failed.push(path.basename(absPath)); }
        }
        run.turnSnapshots.clear();
        const msg = isZh()
            ? `已回滚 ${reverted.length} 个文件：${reverted.join('、')}`
            : `Reverted ${reverted.length} file(s): ${reverted.join(', ')}`;
        failed.length
            ? vscode.window.showWarningMessage(msg + (isZh() ? `；失败：${failed.join('、')}` : `; Failed: ${failed.join(', ')}`))
            : vscode.window.showInformationMessage(msg);
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
