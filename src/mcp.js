// MCP (Model Context Protocol) client for Deep Copilot.
//
// Connects to external tool servers over stdio using JSON-RPC 2.0.
// Configure servers in VS Code settings:
//
//   "deepseekAgent.mcp.servers": [
//     { "name": "my-db",  "command": "npx", "args": ["my-db-mcp-server"] },
//     { "name": "jira",   "command": "node", "args": ["./tools/jira-mcp.js"] }
//   ]
//
// Tools from connected servers appear as `mcp__<server>__<tool>` in the model's
// function-calling interface. Results are routed back to the correct server.
'use strict';

const cp       = require('child_process');
const readline = require('readline');
const vscode   = require('vscode');
const { Logger } = require('./logger');

/** Sanitize a string to a safe function-name component ([a-zA-Z0-9_]). */
function sanitize(s) {
    return String(s || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 28);
}

// ─── McpClient ─────────────────────────────────────────────────────────────

class McpClient {
    constructor({ name, command, args = [], env = {}, cwd }) {
        this.serverName  = name;
        this.command     = command;
        this.spawnArgs   = Array.isArray(args) ? args : [];
        this.env         = env || {};
        this.cwd         = cwd || null;
        this.proc        = null;
        this.rl          = null;
        this._pending    = new Map();   // id -> { resolve, reject }
        this._nextId     = 1;
        this.tools       = [];
        this._ready      = false;
    }

    /** Spawn the server process and perform MCP initialization handshake. */
    async start(wsRoot) {
        const cwd = this.cwd || wsRoot || process.cwd();
        this.proc = cp.spawn(this.command, this.spawnArgs, {
            cwd,
            env:   { ...process.env, ...this.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.proc.on('error', (e) => {
            Logger.info('MCP_PROC_ERROR', { server: this.serverName, message: e.message });
            this._rejectAll(e);
        });
        this.proc.on('exit', (code) => {
            this._ready = false;
            Logger.info('MCP_PROC_EXIT', { server: this.serverName, code });
            this._rejectAll(new Error(`MCP server '${this.serverName}' exited (code ${code})`));
        });

        // Read newline-delimited JSON responses from stdout
        this.rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
        this.rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                const msg = JSON.parse(line);
                this._handleMsg(msg);
            } catch { /* ignore malformed lines */ }
        });

        // MCP initialize handshake
        await this._request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities:    { tools: {} },
            clientInfo:      { name: 'deep-copilot', version: '1.0.0' },
        }, 10000);

        // Send initialized notification (no response expected)
        this._notify('notifications/initialized', {});
        this._ready = true;
    }

    /** Fetch the list of tools this server exposes. */
    async listTools() {
        const res  = await this._request('tools/list', {});
        this.tools = (res && Array.isArray(res.tools)) ? res.tools : [];
        return this.tools;
    }

    /** Call a tool on this server. */
    async callTool(toolName, toolArgs) {
        const res = await this._request('tools/call', {
            name:      toolName,
            arguments: toolArgs || {},
        });
        if (res && res.isError) {
            const msg = Array.isArray(res.content)
                ? res.content.map(c => c.text || c.data || '').join('\n')
                : 'Tool returned an error';
            throw new Error(msg);
        }
        const content = (res && Array.isArray(res.content)) ? res.content : [];
        return content.map(c => c.text || c.data || '').join('\n') || '(no output)';
    }

    stop() {
        this._ready = false;
        if (this.rl)   { try { this.rl.close();   } catch {} this.rl   = null; }
        if (this.proc) { try { this.proc.kill();   } catch {} this.proc = null; }
    }

    // ── private ────────────────────────────────────────────────────────

    _handleMsg(msg) {
        if (msg.id !== undefined) {
            const p = this._pending.get(msg.id);
            if (p) {
                this._pending.delete(msg.id);
                if (msg.error) {
                    p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                } else {
                    p.resolve(msg.result);
                }
            }
        }
        // Notifications (no id) are silently ignored for now.
    }

    _request(method, params, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            if (!this.proc || !this.proc.stdin.writable) {
                return reject(new Error(`MCP server '${this.serverName}' not running`));
            }
            const id    = this._nextId++;
            const timer = setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error(`MCP '${this.serverName}' '${method}' timed out`));
                }
            }, timeoutMs);
            this._pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject:  (e) => { clearTimeout(timer); reject(e);  },
            });
            const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
            this.proc.stdin.write(line);
        });
    }

    _notify(method, params) {
        if (!this.proc || !this.proc.stdin.writable) return;
        const line = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
        this.proc.stdin.write(line);
    }

    _rejectAll(err) {
        for (const [, p] of this._pending) p.reject(err);
        this._pending.clear();
    }
}

// ─── McpManager ────────────────────────────────────────────────────────────

class McpManager {
    constructor() {
        this.clients    = new Map();   // serverName -> McpClient
        this._toolDefs  = [];          // OpenAI function-calling tool defs
        this._toolMap   = new Map();   // fullFunctionName -> { serverName, originalName }
        this._initDone  = false;
    }

    /**
     * Initialize all configured MCP servers.
     * Called once, non-blocking (callers fire-and-forget).
     */
    async init(wsRoot) {
        if (this._initDone) return;
        this._initDone = true;

        let servers = [];
        try {
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            servers = cfg.get('mcp.servers') || [];
        } catch { return; }

        if (!Array.isArray(servers) || !servers.length) return;

        for (const srv of servers) {
            if (!srv || !srv.name || !srv.command) continue;
            try {
                const client = new McpClient(srv);
                await client.start(wsRoot);
                const tools = await client.listTools();
                this.clients.set(srv.name, client);

                for (const t of tools) {
                    const fname = this._makeFuncName(srv.name, t.name);
                    this._toolDefs.push({
                        type: 'function',
                        function: {
                            name:        fname,
                            description: `[MCP:${srv.name}] ${(t.description || t.name).slice(0, 200)}`,
                            parameters:  t.inputSchema || { type: 'object', properties: {} },
                        },
                    });
                    this._toolMap.set(fname, { serverName: srv.name, originalName: t.name });
                }
                Logger.info('MCP_INIT_OK', { server: srv.name, tools: tools.length });
            } catch (e) {
                Logger.info('MCP_INIT_FAIL', { server: srv.name, message: e.message });
            }
        }
    }

    /** Build a valid OpenAI function name from server + tool names (max 64 chars). */
    _makeFuncName(serverName, toolName) {
        return `mcp__${sanitize(serverName)}__${sanitize(toolName)}`.slice(0, 64);
    }

    /** Return extra tool defs to merge with the standard TOOL_DEFS. */
    getToolDefs() { return this._toolDefs; }

    /** Returns true if the given function name is an MCP-routed tool. */
    isMcpTool(name) { return this._toolMap.has(name); }

    /** Call an MCP tool by its full function name. */
    async callTool(fullName, args) {
        const entry = this._toolMap.get(fullName);
        if (!entry) return `Error: Unknown MCP tool '${fullName}'`;
        const client = this.clients.get(entry.serverName);
        if (!client) return `Error: MCP server '${entry.serverName}' not connected`;
        return await client.callTool(entry.originalName, args);
    }

    /** Stop all connected servers (e.g. on extension deactivate). */
    stopAll() {
        for (const client of this.clients.values()) client.stop();
        this.clients.clear();
        this._toolDefs  = [];
        this._toolMap.clear();
        this._initDone  = false;
    }
}

// Module-level singleton — shared across all provider instances.
const mcpManager = new McpManager();

module.exports = { mcpManager };
