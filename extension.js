// Deep Copilot VS Code Extension — Standalone, no external backend required.
// All API calls go directly to DeepSeek (OpenAI-compatible), all tools run in Node.js.
'use strict';

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const cp     = require('child_process');
const https  = require('https');
const http   = require('http');

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Deep Copilot, an expert AI coding agent embedded in VS Code.
You have access to tools to read files, list directories, search code, write files, and run shell commands.
Always use tools to explore the workspace before answering. Prefer reading actual files over guessing.
When referencing files, use the format: path/to/file.ts:lineNumber
Do NOT use emojis in your responses. Be concise, precise, and professional.
After completing a task, summarize what you did and any files you changed.
For complex tasks, use update_plan to show your work plan to the user before starting.`;

// ─── Tool Definitions (OpenAI function-calling format) ────────────────────────

const TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file. Use start_line/end_line to read a range.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative or absolute file path' },
                    start_line: { type: 'integer', description: '1-based start line (optional)' },
                    end_line: { type: 'integer', description: '1-based end line (optional)' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_dir',
            description: 'List files and folders at a directory path.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path (default: workspace root)' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'grep_search',
            description: 'Search for a text pattern across files in the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Search pattern' },
                    path: { type: 'string', description: 'Directory to search (default: workspace root)' },
                    include: { type: 'string', description: 'File glob filter e.g. "*.ts"' },
                    is_regex: { type: 'boolean', description: 'Treat pattern as regex' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write (or overwrite) a file with the given content. Creates parent directories automatically.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to write' },
                    content: { type: 'string', description: 'Full file content' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_shell',
            description: 'Execute a shell command in the workspace root directory.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' },
                    timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 30000)' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_plan',
            description: 'Update the Plan and Todos panels visible to the user in the sidebar.',
            parameters: {
                type: 'object',
                properties: {
                    plan: {
                        type: 'array',
                        description: 'List of plan steps',
                        items: {
                            type: 'object',
                            properties: {
                                text: { type: 'string' },
                                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
                            },
                            required: ['text'],
                        },
                    },
                    todos: {
                        type: 'array',
                        description: 'List of todo items',
                        items: {
                            type: 'object',
                            properties: {
                                text: { type: 'string' },
                                done: { type: 'boolean' },
                            },
                            required: ['text'],
                        },
                    },
                },
            },
        },
    },
];

// ─── DeepSeek API Streaming ───────────────────────────────────────────────────

// ─── #8 Phase 6: friendly error mapping for the chat error card ───────
function friendlyError(e) {
    const code = e && e.statusCode;
    const raw = (e && e.message) || String(e || '');
    let title = '请求失败', tip = raw, retryable = true;

    if (code === 401 || code === 403) {
        title = 'API Key 无效或已过期';
        tip = '请打开右上角 🔑 重新设置 DeepSeek API Key,确认密钥未过期且未被禁用。';
        retryable = false;
    } else if (code === 402) {
        title = '账户余额不足';
        tip = '请前往 DeepSeek 控制台充值后再试。';
        retryable = false;
    } else if (code === 429) {
        title = '请求过于频繁(限流)';
        tip = '已触发 DeepSeek 限流。请稍候几秒再点击「重试」。';
    } else if (code === 400) {
        title = '请求参数错误';
        tip = '可能是上下文过长或消息格式异常。可尝试清空会话(Ctrl+K)后重试。';
    } else if (code && code >= 500) {
        title = 'DeepSeek 服务异常';
        tip = `服务端返回 ${code}。这通常是临时故障,几秒后重试即可。`;
    } else if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|fetch failed/i.test(raw)) {
        title = '网络连接失败';
        tip = '无法连接 DeepSeek API。请检查网络/代理/防火墙设置。';
    } else if (/aborted/i.test(raw)) {
        title = '已停止生成';
        tip = '生成被用户中断。';
        retryable = false;
    }
    return { title, tip, code: code || null, retryable, raw };
}

/**
 * Stream a chat completion from DeepSeek (OpenAI-compatible).
 * Returns an object: { toolCalls: [{id, name, args}], usage: {…} }
 */
function streamDeepSeek({ apiKey, baseUrl, messages, model }, callbacks, abortSignal) {
    return new Promise((resolve, reject) => {
        const base = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
        const urlObj = new URL('/chat/completions', base);
        const isHttps = urlObj.protocol === 'https:';

        const body = JSON.stringify({
            model: model || 'deepseek-chat',
            messages,
            tools: TOOL_DEFS,
            tool_choice: 'auto',
            stream: true,
            max_tokens: 8192,
        });

        const reqOpts = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + (urlObj.search || ''),
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const mod = isHttps ? https : http;
        let buf = '';
        const toolCalls = {}; // index → {id, name, args}
        let usage = null;
        let settled = false;

        function settle(val) {
            if (!settled) { settled = true; resolve(val); }
        }

        const req = mod.request(reqOpts, (res) => {
            if (res.statusCode !== 200) {
                let errBody = '';
                res.on('data', c => { errBody += c; });
                res.on('end', () => {
                    const err = new Error(`DeepSeek API ${res.statusCode}: ${errBody.slice(0, 500)}`);
                    err.statusCode = res.statusCode;
                    err.body = errBody;
                    reject(err);
                });
                return;
            }
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buf += chunk;
                let idx;
                while ((idx = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') { settle({ toolCalls: Object.values(toolCalls), usage }); return; }
                    let obj;
                    try { obj = JSON.parse(data); } catch { continue; }
                    if (obj.usage) usage = obj.usage;
                    const choice = obj.choices?.[0];
                    if (!choice) continue;
                    const delta = choice.delta || {};
                    if (delta.content)           callbacks.onDelta?.(delta.content);
                    if (delta.reasoning_content) callbacks.onThinking?.(delta.reasoning_content);
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const i = tc.index ?? 0;
                            if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', args: '' };
                            if (tc.id)                  toolCalls[i].id   = tc.id;
                            if (tc.function?.name)      toolCalls[i].name = tc.function.name;
                            if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
                        }
                    }
                    if (choice.finish_reason === 'stop') { settle({ toolCalls: [], usage }); return; }
                }
            });
            res.on('end', () => settle({ toolCalls: Object.values(toolCalls), usage }));
            res.on('error', reject);
        });

        if (abortSignal) {
            const onAbort = () => { try { req.destroy(); } catch {} reject(new Error('aborted')); };
            abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── Tool Execution ───────────────────────────────────────────────────────────

function wsRoot() {
    const f = vscode.workspace.workspaceFolders;
    return (f && f[0] && f[0].uri.fsPath) || os.homedir();
}

function resolvePath(p) {
    if (!p) return wsRoot();
    if (path.isAbsolute(p)) return p;
    return path.join(wsRoot(), p);
}

function toolReadFile(args) {
    try {
        const fp = resolvePath(args.path);
        const text = fs.readFileSync(fp, 'utf8');
        if (args.start_line || args.end_line) {
            const lines = text.split('\n');
            const s = Math.max(0, (args.start_line || 1) - 1);
            const e = args.end_line || lines.length;
            return lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n');
        }
        if (text.length > 80000) return text.slice(0, 80000) + '\n... [file truncated at 80 KB]';
        return text;
    } catch (e) { return `Error: ${e.message}`; }
}

function toolListDir(args) {
    try {
        const dp = resolvePath(args.path || '.');
        const entries = fs.readdirSync(dp, { withFileTypes: true });
        return entries.map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n') || '(empty)';
    } catch (e) { return `Error: ${e.message}`; }
}

function toolGrepSearch(args) {
    try {
        const root = resolvePath(args.path || '.');
        // Try ripgrep, fall back to native grep
        const isWin = process.platform === 'win32';
        const rgExe = (() => { try { cp.execSync(isWin ? 'where rg' : 'which rg', { stdio: 'pipe' }); return 'rg'; } catch { return null; } })();
        let cmd;
        if (rgExe) {
            const fixed = args.is_regex ? '' : '--fixed-strings';
            const glob  = args.include ? `--glob "${args.include}"` : '';
            cmd = `rg ${fixed} --line-number --max-count 3 --max-filesize 1M ${glob} -- "${args.pattern.replace(/"/g, '\\"')}" "${root}"`;
        } else {
            const fixed = args.is_regex ? '' : '-F';
            const inc   = args.include ? `--include="${args.include}"` : '';
            cmd = isWin
                ? `findstr /s /n /i /m "${args.pattern}" "${root}\\*"`
                : `grep -rn ${fixed} ${inc} --max-count=3 -- "${args.pattern.replace(/"/g, '\\"')}" "${root}"`;
        }
        const out = cp.execSync(cmd, { cwd: wsRoot(), timeout: 15000, encoding: 'utf8', shell: true });
        const lines = out.trim().split('\n').slice(0, 50);
        return lines.join('\n') || '(no matches)';
    } catch (e) {
        // grep exits 1 for no match — not an error
        if (e.status === 1) return '(no matches)';
        return `Error: ${e.message}`;
    }
}

function toolWriteFile(args) {
    try {
        const fp = resolvePath(args.path);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, args.content, 'utf8');
        return `OK: wrote ${args.content.length} chars to ${args.path}`;
    } catch (e) { return `Error: ${e.message}`; }
}

function toolRunShell(args) {
    try {
        const out = cp.execSync(args.command, {
            cwd: wsRoot(),
            timeout: args.timeout_ms || 30000,
            encoding: 'utf8',
            shell: true,
        });
        return (out || '').trim() || '(no output)';
    } catch (e) {
        return `Exit ${e.status || 1}: ${(e.stderr || e.message || '').slice(0, 2000)}`;
    }
}

// ─── Chat View Provider ───────────────────────────────────────────────────────

class ChatViewProvider {
    static viewType = 'deepseek.chatView';

    constructor(context) {
        this._context    = context;
        this._view       = null;
        this._panel      = null;
        this._includeCtx = false;
        this._sessionId  = null;
        this._reply      = { user: '', asst: '', thoughts: '' };
        // Full OpenAI message history for current conversation (multi-turn tool calls)
        this._messages   = [];
        // Abort controller for current stream
        this._abortCtrl  = null;
        this._busy       = false;
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
    async _appendToCurrentSession(userText, asstText, thoughts) {
        if (!userText && !asstText) return;
        const list = this._sessionsAll();
        let s = this._sessionId ? list.find(x => x.id === this._sessionId) : null;
        if (!s) {
            const id = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            s = { id, title: (userText || 'Untitled').slice(0, 40), createdAt: Date.now(), updatedAt: Date.now(), ws: this._currentWs(), messages: [] };
            this._sessionId = id;
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
        await this._sessionsSet(list);
        this._postSessionList();
    }
    _postSessionList() {
        this._post({
            type: 'sessions', currentWs: this._currentWs(),
            items: this._sessionsAll().map(s => ({
                id: s.id, title: s.title, preview: s.preview, msgCount: s.msgCount,
                model: s.model, mode: s.mode, ws: s.ws || '', createdAt: s.createdAt, updatedAt: s.updatedAt,
            })),
            activeId: this._sessionId,
        });
    }
    async _sessionLoad(id) {
        const s = this._sessionsAll().find(x => x.id === id);
        if (!s) return;
        this._sessionId = s.id;
        this._messages  = []; // fresh API context (old tool calls not replayable)
        // Reconstruct simple user/asst messages for API continuity
        for (const m of (s.messages || [])) {
            this._messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text || '' });
        }
        this._post({ type: 'sessionLoaded', id: s.id, messages: s.messages || [] });
        this._postSessionList();
    }
    async _sessionNew() {
        this._sessionId = null;
        this._messages  = [];
        this._reply     = { user: '', asst: '', thoughts: '' };
        this._post({ type: 'sessionLoaded', id: null, messages: [] });
        this._postSessionList();
    }
    async _sessionDelete(id) {
        let list = this._sessionsAll().filter(x => x.id !== id);
        if (this._sessionId === id) { this._sessionId = null; this._messages = []; }
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
                // Auto-restore last workspace session (Copilot-style)
                if (!this._sessionId) {
                    const ws = this._currentWs();
                    if (ws) {
                        const list = this._sessionsAll().filter(s => (s.ws || '') === ws);
                        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                        if (list[0]) this._sessionLoad(list[0].id);
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
            case 'stop':
                if (this._abortCtrl) { this._abortCtrl.abort(); this._abortCtrl = null; }
                break;
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
                this._messages = [];
                this._sessionId = null;
                break;
            case 'contextToggle':
                this._includeCtx = !!msg.active;
                break;
            case 'regenerate': {
                if (this._busy) break;
                // Pop trailing assistant turns + the last user turn from history,
                // grab that user text, and re-issue it through _handleSend.
                let lastUser = '';
                while (this._messages.length){
                    const last = this._messages[this._messages.length - 1];
                    if (last.role === 'user'){
                        const c = last.content;
                        if (typeof c === 'string') lastUser = c;
                        else if (Array.isArray(c)){
                            const t = c.find(p => p && p.type === 'text');
                            lastUser = t ? (t.text || '') : '';
                        }
                        this._messages.pop();
                        break;
                    }
                    this._messages.pop();
                }
                // Strip any leading file-context block we may have prepended originally.
                const stripped = lastUser.replace(/^---\s*\n[\s\S]*?\n---\s*\n\n?/, '');
                if (stripped.trim()) this._handleSend(stripped);
                break;
            }
            case 'feedback':
                // Local-only signal — no telemetry. Just acknowledge.
                vscode.window.setStatusBarMessage(msg.value === 'up' ? '👍 已记录' : '👎 已记录', 1500);
                break;
        }
    }

    // ─── Agentic Loop ──────────────────────────────────────────────────
    async _handleSend(text) {
        if (!text?.trim() || this._busy) return;
        this._busy = true;

        const apiKey = await this._context.secrets.get('deepseekAgent.apiKey');
        if (!apiKey) {
            this._post({ type: 'error', text: '请先设置 API Key — 点击工具栏 🔑 按钮' });
            this._busy = false;
            return;
        }

        const cfg      = vscode.workspace.getConfiguration('deepseekAgent');
        const model    = cfg.get('defaultModel') || 'deepseek-v4-pro';
        const baseUrl  = (cfg.get('apiBaseUrl') || '').trim() || 'https://api.deepseek.com';
        const mode     = cfg.get('approvalMode') || 'manual';

        // Build user content (optionally with active file context)
        let userContent = text;
        if (this._includeCtx) {
            const ctx = this._buildFileContext();
            if (ctx) userContent = ctx + '\n\n' + text;
        }

        this._reply = { user: text, asst: '', thoughts: '' };
        this._messages.push({ role: 'user', content: userContent });

        this._post({ type: 'replyStart' });
        this._post({ type: 'status', text: '⚡ 思考中...' });

        this._abortCtrl = new AbortController();
        const signal    = this._abortCtrl.signal;

        const MAX_ITERS = 15;
        let iter = 0;

        try {
            while (iter++ < MAX_ITERS) {
                const msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...this._messages];
                let assistantText = '';
                let reasoningText = '';

                const { toolCalls, usage } = await streamDeepSeek(
                    { apiKey, baseUrl, messages: msgs, model },
                    {
                        onDelta:    t => { assistantText += t; this._reply.asst += t; this._post({ type: 'replyDelta', text: t }); },
                        onThinking: t => { reasoningText += t; this._reply.thoughts += t; this._post({ type: 'thinkingDelta', text: t }); },
                    },
                    signal,
                );

                if (usage) {
                    this._post({ type: 'usage', usage });
                }

                if (!toolCalls.length) {
                    // No tool calls → done
                    this._messages.push({ role: 'assistant', content: assistantText, ...(reasoningText ? { reasoning_content: reasoningText } : {}) });
                    break;
                }

                // Append assistant message WITH tool_calls (required for API continuity)
                this._messages.push({
                    role: 'assistant',
                    content: assistantText || null,
                    ...(reasoningText ? { reasoning_content: reasoningText } : {}),
                    tool_calls: toolCalls.map(tc => ({
                        id: tc.id, type: 'function',
                        function: { name: tc.name, arguments: tc.args },
                    })),
                });

                // Signal webview to finish current bubble and prepare for continuation
                this._post({ type: 'newTurn' });

                // Execute each tool
                for (const tc of toolCalls) {
                    let args;
                    try { args = JSON.parse(tc.args || '{}'); } catch { args = {}; }

                    this._post({ type: 'toolStart', id: tc.id, name: tc.name, args });

                    let result = '';
                    try {
                        result = await this._executeTool(tc.name, args, mode);
                    } catch (e) {
                        result = `Error: ${e.message}`;
                    }

                    this._post({ type: 'toolResult', id: tc.id, name: tc.name, ok: !result.startsWith('Error'), output: result.slice(0, 600) });

                    this._messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: String(result),
                    });
                }
            }
        } catch (e) {
            if (e.message !== 'aborted') {
                const fe = friendlyError(e);
                this._post({ type: 'error', title: fe.title, text: fe.tip, code: fe.code, retryable: fe.retryable, raw: fe.raw });
            }
        }

        this._post({ type: 'replyEnd', empty: false });
        this._post({ type: 'status', text: '' });
        this._abortCtrl = null;
        this._busy = false;

        const r = this._reply;
        if (r.user || r.asst) await this._appendToCurrentSession(r.user, r.asst, r.thoughts);
        this._reply = { user: '', asst: '', thoughts: '' };
    }

    // ─── Tool Dispatcher ───────────────────────────────────────────────
    async _executeTool(name, args, approvalMode) {
        // Read-only mode: block all writes
        if (approvalMode === 'readonly' && (name === 'write_file' || name === 'run_shell')) {
            return 'Denied: Read-Only mode is active.';
        }

        // Approval for write_file
        if (name === 'write_file' && approvalMode === 'manual') {
            const ok = await this._requestApproval(`Write file: ${args.path}`);
            if (!ok) return 'Denied by user.';
        }

        // Approval for run_shell
        if (name === 'run_shell' && (approvalMode === 'manual' || approvalMode === 'auto-edit')) {
            if (approvalMode === 'manual') {
                const ok = await this._requestApproval(`Run: ${args.command}`);
                if (!ok) return 'Denied by user.';
            }
            // auto-edit: allow run_shell without prompt
        }

        switch (name) {
            case 'read_file':   return toolReadFile(args);
            case 'list_dir':    return toolListDir(args);
            case 'grep_search': return toolGrepSearch(args);
            case 'write_file':  return toolWriteFile(args);
            case 'run_shell':   return toolRunShell(args);
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

                this._post({ type: 'plan', steps, todos });
                return 'Plan updated.';
            }
            default:
                return `Unknown tool: ${name}`;
        }
    }

    async _requestApproval(description) {
        const answer = await vscode.window.showInformationMessage(
            `Deep Copilot wants to: ${description}`,
            { modal: true },
            'Approve', 'Deny',
        );
        return answer === 'Approve';
    }

    // ─── Helpers ───────────────────────────────────────────────────────
    _buildFileContext() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return null;
        const doc  = editor.document;
        const sel  = editor.selection;
        const lang = doc.languageId;
        const name = path.basename(doc.fileName);
        if (!sel.isEmpty) {
            const selected = doc.getText(sel);
            return `Selected code (${name}, ${lang}):\n\`\`\`${lang}\n${selected}\n\`\`\``;
        }
        const range   = editor.visibleRanges[0];
        const visible = doc.getText(range).substring(0, 3000);
        return `Current file (${name}, ${lang}):\n\`\`\`${lang}\n${visible}\n\`\`\``;
    }

    _insertToEditor(code) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('请先在编辑器中打开一个文件'); return; }
        editor.edit(b => b.replace(editor.selection, code));
        vscode.window.setStatusBarMessage('✓ 代码已插入编辑器', 2500);
    }

    // Send a shell command to a VS Code integrated terminal.
    // execute=true   → also press Enter (Run)
    // execute=false  → only insert text (Insert into Terminal)
    _sendToTerminal(code, execute) {
        if (!code) return;
        // Reuse a dedicated terminal so consecutive runs share history
        const NAME = 'Deep Copilot';
        let term = vscode.window.terminals.find(t => t.name === NAME);
        if (!term) term = vscode.window.createTerminal({ name: NAME, cwd: wsRoot() });
        term.show(true);
        // Strip leading "$ " or "PS> " prompts that the model might include
        const cleaned = code.split(/\r?\n/).map(l => l.replace(/^\s*(?:PS\s*[A-Za-z]?:?[^>]*>\s*|[#$]\s+)/, '')).join('\n');
        term.sendText(cleaned, !!execute);
    }

    async _openFile(p, line) {
        if (!p) return;
        try {
            const folders = vscode.workspace.workspaceFolders || [];
            const tries = [];
            if (path.isAbsolute(p)) tries.push(vscode.Uri.file(p));
            for (const f of folders) tries.push(vscode.Uri.joinPath(f.uri, p));
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
            if (!target) { vscode.window.showWarningMessage(`找不到文件：${p}`); return; }
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

    // Convenience alias used by future stream / tool / error helpers
    postToWebview(type, payload) {
        this._post(Object.assign({ type }, payload || {}));
    }
}

function buildWebviewHtml(webview, extensionUri) {
    const cssUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css'));
    const jsUri   = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.js'));
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logo.png'));
    const nonce   = Buffer.from(Date.now().toString() + Math.random().toString()).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deep Copilot</title>
<link rel="stylesheet" href="${cssUri}">
</head><body>
<div id="prog" class="prog"></div>
<div id="tb">
  <span class="logo">
    <img class="logo-img" src="${logoUri}" alt="logo"/>
    <select class="tbsel" id="modelSel" title="模型">
      <option value="deepseek-v4-pro">v4-pro</option>
      <option value="deepseek-v4-flash">v4-flash</option>
      <option value="deepseek-reasoner">reasoner</option>
    </select>
    <select class="tbsel" id="modeSel" title="批准策略 (Approval Mode)">
      <option value="manual">🛡 Manual</option>
      <option value="auto-edit">✏️ Auto-Edit</option>
      <option value="autopilot">🚀 Autopilot</option>
      <option value="readonly">👁 Read-Only</option>
    </select>
  </span>
  <button class="tbb" id="cxbt" title="包含当前文件">📎</button>
  <button class="tbb" id="apibt" title="API 设置（Key / Base URL）">🔑</button>
  <button class="tbb" id="cbt" title="清空当前会话(不存档)">🗑</button>
</div>
<button id="edgeL" class="edge-toggle edge-l" title="Plan / Todos" aria-label="toggle left panel"></button>
<button id="edgeR" class="edge-toggle edge-r" title="历史会话" aria-label="toggle right panel"></button>
<div id="sb"></div>
<aside id="left">
  <section class="pnl" id="planPnl" data-open="1">
    <div class="ph"><span class="pchev">▾</span> Plan <span class="cnt" id="plan-cnt"></span></div>
    <div class="pb" id="plan-body"><div class="empty">No active plan</div></div>
  </section>
  <section class="pnl" id="todoPnl" data-open="1">
    <div class="ph"><span class="pchev">▾</span> Todos <span class="cnt" id="todo-cnt"></span></div>
    <div class="pb" id="todo-body"><div class="empty">No todos</div></div>
  </section>
  <section class="pnl pnl-mini" id="agentPnl" data-open="0">
    <div class="ph"><span class="pchev">▸</span> Agents <span class="cnt" id="agent-cnt">0</span></div>
    <div class="pb" id="agent-body" style="display:none"><div class="empty">No agents</div></div>
  </section>
</aside>
<div id="main">
  <div id="es">
    <p><strong>Deep Copilot</strong><br>让高质量 AI 生产力开放、公平、可负担地惠及每个人</p>
    <p style="font-size:11px;opacity:.7;margin-top:12px">输入消息，按 Enter 发送</p></div>
  <div id="thk">● ● ● 思考中...</div>
</div>
<aside id="right">
  <div class="rh">
    <span class="rt">Sessions</span>
  </div>
  <div class="rscope">
    <button id="scopeWs" class="on" title="只显示当前工作区会话">本工作区</button>
    <button id="scopeAll" title="显示全部会话">全部</button>
  </div>
  <div class="rsearch"><input id="dsearch" type="text" placeholder="搜索会话..."/></div>
  <div class="rnew">
    <button id="newSessionBtn" class="new-session-btn" title="新建会话">
      <span class="icon">+</span>
      <span class="text">新建会话</span>
    </button>
  </div>
  <div class="rlist" id="dlist"><div class="empty">暂无会话</div></div>
</aside>
<div id="ia">
  <div id="cxb">📎 将附带当前文件 / 选中代码</div>
  <div id="pop" class="pop" style="display:none"></div>
  <div id="ir">
    <textarea id="inp" rows="1" placeholder="向 Deep Copilot 提问... (Enter 发送 / Shift+Enter 换行 / / 命令 / @ 上下文 / Ctrl+K 清空)"></textarea>
    <button id="sbtn" title="发送">↑</button>
  </div>
</div>
<div id="foot">
  <div class="ft-left">
    <span class="dot" id="dot"></span>
    <span id="ft-mode">agent · deepseek-v4-pro</span>
  </div>
  <div class="ft-right">
    <span class="pill" id="ft-think">🤔 0.0s</span>
    <span class="pill" id="ft-tokens">0 tokens</span>
    <span class="pill" id="ft-cost" style="color:#e8b86d">¥0.0000</span>
  </div>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body></html>`;
}

// ─── Activate ─────────────────────────────────────────────────────────────────

function activate(context) {
    const chatProvider = new ChatViewProvider(context);

    // ─── API key / base URL management ────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.setApiKey', async () => {
            const existing = await context.secrets.get('deepseekAgent.apiKey');
            const key = await vscode.window.showInputBox({
                prompt: '输入 DeepSeek API Key（保存到 VS Code SecretStorage，不会写入 settings.json）',
                placeHolder: 'sk-...',
                value: existing || '',
                password: true,
                ignoreFocusOut: true,
            });
            if (key === undefined) return;
            if (key.trim() === '') {
                await context.secrets.delete('deepseekAgent.apiKey');
                vscode.window.showInformationMessage('已删除 DeepSeek API Key');
            } else {
                await context.secrets.store('deepseekAgent.apiKey', key.trim());
                vscode.window.showInformationMessage('✅ DeepSeek API Key 已保存，立即生效。');
            }
        }),
        vscode.commands.registerCommand('deepseekAgent.setBaseUrl', async () => {
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            const cur = cfg.get('apiBaseUrl') || '';
            const choice = await vscode.window.showQuickPick(
                [
                    { label: '🌍 国际版（默认）', description: 'https://api.deepseek.com', value: 'https://api.deepseek.com' },
                    { label: '🇨🇳 中国大陆', description: 'https://api.deepseeki.com', value: 'https://api.deepseeki.com' },
                    { label: '✏️ 自定义…', description: '手动输入 URL', value: '__custom__' },
                    { label: '↩ 清空（用默认国际版）', description: '', value: '' },
                ],
                { placeHolder: `当前：${cur || '默认（国际版）'}` }
            );
            if (!choice) return;
            let url = choice.value;
            if (url === '__custom__') {
                url = await vscode.window.showInputBox({
                    prompt: '输入 OpenAI 兼容 Base URL',
                    value: cur,
                    placeHolder: 'https://api.example.com',
                    ignoreFocusOut: true,
                });
                if (url === undefined) return;
            }
            await cfg.update('apiBaseUrl', url, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`✅ Base URL = ${url || '(国际版默认)'}`);
        }),
        vscode.commands.registerCommand('deepseekAgent.showApiStatus', async () => {
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            const key = await context.secrets.get('deepseekAgent.apiKey');
            const lines = [
                `**API Key**：${key ? '✅ 已设置' : '❌ 未设置（点击「设置 Key」）'}`,
                `**Base URL**：${cfg.get('apiBaseUrl') || 'https://api.deepseek.com（默认）'}`,
                `**模型**：${cfg.get('defaultModel') || 'deepseek-v4-pro'}`,
                `**批准策略**：${cfg.get('approvalMode') || 'manual'}`,
            ];
            const action = await vscode.window.showInformationMessage(lines.join(' · '), '设置 API Key', '切换 Base URL');
            if (action === '设置 API Key') vscode.commands.executeCommand('deepseekAgent.setApiKey');
            else if (action === '切换 Base URL') vscode.commands.executeCommand('deepseekAgent.setBaseUrl');
        }),
        // Keep old commands registered so package.json doesn't break
        vscode.commands.registerCommand('deepseekAgent.restartServer', () => {
            vscode.window.showInformationMessage('Deep Copilot 是独立扩展，无需后端服务器。');
        }),
        vscode.commands.registerCommand('deepseekAgent.openTerminal', () => {
            vscode.window.showInformationMessage('Deep Copilot 独立版不需要 TUI 终端。');
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
            vscode.commands.executeCommand('workbench.view.extension.deeppilot-sidebar');
        })
    );

    // Open as dedicated editor tab
    let activeTabPanel = null;
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.openInTab', () => {
            if (activeTabPanel) { activeTabPanel.reveal(vscode.ViewColumn.Beside, false); return; }
            const panel = vscode.window.createWebviewPanel(
                'deepseek.chatPanel', 'Deep Copilot',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
            );
            try { panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.png'); } catch (_) {}
            activeTabPanel = panel;
            panel.onDidDispose(() => { if (activeTabPanel === panel) activeTabPanel = null; });
            chatProvider.bindPanel(panel);
        }),
        vscode.commands.registerCommand('deepseekAgent.moveToRight', async () => {
            try { await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar'); } catch (_) {}
            try { await vscode.commands.executeCommand('workbench.view.extension.deeppilot-sidebar'); } catch (_) {}
            vscode.window.showInformationMessage('把活动栏的 ⚡ 图标拖到右侧 Secondary Side Bar 即可，VS Code 会记住位置。');
        }),
    );

    // Status bar button
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.text    = '$(robot) Deep Copilot';
    statusItem.tooltip = '点击打开 Deep Copilot';
    statusItem.command = 'deepseekAgent.openInTab';
    statusItem.show();
    context.subscriptions.push(statusItem);

    // First-run: prompt for API key
    context.secrets.get('deepseekAgent.apiKey').then(key => {
        if (!key && !context.globalState.get('deepseekAgent.keyPrompted')) {
            context.globalState.update('deepseekAgent.keyPrompted', true);
            setTimeout(() => {
                vscode.window.showInformationMessage(
                    'Deep Copilot 已安装！请先设置 DeepSeek API Key 才能开始使用。',
                    '设置 API Key', '稍后'
                ).then(pick => {
                    if (pick === '设置 API Key') vscode.commands.executeCommand('deepseekAgent.setApiKey');
                });
            }, 1500);
        }
    });
}

function deactivate() {}

module.exports = { activate, deactivate };
