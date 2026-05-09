// DeepSeek Agent VS Code Extension - Sidebar Chat Panel
// Provides a GitHub Copilot-style sidebar that talks to deepseek-app-server
'use strict';

const vscode     = require('vscode');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { spawn, exec } = require('child_process');

// ─── API Client ───────────────────────────────────────────────────────────────

class ApiClient {
    constructor(port = 8787) {
        this.port = port;
    }

    updatePort(port) { this.port = port; }

    _request(method, endpoint, body) {
        return new Promise((resolve, reject) => {
            const data = body ? JSON.stringify(body) : undefined;
            const options = {
                hostname: '127.0.0.1',
                port: this.port,
                path: endpoint,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                },
            };
            const req = http.request(options, res => {
                let buf = '';
                res.on('data', chunk => { buf += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(buf)); }
                    catch { reject(new Error(`Invalid JSON from server: ${buf.substring(0, 300)}`)); }
                });
            });
            req.on('error', reject);
            req.setTimeout(90_000, () => {
                req.destroy();
                reject(new Error('Request timed out (90s)'));
            });
            if (data) req.write(data);
            req.end();
        });
    }

    healthCheck() { return this._request('GET', '/healthz'); }

    sendPrompt(prompt, threadId, model) {
        const body = { input: prompt };
        if (threadId) body.thread_id = threadId;
        if (model)    body.model     = model;
        return this._request('POST', '/prompt', body);
    }

    /**
     * Open an SSE stream via POST /prompt/stream.
     * Calls handlers.onDelta(text), onThinking(text), onError(msg), onDone() as events arrive.
     * Returns a function that aborts the request.
     */
    streamPrompt(prompt, threadId, model, workspaceRoot, handlers) {
        const body = JSON.stringify({
            input: prompt,
            ...(threadId ? { thread_id: threadId } : {}),
            ...(model ? { model } : {}),
            ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
        });
        const options = {
            hostname: '127.0.0.1',
            port: this.port,
            path: '/prompt/stream',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        let buf = '';
        let aborted = false;

        const req = http.request(options, res => {
            if (res.statusCode !== 200) {
                let errBuf = '';
                res.on('data', c => errBuf += c);
                res.on('end', () => {
                    handlers.onError?.(`HTTP ${res.statusCode}: ${errBuf.substring(0, 300)}`);
                    handlers.onDone?.();
                });
                return;
            }
            res.setEncoding('utf8');
            res.on('data', chunk => {
                if (aborted) return;
                buf += chunk;
                // Split on SSE frame boundary (blank line)
                let idx;
                while ((idx = buf.indexOf('\n\n')) !== -1) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    let event = 'message';
                    const dataLines = [];
                    for (const line of frame.split('\n')) {
                        if (line.startsWith('event:')) event = line.slice(6).trim();
                        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
                    }
                    if (dataLines.length === 0) continue;
                    let payload = {};
                    try { payload = JSON.parse(dataLines.join('\n')); } catch { continue; }
                    if (event === 'delta') handlers.onDelta?.(payload.text || '');
                    else if (event === 'thinking') handlers.onThinking?.(payload.text || '');
                    else if (event === 'tool_call') handlers.onToolCall?.(payload);
                    else if (event === 'tool_start') handlers.onToolStart?.(payload);
                    else if (event === 'tool_result') handlers.onToolResult?.(payload);
                    else if (event === 'approval_request') handlers.onApprovalRequest?.(payload);
                    else if (event === 'turn_end') handlers.onTurnEnd?.(payload);
                    else if (event === 'usage') handlers.onUsage?.(payload);
                    else if (event === 'plan') handlers.onPlan?.(payload);
                    else if (event === 'error') handlers.onError?.(payload.message || 'unknown error');
                    else if (event === 'done') { handlers.onDone?.(); }
                }
            });
            res.on('end', () => { if (!aborted) handlers.onDone?.(); });
            res.on('error', e => handlers.onError?.(e.message));
        });
        req.on('error', e => { if (!aborted) handlers.onError?.(e.message); });
        req.setTimeout(600_000, () => { req.destroy(); handlers.onError?.('stream timed out (600s)'); });
        req.write(body);
        req.end();

        return () => { aborted = true; try { req.destroy(); } catch {} };
    }

    approve(id, decision) {
        return this._request('POST', '/agent/approve', { id, decision: !!decision });
    }
}

// ─── Server Manager ───────────────────────────────────────────────────────────

class ServerManager {
    constructor(outputChannel, secrets) {
        this.outputChannel = outputChannel;
        this._process      = null;
        this._status       = 'stopped';
        this.client        = new ApiClient();
        this.secrets       = secrets || null;
    }

    /** Restart the server (used after API key / base URL changes). */
    async restart() {
        if (this._process) {
            try { this._process.kill(); } catch {}
            this._process = null;
        }
        this._status = 'stopped';
        await wait(400);
        await this.ensureRunning();
    }

    get isRunning() { return this._status === 'running'; }

    async ensureRunning() {
        if (this._status === 'running') return;
        if (this._status === 'starting') {
            for (let i = 0; i < 33; i++) {
                await wait(300);
                if (this._status === 'running') return;
            }
            throw new Error('Server start timed out');
        }
        if (await this.probe()) return;
        await this.start();
    }

    async start() {
        if (this._status === 'running' || this._status === 'starting') return;
        const exe = await this.findServerExecutable();
        if (!exe) {
            this._status = 'error';
            throw new Error(
                '找不到 deepseek-app-server 可执行文件。\n' +
                '请先运行：cargo build --release -p deepseek-app-server\n' +
                '或在设置 deepseekAgent.serverExecutablePath 中指定路径'
            );
        }

        const config = vscode.workspace.getConfiguration('deepseekAgent');
        const port   = config.get('serverPort', 8787);
        this.client.updatePort(port);
        this._status = 'starting';

        // Build environment: workspace settings + secret storage override the inherited env.
        const env = Object.assign({}, process.env);
        const baseUrl = (config.get('apiBaseUrl') || '').trim();
        if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl;
        if (this.secrets) {
            try {
                const k = await this.secrets.get('deepseekAgent.apiKey');
                if (k) env.DEEPSEEK_API_KEY = k;
            } catch {}
        }
        const keySrc = env.DEEPSEEK_API_KEY ? (this.secrets && (await this.secrets.get('deepseekAgent.apiKey')) ? 'SecretStorage' : 'process env') : 'NONE';
        this.outputChannel.appendLine(`[DeepSeek] Starting server: ${exe} --port ${port} (key=${keySrc}, base=${env.DEEPSEEK_BASE_URL || 'default'})`);

        this._process = spawn(exe, ['--port', String(port)], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
        });
        this._process.stdout?.on('data', d => this.outputChannel.append(`[server] ${d}`));
        this._process.stderr?.on('data', d => this.outputChannel.append(`[server:err] ${d}`));
        this._process.on('exit', code => {
            this.outputChannel.appendLine(`[DeepSeek] Server exited: ${code}`);
            this._process = null;
            this._status  = 'stopped';
        });
        this._process.on('error', err => {
            this.outputChannel.appendLine(`[DeepSeek] Server error: ${err.message}`);
            this._status = 'error';
        });

        await this._waitForReady(port);
    }

    async _waitForReady(port, timeout = 12_000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            try {
                await this.client.healthCheck();
                this._status = 'running';
                this.outputChannel.appendLine(`[DeepSeek] Server ready on port ${port}`);
                return;
            } catch { await wait(300); }
        }
        this._status = 'error';
        throw new Error('Server did not become ready in time');
    }

    async probe() {
        const config = vscode.workspace.getConfiguration('deepseekAgent');
        const port   = config.get('serverPort', 8787);
        this.client.updatePort(port);
        try {
            await this.client.healthCheck();
            if (this._status !== 'running') this._status = 'running';
            return true;
        } catch { return false; }
    }

    async stop() {
        if (this._process) { this._process.kill(); this._process = null; }
        this._status = 'stopped';
    }

    async findServerExecutable() {
        const config     = vscode.workspace.getConfiguration('deepseekAgent');
        const configured = config.get('serverExecutablePath', '');
        if (configured && fs.existsSync(configured)) return configured;

        const isWin   = process.platform === 'win32';
        const name    = isWin ? 'deepseek-app-server.exe' : 'deepseek-app-server';
        const folders = vscode.workspace.workspaceFolders || [];

        for (const folder of folders) {
            for (const sub of ['target/release', 'target/debug']) {
                const p = path.join(folder.uri.fsPath, sub, name);
                if (fs.existsSync(p)) return p;
            }
        }

        return new Promise(resolve => {
            const cmd = isWin ? 'where' : 'which';
            exec(`${cmd} ${name}`, (err, stdout) => {
                resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0].trim() : null);
            });
        });
    }
}

// ─── Chat View Provider ───────────────────────────────────────────────────────

class ChatViewProvider {
    static viewType = 'deepseek.chatView';

    constructor(context, serverManager) {
        this._context       = context;
        this._serverManager = serverManager;
        this._view          = null;       // WebviewView (sidebar)
        this._panel         = null;       // WebviewPanel (editor tab)
        this._threadId      = undefined;
        this._includeCtx    = false;
        // Sessions persistence (globalState)
        this._sessionId     = null;       // current session id (null = unsaved)
        this._reply         = { user: '', asst: '', thoughts: '' };
    }

    // ─── Sessions store (globalState) ─────────────────────────────────
    _currentWs() {
        const f = vscode.workspace.workspaceFolders;
        return (f && f[0] && f[0].uri && f[0].uri.fsPath) || '';
    }
    _sessionsAll() {
        return this._context.globalState.get('deepseekAgent.sessions', []);
    }
    async _sessionsSet(list) {
        // cap to 100 most recent
        list.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
        if (list.length > 100) list = list.slice(0, 100);
        await this._context.globalState.update('deepseekAgent.sessions', list);
    }
    async _appendToCurrentSession(userText, asstText, thoughts) {
        if (!userText && !asstText) return;
        const list = this._sessionsAll();
        let s = this._sessionId ? list.find(x => x.id === this._sessionId) : null;
        if (!s) {
            const id = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
            s = {
                id,
                title: (userText || 'Untitled').slice(0, 40),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                ws: this._currentWs(),
                messages: [],
            };
            this._sessionId = id;
            list.unshift(s);
        } else if (!s.ws) {
            s.ws = this._currentWs();
        }
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        s.model = cfg.get('defaultModel') || 'deepseek-v4-pro';
        s.mode  = cfg.get('approvalMode') || 'manual';
        if (userText) s.messages.push({ role:'user', text: userText });
        if (asstText || thoughts) s.messages.push({ role:'assistant', text: asstText || '', thoughts: thoughts || '' });
        if (s.messages.length > 200) s.messages = s.messages.slice(-200);
        const last = s.messages[s.messages.length-1];
        s.preview = (last && last.text || '').replace(/\s+/g, ' ').slice(0, 80);
        s.msgCount = s.messages.length;
        s.updatedAt = Date.now();
        await this._sessionsSet(list);
        this._postSessionList();
    }
    _postSessionList() {
        this._post({ type:'sessions', currentWs: this._currentWs(), items: this._sessionsAll().map(s => ({
            id:s.id, title:s.title, preview:s.preview, msgCount:s.msgCount,
            model:s.model, mode:s.mode, ws:s.ws||'', createdAt:s.createdAt, updatedAt:s.updatedAt,
        })), activeId: this._sessionId });
    }
    async _sessionLoad(id) {
        const s = this._sessionsAll().find(x => x.id === id);
        if (!s) return;
        this._sessionId = s.id;
        this._threadId  = undefined; // start a fresh model thread when user continues
        this._post({ type:'sessionLoaded', id:s.id, messages: s.messages || [] });
        this._postSessionList();
    }
    async _sessionNew() {
        this._sessionId = null;
        this._threadId  = undefined;
        this._reply = { user:'', asst:'', thoughts:'' };
        this._post({ type:'sessionLoaded', id: null, messages: [] });
        this._postSessionList();
    }
    async _sessionDelete(id) {
        let list = this._sessionsAll().filter(x => x.id !== id);
        if (this._sessionId === id) { this._sessionId = null; this._threadId = undefined; }
        await this._sessionsSet(list);
        this._postSessionList();
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

    /** Returns the active webview (panel takes priority if both exist). */
    get _activeWebview() {
        return this._panel?.webview || this._view?.webview || null;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media'),
            ],
        };
        webviewView.webview.html = buildWebviewHtml();
        webviewView.webview.onDidReceiveMessage(msg => this._onMessage(msg));

        this._serverManager.probe().then(running => {
            this._post({ type: 'serverStatus', running });
        });
    }

    /** Bind to an editor-tab WebviewPanel (separate window-style experience). */
    bindPanel(panel) {
        this._panel = panel;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media'),
            ],
        };
        panel.webview.html = buildWebviewHtml();
        panel.webview.onDidReceiveMessage(msg => this._onMessage(msg));
        panel.onDidDispose(() => { if (this._panel === panel) this._panel = null; });
        this._serverManager.probe().then(running => {
            this._post({ type: 'serverStatus', running });
        });
    }

    _onMessage(msg) {
        switch (msg.type) {
            case 'ready': {
                this._serverManager.probe().then(r => this._post({ type: 'serverStatus', running: r }));
                const cfg = vscode.workspace.getConfiguration('deepseekAgent');
                const model = cfg.get('defaultModel') || 'deepseek-v4-pro';
                const mode  = cfg.get('approvalMode') || 'manual';
                this._post({ type: 'modelInfo', model, approvalMode: mode });
                this._postSessionList();
                // Auto-restore most-recent session for current workspace (Copilot-style)
                if (!this._sessionId) {
                    const ws = this._currentWs();
                    if (ws) {
                        const list = this._sessionsAll().filter(s => (s.ws||'') === ws);
                        list.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
                        if (list[0]) { this._sessionLoad(list[0].id); }
                    }
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
                this._openFile(msg.path, msg.line);
                break;
            case 'send':
                this._handleSend(msg.text);
                break;
            case 'insert':
                this._insertToEditor(msg.code);
                break;
            case 'copy':
                vscode.env.clipboard.writeText(msg.code)
                    .then(() => vscode.window.setStatusBarMessage('已复制到剪贴板', 2000));
                break;
            case 'clear':
                this._threadId = undefined;
                break;
            case 'contextToggle':
                this._includeCtx = !!msg.active;
                break;
            case 'approve':
                this._serverManager.client.approve(msg.id, msg.decision)
                    .catch(err => this._post({ type: 'error', text: 'approve failed: ' + (err?.message || err) }));
                break;
        }
    }

    async _handleSend(text) {
        if (!text?.trim()) return;

        let prompt = text;
        if (this._includeCtx) {
            const ctx = this._buildFileContext();
            if (ctx) prompt = ctx + '\n\n' + text;
        }

        this._post({ type: 'thinking', show: true });
        this._post({ type: 'status', text: '正在连接服务器…' });

        try {
            await this._serverManager.ensureRunning();
            this._post({ type: 'status', text: '' });

            const config = vscode.workspace.getConfiguration('deepseekAgent');
            const model  = config.get('defaultModel', 'deepseek-v4-pro');

            // Determine workspace root (first folder).
            const wsFolders = vscode.workspace.workspaceFolders;
            const workspaceRoot = wsFolders && wsFolders.length > 0 ? wsFolders[0].uri.fsPath : null;

            // Tell webview to open a new streaming reply bubble.
            this._post({ type: 'replyStart' });

            // Reset accumulator for this turn (will save on done)
            this._reply = { user: text, asst: '', thoughts: '' };

            await new Promise((resolve) => {
                let gotAnything = false;
                this._serverManager.client.streamPrompt(prompt, this._threadId, model, workspaceRoot, {
                    onDelta: (t) => {
                        gotAnything = true;
                        this._reply.asst += (t || '');
                        this._post({ type: 'replyDelta', text: t });
                    },
                    onThinking: (t) => {
                        this._reply.thoughts += (t || '');
                        this._post({ type: 'thinkingDelta', text: t });
                    },
                    onToolStart: (p) => {
                        gotAnything = true;
                        this._post({ type: 'toolStart', id: p.id, name: p.name, args: p.args });
                    },
                    onToolResult: (p) => {
                        this._post({ type: 'toolResult', id: p.id, name: p.name, ok: p.ok, output: p.output });
                    },
                    onApprovalRequest: (p) => {
                        // Apply approval policy from config (manual / auto-edit / autopilot / readonly)
                        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
                        const mode = cfg.get('approvalMode') || 'manual';
                        const allowList = cfg.get('autoApproveTools') || [];
                        const denyList = cfg.get('denyTools') || [];
                        const decide = (() => {
                            if (denyList.includes(p.name)) return false;
                            if (allowList.includes(p.name)) return true;
                            if (mode === 'autopilot') return true;
                            if (mode === 'readonly') return false;
                            if (mode === 'auto-edit') {
                                if (p.name === 'write_file') return true;
                                return null; // shell still asks
                            }
                            return null; // manual: ask user
                        })();
                        if (decide === true || decide === false) {
                            // Server-side auto-decision — surface a small notice card so user sees what happened
                            this._post({ type: 'autoApproval', id: p.id, name: p.name, args: p.args, decision: decide, mode });
                            this._serverManager.client.approve(p.id, decide).catch(err =>
                                this._post({ type: 'error', text: 'auto-approve failed: ' + (err?.message || err) }));
                        } else {
                            this._post({ type: 'approvalRequest', id: p.id, name: p.name, args: p.args });
                        }
                    },
                    onPlan: (p) => {
                        this._post({ type: 'plan', steps: p.steps || [] });
                    },
                    onUsage: (p) => {
                        this._post({ type: 'usage', usage: p });
                    },
                    onTurnEnd: (p) => {
                        // After a tool round, the model will speak again. Open a new bubble for the next turn.
                        if (!p.final) this._post({ type: 'newTurn' });
                    },
                    onError: (m) => {
                        this._post({ type: 'error', text: m });
                    },
                    onDone: () => {
                        this._post({ type: 'replyEnd', empty: !gotAnything });
                        // Persist this exchange to the session store
                        const r = this._reply;
                        if (r.user || r.asst) this._appendToCurrentSession(r.user, r.asst, r.thoughts);
                        this._reply = { user:'', asst:'', thoughts:'' };
                        resolve();
                    },
                });
            });
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this._post({ type: 'error', text: errMsg });
        } finally {
            this._post({ type: 'thinking', show: false });
            this._serverManager.probe().then(r => this._post({ type: 'serverStatus', running: r }));
        }
    }

    _buildFileContext() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return null;

        const doc      = editor.document;
        const fileName = path.basename(doc.fileName);
        const lang     = doc.languageId;
        const sel      = editor.selection;

        if (!sel.isEmpty) {
            const selected = doc.getText(sel);
            return `当前选中的代码（${fileName}，${lang}）：\n\`\`\`${lang}\n${selected}\n\`\`\``;
        }

        const range   = editor.visibleRanges[0];
        const visible = doc.getText(range).substring(0, 3000);
        return `当前文件（${fileName}，${lang}）可见内容：\n\`\`\`${lang}\n${visible}\n\`\`\``;
    }

    _insertToEditor(code) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先在编辑器中打开一个文件');
            return;
        }
        editor.edit(builder => builder.replace(editor.selection, code));
        vscode.window.setStatusBarMessage('✓ 代码已插入编辑器', 2500);
    }

    async _openFile(p, line) {
        if (!p) return;
        try {
            const folders = vscode.workspace.workspaceFolders || [];
            const tries = [];
            // Absolute path
            if (path.isAbsolute(p)) tries.push(vscode.Uri.file(p));
            // Workspace-relative for each folder
            for (const f of folders) tries.push(vscode.Uri.joinPath(f.uri, p));
            // findFiles fallback (basename match)
            let target = null;
            for (const u of tries) {
                try { await vscode.workspace.fs.stat(u); target = u; break; } catch {}
            }
            if (!target) {
                const found = await vscode.workspace.findFiles(`**/${path.basename(p)}`, undefined, 5);
                if (found.length === 1) target = found[0];
                else if (found.length > 1) {
                    const picks = found.map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));
                    const c = await vscode.window.showQuickPick(picks, { placeHolder: `选择 ${path.basename(p)}` });
                    if (c) target = c.uri;
                }
            }
            if (!target) {
                vscode.window.showWarningMessage(`找不到文件：${p}`);
                return;
            }
            const opts = {};
            if (line && line > 0) {
                const pos = new vscode.Position(Math.max(0, line - 1), 0);
                opts.selection = new vscode.Range(pos, pos);
            }
            await vscode.window.showTextDocument(target, opts);
        } catch (err) {
            vscode.window.showErrorMessage('打开文件失败：' + (err?.message || err));
        }
    }

    _post(msg) {
        const wv = this._activeWebview;
        if (wv) wv.postMessage(msg);
    }
}

// ─── Inline Webview HTML ──────────────────────────────────────────────────────

function buildWebviewHtml() {
    // Use a string array + join to avoid template literal escaping issues with regex
    return [
'<!DOCTYPE html>',
'<html lang="zh"><head><meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>DeepSeek Agent</title>',
'<style>',
'*{box-sizing:border-box;margin:0;padding:0}',
'body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);height:100vh;overflow:hidden;position:relative;',
'  display:grid;grid-template-columns:220px 1fr 280px;grid-template-rows:auto 1fr auto auto;',
'  grid-template-areas:"tb tb tb" "left main right" "left composer right" "foot foot foot"}',
'body.no-left{grid-template-columns:0 1fr 280px}',
'body.no-left #left{display:none}',
'body.no-right{grid-template-columns:220px 1fr 0}',
'body.no-right #right{display:none}',
'body.no-left.no-right{grid-template-columns:0 1fr 0}',
'body.narrow{grid-template-columns:1fr;grid-template-areas:"tb" "main" "composer" "foot"}',
'body.narrow #left,body.narrow #right{display:none}',
'#tb{grid-area:tb;display:flex;align-items:center;padding:6px 10px;gap:6px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-titleBar-activeBackground)}',
'#tb .logo{flex:1;font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px}',
'#tb .logo .badge{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:500}',
'#tb .logo .model{opacity:.65;font-weight:400;font-size:11px}',
'.tbsel{background:var(--vscode-input-background);color:var(--vscode-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;font-size:11px;padding:2px 4px;cursor:pointer;outline:none}',
'.tbsel:focus{border-color:var(--vscode-focusBorder)}',
'.tbsel#modeSel[data-m="autopilot"]{background:rgba(244,135,113,.15);border-color:var(--vscode-errorForeground)}',
'.tbsel#modeSel[data-m="auto-edit"]{background:rgba(232,184,109,.15)}',
'.tbsel#modeSel[data-m="readonly"]{background:rgba(126,201,154,.10)}',
'.tbb{background:none;border:none;cursor:pointer;color:var(--vscode-icon-foreground);padding:3px 8px;border-radius:3px;font-size:11px}',
'.tbb:hover{background:var(--vscode-toolbar-hoverBackground)}',
'.tbb.active{color:var(--vscode-button-background)}',
'#sb{grid-area:tb;align-self:end;padding:3px 10px;font-size:11px;color:var(--vscode-descriptionForeground);background:rgba(244,135,113,.1);border-bottom:1px solid var(--vscode-panel-border);display:none}',
'#main{grid-area:main;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:12px;min-height:0}',
'.msgU{background:var(--vscode-input-background);border-radius:8px 8px 2px 8px;padding:8px 12px;align-self:flex-end;max-width:88%;white-space:pre-wrap;word-break:break-word;line-height:1.5}',
'.msgA{align-self:flex-start;width:100%}',
'.msgA .lbl{font-size:10px;font-weight:700;letter-spacing:1px;color:var(--vscode-button-background);margin-bottom:5px}',
'.msgC{line-height:1.6;word-break:break-word}',
'.msgC>p{margin:0 0 8px 0}',
'.msgC>p:last-child{margin-bottom:0}',
'.msgC h2.mh,.msgC h3.mh,.msgC h4.mh,.msgC h5.mh,.msgC h6.mh{margin:14px 0 6px 0;font-weight:600;color:var(--vscode-foreground);line-height:1.3}',
'.msgC h2.mh{font-size:15px;padding-bottom:4px;border-bottom:1px solid var(--vscode-panel-border)}',
'.msgC h3.mh{font-size:13.5px}',
'.msgC h4.mh,.msgC h5.mh,.msgC h6.mh{font-size:12.5px;color:var(--vscode-descriptionForeground)}',
'.msgC ul.mul,.msgC ol.mol{margin:4px 0 8px 0;padding-left:22px}',
'.msgC ul.mul li,.msgC ol.mol li{margin:2px 0;line-height:1.55}',
'.msgC ul.mul li::marker{color:var(--vscode-descriptionForeground)}',
'.msgC hr.mhr{border:none;border-top:1px solid var(--vscode-panel-border);margin:12px 0}',
'.msgC blockquote.mbq{margin:6px 0;padding:4px 10px;border-left:3px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);background:rgba(255,255,255,.02)}',
'.msgC table.mtbl{border-collapse:collapse;margin:6px 0 10px 0;font-size:12px;width:auto;max-width:100%}',
'.msgC table.mtbl th,.msgC table.mtbl td{border:1px solid var(--vscode-panel-border);padding:4px 10px;text-align:left;vertical-align:top}',
'.msgC table.mtbl th{background:var(--vscode-textCodeBlock-background);font-weight:600;font-size:11.5px}',
'.msgC table.mtbl tr:nth-child(even) td{background:rgba(255,255,255,.02)}',
'.msgC pre.cb{background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);border-radius:6px;margin:6px 0;overflow:hidden;font-family:var(--vscode-editor-font-family,monospace);font-size:12px}',
'.msgC pre.cb .cb-h{display:flex;align-items:center;gap:6px;padding:3px 8px;background:rgba(255,255,255,.04);border-bottom:1px solid var(--vscode-panel-border);font-size:10px;color:var(--vscode-descriptionForeground);user-select:none}',
'.msgC pre.cb .cb-h .lang{font-family:var(--vscode-font-family);text-transform:lowercase;flex:1}',
'.msgC pre.cb .cb-h button{background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px;font-family:inherit}',
'.msgC pre.cb .cb-h button:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}',
'.msgC pre.cb .cb-h button.copied{color:#7ec99a}',
'.msgC pre.cb code{display:block;padding:8px 10px;overflow-x:auto;white-space:pre;line-height:1.5}',
'.msgC code.ic{background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:3px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px}',
'.msgC a.flink{color:var(--vscode-textLink-foreground);text-decoration:none;background:rgba(100,160,255,.10);padding:0 4px;border-radius:3px;font-family:var(--vscode-editor-font-family,monospace);font-size:11.5px;cursor:pointer;border:1px solid transparent}',
'.msgC a.flink:hover{background:rgba(100,160,255,.20);border-color:var(--vscode-textLink-foreground);text-decoration:none}',
'.msgC a.flink .ico{opacity:.7;margin-right:2px}',
'.jumpbtn{position:absolute;right:12px;bottom:8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:14px;padding:4px 10px;font-size:11px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.25);display:none;z-index:5}',
'.jumpbtn.show{display:block}',
'#main{position:relative}',
'.thinkblk{font-size:11px;color:var(--vscode-descriptionForeground);font-style:italic;border-left:2px solid var(--vscode-panel-border);padding:6px 10px;margin:4px 0 8px 0;white-space:pre-wrap;opacity:.85;max-height:200px;overflow-y:auto;background:rgba(255,255,255,.02);border-radius:0 3px 3px 0}',
'.thinkhead{font-size:10.5px;color:var(--vscode-descriptionForeground);margin-bottom:3px;cursor:pointer;user-select:none;display:inline-block;padding:2px 6px;border-radius:3px;opacity:.7}',
'.thinkhead:hover{background:var(--vscode-toolbar-hoverBackground);opacity:1}',
'.tool{margin:2px 0;border:1px solid var(--vscode-panel-border);border-radius:4px;font-size:12px;overflow:hidden;background:var(--vscode-textCodeBlock-background)}',
'.tool .h{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;user-select:none;line-height:1.4}',
'.tool .h:hover{background:rgba(255,255,255,.04)}',
'.tool .h .ico{font-size:11px;opacity:.65;flex-shrink:0}',
'.tool .h .nm{font-family:var(--vscode-editor-font-family,monospace);font-weight:500;color:var(--vscode-foreground);font-size:11.5px;flex-shrink:0}',
'.tool .h .tgt{flex:1;color:var(--vscode-textLink-foreground);font-family:var(--vscode-editor-font-family,monospace);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
'.tool .h .st{font-size:10px;opacity:.55;flex-shrink:0;font-family:var(--vscode-font-family)}',
'.tool .h .chev{font-size:9px;opacity:.5;flex-shrink:0;transition:transform .15s}',
'.tool.open .h .chev{transform:rotate(90deg)}',
'.tool .b{padding:6px 10px;display:none;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;white-space:pre-wrap;max-height:280px;overflow:auto;border-top:1px solid var(--vscode-panel-border)}',
'.tool.open .b{display:block}',
'.tool .args{color:var(--vscode-descriptionForeground);margin-bottom:4px;white-space:pre-wrap;word-break:break-all;font-size:10.5px}',
'.tool.err{border-color:rgba(244,135,113,.45)}',
'.tool.err .h .st{color:var(--vscode-errorForeground);opacity:.95}',
'.tool.ok .h .st{color:#7ec99a}',
'.tool.run .h .st{color:#e8b86d}',
'.tool .approve{padding:5px 8px;display:flex;gap:6px;border-top:1px solid var(--vscode-panel-border);background:rgba(255,200,100,.08)}',
'.tool .approve button{padding:3px 10px;border:none;border-radius:3px;cursor:pointer;font-size:11px}',
'.btn-yes{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}',
'.btn-no{background:var(--vscode-input-background);color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border)!important}',
'.err{color:var(--vscode-errorForeground);font-size:12px;padding:6px 10px;background:rgba(244,135,113,.08);border-radius:6px;border-left:3px solid var(--vscode-errorForeground);align-self:flex-start;width:100%;white-space:pre-wrap}',
/* ─── Left side panels (Plan/Todos/Agents) ─────────────────────────── */
'#left{grid-area:left;display:flex;flex-direction:column;border-right:1px solid var(--vscode-panel-border);overflow:hidden;min-width:0;background:var(--vscode-sideBar-background)}',
/* ─── Right side panel (Sessions) ──────────────────────────────────── */
'#right{grid-area:right;display:flex;flex-direction:column;border-left:1px solid var(--vscode-panel-border);overflow:hidden;min-width:0;background:var(--vscode-sideBar-background)}',
'.pnl{display:flex;flex-direction:column;border-bottom:1px solid var(--vscode-panel-border);min-height:0;flex:1 1 0}',
'.pnl.pnl-mini{flex:0 0 auto}',
'.pnl[data-open="0"]{flex:0 0 auto}',
'.pnl[data-open="0"] .pb{display:none!important}',
'.pnl:last-child{border-bottom:none}',
'.pnl .ph{padding:5px 10px;font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--vscode-button-background);background:var(--vscode-titleBar-activeBackground);text-transform:uppercase;display:flex;align-items:center;gap:5px;flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer;user-select:none}',
'.pnl .ph:hover{background:var(--vscode-toolbar-hoverBackground)}',
'.pnl .ph .pchev{font-size:9px;opacity:.6;width:10px;text-align:center}',
'.pnl .ph .cnt{margin-left:auto;font-size:9px;opacity:.7;font-weight:500}',
'.pnl .pb{padding:7px 10px;font-size:11px;line-height:1.55;overflow-y:auto;flex:1 1 auto;min-height:40px}',
'.pnl .empty{color:var(--vscode-descriptionForeground);font-style:italic;opacity:.6}',
'.plan-list{list-style:none;padding:0;margin:0}',
'.plan-list li{padding:3px 0;display:flex;gap:6px;line-height:1.45}',
'.plan-list li .ic{flex-shrink:0;width:14px;text-align:center}',
'.plan-list li.st-done{color:var(--vscode-descriptionForeground);text-decoration:line-through;opacity:.7}',
'.plan-list li.st-in_progress{color:var(--vscode-button-background);font-weight:500}',
'.plan-list li.st-blocked{color:var(--vscode-errorForeground)}',
'.todo-bar{height:6px;background:var(--vscode-textCodeBlock-background);border-radius:3px;overflow:hidden;margin:4px 0 6px}',
'.todo-bar .fill{height:100%;background:var(--vscode-button-background);transition:width .3s ease}',
'.todo-stat{font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:4px}',
'.todo-list{list-style:none;padding:0;margin:0}',
'.todo-list li{padding:2px 0;font-size:11px;display:flex;gap:5px}',
/* ─── Sessions list (right column) ─────────────────────────────────── */
'#right .rh{display:flex;align-items:center;gap:4px;padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-titleBar-activeBackground);flex-shrink:0}',
'#right .rh .rt{flex:1;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--vscode-button-background)}',
'#right .rsearch{padding:5px 7px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}',
'#right .rsearch input{width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:3px 8px;font-size:11px;outline:none;font-family:inherit}',
'#right .rsearch input:focus{border-color:var(--vscode-focusBorder)}',
'#right .rscope{padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);font-size:10px;color:var(--vscode-descriptionForeground);display:flex;gap:4px;flex-shrink:0}',
'#right .rscope button{flex:1;background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);cursor:pointer;padding:2px 6px;border-radius:3px;font-size:10px}',
'#right .rscope button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}',
'#right .rlist{flex:1 1 auto;overflow-y:auto;padding:0}',
'#right .rlist .empty{padding:18px 12px;text-align:center;color:var(--vscode-descriptionForeground);font-style:italic;font-size:11px;opacity:.6}',
'#right .grp{font-size:9.5px;font-weight:700;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:1px;padding:6px 10px 3px;position:sticky;top:0;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);opacity:.7;z-index:1}',
'#right .si{padding:6px 8px 6px 10px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;position:relative}',
'#right .si:hover{background:var(--vscode-toolbar-hoverBackground)}',
'#right .si.active{background:rgba(100,160,255,.10)}',
'#right .si.active::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:2px;background:var(--vscode-button-background);border-radius:0 2px 2px 0}',
'#right .si .ti{font-size:11.5px;font-weight:500;color:var(--vscode-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:34px}',
'#right .si.active .ti{color:var(--vscode-button-background)}',
'#right .si .meta{font-size:9.5px;color:var(--vscode-descriptionForeground);margin-top:1px;opacity:.75}',
'#right .si .pv{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.6}',
'#right .si .ops{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:none;gap:1px}',
'#right .si:hover .ops{display:flex}',
'#right .si .ops button{background:none;border:none;color:var(--vscode-icon-foreground);cursor:pointer;padding:2px 4px;border-radius:3px;font-size:10px;opacity:.7}',
'#right .si .ops button:hover{background:var(--vscode-toolbar-hoverBackground);opacity:1}',
/* ─── Composer + Footer ───────────────────────────────────────────────── */
'#ia{grid-area:composer;border-top:1px solid var(--vscode-panel-border);padding:8px;background:var(--vscode-sideBar-background)}',
'#cxb{display:none;font-size:11px;color:var(--vscode-button-background);padding:0 2px 6px}',
'#ir{display:flex;gap:6px;align-items:flex-end}',
'#inp{flex:1;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:7px 10px;font-family:inherit;font-size:13px;line-height:1.45;min-height:36px;max-height:140px;outline:none}',
'#inp:focus{border-color:var(--vscode-focusBorder)}',
'#sbtn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:6px;width:34px;height:34px;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1}',
'#sbtn:hover{opacity:.85}',
'#sbtn:disabled{opacity:.38;cursor:default}',
'#foot{grid-area:foot;padding:3px 12px;font-size:10px;border-top:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);background:var(--vscode-statusBar-background,var(--vscode-titleBar-activeBackground));display:flex;align-items:center;gap:12px;height:22px}',
'#foot .ft-left{flex:1;display:flex;align-items:center;gap:8px}',
'#foot .ft-right{display:flex;align-items:center;gap:10px}',
'#foot .dot{width:6px;height:6px;border-radius:50%;background:#7ec99a;display:inline-block}',
'#foot .dot.warn{background:#e8b86d}',
'#foot .dot.err{background:var(--vscode-errorForeground)}',
'#foot .pill{padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.05)}',
'#es{padding:24px;text-align:center;opacity:.55;align-self:center;margin:auto}',
'#es .big{font-size:32px;margin-bottom:8px}',
'#es p{font-size:12px;line-height:1.7}',
'#thk{display:none;padding:2px 10px 8px;align-self:flex-start;color:var(--vscode-descriptionForeground);font-size:11px}',
'</style></head><body>',
'<div id="tb">',
'  <button class="tbb" id="leftbt" title="左侧栏 Plan/Todos">▦</button>',
'  <span class="logo">',
'    <span style="font-size:14px">⚡</span>',
'    <span>DeepSeek</span>',
'    <select class="tbsel" id="modelSel" title="模型">',
'      <option value="deepseek-v4-pro">v4-pro</option>',
'      <option value="deepseek-v4-flash">v4-flash</option>',
'      <option value="deepseek-reasoner">reasoner</option>',
'    </select>',
'    <select class="tbsel" id="modeSel" title="批准策略 (Approval Mode)">',
'      <option value="manual">🛡 Manual</option>',
'      <option value="auto-edit">✏️ Auto-Edit</option>',
'      <option value="autopilot">🚀 Autopilot</option>',
'      <option value="readonly">👁 Read-Only</option>',
'    </select>',
'  </span>',
'  <button class="tbb" id="newbt" title="新建会话 (存档当前)">➕</button>',
'  <button class="tbb" id="cxbt" title="包含当前文件">📎</button>',
'  <button class="tbb" id="apibt" title="API 设置（Key / Base URL）">🔑</button>',
'  <button class="tbb" id="rightbt" title="右侧栏 历史会话">☰</button>',
'  <button class="tbb" id="cbt" title="清空当前会话(不存档)">🗑</button>',
'</div>',
'<div id="sb"></div>',
'<aside id="left">',
'  <section class="pnl" id="planPnl" data-open="1">',
'    <div class="ph"><span class="pchev">▾</span> 📋 Plan <span class="cnt" id="plan-cnt"></span></div>',
'    <div class="pb" id="plan-body"><div class="empty">No active plan</div></div>',
'  </section>',
'  <section class="pnl" id="todoPnl" data-open="1">',
'    <div class="ph"><span class="pchev">▾</span> ✓ Todos <span class="cnt" id="todo-cnt"></span></div>',
'    <div class="pb" id="todo-body"><div class="empty">No todos</div></div>',
'  </section>',
'  <section class="pnl pnl-mini" id="agentPnl" data-open="0">',
'    <div class="ph"><span class="pchev">▸</span> 🤝 Agents <span class="cnt" id="agent-cnt">0</span></div>',
'    <div class="pb" id="agent-body" style="display:none"><div class="empty">No agents</div></div>',
'  </section>',
'</aside>',
'<div id="main">',
'  <div id="es"><div class="big">⚡</div>',
'    <p><strong>DeepSeek Agent</strong><br>输入消息，按 Enter 发送<br>勾选「📎」附带当前文件</p></div>',
'  <div id="thk">● ● ● 思考中...</div>',
'</div>',
'<aside id="right">',
'  <div class="rh">',
'    <span class="rt">Sessions</span>',
'    <button class="tbb" id="rnewbt" title="新建会话">➕</button>',
'  </div>',
'  <div class="rscope">',
'    <button id="scopeWs" class="on" title="只显示当前工作区会话">📁 本工作区</button>',
'    <button id="scopeAll" title="显示全部会话">🌐 全部</button>',
'  </div>',
'  <div class="rsearch"><input id="dsearch" type="text" placeholder="🔍 搜索会话…"/></div>',
'  <div class="rlist" id="dlist"><div class="empty">暂无会话</div></div>',
'</aside>',
'<div id="ia">',
'  <div id="cxb">📎 将附带当前文件 / 选中代码</div>',
'  <div id="ir">',
'    <textarea id="inp" rows="1" placeholder="向 DeepSeek 提问... (Enter 发送 / Shift+Enter 换行)"></textarea>',
'    <button id="sbtn" title="发送">↑</button>',
'  </div>',
'</div>',
'<div id="foot">',
'  <div class="ft-left">',
'    <span class="dot" id="dot"></span>',
'    <span id="ft-mode">agent · deepseek-v4-pro</span>',
'  </div>',
'  <div class="ft-right">',
'    <span class="pill" id="ft-think">🤔 0.0s</span>',
'    <span class="pill" id="ft-tokens">0 tokens</span>',
'    <span class="pill" id="ft-cost" style="color:#e8b86d">¥0.0000</span>',
'  </div>',
'</div>',
'<script>',
'(function(){',
'  var vscode;',
'  try { vscode = acquireVsCodeApi(); } catch(e) { document.body.innerHTML += "<div style=\\"color:red;padding:10px\\">vscode API error: "+e.message+"</div>"; return; }',
'  var msgs = document.getElementById("main");',
'  var thk  = document.getElementById("thk");',
'  var inp  = document.getElementById("inp");',
'  var sbtn = document.getElementById("sbtn");',
'  var es   = document.getElementById("es");',
'  var cxb  = document.getElementById("cxb");',
'  var cxbt = document.getElementById("cxbt");',
'  var apibt = document.getElementById("apibt");',
'  var leftbt = document.getElementById("leftbt");',
'  var rightbt = document.getElementById("rightbt");',
'  var newbt  = document.getElementById("newbt");',
'  var rnewbt = document.getElementById("rnewbt");',
'  var scopeWs = document.getElementById("scopeWs");',
'  var scopeAll = document.getElementById("scopeAll");',
'  var dlist  = document.getElementById("dlist");',
'  var dsearch = document.getElementById("dsearch");',
'  var cbt  = document.getElementById("cbt");',
'  var modelSel = document.getElementById("modelSel");',
'  var modeSel = document.getElementById("modeSel");',
'  var sb   = document.getElementById("sb");',
'  var dot  = document.getElementById("dot");',
'  var ftMode = document.getElementById("ft-mode");',
'  var ftThink = document.getElementById("ft-think");',
'  var ftTokens = document.getElementById("ft-tokens");',
'  var ftCost = document.getElementById("ft-cost");',
'  var planBody = document.getElementById("plan-body");',
'  var planCnt = document.getElementById("plan-cnt");',
'  var todoBody = document.getElementById("todo-body");',
'  var todoCnt = document.getElementById("todo-cnt");',
'  var cxOn = false, busy = false;',
'  var cur = null, curText = "", curThk = null, curBubble = null;',
'  var toolMap = {};',
/* session-cumulative metrics */
'  var sess = { tokens:0, cost:0, thinkMs:0 };',
'  var sessions = [], activeSessionId = null, currentWs = "";',
'  /* Smart scroll: only auto-stick to bottom when user is at/near bottom; otherwise leave alone. */',
'  var stick = true;',
'  var jumpBtn = document.createElement("button");',
'  jumpBtn.className = "jumpbtn"; jumpBtn.textContent = "↓ 跳到最新";',
'  jumpBtn.addEventListener("click", function(){ stick = true; msgs.scrollTop = msgs.scrollHeight; jumpBtn.classList.remove("show"); });',
'  msgs.appendChild(jumpBtn);',
'  msgs.addEventListener("scroll", function(){',
'    var nearBottom = (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight) < 80;',
'    stick = nearBottom;',
'    jumpBtn.classList.toggle("show", !nearBottom && busy);',
'  }, { passive: true });',
'  /* Disable autoscroll on user wheel/touch scroll up. */',
'  msgs.addEventListener("wheel", function(e){ if (e.deltaY < 0) stick = false; }, { passive: true });',
'  function ascroll(){ if (stick) msgs.scrollTop = msgs.scrollHeight; else jumpBtn.classList.add("show"); }',
'',
'  /* Auto narrow mode based on width */',
'  function checkNarrow(){',
'    if (window.innerWidth < 600) document.body.classList.add("narrow");',
'    else document.body.classList.remove("narrow");',
'  }',
'  window.addEventListener("resize", checkNarrow); checkNarrow();',
'  /* ▦ left button: toggle Plan/Todos column */',
'  leftbt.addEventListener("click", function(){ document.body.classList.toggle("no-left"); });',
'  /* ☰ right button: toggle Sessions column */',
'  rightbt.addEventListener("click", function(){ document.body.classList.toggle("no-right"); });',
'  /* Scope buttons: filter sessions by current workspace or all */',
'  var scopeMode = "ws"; /* "ws" | "all" */',
'  function setScope(m){ scopeMode = m; scopeWs.classList.toggle("on", m==="ws"); scopeAll.classList.toggle("on", m==="all"); renderSessions(); }',
'  scopeWs.addEventListener("click", function(){ setScope("ws"); });',
'  scopeAll.addEventListener("click", function(){ setScope("all"); });',
'  function newSession(){ vscode.postMessage({type:"sessionNew"}); resetChat(); }',
'  newbt.addEventListener("click", newSession);',
'  rnewbt.addEventListener("click", newSession);',
'  /* Panel headers: click to collapse */',
'  document.querySelectorAll(".pnl .ph").forEach(function(ph){',
'    ph.addEventListener("click", function(){',
'      var pn = ph.parentElement;',
'      var open = pn.dataset.open === "1";',
'      pn.dataset.open = open ? "0" : "1";',
'      var ch = ph.querySelector(".pchev"); if (ch) ch.textContent = open ? "▸" : "▾";',
'      var pb = pn.querySelector(".pb"); if (pb) pb.style.display = open ? "none" : "";',
'    });',
'  });',
'',
'  function escHtml(s){',
'    return String(s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split("\\"").join("&quot;");',
'  }',
'  function escapeHtml(s){',
'    return String(s||"").replace(/[&<>"\\\']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\\\'":"&#39;"})[c]; });',
'  }',
'',
'  function renderInline(t){',
'    var x = escHtml(t);',
'    x = x.replace(/`([^`\\n]+)`/g, "<code class=\\"ic\\">$1</code>");',
'    x = x.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");',
'    x = x.replace(/(^|[\\s(\\[\\"`])([\\w./\\-]+\\.(?:ts|tsx|js|jsx|rs|py|go|java|c|cc|cpp|h|hpp|md|json|toml|yaml|yml|sh|ps1|html|css|scss|sql|rb|swift|kt|php|lua|vue|svelte))(?::(\\d+)(?::(\\d+))?)?(?=[\\s,);:.!?\\]\\"`]|$)/g,',
'      function(_, pre, p, line, col){',
'        var disp = p + (line ? ":" + line : "") + (col ? ":" + col : "");',
'        return pre + "<a class=\\"flink\\" data-path=\\"" + escHtml(p) + "\\" data-line=\\"" + (line || "") + "\\">" + escHtml(disp) + "</a>";',
'      });',
'    return x;',
'  }',
'  function renderMd(s){',
'    /* Step 1: extract fenced code blocks as placeholders */',
'    var codes = [];',
'    var src = String(s||"").replace(/```([a-zA-Z0-9_+-]*)\\n?([\\s\\S]*?)```/g, function(_, lang, code){',
'      var L = (lang || "plaintext").toLowerCase();',
'      var raw = code.replace(/\\n$/, "");',
'      codes.push({L:L, raw:raw});',
'      return "\\u0000CB" + (codes.length-1) + "\\u0000";',
'    });',
'    var lines = src.split(/\\r?\\n/);',
'    var out = [];',
'    var paraBuf = [];',
'    function flushPara(){',
'      if (!paraBuf.length) return;',
'      var joined = paraBuf.join(" ");',
'      /* If a paragraph is JUST a code-block placeholder, emit it raw */',
'      var only = joined.match(/^\\s*\\u0000CB(\\d+)\\u0000\\s*$/);',
'      if (only){',
'        var c = codes[+only[1]], b64 = encodeURIComponent(c.raw);',
'        out.push("<pre class=\\"cb\\" data-code=\\"" + b64 + "\\"><div class=\\"cb-h\\"><span class=\\"lang\\">" + escHtml(c.L) + "</span><button class=\\"cb-copy\\">复制</button><button class=\\"cb-insert\\">插入</button></div><code>" + c.raw + "</code></pre>");',
'      } else {',
'        out.push("<p>" + renderInline(joined) + "</p>");',
'      }',
'      paraBuf = [];',
'    }',
'    var i = 0;',
'    while (i < lines.length){',
'      var ln = lines[i];',
'      var m;',
'      /* Headers ## Foo */',
'      if ((m = ln.match(/^(#{1,4})\\s+(.+?)\\s*#*\\s*$/))){',
'        flushPara();',
'        var lvl = m[1].length + 1; if (lvl > 6) lvl = 6;',
'        out.push("<h" + lvl + " class=\\"mh\\">" + renderInline(m[2]) + "</h" + lvl + ">");',
'        i++; continue;',
'      }',
'      /* HR */',
'      if (/^\\s*[-*_]{3,}\\s*$/.test(ln)){',
'        flushPara(); out.push("<hr class=\\"mhr\\"/>"); i++; continue;',
'      }',
'      /* Standalone code-block placeholder line */',
'      if (/^\\s*\\u0000CB\\d+\\u0000\\s*$/.test(ln)){',
'        flushPara();',
'        var idx = +ln.match(/\\u0000CB(\\d+)\\u0000/)[1];',
'        var cc = codes[idx], b64b = encodeURIComponent(cc.raw);',
'        out.push("<pre class=\\"cb\\" data-code=\\"" + b64b + "\\"><div class=\\"cb-h\\"><span class=\\"lang\\">" + escHtml(cc.L) + "</span><button class=\\"cb-copy\\">复制</button><button class=\\"cb-insert\\">插入</button></div><code>" + cc.raw + "</code></pre>");',
'        i++; continue;',
'      }',
'      /* Table: header | sep */',
'      if (i+1 < lines.length && /\\|/.test(ln) && /^\\s*\\|?\\s*:?-{2,}/.test(lines[i+1])){',
'        flushPara();',
'        function splitRow(r){ var p = r.split("|").map(function(x){return x.trim();}); if (p.length && p[0]==="") p.shift(); if (p.length && p[p.length-1]==="") p.pop(); return p; }',
'        var head = splitRow(ln); i += 2;',
'        var rows = [];',
'        while (i < lines.length && /\\|/.test(lines[i]) && lines[i].trim() !== ""){ rows.push(splitRow(lines[i])); i++; }',
'        var ht = "<table class=\\"mtbl\\"><thead><tr>" + head.map(function(c){return "<th>" + renderInline(c) + "</th>";}).join("") + "</tr></thead><tbody>";',
'        ht += rows.map(function(r){ return "<tr>" + r.map(function(c){return "<td>" + renderInline(c) + "</td>";}).join("") + "</tr>"; }).join("");',
'        ht += "</tbody></table>";',
'        out.push(ht); continue;',
'      }',
'      /* Unordered list */',
'      if (/^\\s*[-*+]\\s+/.test(ln)){',
'        flushPara();',
'        var its = [];',
'        while (i < lines.length && /^\\s*[-*+]\\s+/.test(lines[i])){ its.push(lines[i].replace(/^\\s*[-*+]\\s+/, "")); i++; }',
'        out.push("<ul class=\\"mul\\">" + its.map(function(x){return "<li>" + renderInline(x) + "</li>";}).join("") + "</ul>");',
'        continue;',
'      }',
'      /* Ordered list */',
'      if (/^\\s*\\d+\\.\\s+/.test(ln)){',
'        flushPara();',
'        var ord = [];',
'        while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])){ ord.push(lines[i].replace(/^\\s*\\d+\\.\\s+/, "")); i++; }',
'        out.push("<ol class=\\"mol\\">" + ord.map(function(x){return "<li>" + renderInline(x) + "</li>";}).join("") + "</ol>");',
'        continue;',
'      }',
'      /* Blockquote */',
'      if (/^\\s*>\\s?/.test(ln)){',
'        flushPara();',
'        var bq = [];',
'        while (i < lines.length && /^\\s*>\\s?/.test(lines[i])){ bq.push(lines[i].replace(/^\\s*>\\s?/, "")); i++; }',
'        out.push("<blockquote class=\\"mbq\\">" + renderInline(bq.join(" ")) + "</blockquote>");',
'        continue;',
'      }',
'      /* Blank line = paragraph break */',
'      if (ln.trim() === ""){ flushPara(); i++; continue; }',
'      paraBuf.push(ln); i++;',
'    }',
'    flushPara();',
'    return out.join("");',
'  }',
'',
'  function add(role, text){',
'    if (es) es.style.display = "none";',
'    var d = document.createElement("div");',
'    if (role === "user"){ d.className = "msgU"; d.textContent = text; }',
'    else if (role === "assistant"){',
'      d.className = "msgA";',
'      d.innerHTML = "<div class=\\"lbl\\">DEEPSEEK</div><div class=\\"msgC\\">" + escHtml(text) + "</div>";',
'    } else { d.className = "err"; d.textContent = text; }',
'    if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);',
'    ascroll();',
'  }',
'',
'  function ensureBubble(){',
'    if (curBubble) return curBubble;',
'    if (es) es.style.display = "none";',
'    var d = document.createElement("div");',
'    d.className = "msgA";',
'    d.innerHTML = "<div class=\\"lbl\\">DEEPSEEK</div>" +',
'      "<div class=\\"thinkhead\\" style=\\"display:none\\">▸ thinking</div>" +',
'      "<div class=\\"thinkblk\\" style=\\"display:none\\"></div>" +',
'      "<div class=\\"tools\\"></div><div class=\\"msgC\\"></div>";',
'    if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);',
'    curBubble = d;',
'    cur = d.querySelector(".msgC");',
'    curThk = d.querySelector(".thinkblk");',
'    var thh = d.querySelector(".thinkhead");',
'    thh.addEventListener("click", function(){',
'      if (!curThk) return;',
'      var open = curThk.style.display === "block";',
'      curThk.style.display = open ? "none" : "block";',
'      thh.textContent = (open ? "▸ " : "▾ ") + (thh.dataset.label || "thinking");',
'    });',
'    curText = "";',
'    return d;',
'  }',
'',
'  function shortArgs(s){',
'    try { var o = JSON.parse(s||"{}"); return JSON.stringify(o); } catch(e){ return String(s||"").slice(0,200); }',
'  }',
'  /* Copilot-style verb + target extraction (e.g. "Read crates/core/src/lib.rs") */',
'  var VERB = { read_file:"Read", write_file:"Write", list_dir:"List", grep_search:"Search", run_shell:"Run", update_plan:"Plan" };',
'  function toolTarget(name, argStr){',
'    var o; try { o = JSON.parse(argStr||"{}"); } catch(e){ return ""; }',
'    if (!o || typeof o !== "object") return "";',
'    if (name === "read_file"){',
'      var p = o.path || o.file || ""; if (!p) return "";',
'      if (o.start_line || o.end_line) return p + ":" + (o.start_line||1) + "-" + (o.end_line||"");',
'      return p;',
'    }',
'    if (name === "write_file") return o.path || o.file || "";',
'    if (name === "list_dir") return o.path || o.dir || ".";',
'    if (name === "grep_search") return (o.pattern || o.query || "") + (o.path ? "  in " + o.path : "");',
'    if (name === "run_shell") return o.command || o.cmd || "";',
'    if (name === "update_plan") return ((o.steps && o.steps.length) ? o.steps.length + " step" + (o.steps.length>1?"s":"") : "");',
'    var v = o.path || o.file || o.query || o.pattern || o.command || ""; return String(v).slice(0,120);',
'  }',
'',
'  function addToolCard(id, name, args, opts){',
'    opts = opts || {};',
'    ensureBubble();',
'    var holder = curBubble.querySelector(".tools");',
'    var d = document.createElement("div");',
'    d.className = "tool run";',
'    var verb = VERB[name] || name;',
'    var target = toolTarget(name, args);',
'    var statusTxt = opts.approval ? "等待批准" : "…";',
'    d.innerHTML = ',
'      "<div class=\\"h\\">" +',
'        "<span class=\\"chev\\">▶</span>" +',
'        "<span class=\\"nm\\">" + escHtml(verb) + "</span>" +',
'        "<span class=\\"tgt\\" title=\\"" + escHtml(target) + "\\">" + escHtml(target) + "</span>" +',
'        "<span class=\\"st\\">" + escHtml(statusTxt) + "</span>" +',
'      "</div>" +',
'      "<div class=\\"b\\"><div class=\\"args\\">" + escHtml(shortArgs(args)) + "</div><div class=\\"out\\"></div></div>";',
'    holder.appendChild(d);',
'    d.querySelector(".h").addEventListener("click", function(){ d.classList.toggle("open"); });',
'    if (opts.approval){',
'      d.classList.add("open");',
'      var ap = document.createElement("div");',
'      ap.className = "approve";',
'      ap.innerHTML = "<button class=\\"btn-yes\\">允许</button><button class=\\"btn-no\\">拒绝</button>";',
'      d.appendChild(ap);',
'      ap.querySelector(".btn-yes").addEventListener("click", function(){',
'        vscode.postMessage({type:"approve", id:id, decision:true}); ap.remove();',
'        d.querySelector(".st").textContent = "运行中";',
'      });',
'      ap.querySelector(".btn-no").addEventListener("click", function(){',
'        vscode.postMessage({type:"approve", id:id, decision:false}); ap.remove();',
'        d.querySelector(".st").textContent = "拒绝"; d.classList.remove("run"); d.classList.add("err");',
'      });',
'    }',
'    toolMap[id] = { root:d, body:d.querySelector(".b .out"), status:d.querySelector(".st") };',
'    ascroll();',
'    return d;',
'  }',
'',
'  /* ─── Side panel renderers ─────────────────────────────────────────── */',
'  var ICONS = {pending:"⬜", in_progress:"🔄", done:"✅", blocked:"🚧"};',
'  function renderPlan(steps){',
'    if (!steps || !steps.length){',
'      planBody.innerHTML = "<div class=\\"empty\\">No active plan</div>"; planCnt.textContent = ""; renderTodos([]); return;',
'    }',
'    var html = "<ul class=\\"plan-list\\">";',
'    steps.forEach(function(s, i){',
'      var ic = ICONS[s.status] || ICONS.pending;',
'      html += "<li class=\\"st-" + s.status + "\\"><span class=\\"ic\\">" + ic + "</span><span>" + (i+1) + ". " + escapeHtml(s.title) + "</span></li>";',
'    });',
'    html += "</ul>";',
'    planBody.innerHTML = html;',
'    var done = steps.filter(function(s){return s.status === "done";}).length;',
'    planCnt.textContent = done + "/" + steps.length;',
'    renderTodos(steps);',
'  }',
'  function renderTodos(steps){',
'    if (!steps || !steps.length){',
'      todoBody.innerHTML = "<div class=\\"empty\\">No todos</div>"; todoCnt.textContent = ""; return;',
'    }',
'    var done = steps.filter(function(s){return s.status === "done";}).length;',
'    var pct = Math.round((done / steps.length) * 100);',
'    var html = "<div class=\\"todo-stat\\">" + done + " / " + steps.length + " 完成 (" + pct + "%)</div>";',
'    html += "<div class=\\"todo-bar\\"><div class=\\"fill\\" style=\\"width:" + pct + "%\\"></div></div>";',
'    html += "<ul class=\\"todo-list\\">";',
'    steps.forEach(function(s){',
'      if (s.status === "done") return;',
'      var ic = ICONS[s.status] || ICONS.pending;',
'      html += "<li><span>" + ic + "</span><span>" + escapeHtml(s.title) + "</span></li>";',
'    });',
'    html += "</ul>";',
'    todoBody.innerHTML = html; todoCnt.textContent = done + "/" + steps.length;',
'  }',
'  function addTask(){ return null; }',
'  function updateTask(){ /* no-op since v0.16: Tasks panel removed; sessions drawer replaces it */ }',
'',
'  /* ─── Footer / session metrics ─────────────────────────────────────── */',
'  function fmtCny(v){ return "¥" + (v||0).toFixed(4); }',
'  function fmtTokens(n){',
'    if (n >= 1e6) return (n/1e6).toFixed(2) + "M";',
'    if (n >= 1e3) return (n/1e3).toFixed(1) + "K";',
'    return String(n);',
'  }',
'  function bumpUsage(u){',
'    sess.tokens += (u.total_tokens || 0);',
'    sess.cost += (u.cost_cny || 0);',
'    sess.thinkMs += (u.thinking_ms || 0);',
'    ftTokens.textContent = fmtTokens(sess.tokens) + " tokens";',
'    ftCost.textContent = fmtCny(sess.cost);',
'    ftThink.textContent = "🤔 " + (sess.thinkMs / 1000).toFixed(1) + "s";',
'  }',
'',
'  /* ─── Composer ─────────────────────────────────────────────────────── */',
'  function autosize(){ inp.style.height = "36px"; inp.style.height = Math.min(inp.scrollHeight, 140) + "px"; }',
'  function doSend(){',
'    var t = inp.value.trim();',
'    if (!t || busy) return;',
'    add("user", t);',
'    inp.value = ""; autosize();',
'    vscode.postMessage({type:"send", text:t});',
'  }',
'  function resetChat(){',
'    var nodes = msgs.querySelectorAll(".msgU,.msgA,.err");',
'    for (var i=0;i<nodes.length;i++) nodes[i].remove();',
'    if (es) es.style.display = "block";',
'    sess = { tokens:0, cost:0, thinkMs:0 };',
'    ftTokens.textContent = "0 tokens"; ftCost.textContent = "¥0.0000"; ftThink.textContent = "🤔 0.0s";',
'    renderPlan([]);',
'    curBubble = null; cur = null; curText = ""; curThk = null; toolMap = {};',
'  }',
'  inp.addEventListener("input", autosize);',
'  inp.addEventListener("keydown", function(e){',
'    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); doSend(); }',
'  });',
'  sbtn.addEventListener("click", doSend);',
'  cxbt.addEventListener("click", function(){',
'    cxOn = !cxOn;',
'    cxbt.classList.toggle("active", cxOn);',
'    cxb.style.display = cxOn ? "block" : "none";',
'    vscode.postMessage({type:"contextToggle", active:cxOn});',
'  });',
'  modelSel.addEventListener("change", function(){',
'    vscode.postMessage({type:"setModel", model: modelSel.value});',
'  });',
'  modeSel.addEventListener("change", function(){',
'    modeSel.dataset.m = modeSel.value;',
'    vscode.postMessage({type:"setMode", mode: modeSel.value});',
'  });',
'  apibt.addEventListener("click", function(){ vscode.postMessage({type:"openApiSettings"}); });',
'  cbt.addEventListener("click", function(){',
'    resetChat();',
'    vscode.postMessage({type:"clear"});',
'  });',
'',
'  /* ─── Message handler ──────────────────────────────────────────────── */',
'  window.addEventListener("message", function(e){',
'    var m = e.data;',
'    if (m.type === "thinking"){',
'      busy = m.show; thk.style.display = m.show ? "block" : "none"; sbtn.disabled = m.show;',
'      dot.className = "dot" + (m.show ? " warn" : "");',
'    } else if (m.type === "replyStart"){',
'      curBubble = null; cur = null; curThk = null; curText = ""; toolMap = {};',
'      ensureBubble(); ascroll();',
'    } else if (m.type === "newTurn"){',
'      curBubble = null; cur = null; curThk = null; curText = ""; ensureBubble();',
'    } else if (m.type === "replyDelta"){',
'      ensureBubble();',
'      curText += (m.text || ""); cur.innerHTML = renderMd(curText);',
'      var th2 = curBubble.querySelector(".thinkhead");',
'      if (th2 && th2.style.display !== "none" && !th2.dataset.done) {',
'        th2.dataset.done = "1";',
'        th2.dataset.label = "thoughts";',
'        th2.textContent = (curThk && curThk.style.display === "block" ? "▾ " : "▸ ") + "thoughts";',
'      }',
'      ascroll();',
'    } else if (m.type === "thinkingDelta"){',
'      ensureBubble();',
'      var th = curBubble.querySelector(".thinkhead");',
'      if (th && th.style.display === "none") { th.style.display = "inline-block"; th.textContent = "▸ thinking…"; }',
'      /* keep thinkblk hidden until user clicks the head; just accumulate content */',
'      curThk.textContent += (m.text || "");',
'      ascroll();',
'    } else if (m.type === "toolStart"){',
'      addToolCard(m.id, m.name, m.args, {});',
'    } else if (m.type === "approvalRequest"){',
'      addToolCard(m.id, m.name, m.args, { approval:true });',
'    } else if (m.type === "autoApproval"){',
'      ensureBubble();',
'      var holder = curBubble.querySelector(".tools");',
'      var d = document.createElement("div");',
'      d.className = "tool " + (m.decision ? "ok" : "err");',
'      var verb2 = (VERB[m.name] || m.name);',
'      var tgt2 = toolTarget(m.name, m.args);',
'      var label = m.decision ? ("auto-allow · " + m.mode) : ("auto-deny · " + m.mode);',
'      d.innerHTML = "<div class=\\"h\\"><span class=\\"chev\\">▶</span><span class=\\"nm\\">" + escHtml(verb2) + "</span><span class=\\"tgt\\">" + escHtml(tgt2) + "</span><span class=\\"st\\">" + escHtml(label) + "</span></div>" +',
'        "<div class=\\"b\\"><div class=\\"args\\">" + escHtml(shortArgs(m.args)) + "</div></div>";',
'      holder.appendChild(d);',
'      d.querySelector(".h").addEventListener("click", function(){ d.classList.toggle("open"); });',
'    } else if (m.type === "toolResult"){',
'      var tc = toolMap[m.id];',
'      if (!tc){ tc = { root: addToolCard(m.id, m.name, "{}", {}), body:null, status:null };',
'        tc.body = tc.root.querySelector(".b .out"); tc.status = tc.root.querySelector(".st"); }',
'      tc.root.classList.remove("run");',
'      tc.root.classList.add(m.ok ? "ok" : "err");',
'      var out = String(m.output || "");',
'      var lines = out ? out.split(/\\r?\\n/).length : 0;',
'      var bytes = out.length;',
'      tc.status.textContent = m.ok ? (lines>1 ? lines + " lines" : (bytes ? bytes + "B" : "ok")) : "failed";',
'      tc.body.textContent = out;',
'      ascroll();',
'    } else if (m.type === "plan"){',
'      renderPlan(m.steps || []);',
'    } else if (m.type === "usage"){',
'      bumpUsage(m.usage || {});',
'    } else if (m.type === "replyEnd"){',
'      if (cur && m.empty && curText === "" && curBubble && !curBubble.querySelector(".tool")){ cur.textContent = "(no response)"; }',
'      curBubble = null; cur = null; curThk = null; curText = "";',
'    } else if (m.type === "reply"){',
'      add("assistant", m.text);',
'    } else if (m.type === "error"){',
'      add("error", m.text);',
'    } else if (m.type === "serverStatus"){',
'      sb.style.display = m.running ? "none" : "block";',
'      if (!m.running) sb.textContent = "⚠ 后端服务器未启动 — 发送时将自动启动";',
'      dot.className = "dot" + (m.running ? "" : " err");',
'    } else if (m.type === "modelInfo"){',
'      if (m.model){',
'        if (modelSel) modelSel.value = m.model;',
'        ftMode.textContent = "agent · " + m.model;',
'      }',
'      if (m.approvalMode){',
'        if (modeSel){ modeSel.value = m.approvalMode; modeSel.dataset.m = m.approvalMode; }',
'      }',
'    } else if (m.type === "status"){',
'      if (m.text){ sb.textContent = m.text; sb.style.display = "block"; } else sb.style.display = "none";',
'    } else if (m.type === "sessions"){',
'      sessions = m.items || []; activeSessionId = m.activeId || null;',
'      if (typeof m.currentWs === "string") currentWs = m.currentWs;',
'      renderSessions();',
'    } else if (m.type === "sessionLoaded"){',
'      activeSessionId = m.id || null;',
'      resetChat();',
'      var msgsArr = m.messages || [];',
'      for (var k=0; k<msgsArr.length; k++){',
'        var mm = msgsArr[k];',
'        if (mm.role === "user") add("user", mm.text || "");',
'        else if (mm.role === "assistant"){',
'          if (es) es.style.display = "none";',
'          var d = document.createElement("div");',
'          d.className = "msgA";',
'          d.innerHTML = "<div class=\\"lbl\\">DEEPSEEK</div><div class=\\"msgC\\"></div>";',
'          if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);',
'          d.querySelector(".msgC").innerHTML = renderMd(mm.text || "");',
'        }',
'      }',
'      renderSessions(); ascroll();',
'    }',
'  });',
'',
'  /* ─── Sessions list rendering ──────────────────────────────────── */',
'  function relTime(ts){',
'    if (!ts) return "";',
'    var d = Date.now() - ts;',
'    if (d < 60000) return "刚刚";',
'    if (d < 3600000) return Math.floor(d/60000) + " 分钟前";',
'    if (d < 86400000) return Math.floor(d/3600000) + " 小时前";',
'    if (d < 7*86400000) return Math.floor(d/86400000) + " 天前";',
'    var dt = new Date(ts);',
'    return (dt.getMonth()+1) + "月" + dt.getDate() + "日";',
'  }',
'  function dayBucket(ts){',
'    var now = new Date();',
'    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();',
'    var yesterdayStart = todayStart - 86400000;',
'    var weekStart = todayStart - 6*86400000;',
'    if (ts >= todayStart) return "今天";',
'    if (ts >= yesterdayStart) return "昨天";',
'    if (ts >= weekStart) return "本周";',
'    return "更早";',
'  }',
'  function renderSessions(){',
'    var q = (dsearch && dsearch.value || "").trim().toLowerCase();',
'    var list = sessions.slice();',
'    if (scopeMode === "ws" && currentWs) list = list.filter(function(s){ return (s.ws||"") === currentWs; });',
'    if (q) list = list.filter(function(s){ return (s.title||"").toLowerCase().indexOf(q) >= 0 || (s.preview||"").toLowerCase().indexOf(q) >= 0; });',
'    if (!list.length){ dlist.innerHTML = \'<div class="empty">\' + (q ? "无匹配" : (scopeMode==="ws" ? "本工作区暂无会话" : "暂无会话")) + \'</div>\'; return; }',
'    var html = "", lastBucket = "";',
'    list.forEach(function(s){',
'      var b = dayBucket(s.updatedAt || s.createdAt || 0);',
'      if (b !== lastBucket){ html += \'<div class="grp">\' + b + \'</div>\'; lastBucket = b; }',
'      var act = (s.id === activeSessionId) ? " active" : "";',
'      html += \'<div class="si\' + act + \'" data-id="\' + s.id + \'">\' +',
'        \'<div class="ti">\' + escHtml(s.title || "Untitled") + \'</div>\' +',
'        \'<div class="meta">\' + escHtml(s.model || "") + " · " + (s.msgCount||0) + " msg · " + escHtml(relTime(s.updatedAt)) + \'</div>\' +',
'        (s.preview ? \'<div class="pv">\' + escHtml(s.preview) + \'</div>\' : "") +',
'        \'<div class="ops"><button class="rn" title="重命名">✏</button><button class="dl" title="删除">🗑</button></div>\' +',
'      \'</div>\';',
'    });',
'    dlist.innerHTML = html;',
'  }',
'  if (dsearch) dsearch.addEventListener("input", renderSessions);',
'  dlist.addEventListener("click", function(e){',
'    var btnRn = e.target.closest && e.target.closest("button.rn");',
'    var btnDl = e.target.closest && e.target.closest("button.dl");',
'    var item  = e.target.closest && e.target.closest(".si");',
'    if (!item) return;',
'    var id = item.dataset.id;',
'    if (btnDl){ e.stopPropagation(); if (confirm("删除该会话？")) vscode.postMessage({type:"sessionDelete", id:id}); return; }',
'    if (btnRn){',
'      e.stopPropagation();',
'      var cur = item.querySelector(".ti").textContent;',
'      var nv = prompt("重命名会话：", cur); if (nv != null) vscode.postMessage({type:"sessionRename", id:id, title:nv});',
'      return;',
'    }',
'    vscode.postMessage({type:"sessionLoad", id:id});',
'  });',
'',
'  /* Click delegation: code-block copy/insert buttons + file path links */',
'  msgs.addEventListener("click", function(e){',
'    var t = e.target;',
'    if (t.classList.contains("cb-copy")){',
'      var pre = t.closest("pre.cb"); if (!pre) return;',
'      var code = decodeURIComponent(pre.getAttribute("data-code") || "");',
'      navigator.clipboard.writeText(code).then(function(){',
'        var orig = t.textContent; t.textContent = "✓ 已复制"; t.classList.add("copied");',
'        setTimeout(function(){ t.textContent = orig; t.classList.remove("copied"); }, 1500);',
'      });',
'      return;',
'    }',
'    if (t.classList.contains("cb-insert")){',
'      var pre2 = t.closest("pre.cb"); if (!pre2) return;',
'      var code2 = decodeURIComponent(pre2.getAttribute("data-code") || "");',
'      vscode.postMessage({type:"insert", code: code2});',
'      var orig2 = t.textContent; t.textContent = "✓ 已插入";',
'      setTimeout(function(){ t.textContent = orig2; }, 1500);',
'      return;',
'    }',
'    var a = t.closest && t.closest("a.flink");',
'    if (a){',
'      e.preventDefault();',
'      vscode.postMessage({type:"openFile", path: a.getAttribute("data-path"), line: parseInt(a.getAttribute("data-line") || "0", 10) || 0});',
'    }',
'  });',
'',
'  vscode.postMessage({type:"ready"});',
'})();',
'</script></body></html>'
    ].join('\n');
}

// ─── Activate ─────────────────────────────────────────────────────────────────

function activate(context) {
    const output        = vscode.window.createOutputChannel('DeepSeek Agent');
    const serverManager = new ServerManager(output, context.secrets);
    const chatProvider  = new ChatViewProvider(context, serverManager);

    // ─── API key / base URL management ────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.setApiKey', async () => {
            const existing = await context.secrets.get('deepseekAgent.apiKey');
            const key = await vscode.window.showInputBox({
                prompt: '输入 DeepSeek API Key（保存到 VS Code SecretStorage，不会写入 settings.json）',
                placeHolder: 'sk-...',
                value: existing ? '' : '',
                password: true,
                ignoreFocusOut: true,
            });
            if (key === undefined) return;
            if (key.trim() === '') {
                await context.secrets.delete('deepseekAgent.apiKey');
                vscode.window.showInformationMessage('已删除 DeepSeek API Key');
            } else {
                await context.secrets.store('deepseekAgent.apiKey', key.trim());
                vscode.window.showInformationMessage('✅ DeepSeek API Key 已保存。正在重启后端…');
            }
            await serverManager.restart().catch(e => vscode.window.showErrorMessage('重启失败：' + e.message));
        }),
        vscode.commands.registerCommand('deepseekAgent.setBaseUrl', async () => {
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            const cur = cfg.get('apiBaseUrl') || '';
            const choice = await vscode.window.showQuickPick(
                [
                    { label: '🌍 国际版（默认）', description: 'https://api.deepseek.com', value: 'https://api.deepseek.com' },
                    { label: '🇨🇳 中国大陆', description: 'https://api.deepseeki.com', value: 'https://api.deepseeki.com' },
                    { label: '✏️ 自定义…', description: '手动输入 URL', value: '__custom__' },
                    { label: '↩ 清空（用配置文件 / 默认）', description: '', value: '' },
                ],
                { placeHolder: `当前：${cur || '默认'}` }
            );
            if (!choice) return;
            let url = choice.value;
            if (url === '__custom__') {
                url = await vscode.window.showInputBox({
                    prompt: '输入 OpenAI 兼容 Base URL',
                    value: cur,
                    placeHolder: 'https://api.example.com/v1',
                    ignoreFocusOut: true,
                });
                if (url === undefined) return;
            }
            await cfg.update('apiBaseUrl', url, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`✅ Base URL = ${url || '(默认)'}。正在重启后端…`);
            await serverManager.restart().catch(e => vscode.window.showErrorMessage('重启失败：' + e.message));
        }),
        vscode.commands.registerCommand('deepseekAgent.restartServer', async () => {
            try { await serverManager.restart(); vscode.window.showInformationMessage('✅ 后端已重启'); }
            catch (e) { vscode.window.showErrorMessage('重启失败：' + e.message); }
        }),
        vscode.commands.registerCommand('deepseekAgent.showApiStatus', async () => {
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            const key = await context.secrets.get('deepseekAgent.apiKey');
            const envKey = process.env.DEEPSEEK_API_KEY;
            const lines = [
                `**API Key**：${key ? '✅ 已设置（SecretStorage）' : (envKey ? '⚠ 仅来自环境变量' : '❌ 未设置')}`,
                `**Base URL**：${cfg.get('apiBaseUrl') || '默认（api.deepseek.com 或配置文件）'}`,
                `**模型**：${cfg.get('defaultModel')}`,
                `**端口**：${cfg.get('serverPort')}`,
                `**批准策略**：${cfg.get('approvalMode')}`,
            ];
            const action = await vscode.window.showInformationMessage(lines.join(' · '), '设置 API Key', '切换 Base URL', '重启后端');
            if (action === '设置 API Key') vscode.commands.executeCommand('deepseekAgent.setApiKey');
            else if (action === '切换 Base URL') vscode.commands.executeCommand('deepseekAgent.setBaseUrl');
            else if (action === '重启后端') vscode.commands.executeCommand('deepseekAgent.restartServer');
        }),
    );

    // Sidebar WebviewView
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Open sidebar command
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.open', () => {
            vscode.commands.executeCommand('workbench.view.extension.deepseek-sidebar');
        })
    );

    // Open as a dedicated editor tab — looks like a separate "window" right
    // next to Copilot Chat. The user can then drag this tab to a split group
    // (right pane) to make it feel like a permanent right-side panel.
    let activeTabPanel = null;
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.openInTab', () => {
            if (activeTabPanel) {
                activeTabPanel.reveal(vscode.ViewColumn.Beside, false);
                return;
            }
            const panel = vscode.window.createWebviewPanel(
                'deepseek.chatPanel',
                'DeepSeek Agent',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
                }
            );
            try {
                panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
            } catch (_) { /* optional */ }
            activeTabPanel = panel;
            panel.onDidDispose(() => { if (activeTabPanel === panel) activeTabPanel = null; });
            chatProvider.bindPanel(panel);
        })
    );

    // Open full TUI in terminal
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.openTerminal', () => {
            openTuiTerminal();
        })
    );

    // Move-to-right helper: opens the auxiliary (right) side bar so the user
    // can drag the DeepSeek icon there. VS Code does not expose a public API
    // for third-party extensions to default-locate a view in the secondary
    // side bar, so we make the manual step as painless as possible.
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.moveToRight', async () => {
            // Make sure the auxiliary bar is visible.
            try { await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar'); }
            catch (_) {
                try { await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar'); }
                catch (_) { /* ignore */ }
            }
            // Also reveal our view in its current container.
            try { await vscode.commands.executeCommand('workbench.view.extension.deepseek-sidebar'); }
            catch (_) { /* ignore */ }
            const pick = await vscode.window.showInformationMessage(
                'DeepSeek 侧栏要放到右侧（像 Copilot Chat 一样）？\n请把活动栏左侧的 ⚡ DeepSeek 图标用鼠标拖到右侧的 Secondary Side Bar 即可。这一步只需做一次，VS Code 会记住位置。',
                { modal: false },
                '我知道了',
                '不再提示'
            );
            if (pick === '不再提示') {
                await context.globalState.update('deepseekAgent.hideMoveHint', true);
            }
        })
    );

    // First-run prompt: nudge users towards the new tab experience.
    if (!context.globalState.get('deepseekAgent.hideMoveHint', false) &&
        !context.globalState.get('deepseekAgent.tabPrompted_v0_9', false)) {
        context.globalState.update('deepseekAgent.tabPrompted_v0_9', true);
        setTimeout(() => {
            vscode.window.showInformationMessage(
                'DeepSeek Agent v0.9 已安装。要现在在一个独立标签页里打开它吗（类似 Copilot Chat 的效果）？',
                '在新标签页打开',
                '用侧栏',
                '不再提示'
            ).then((pick) => {
                if (pick === '在新标签页打开') {
                    vscode.commands.executeCommand('deepseekAgent.openInTab');
                } else if (pick === '用侧栏') {
                    vscode.commands.executeCommand('deepseekAgent.open');
                } else if (pick === '不再提示') {
                    context.globalState.update('deepseekAgent.hideMoveHint', true);
                }
            });
        }, 1500);
    }

    // Status bar button
    const statusItem   = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.text    = '$(robot) DeepSeek';
    statusItem.tooltip = '点击打开 DeepSeek Agent（侧栏：Ctrl+Shift+D / 独立窗口：Ctrl+Shift+L）';
    statusItem.command = 'deepseekAgent.openInTab';
    statusItem.show();
    context.subscriptions.push(statusItem);

    // ─── Chat Participant (lives inside VS Code's built-in Chat panel) ──────
    // Lets users do `@deepseek your question` from the same right-side chat
    // panel that hosts Copilot Chat, Cline, etc.
    if (vscode.chat && typeof vscode.chat.createChatParticipant === 'function') {
        const participant = vscode.chat.createChatParticipant(
            'deepseek-agent.deepseek',
            (request, chatContext, response, token) => chatHandler(serverManager, request, chatContext, response, token)
        );
        try {
            participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
        } catch (_) { /* optional */ }
        context.subscriptions.push(participant);
        output.appendLine('[DeepSeek] Chat participant registered as @deepseek');
    } else {
        output.appendLine('[DeepSeek] vscode.chat API unavailable — chat participant disabled (need VS Code 1.95+)');
    }
}

// ─── Chat Participant handler ────────────────────────────────────────────────

// Single thread id reused across turns within the active chat session. Reset
// whenever a session starts fresh (history.length === 0) or `/clear` is used.
let _chatThreadId = null;

async function chatHandler(serverManager, request, chatContext, response, token) {
    // Slash commands.
    if (request.command === 'clear') {
        _chatThreadId = null;
        response.markdown('🧹 已清空 DeepSeek 会话上下文（下条消息开启新会话）。');
        return;
    }
    if (request.command === 'doctor') {
        const running = await serverManager.probe();
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        const port = cfg.get('serverPort') || 8787;
        const model = cfg.get('defaultModel') || 'deepseek-v4-pro';
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '(无)';
        const apiKey = process.env.DEEPSEEK_API_KEY ? '✅ 已设置' : '❌ 未设置（需要 `setx DEEPSEEK_API_KEY ...`）';
        response.markdown(
            `**DeepSeek Agent 状态**\n\n` +
            `- 后端: ${running ? '✅ 运行中' : '⏸ 未启动（首次发送会自动启动）'}\n` +
            `- 端口: \`${port}\`\n` +
            `- 模型: \`${model}\`\n` +
            `- 工作区: \`${ws}\`\n` +
            `- API Key: ${apiKey}\n`
        );
        return;
    }

    // Make sure backend is alive.
    try {
        response.progress('启动后端…');
        await serverManager.ensureRunning();
    } catch (e) {
        response.markdown(`**无法启动 deepseek-app-server：** ${e?.message || e}\n\n请先 \`cargo build --release -p deepseek-app-server\` 并设置 \`DEEPSEEK_API_KEY\` 环境变量。`);
        return;
    }

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cfg = vscode.workspace.getConfiguration('deepseekAgent');
    const model = cfg.get('defaultModel') || 'deepseek-v4-pro';

    // Stable thread id within a chat session.
    if (!chatContext.history || chatContext.history.length === 0 || !_chatThreadId) {
        _chatThreadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const threadId = _chatThreadId;

    // Build the prompt — optionally include current selection / active file.
    let prompt = request.prompt || '';
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {
        const sel = editor.document.getText(editor.selection);
        if (sel && sel.length < 6000) {
            prompt += `\n\n[来自当前编辑器选区 ${path.basename(editor.document.fileName)}]\n\u0060\u0060\u0060\n${sel}\n\u0060\u0060\u0060`;
        }
    }

    response.progress('思考中…');

    let abortFn = null;
    let thinkBuf = '';
    let pendingApprovals = 0;
    let lastUsage = null;
    let lastPlan = null;

    await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };

        abortFn = serverManager.client.streamPrompt(prompt, threadId, model, wsRoot, {
            onDelta: (t) => {
                if (t) response.markdown(t);
            },
            onThinking: (t) => {
                thinkBuf += t;
                // Show a rolling tail of the thinking stream as progress text.
                const tail = thinkBuf.replace(/\s+/g, ' ').trim().slice(-80);
                response.progress(`🤔 ${tail}`);
            },
            onToolStart: ({ name, args }) => {
                const argPreview = (args && args !== '{}') ? ` \`${String(args).slice(0, 100)}\`` : '';
                response.markdown(`\n\n> 🔧 调用工具 \`${name}\`${argPreview}\n`);
            },
            onToolResult: ({ name, ok, output }) => {
                // Plan results are rendered separately via onPlan; suppress here.
                if (name === 'update_plan') return;
                const head = ok ? '✅' : '❌';
                const out = String(output || '');
                const truncated = out.length > 1200 ? out.slice(0, 1200) + '\n...(已截断)' : out;
                response.markdown(`\n> ${head} \`${name}\` ${ok ? '完成' : '失败'}\n\n\`\`\`\n${truncated}\n\`\`\`\n\n`);
            },
            onPlan: ({ steps }) => {
                lastPlan = steps || [];
                if (!lastPlan.length) return;
                const icon = (s) => ({
                    pending: '⬜', in_progress: '🔄', done: '✅', blocked: '🚧',
                }[s] || '⬜');
                const lines = lastPlan.map(s => `${icon(s.status)} ${s.title}`).join('\n');
                response.markdown(`\n\n**📋 计划 / Todos**\n\n${lines}\n\n`);
            },
            onUsage: (u) => { lastUsage = u; },
            onApprovalRequest: async ({ id, name, args }) => {
                // Auto-approve in chat-participant mode (the user explicitly
                // invoked an agent, they've consented to tool execution).
                pendingApprovals++;
                response.markdown(`\n> ⚠️ 自动批准敏感工具 \`${name}\`（聊天模式下默认放行）\n`);
                try { await serverManager.client.approve(id, true); } catch (_) {}
                pendingApprovals--;
            },
            onError: (msg) => {
                response.markdown(`\n\n**错误：** ${msg}\n`);
            },
            onTurnEnd: () => { /* between agent steps */ },
            onDone: finish,
        });

        token.onCancellationRequested(() => {
            try { abortFn && abortFn(); } catch (_) {}
            response.markdown('\n\n_（已取消）_');
            finish();
        });
    });

    // Footer: token + cost + thinking time.
    if (lastUsage) {
        const cost = (lastUsage.cost_cny || 0).toFixed(4);
        const think = lastUsage.thinking_ms ? ` · 🤔 ${(lastUsage.thinking_ms / 1000).toFixed(1)}s` : '';
        const reasoning = lastUsage.reasoning_tokens ? ` (含推理 ${lastUsage.reasoning_tokens})` : '';
        response.markdown(
            `\n\n---\n` +
            `_📊 ${lastUsage.prompt_tokens} in · ${lastUsage.completion_tokens}${reasoning} out · ` +
            `共 ${lastUsage.total_tokens} tokens · ¥${cost}${think}_\n`
        );
    }

    return { metadata: { threadId } };
}

function openTuiTerminal() {
    const isWin   = process.platform === 'win32';
    const exeName = isWin ? 'deepseek.exe' : 'deepseek';
    const folders = vscode.workspace.workspaceFolders || [];

    let found = null;
    for (const f of folders) {
        for (const sub of ['target/release', 'target/debug']) {
            const p = path.join(f.uri.fsPath, sub, exeName);
            if (fs.existsSync(p)) { found = p; break; }
        }
        if (found) break;
    }
    if (!found) found = path.join(os.homedir(), '.cargo', 'bin', exeName);

    vscode.window.createTerminal({
        name:      'DeepSeek TUI',
        shellPath: found,
        iconPath:  new vscode.ThemeIcon('robot'),
        cwd:       folders[0]?.uri.fsPath || os.homedir(),
    }).show();
}

function deactivate() {}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { activate, deactivate };
