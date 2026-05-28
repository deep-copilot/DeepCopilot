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
const { wsRoot, resolvePath, findContainingFolder } = require('../utils/paths');
const { isZh }             = require('../utils/i18n');
const { openFile }         = require('./openFile');
const { buildWebviewHtml, buildSidebarHintHtml } = require('../webview/html');
const { mcpManager }       = require('../mcp');

const { SessionStore } = require('./session-store');
const { ToolExecutor } = require('./tool-executor');
const { AgentLoop }    = require('./agent-loop');

// ─── Module-level constants ───────────────────────────────────────────────────
/** Maximum bytes of file content attached via the Explorer context menu. */
const MAX_FILE_ATTACH_BYTES = 65536;
/** Directory / file names skipped when building a folder file-tree chip. */
const FOLDER_TREE_SKIP = new Set([
    'node_modules', '.git', 'dist', 'out', 'build',
    '__pycache__', '.venv', 'venv', '.next', 'coverage', '.turbo',
]);
const { fetchBalance, resolveProviderConfig } = require('../api/adapter');
const { testConnection: testAnthropicConnection } = require('../api/anthropic-client');
const { resolveContextRef } = require('./context-refs');

class ChatViewProvider {
    static viewType = 'deepseek.chatView';

    constructor(context) {
        this._context    = context;
        this._view       = null;       // most-recently-active WebviewView
        this._views      = new Set();  // all live WebviewView instances
        this._panel      = null;
        this._runs       = new Map();
        // pendingEdits live at the *session* level (not the per-turn run) so
        // that the review panel stays clickable after the agent's reply ends
        // and the run is reaped by AgentLoop.
        this._pendingEditsBySession = new Map();

        this._store = new SessionStore(context.globalState, {
            getCurrentWs: () => this._currentWs(),
            post:         (msg) => this._post(msg),
            getBusy:      (id)  => !!this._runs.get(id)?.busy,
            onDeleteRun:  (id)  => {
                const run = this._runs.get(id);
                if (run) { run.discarded = true; try { run.abortCtrl?.abort(); } catch {} this._runs.delete(id); }
                // Session was deleted → drop its pending edits map too.
                this._pendingEditsBySession.delete(id);
            },
        });

        this._exec = new ToolExecutor(context, {
            postToRun: (run, msg) => this._runPost(run, msg),
            post:      (msg)      => this._post(msg),
        });

        this._balanceLastAt = 0; // timestamp of last successful balance fetch

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
            buildAttachment: () => this._buildAttachmentBlock(),
        });

        const wsR = wsRoot();
        if (wsR) mcpManager.init(wsR).catch(e => Logger.info('MCP_INIT_ERROR', { message: e.message }));
    }

    _newRun(sessionId, seedMessages = []) {
        // Reuse (or lazily create) the per-session pendingEdits map so the
        // review panel survives the run-reaping at end-of-turn.
        if (!this._pendingEditsBySession.has(sessionId)) {
            this._pendingEditsBySession.set(sessionId, new Map());
        }
        const run = {
            sessionId,
            messages:      seedMessages.length ? seedMessages.slice() : [],
            abortCtrl:     null,
            reply:         { user: '', asst: '', thoughts: '' },
            busy:          false,
            events:        [],
            toolCache:     new Map(),
            turnSnapshots: new Map(),
            pendingEdits:  this._pendingEditsBySession.get(sessionId), // shared ref
            plan:          null,
            planUpdatedIter: -1,
        };
        this._runs.set(sessionId, run);
        return run;
    }

    /** Get the live pendingEdits map for a session, even after the run is reaped. */
    _pendingFor(sessionId) {
        if (!sessionId) return null;
        return this._pendingEditsBySession.get(sessionId) || null;
    }

    /**
     * Lookup helper used by the `deepcopilot-before:` TextDocumentContentProvider
     * registered in extension.js. Returns the pre-edit snapshot for a file in a
     * given session, or an empty string when unavailable (file was new).
     */
    getPendingBefore(sessionId, absPath) {
        const map = this._pendingFor(sessionId);
        if (!map) return '';
        const entry = map.get(absPath);
        if (!entry) return '';
        return typeof entry.before === 'string' ? entry.before : '';
    }

    _runPost(run, msg) {
        run.events.push(msg);
        if (run.sessionId === this._store.sessionId) this._post(msg);
        if (msg.type === 'usage') this._refreshBalance(false);
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
        this._views.add(webviewView);
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media'),
                vscode.Uri.joinPath(this._context.extensionUri, 'imgs'),
            ],
        };
        // Show a minimal launcher page instead of the full chat UI.
        // The full chat is only available in the editor-area tab (status bar).
        webviewView.webview.html = buildSidebarHintHtml(webviewView.webview, this._context.extensionUri);
        webviewView.webview.onDidReceiveMessage(msg => this._onMessage(msg));
        webviewView.onDidDispose(() => {
            this._views.delete(webviewView);
            if (this._view === webviewView) {
                this._view = this._views.size ? [...this._views][this._views.size - 1] : null;
            }
        });
    }

    bindPanel(panel) {
        this._panel = panel;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media'),
                vscode.Uri.joinPath(this._context.extensionUri, 'imgs'),
            ],
        };
        panel.webview.html = buildWebviewHtml(panel.webview, this._context.extensionUri);
        panel.webview.onDidReceiveMessage(msg => this._onMessage(msg));
        panel.onDidDispose(() => { if (this._panel === panel) this._panel = null; });
    }

    async _onMessage(msg) {
        switch (msg.type) {
            case 'ready': {
                const cfg = vscode.workspace.getConfiguration('deepseekAgent');
                // Push the dynamic provider registry first so the webview can
                // build its model picker / settings dropdown from real data
                // rather than the previously-hardcoded JS objects.
                try {
                    const { listProviders } = require('../providers');
                    this._post({ type: 'providersInfo', providers: listProviders() });
                } catch { /* registry failure shouldn't break the chat UI */ }
                this._post({
                    type: 'modelInfo',
                    model: cfg.get('defaultModel') || 'deepseek-v4-pro',
                    approvalMode: cfg.get('approvalMode') || 'manual',
                    provider: cfg.get('provider') || 'deepseek',
                    interactionMode: cfg.get('interactionMode') || 'agent',
                });
                if (!this._store.sessionId) {
                    try {
                        const all = this._store.all();
                        const latest = all.length ? all.find(s => !s.archived) : null;
                        if (latest) {
                            await this._store.load(latest.id); // load() calls postList() internally
                        } else {
                            this._store.postList();
                            this._post({ type: 'sessionLoaded', id: null, messages: [] });
                        }
                    } catch {
                        this._store.postList();
                        this._post({ type: 'sessionLoaded', id: null, messages: [] });
                    }
                } else {
                    this._store.postList();
                }
                this._refreshBalance(false);
                // Push discovered skills to the webview for slash-command autocomplete.
                // NOTE: content is intentionally omitted here — the webview only needs name/desc/hint
                // for the popup UI. When the user sends a skill, provider.js re-reads the full
                // content from disk via discoverSkills() using msg.skillName as the key.
                try {
                    const { discoverSkills } = require('../skills');
                    const skills = discoverSkills().map(s => ({ name: s.name, desc: s.desc, hint: s.hint }));
                    if (skills.length) this._post({ type: 'skillList', skills });
                } catch { /* non-fatal: skill discovery failures must not break startup */ }
                // Issue #97: push the current active editor as the initial chip
                // so users see context immediately after the webview boots,
                // without having to click into the editor first.
                try { this.attachLiveSelection(vscode.window.activeTextEditor); } catch { /* non-fatal */ }
                break;
            }
            case 'balanceRefresh': this._refreshBalance(true); break;
            case 'sessionList':    this._store.postList(); break;
            case 'sessionLoad':    await this._loadSession(msg.id); break;
            case 'sessionNew':     this._store.newSession(); break;
            case 'sessionDelete':  this._store.delete(msg.id); break;
            case 'sessionRename':  this._store.rename(msg.id, msg.title); break;
            case 'sessionPin':     this._store.pin(msg.id); break;
            case 'sessionUnread':  this._store.unread(msg.id); break;
            case 'sessionArchive': this._store.archive(msg.id); break;

            // ─── Pending edits panel (Copilot-style review of agent writes) ───
            case 'keepEdit':        this._handlePendingEdit('keep',    msg.path); break;
            case 'keepAllEdits':    this._handlePendingEdit('keepAll'); break;
            case 'discardEdit':     this._handlePendingEdit('discard', msg.path); break;
            case 'discardAllEdits': this._handlePendingEdit('discardAll'); break;
            case 'openEditDiff':    await this._handleOpenEditDiff(msg.path); break;

            case 'setInteractionMode': {
                const cfg = vscode.workspace.getConfiguration('deepseekAgent');
                cfg.update('interactionMode', msg.mode, vscode.ConfigurationTarget.Global)
                    .then(() => this._post({ type: 'modelInfo', interactionMode: msg.mode }));
                break;
            }
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
            case 'openApiSettings': {
                const cfg       = vscode.workspace.getConfiguration('deepseekAgent');
                const dsKey     = await this._context.secrets.get('deepseekAgent.apiKey') || '';
                const tvKey     = await this._context.secrets.get('deepseekAgent.tavilyKey') || '';
                const baseUrl   = cfg.get('apiBaseUrl') || '';
                const provider  = cfg.get('provider') || 'deepseek';
                const rawWsProvider = cfg.get('webSearchProvider');
                const wsProvider = ['tavily', 'bing'].includes(rawWsProvider) ? rawWsProvider : 'tavily';
                const maskKey   = (k) => k ? (k.slice(0, 6) + '...' + k.slice(-4)) : '';
                this._post({
                    type:              'settingsLoaded',
                    dsKeySet:          !!dsKey,
                    dsKeyHint:         maskKey(dsKey),
                    tvKeySet:          !!tvKey,
                    tvKeyHint:         maskKey(tvKey),
                    baseUrl:           baseUrl,
                    provider:          provider,
                    webSearchProvider: wsProvider,
                });
                break;
            }
            case 'testApiKey': {
                const which = msg.which; // 'ds' | 'tv'
                const t0    = Date.now();
                if (which === 'ds') {
                    const testKey = msg.key || (await this._context.secrets.get('deepseekAgent.apiKey') || '');
                    const cfg     = vscode.workspace.getConfiguration('deepseekAgent');
                    const provider = msg.provider || cfg.get('provider') || 'deepseek';
                    const resolved = resolveProviderConfig(provider, msg.baseUrl || cfg.get('apiBaseUrl') || '', '');
                    if (!testKey && !resolved.noApiKey) {
                        this._post({ type: 'testApiKeyResult', which, ok: false, error: 'No API key set' });
                        break;
                    }
                    try {
                        let result;
                        if (provider === 'anthropic') {
                            // Use the native Anthropic SDK for the test — avoids replicating
                            // the SDK's internal header/URL handling in raw HTTP.
                            result = await testAnthropicConnection({
                                apiKey:  testKey,
                                baseUrl: resolved.baseUrl,
                                model:   resolved.model,
                            });
                        } else {
                            const https = require('https');
                            const http  = require('http');
                            const base  = resolved.baseUrl.replace(/\/$/, '');
                            const urlObj = new URL(base + '/chat/completions');
                            const tokenKey = resolved.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens';
                            // Token budget for the test ping:
                            //   1. Use provider-declared testConnectionMaxTokens if set (e.g. Anthropic rejects < 64)
                            //   2. Reasoning models (useMaxCompletionTokens) need room for reasoning budget → 2048
                            //   3. Everything else: 1 token is enough to confirm reachability
                            const tokenBudget = resolved.testConnectionMaxTokens ?? (resolved.useMaxCompletionTokens ? 2048 : 1);
                            const body   = JSON.stringify({ model: resolved.model, messages: [{ role: 'user', content: 'hi' }], [tokenKey]: tokenBudget });
                            const isHttps = urlObj.protocol === 'https:';
                            result = await new Promise((resolve) => {
                                const req = (isHttps ? https : http).request({
                                    hostname: urlObj.hostname,
                                    port:     urlObj.port || (isHttps ? 443 : 80),
                                    path:     urlObj.pathname,
                                    method:   'POST',
                                    headers:  {
                                        'Authorization':  `Bearer ${testKey || 'no-key'}`,
                                        'Content-Type':   'application/json',
                                        'Content-Length': Buffer.byteLength(body),
                                    },
                                    timeout:  10000,
                                }, (res) => {
                                    let raw = '';
                                    res.on('data', c => { raw += c; });
                                    res.on('end', () => {
                                        if (res.statusCode === 200 || res.statusCode === 201) { resolve({ ok: true }); return; }
                                        try {
                                            const d = JSON.parse(raw);
                                            resolve({ ok: false, error: (d.error && d.error.message) || `HTTP ${res.statusCode}` });
                                        } catch { resolve({ ok: false, error: `HTTP ${res.statusCode}` }); }
                                    });
                                    res.on('error', e => resolve({ ok: false, error: e.message }));
                                });
                                req.on('error', e => resolve({ ok: false, error: e.message }));
                                req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
                                req.write(body);
                                req.end();
                            });
                        }
                        this._post({ type: 'testApiKeyResult', which, ok: result.ok, latency: Date.now() - t0, error: result.error });
                    } catch (e) {
                        this._post({ type: 'testApiKeyResult', which, ok: false, error: e.message });
                    }
                } else if (which === 'tv') {
                    const testKey = msg.key || (await this._context.secrets.get('deepseekAgent.tavilyKey') || '');
                    if (!testKey) {
                        this._post({ type: 'testApiKeyResult', which, ok: false, error: 'No Tavily key set' });
                        break;
                    }
                    try {
                        const https  = require('https');
                        const body   = JSON.stringify({ api_key: testKey, query: 'test', max_results: 1 });
                        const result = await new Promise((resolve) => {
                            const req = https.request({
                                hostname: 'api.tavily.com',
                                port: 443,
                                path: '/search',
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                                timeout: 10000,
                            }, (res) => {
                                let raw = '';
                                res.on('data', c => { raw += c; });
                                res.on('end', () => {
                                    if (res.statusCode === 200) { resolve({ ok: true }); return; }
                                    try {
                                        const d = JSON.parse(raw);
                                        resolve({ ok: false, error: (d.detail || d.message || `HTTP ${res.statusCode}`) });
                                    } catch { resolve({ ok: false, error: `HTTP ${res.statusCode}` }); }
                                });
                                res.on('error', e => resolve({ ok: false, error: e.message }));
                            });
                            req.on('error', e => resolve({ ok: false, error: e.message }));
                            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
                            req.write(body);
                            req.end();
                        });
                        this._post({ type: 'testApiKeyResult', which, ok: result.ok, latency: Date.now() - t0, error: result.error });
                    } catch (e) {
                        this._post({ type: 'testApiKeyResult', which, ok: false, error: e.message });
                    }
                }
                break;
            }
            case 'saveApiSettings': {
                const cfg = vscode.workspace.getConfiguration('deepseekAgent');
                if (msg.dsKey) {
                    await this._context.secrets.store('deepseekAgent.apiKey', msg.dsKey);
                }
                if (msg.tvKey) {
                    await this._context.secrets.store('deepseekAgent.tavilyKey', msg.tvKey);
                }
                if (msg.provider) {
                    await cfg.update('provider', msg.provider, vscode.ConfigurationTarget.Global);
                }
                if (msg.webSearchProvider && ['tavily', 'bing'].includes(msg.webSearchProvider)) {
                    await cfg.update('webSearchProvider', msg.webSearchProvider, vscode.ConfigurationTarget.Global);
                }
                // If the UI sent the currently selected model alongside the provider,
                // persist it so deepseekAgent.defaultModel is always consistent.
                if (msg.model) {
                    await cfg.update('defaultModel', msg.model, vscode.ConfigurationTarget.Global);
                }
                if (typeof msg.baseUrl === 'string') {
                    // Save an empty string when the URL matches the provider's preset URL,
                    // so that switching the provider later always resolves the correct default.
                    await cfg.update('apiBaseUrl', msg.baseUrl.trim().replace(/\/$/, ''), vscode.ConfigurationTarget.Global);
                }
                this._refreshBalance(true);
                break;
            }
            case 'openExternal': {
                const rawUrl = String(msg.url || '');
                if (/^https?:\/\//.test(rawUrl)) {
                    vscode.env.openExternal(vscode.Uri.parse(rawUrl));
                }
                break;
            }
            case 'openFile':        openFile(msg.path, msg.line); break;
            case 'send': {
                // Issue #142 P3-1/P3-4/P3-5: slash commands handled locally
                // (never sent to the LLM).
                const rawText = String(msg.text || '').trim();
                if (/^\/compact(\s|$)/.test(rawText)) {
                    const focus = rawText.replace(/^\/compact\s*/, '').trim();
                    await this._handleCompactCommand(focus);
                    break;
                }
                if (/^\/context(\s|$)/.test(rawText)) {
                    await this._handleContextCommand();
                    break;
                }
                if (/^\/fork(\s|$)/.test(rawText)) {
                    const title = rawText.replace(/^\/fork\s*/, '').trim();
                    await this._handleForkCommand(title);
                    break;
                }
                let skillContent = null;
                // msg.skillName is set when a skill chip was staged in the input box.
                // Always resolve skill content from disk (via discoverSkills) — the webview
                // does NOT carry the full SKILL.md body (it only has name/desc/hint for the UI).
                if (msg.skillName) {
                    try {
                        const { discoverSkills } = require('../skills');
                        const sk = discoverSkills().find(s => s.name === msg.skillName);
                        if (sk) {
                            const rawBody = sk.content.replace(/^---[\s\S]*?---\r?\n/, '').trim();
                            const userArg = (msg.text || '').trim();
                            const body = rawBody.includes('$ARGUMENTS')
                                ? rawBody.replace(/\$ARGUMENTS/g, userArg)
                                : rawBody + (userArg ? `\n\nUser argument: ${userArg}` : '');
                            skillContent = { _skillName: msg.skillName, _skillPath: require('path').join(sk.dir, sk.name, 'SKILL.md'), body };
                        } else {
                            this._post({ type: 'error', text: `Skill "${msg.skillName}" not found — check ~/.deepcopilot/skills (or ~/.claude/skills)` });
                        }
                    } catch (e) {
                        this._post({ type: 'error', text: `Skill load failed: ${e.message}` });
                    }
                }
                // Resolve any inline #<ref>:<arg> tokens (e.g. #symbol:Foo) the
                // user did not commit as chips. Race-free: we resolve here
                // *before* handing off to the agent loop, then merge results
                // into msg.attachments so they ride along with the user turn.
                let attachments = Array.isArray(msg.attachments) ? msg.attachments.slice() : [];
                if (Array.isArray(msg.pendingRefs) && msg.pendingRefs.length) {
                    for (const r of msg.pendingRefs) {
                        try {
                            const result = await resolveContextRef(r.refType, r.value);
                            if (result && !result.error) {
                                attachments.push(result);
                                // Echo a chip into the CURRENT user bubble.
                                // Posting `addPendingAttachment` BEFORE the loop
                                // fires `userEcho` ensures the webview merges
                                // these into `_pendingAttachments`, which is
                                // flushed by the next userEcho handler
                                // (see media/chat.js).
                                this._post({ type: 'addPendingAttachment', payload: result });
                            } else if (result && result.error) {
                                this._post({ type: 'error', text: `#${r.refType}:${r.value} — ${result.error}` });
                            }
                        } catch (e) {
                            this._post({ type: 'error', text: `#${r.refType} failed: ${e.message}` });
                        }
                    }
                }
                this._loop.handleSend(msg.text, attachments, skillContent);
                break;
            }
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
            case 'openFilePicker': {
                try {
                    // Open tabs first — most relevant to the user's current context.
                    // Use fsPath for deduplication to avoid multi-root ambiguity.
                    const openItems = vscode.workspace.textDocuments
                        .filter(d => d.uri.scheme === 'file')
                        .map(d => ({
                            label:       vscode.workspace.asRelativePath(d.uri, false),
                            description: '● open',
                            fsPath:      d.uri.fsPath,
                        }));
                    const openSet = new Set(openItems.map(p => p.fsPath));

                    // All workspace files — exclude same dirs as FOLDER_TREE_SKIP for consistency.
                    const found = await vscode.workspace.findFiles(
                        '**/*',
                        '{**/node_modules/**,**/.git/**,**/out/**,**/.vscode/**,**/dist/**,**/build/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/.next/**,**/coverage/**,**/.turbo/**}',
                        500,
                    );
                    const wsItems = found
                        .map(u => ({
                            label:   vscode.workspace.asRelativePath(u, false),
                            description: '',
                            fsPath:  u.fsPath,
                        }))
                        .filter(p => !openSet.has(p.fsPath));

                    const picked = await vscode.window.showQuickPick([...openItems, ...wsItems], {
                        placeHolder: isZh() ? '搜索并选择文件…' : 'Search and select a file…',
                        matchOnDescription: false,
                    });
                    // Send fsPath — avoids multi-root ambiguity; resolvePath handles absolute paths.
                    this._post({ type: 'filePickerResult', path: picked ? picked.fsPath : null });
                } catch (e) {
                    this._post({ type: 'filePickerResult', path: null });
                }
                break;
            }
            case 'fileContent': {
                const rel    = String(msg.path || '');
                let content  = '', error = '', imageData = '';
                // Image and binary detection by extension.
                const IMAGE_EXTS  = new Set(['png','jpg','jpeg','gif','bmp','webp','tiff','tif','ico']);
                const BINARY_EXTS = new Set(['pdf','zip','tar','gz','7z','rar','exe','dll','so','wasm',
                                             'mp4','mp3','wav','mov','avi','pt','pth','onnx','pkl','bin']);
                try {
                    // resolvePath handles both absolute and relative paths correctly.
                    const fp  = resolvePath(rel);
                    const ext = path.extname(fp).slice(1).toLowerCase();
                    if (IMAGE_EXTS.has(ext)) {
                        const buf  = fs.readFileSync(fp);
                        const mime = `image/${ext === 'jpg' ? 'jpeg' : (ext === 'tif' ? 'tiff' : ext)}`;
                        imageData  = `data:${mime};base64,${buf.toString('base64')}`;
                    } else if (BINARY_EXTS.has(ext)) {
                        error = `Binary file (.${ext}) — cannot attach as text. Use a path reference instead.`;
                    } else {
                        content = fs.readFileSync(fp, 'utf8');
                        if (content.length > 65536) content = content.slice(0, 65536) + '\n... [truncated]';
                    }
                } catch (e) { error = e.message; }
                this._post({ type: 'fileContentResult', path: rel, content, error, imageData });
                break;
            }
            case 'resolveContextRef': {
                const refType = String(msg.refType || '');
                const value   = msg.value != null ? String(msg.value) : '';
                try {
                    const result = await resolveContextRef(refType, value);
                    if (!result || result.error) {
                        this._post({ type: 'contextRefError', refType, value, text: result?.error || 'failed' });
                    } else {
                        this._post({ type: 'addAttachment', payload: result });
                    }
                } catch (e) {
                    this._post({ type: 'contextRefError', refType, value, text: e.message });
                }
                break;
            }
            case 'openInTab': {
                // Message from the sidebar launcher page — open chat as editor tab
                // and collapse the sidebar so the activity bar is free for others.
                // We only close the sidebar after openInTab succeeds; if it fails
                // we log the error and leave the sidebar alone so the user still
                // sees a working UI.
                try {
                    await vscode.commands.executeCommand('deepseekAgent.openInTab');
                    try { await vscode.commands.executeCommand('workbench.action.closeSidebar'); }
                    catch (e) { Logger.info('SIDEBAR_CLOSE_FAILED', { err: String(e && e.message || e) }); }
                } catch (e) {
                    Logger.info('OPEN_IN_TAB_FAILED', { err: String(e && e.message || e) });
                }
                break;
            }
        }
    }

    async _loadSession(id) {
        // Check run before load — completed runs are deleted from _runs, so
        // run will be null for finished sessions and truthy for in-flight ones.
        const run = this._runs.get(id);
        await this._store.load(id, { busy: !!(run && run.busy) });
        if (!run || !run.events.length) return;
        // Issue #143: defer event replay to the next macrotask so the webview
        // has time to paint the rebuilt session history BEFORE the buffered
        // events flood in. We also wrap the burst in replayStart/replayEnd
        // envelopes so the webview can suppress per-event scroll-to-bottom
        // (each ascroll() schedules a RAF, causing visible scrollbar jitter).
        //
        // Post replayStart IMMEDIATELY (not inside setTimeout): if the agent
        // is still streaming when the user switches to this session, live
        // streamDelta events posted during the 0-ms delay would otherwise
        // arrive before replayStart and reintroduce per-event scroll jitter
        // (Copilot review feedback on PR #144).
        const evs = run.events.slice();
        this._post({ type: 'replayStart', count: evs.length });
        setTimeout(() => {
            // Guard: the active session may have changed again during the
            // 0-ms delay (rapid clicking). In that case the events are still
            // buffered on `run.events`, so the next _loadSession(id) for this
            // session will replay them; close the envelope here so the webview
            // does not stay in replay-suppress mode forever.
            if (run.sessionId !== this._store.sessionId) {
                this._post({ type: 'replayEnd' });
                return;
            }
            for (const ev of evs) this._post(ev);
            this._post({ type: 'replayEnd' });
        }, 0);
    }

    // Issue #142 P3-1: user-initiated `/compact [focus]` command.
    // Force-compacts the active session's run.messages, optionally biasing the
    // LLM summary toward `focus`.  Persists the compacted state immediately so
    // the next turn (and future reloads) start from the reduced history.
    async _handleCompactCommand(focus) {
        const sid = this._store.sessionId;
        if (!sid) {
            this._post({ type: 'status', text: '没有活动会话可压缩 / No active session to compact' });
            return;
        }
        const run = this._activeRun();
        if (!run || !Array.isArray(run.messages) || run.messages.length === 0) {
            this._post({ type: 'status', text: '当前会话尚无可压缩内容 / Nothing to compact yet' });
            return;
        }
        if (run.busy) {
            this._post({ type: 'status', text: '请等待当前回复结束再压缩 / Wait for the current reply to finish' });
            return;
        }

        const { autoCompactIfNeeded, estimateMessagesTokens } = require('./compact');
        const cfg      = vscode.workspace.getConfiguration('deepseekAgent');
        const provider = cfg.get('provider') || 'deepseek';
        const model    = cfg.get('defaultModel') || 'deepseek-v4-pro';
        const baseUrl  = (cfg.get('apiBaseUrl') || '').trim();
        const apiKey   = await this._context.secrets.get('deepseekAgent.apiKey');

        // Issue #142 P3-2: project-level compact instructions.  If the user
        // has a `.deepcopilot/compact.md` (or CLAUDE.md fallback) in the
        // workspace root, its contents are merged into the focus hint.
        let effectiveFocus = focus || '';
        try {
            const ws = this._currentWs();
            if (ws) {
                const fs   = require('fs');
                const path = require('path');
                const candidates = [
                    path.join(ws, '.deepcopilot', 'compact.md'),
                    path.join(ws, '.deepcopilot', 'COMPACT.md'),
                    path.join(ws, 'CLAUDE.md'),
                ];
                for (const p of candidates) {
                    if (fs.existsSync(p)) {
                        const txt = fs.readFileSync(p, 'utf8').slice(0, 4000);
                        effectiveFocus = effectiveFocus ? `${effectiveFocus}\n\n${txt}` : txt;
                        break;
                    }
                }
            }
        } catch { /* best effort */ }
        const apiConfig = { apiKey, baseUrl, model, provider, focus: effectiveFocus };

        const before = estimateMessagesTokens(run.messages);
        // Force compaction by setting a budget well below the current size.
        const budget = Math.max(2000, Math.floor(before * (focus ? 0.3 : 0.4)));

        this._post({ type: 'status', text: '🗜 正在压缩历史… / Compacting…' });
        try {
            const res = await autoCompactIfNeeded(run.messages, budget, 6, apiConfig);
            if (res && res.compacted) {
                run.messages = res.messages;
                const after = estimateMessagesTokens(run.messages);
                // Persist the compacted state — no userText / asstText so
                // append() only updates apiMessages.
                try {
                    await this._store.append(sid, '', '', '', null, run.messages);
                } catch (_e) { /* persistence best-effort */ }
                this._post({
                    type: 'status',
                    text: `✅ 已压缩 ${Math.round(before / 1000)}K → ${Math.round(after / 1000)}K tokens`,
                });
            } else {
                this._post({ type: 'status', text: '历史已足够紧凑 / History already compact' });
            }
        } catch (e) {
            this._post({ type: 'error', text: `Compact failed: ${e.message}` });
        }
    }

    // Issue #142 P3-4: `/context` status report.  Reports a coarse breakdown
    // (system prompt + message history) so the user can decide whether to
    // /compact or /fork.  Note: tool definitions, file/hint payloads sent
    // alongside the request are NOT included here — the on-wire request can
    // be a few K larger than the number shown.  Aligning this with the real
    // wire size is tracked separately (Copilot review feedback).
    async _handleContextCommand() {
        try {
            const { estimateMessagesTokens, estimateTokens } = require('./compact');
            const run = this._activeRun();
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            const provider = cfg.get('provider') || 'deepseek';
            const model    = cfg.get('defaultModel') || 'deepseek-v4-pro';
            const { resolveProvider } = require('../providers');
            let modelCfg = { contextWindow: 65536 };
            try {
                const p = resolveProvider(provider);
                modelCfg = p?.models?.find(m => m.id === model) || modelCfg;
            } catch { /* fallback */ }
            const window = modelCfg.contextWindow || 65536;

            const msgs = run?.messages || [];
            const historyTok = estimateMessagesTokens(msgs);
            // Rough estimate for system prompt — uses the default builder.
            let sysTok = 0;
            try {
                const { buildSystemPrompt } = require('../prompts/system');
                const sys = buildSystemPrompt({ provider, model });
                sysTok = estimateTokens(sys);
            } catch { /* skip */ }

            const total = historyTok + sysTok;
            const pct = Math.min(100, Math.round(total / window * 100));
            const bar = (() => {
                const w = 20;
                const filled = Math.round(pct / 100 * w);
                return '█'.repeat(filled) + '░'.repeat(w - filled);
            })();
            const lines = [
                `📊 Context usage — ${pct}%`,
                `[${bar}] ${Math.round(total/1000)}K / ${Math.round(window/1000)}K tokens`,
                ``,
                `• System prompt : ${Math.round(sysTok/1000)}K`,
                `• History       : ${Math.round(historyTok/1000)}K (${msgs.length} msgs)`,
                `• Model         : ${provider} / ${model}`,
                ``,
                `Tip: /compact [focus] to summarise · /fork [title] to branch off`,
            ];
            this._post({ type: 'status', text: lines.join('\n') });
        } catch (e) {
            this._post({ type: 'error', text: `/context failed: ${e.message}` });
        }
    }

    // Issue #142 P3-5: `/fork [title]` clones the current session under a new
    // id so the user can experiment without polluting the original thread.
    async _handleForkCommand(title) {
        const sid = this._store.sessionId;
        if (!sid) {
            this._post({ type: 'status', text: '没有可分叉的会话 / Nothing to fork' });
            return;
        }
        try {
            const newId = await this._store.fork(sid, title);
            if (newId) {
                this._post({ type: 'status', text: `🌿 已分叉到新会话 / Forked to new session` });
            }
        } catch (e) {
            this._post({ type: 'error', text: `/fork failed: ${e.message}` });
        }
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

    // ─── Public API for extension commands ──────────────────────────────────

    /**
     * Compute display path + workspace location for a TextDocument.
     * Issue #97: multi-root aware + external-file aware.
     *  - Returns null for unsupported schemes (we only handle file/untitled;
     *    synthetic schemes like git:/output:/vscode-userdata: are intentionally
     *    refused because their contents are derived views, not source files).
     *  - For workspace-internal files, `rel` is relative to the *containing*
     *    folder (not necessarily the first one).
     *  - For workspace-external files, `external` is true and `rel` falls back
     *    to the absolute path so the UI can disambiguate same-named files.
     *
     * @param {import('vscode').TextDocument} doc
     * @returns {{ abs: string, rel: string, external: boolean, untitled: boolean } | null}
     */
    _resolveDocLocation(doc) {
        if (!doc) return null;
        const scheme = doc.uri.scheme;
        if (scheme !== 'file' && scheme !== 'untitled') return null;
        if (scheme === 'untitled') {
            return { abs: doc.uri.toString(), rel: doc.fileName || 'Untitled', external: false, untitled: true };
        }
        const abs = doc.fileName;
        const hit = findContainingFolder(abs);
        if (hit) return { abs, rel: hit.rel, external: false, untitled: false };
        // External: not inside any workspace folder. Use absolute path as the
        // display key; the UI marks it with a distinct style.
        return { abs, rel: abs.replace(/\\/g, '/'), external: true, untitled: false };
    }

    /**
     * Called by the deepseekAgent.attachFolder command when the user
     * right-clicks a file or folder in the Explorer tree.
     * @param {import('vscode').Uri} [uri]  URI passed by VS Code from explorer/context.
     *   Falls back to the active editor when undefined (command palette invocation).
     */
    async attachExplorerResource(uri) {
        if (!uri || !uri.fsPath) {
            this.attachSelection();
            return;
        }
        let stat;
        try { stat = await vscode.workspace.fs.stat(uri); }
        catch { return; }

        if (stat.type & vscode.FileType.Directory) {
            await this._attachFolderUri(uri);
        } else {
            // File from Explorer — read content and attach as a normal file chip
            let doc;
            try { doc = await vscode.workspace.openTextDocument(uri); }
            catch { return; }
            const loc = this._resolveDocLocation(doc);
            if (!loc) return;
            let content = doc.getText();
            if (content.length > MAX_FILE_ATTACH_BYTES) content = content.slice(0, MAX_FILE_ATTACH_BYTES) + '\n... [截断]';
            this._post({
                type: 'addAttachment',
                payload: { path: loc.rel, content, lang: doc.languageId, external: loc.external },
            });
            vscode.commands.executeCommand('deepseek.chatView.focus').then(() => {}, () => {});
        }
    }

    /** Attach a folder URI as a folder chip (file-tree listing as content). */
    async _attachFolderUri(uri) {
        const fsPath = uri.fsPath;
        const hit = findContainingFolder(fsPath);
        const relPath = hit
            ? hit.rel || path.basename(fsPath)
            : fsPath.replace(/\\/g, '/');
        const external = !hit;

        const treeLines = await this._collectFolderTree(uri, '', 0);
        // Content is the file-tree text; AI can use it to understand the folder structure
        const content = treeLines.join('\n');

        this._post({
            type: 'addAttachment',
            payload: { path: relPath, content, isFolder: true, external },
        });
        vscode.commands.executeCommand('deepseek.chatView.focus').then(() => {}, () => {});
    }

    /**
     * Recursively collect a folder's file tree as an array of indented strings.
     * Skips hidden files, node_modules, common build artifacts, etc.
     * Stops after 200 entries or depth > 3 to keep the payload reasonable.
     * @param {import('vscode').Uri} uri
     * @param {string} prefix  Indentation string for the current level.
     * @param {number} depth
     * @returns {Promise<string[]>}
     */
    async _collectFolderTree(uri, prefix, depth) {
        const MAX_DEPTH = 3;
        const MAX_ENTRIES = 200;
        if (depth > MAX_DEPTH) return [];
        let entries;
        try { entries = await vscode.workspace.fs.readDirectory(uri); }
        catch { return []; }

        // Directories first, then files, both alphabetical
        entries.sort(([a, ta], [b, tb]) => {
            const aDir = (ta & vscode.FileType.Directory) ? 0 : 1;
            const bDir = (tb & vscode.FileType.Directory) ? 0 : 1;
            if (aDir !== bDir) return aDir - bDir;
            return a.localeCompare(b);
        });

        const lines = [];
        for (const [name, type] of entries) {
            if (name.startsWith('.') || FOLDER_TREE_SKIP.has(name)) continue;
            if (type & vscode.FileType.Directory) {
                lines.push(prefix + name + '/');
                if (depth < MAX_DEPTH) {
                    const sub = await this._collectFolderTree(
                        vscode.Uri.joinPath(uri, name), prefix + '  ', depth + 1
                    );
                    lines.push(...sub);
                }
            } else {
                lines.push(prefix + name);
            }
            if (lines.length >= MAX_ENTRIES) {
                lines.push(prefix + '... (truncated)');
                break;
            }
        }
        return lines;
    }

    /**
     * Read the active editor selection (or entire file if nothing selected)
     * and push an addAttachment message to the webview.
     * Called by the deepseekAgent.attachSelection command.
     */
    attachSelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage(
                isZh() ? 'Deep Copilot: 请先在编辑器中打开一个文件' : 'Deep Copilot: Open a file in the editor first'
            );
            return;
        }
        const doc = editor.document;
        const loc = this._resolveDocLocation(doc);
        if (!loc) return;

        const lang = doc.languageId;
        const sel  = editor.selection;

        let content, startLine, endLine;
        if (!sel.isEmpty) {
            content   = doc.getText(sel);
            startLine = sel.start.line + 1;  // convert to 1-based
            endLine   = sel.end.line + 1;
            if (content.length > 12000) content = content.slice(0, 12000) + '\n... [截断]';
        } else {
            content = doc.getText();
            if (content.length > 65536) content = content.slice(0, 65536) + '\n... [截断]';
        }

        // Issue #97: for explicit user-driven attach (right-click / command),
        // we honor the user's intent even on external files — they asked for
        // it. We still tag `external` so the UI can flag it.
        this._post({
            type: 'addAttachment',
            payload: { path: loc.rel, content, startLine, endLine, lang, external: loc.external },
        });
        // Focus the chat panel so the user can see the chip was added
        vscode.commands.executeCommand('deepseek.chatView.focus').then(() => {}, () => {});
    }

    /**
     * Called by the selection-change listener (auto, ~300ms debounce) AND
     * by the active-editor-change listener. Always shows a chip for the
     * currently active file. If a non-empty selection exists, the chip also
     * carries the selected text + line range; otherwise it's just a name tag.
     *
     * Issue #97:
     *  - Multi-root aware: paths are computed relative to the *containing*
     *    workspace folder, not just folders[0].
     *  - External files (outside every workspace folder) are no longer
     *    silently dropped. The chip is rendered with an `external` flag so
     *    the user can see what they have open; the prompt-side attachment
     *    block below skips them so they don't auto-leak into requests.
     * @param {import('vscode').TextEditor} [editor]
     */
    attachLiveSelection(editor) {
        if (!editor) editor = vscode.window.activeTextEditor;
        if (!editor) { this.clearLiveSelection(); return; }
        const doc = editor.document;
        const loc = this._resolveDocLocation(doc);
        if (!loc) { this.clearLiveSelection(); return; }

        const lang = doc.languageId;
        const sel  = editor.selection;
        if (sel && !sel.isEmpty) {
            let content = doc.getText(sel);
            const startLine = sel.start.line + 1;
            const endLine   = sel.end.line + 1;
            if (content.length > 12000) content = content.slice(0, 12000) + (isZh() ? '\n... [截断]' : '\n... [truncated]');
            this._post({
                type: 'setLiveSelection',
                payload: { path: loc.rel, content, startLine, endLine, lang, external: loc.external },
            });
        } else {
            // File is open but no selection: include the full document content
            // (truncated) so that sending the chip attaches the whole file.
            const FILE_CAP = 60 * 1024; // 60KB cap to keep payload reasonable
            let content = doc.getText();
            const truncated = content.length > FILE_CAP;
            if (truncated) content = content.slice(0, FILE_CAP) + (isZh() ? '\n... [文件超出 60KB 已截断]' : '\n... [file exceeded 60KB and was truncated]');
            this._post({
                type: 'setLiveSelection',
                payload: { path: loc.rel, content, lang, external: loc.external },
            });
        }
    }

    /** Remove the live selection chip from the webview. */
    clearLiveSelection() {
        this._post({ type: 'clearLiveSelection' });
    }

    _buildAttachmentBlock() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return null;
        const doc  = editor.document;
        const loc  = this._resolveDocLocation(doc);
        if (!loc) return null;
        // Issue #97: never auto-leak the content of files outside the workspace
        // into the prompt. The chip is still shown so the user is aware of the
        // file; if they want to include it they must explicitly attach via the
        // right-click command or the `#file` picker.
        if (loc.external) return null;
        const sel  = editor.selection;
        const lang = doc.languageId;
        const rel  = loc.rel;
        const lines = ['<attachments>'];
        lines.push(`The user is currently viewing \`${rel}\` (${lang}).`);
        if (!sel.isEmpty) {
            const selected = doc.getText(sel);
            const capped   = selected.length > 4000 ? selected.slice(0, 4000) + '\n... [selection truncated]' : selected;
            lines.push(`Selection (${rel}:${sel.start.line + 1}-${sel.end.line + 1}):`);
            lines.push('`' + '`' + '`' + lang, capped, '`' + '`' + '`');
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
        if (run.pendingEdits) {
            run.pendingEdits.clear();
            this._runPost(run, { type: 'pendingEdits', items: [] });
        }
        const msg = isZh()
            ? `已回滚 ${reverted.length} 个文件：${reverted.join('、')}`
            : `Reverted ${reverted.length} file(s): ${reverted.join(', ')}`;
        failed.length
            ? vscode.window.showWarningMessage(msg + (isZh() ? `；失败：${failed.join('、')}` : `; Failed: ${failed.join(', ')}`))
            : vscode.window.showInformationMessage(msg);
    }

    // ─── Pending edits panel handlers ────────────────────────────────────────

    /**
     * Apply the user's keep/discard decision on agent-authored edits.
     *  - 'keep'        : mark the entry as accepted, drop it from the panel.
     *  - 'keepAll'     : same for every pending entry.
     *  - 'discard'     : restore the snapshotted `before` content on disk and drop.
     *  - 'discardAll'  : discard every pending entry.
     */
    _handlePendingEdit(action, targetPath) {
        const sid = this._store.sessionId;
        const pending = this._pendingFor(sid);
        if (!pending || pending.size === 0) {
            this._post({ type: 'pendingEdits', items: [] });
            return;
        }
        const matches = (abs) => {
            if (action === 'keepAll' || action === 'discardAll') return true;
            return abs === targetPath;
        };
        const failed = [];
        for (const [abs, entry] of [...pending]) {
            if (entry.status !== 'pending' || !matches(abs)) continue;
            if (action === 'keep' || action === 'keepAll') {
                entry.status = 'accepted';
            } else {
                // discard → restore the snapshotted "before"
                try {
                    if (entry.before === null || entry.before === undefined) {
                        if (fs.existsSync(abs)) fs.unlinkSync(abs);
                    } else {
                        fs.writeFileSync(abs, entry.before, 'utf8');
                    }
                    entry.status = 'discarded';
                    // Keep turnSnapshots untouched: revert_last_turn must still
                    // see the original `before` if the user later asks to undo
                    // the whole turn — and writing the same `before` back is a
                    // no-op for the snapshot-based restore.
                } catch (e) {
                    failed.push(`${path.basename(abs)}: ${e.message}`);
                }
            }
            // Drop resolved entries from the map so the panel cleans up.
            pending.delete(abs);
        }
        if (failed.length) {
            vscode.window.showWarningMessage(
                (isZh() ? 'Deep Copilot：部分文件回退失败：' : 'Deep Copilot: some files failed to revert: ')
                + failed.join('; ')
            );
        }
        // Build the post payload from the session map directly so it works
        // even when no run is active.
        const items = [];
        for (const [abs, e] of pending) {
            if (e.status !== 'pending') continue;
            items.push({
                path: abs, rel: e.rel, tool: e.tool,
                added: e.added, removed: e.removed,
                isNew: !!e.isNew, isDelete: !!e.isDelete,
                binary: !!e.binary, approximate: !!e.approximate,
                updatedAt: e.updatedAt,
            });
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        this._post({ type: 'pendingEdits', items });
    }

    /**
     * Open a native VS Code diff editor comparing the snapshotted `before` of
     * a pending edit against the current on-disk content. The left-hand side is
     * served by the `deepcopilot-before:` TextDocumentContentProvider that
     * extension.js registers; it calls back into `getPendingBefore(sid, abs)`.
     */
    async _handleOpenEditDiff(targetPath) {
        const sid     = this._store.sessionId;
        const pending = this._pendingFor(sid);
        if (!pending) return;
        const entry = pending.get(targetPath);
        if (!entry) return;
        try {
            // Cache-busting `t` ensures every click yields a fresh URI so VS
            // Code always opens a new diff editor instead of silently
            // re-using a previously closed one. Combined with the
            // `_invalidatePendingBefore` event below it also forces the
            // content provider to be re-queried.
            const ts     = Date.now();
            const beforeUri = vscode.Uri.parse(
                'deepcopilot-before:' + path.basename(targetPath)
                + '?sid=' + encodeURIComponent(sid)
                + '&p='   + encodeURIComponent(targetPath)
                + '&t='   + ts
            );
            try { this._invalidatePendingBefore && this._invalidatePendingBefore(beforeUri); } catch {}
            const afterUri  = vscode.Uri.file(targetPath);
            const title     = isZh()
                ? `Deep Copilot 待审阅: ${path.basename(targetPath)}`
                : `Deep Copilot pending: ${path.basename(targetPath)}`;
            // Drop `preview: true` so the diff tab survives the next click;
            // otherwise repeated clicks can replace and instantly close it.
            await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
        } catch (e) {
            Logger.info('OPEN_EDIT_DIFF_ERROR', { message: e.message });
            vscode.window.showWarningMessage(
                (isZh() ? '无法打开差异视图: ' : 'Cannot open diff view: ') + e.message
            );
        }
    }

    async _refreshBalance(force) {
        const now = Date.now();
        if (!force && now - this._balanceLastAt < 30_000) return;
        const cfg      = vscode.workspace.getConfiguration('deepseekAgent');
        const provider = cfg.get('provider') || 'deepseek';
        const apiKey   = await this._context.secrets.get('deepseekAgent.apiKey') || '';
        const resolved = resolveProviderConfig(provider, cfg.get('apiBaseUrl') || '', '');
        if (!apiKey) { this._post({ type: 'balanceUpdate', unsupported: true }); return; }
        const result = await fetchBalance({ apiKey, baseUrl: resolved.baseUrl, balanceEndpoint: resolved.balanceEndpoint });
        if (result === null) { this._post({ type: 'balanceUpdate', unsupported: true }); return; }
        this._balanceLastAt = Date.now();
        this._post({ type: 'balanceUpdate', ...result });
    }

    _post(msg) {
        // Broadcast to dedicated editor tab (if open) and every registered
        // WebviewView (sidebar + auxiliary bar) so both instances stay in sync.
        if (this._panel && this._panel.webview) {
            try { this._panel.webview.postMessage(msg); } catch { /* ignore */ }
        }
        for (const v of this._views) {
            try { v.webview.postMessage(msg); } catch { /* ignore */ }
        }
    }

    postToWebview(type, payload) {
        this._post(Object.assign({ type }, payload || {}));
    }
}

module.exports = { ChatViewProvider };
