// ToolExecutor: runs tool calls with caching, approval, snapshots, and
// post-edit diagnostics.
//
// HOT-PLUGGABLE DESIGN: built-in tools are stored in a Map registry.
// Call registerTool(name, fn) to add or override any tool at runtime —
// useful for extensions, testing, or custom workspace tooling.
//
// Tool function signature: async (args, ctx) => string
//   ctx = { abortSignal, secrets }  (pass only what you need)
'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');

const { Logger }       = require('../logger');
const { t }            = require('../utils/i18n');
const { wsRoot, resolvePath } = require('../utils/paths');
const { runHooks }     = require('../hooks');
const { mcpManager }   = require('../mcp');

const {
    toolReadFile, toolListDir, toolGrepSearch, toolFindFiles,
    toolWriteFile, toolStrReplaceInFile, toolApplyPatch, toolRunShell, toolWebSearch, toolWebFetch,
} = require('../tools/exec');
const { skillInvoke, skillCreate } = require('../tools/skill-tools');

class ToolExecutor {
    // Read-only tools whose results can be cached until workspace changes.
    static CACHEABLE = new Set(['read_file', 'grep_search', 'find_files', 'list_dir', 'web_search', 'web_fetch']);
    // Mutating tools that invalidate the file cache after execution.
    static MUTATING  = new Set(['write_file', 'str_replace_in_file', 'apply_patch', 'run_shell', 'skill_create']);

    /**
     * @param {vscode.ExtensionContext} context
     * @param {{
     *   postToRun : (run, msg) => void,
     *   post      : (msg)      => void,
     * }} opts
     */
    constructor(context, { postToRun, post }) {
        this._context   = context;
        this._postToRun = postToRun || (() => {});
        this._post      = post      || (() => {});

        // Lazy-init SubAgentRunner to avoid circular require at module load time.
        // Assigned on first use inside _handleSpawnAgent().
        this._subAgentRunner = null;

        // ── Built-in tool registry ────────────────────────────────────────
        // Keys are exact tool names. Values: async (args, ctx) => string.
        // Hot-pluggable: swap any entry with registerTool().
        this._registry = new Map([
            ['read_file',           (args)      => toolReadFile(args)],
            ['list_dir',            (args)      => toolListDir(args)],
            ['grep_search',         (args)      => toolGrepSearch(args)],
            ['find_files',          (args)      => toolFindFiles(args)],
            ['write_file',          (args)      => toolWriteFile(args)],
            ['str_replace_in_file', (args)      => toolStrReplaceInFile(args)],
            ['apply_patch',         (args)      => toolApplyPatch(args)],
            ['run_shell',           (args, ctx) => toolRunShell(args, ctx)],
            ['web_search',          (args, ctx) => toolWebSearch(args, ctx)],
            ['web_fetch',           (args, ctx) => toolWebFetch(args, ctx)],
        ]);
    }

    // ─── Hot-plug API ────────────────────────────────────────────────────────

    /** Register (or replace) a tool implementation. Returns this for chaining. */
    registerTool(name, fn) {
        this._registry.set(name, fn);
        return this;
    }

    /** Remove a tool from the registry. Returns this for chaining. */
    unregisterTool(name) {
        this._registry.delete(name);
        return this;
    }

    /** List all registered tool names. */
    registeredTools() {
        return [...this._registry.keys()];
    }

    // ─── Cache helpers ───────────────────────────────────────────────────────

    argsHash(name, args) {
        try { return `${name}::${JSON.stringify(args, Object.keys(args || {}).sort())}`; }
        catch { return `${name}::${String(args)}`; }
    }

    invalidateCacheForMutation(run, name, args) {
        if (!run || !run.toolCache) return;
        const paths = new Set();
        if (args && args.path) paths.add(String(args.path));
        if (name === 'apply_patch' && args && args.patch) {
            const matches = String(args.patch).matchAll(/^\+\+\+ (?:b\/)?(.+)/gm);
            for (const m of matches) paths.add(m[1].trim());
        }
        if (name === 'run_shell' || paths.size === 0) {
            for (const key of run.toolCache.keys()) {
                if (key.startsWith('read_file::') || key.startsWith('list_dir::') ||
                    key.startsWith('find_files::') || key.startsWith('grep_search::')) {
                    run.toolCache.delete(key);
                }
            }
        } else {
            for (const key of run.toolCache.keys()) {
                for (const p of paths) {
                    if (key.includes(p)) { run.toolCache.delete(key); break; }
                }
            }
        }
    }

    // ─── Logging helpers ─────────────────────────────────────────────────────

    /** Parse tc.args, emit TOOL_CALL log + toolStart event. Returns parsed args. */
    logToolStart(run, tc) {
        let args;
        try { args = JSON.parse(tc.args || '{}'); } catch { args = {}; }
        Logger.info('TOOL_CALL', { id: tc.id, name: tc.name, args });
        const already = run._earlyStartedTools && run._earlyStartedTools.has(tc.id);
        if (already) {
            this._postToRun(run, { type: 'toolArgsFinal', id: tc.id, name: tc.name, args: tc.args || '{}' });
        } else {
            this._postToRun(run, { type: 'toolStart', id: tc.id, name: tc.name, args: tc.args || '{}' });
        }
        return args;
    }

    /** Normalize result to string, emit TOOL_RESULT log + toolResult event. Returns string. */
    logToolResult(run, tc, result, elapsedMs) {
        if (typeof result !== 'string') {
            try { result = JSON.stringify(result); } catch { result = String(result); }
        }
        const ok = !result.startsWith('Error');
        Logger.info('TOOL_RESULT', { id: tc.id, name: tc.name, elapsed_ms: elapsedMs, ok, output: result.slice(0, 2000) });
        this._postToRun(run, { type: 'toolResult', id: tc.id, name: tc.name, ok, output: result.slice(0, 600) });
        return result;
    }

    // ─── Approval ────────────────────────────────────────────────────────────

    /**
     * Race a tool promise against the abort signal so the agent-loop never
     * waits on a tool that ignores `ctx.abortSignal`.  The underlying tool may
     * keep running internally (best effort to also pass `abortSignal` in),
     * but its result will be discarded.  Issue #58 P0-3.
     */
    _raceWithAbort(promise, abortSignal) {
        if (!abortSignal) return promise;
        if (abortSignal.aborted) return Promise.reject(new Error('aborted'));
        return new Promise((resolve, reject) => {
            let settled = false;
            const onAbort = () => {
                if (settled) return;
                settled = true;
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
                reject(new Error('aborted'));
            };
            abortSignal.addEventListener('abort', onAbort, { once: true });
            promise.then(
                (v) => { if (settled) return; settled = true; try { abortSignal.removeEventListener('abort', onAbort); } catch {} resolve(v); },
                (e) => { if (settled) return; settled = true; try { abortSignal.removeEventListener('abort', onAbort); } catch {} reject(e); },
            );
        });
    }

    async requestApproval(description, abortSignal) {
        const dialog = vscode.window.showInformationMessage(
            `${t('approvalRequest')}${description}`,
            { modal: true },
            t('approvalApprove'),
            t('approvalDeny'),
        );
        if (!abortSignal) return (await dialog) === t('approvalApprove');

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

    // ─── Pre-edit snapshot ───────────────────────────────────────────────────

    snapshotForEdit(run, name, args) {
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
            if (run.turnSnapshots.has(abs)) continue; // only capture once per turn
            try { run.turnSnapshots.set(abs, fs.readFileSync(abs, 'utf8')); }
            catch { run.turnSnapshots.set(abs, null); } // null = file didn't exist
        }
    }

    // ─── Post-edit diagnostics ───────────────────────────────────────────────

    async collectPostEditDiagnostics(name, args) {
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

        await new Promise(r => setTimeout(r, 500)); // let language servers reanalyse

        const sevName = (s) => ['Error', 'Warning', 'Info', 'Hint'][s] || 'Info';
        const lines = [];
        let totalErr = 0, totalWarn = 0;
        for (const rel of paths) {
            let abs;
            try { abs = resolvePath(rel); } catch { continue; }
            let uri;
            try { uri = vscode.Uri.file(abs); } catch { continue; }
            const diags = vscode.languages.getDiagnostics(uri) || [];
            const filt = diags
                .filter(d => d.severity === vscode.DiagnosticSeverity.Error ||
                             d.severity === vscode.DiagnosticSeverity.Warning)
                .slice(0, 8);
            if (!filt.length) continue;
            lines.push(`- ${rel}:`);
            for (const d of filt) {
                const sev = sevName(d.severity);
                const ln  = (d.range && d.range.start && (d.range.start.line + 1)) || '?';
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

    // ─── Main entry point ────────────────────────────────────────────────────

    async execute(name, args, approvalMode, run, abortSignal, tcId) {
        // Deny list / readonly guard
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        const denyList    = cfg.get('denyTools')      || [];
        const autoApprove = cfg.get('autoApproveTools') || [];
        if (denyList.includes(name)) return `Denied by configuration: ${name} is in denyTools.`;

        const isMutating = ToolExecutor.MUTATING.has(name);
        if (approvalMode === 'readonly' && isMutating) return t('deniedReadonly');

        const skipApproval = autoApprove.includes(name);

        // Approval dialogs for write + shell
        if ((name === 'write_file' || name === 'str_replace_in_file' || name === 'apply_patch') &&
            approvalMode === 'manual' && !skipApproval) {
            const desc = name === 'write_file'
                ? `${t('writeFileLabel')}${args.path}`
                : name === 'apply_patch'
                    ? `${t('writeFileLabel')}(patch)`
                    : `${t('writeFileLabel')}${args.path} (str_replace)`;
            if (!await this.requestApproval(desc, abortSignal)) return t('deniedByUser');
        }

        if (name === 'run_shell' && approvalMode === 'manual' && !skipApproval) {
            if (!await this.requestApproval(`${t('runCmdLabel')}${args.command}`, abortSignal)) return t('deniedByUser');
        }

        // Skill creation writes outside the workspace (~/.deepcopilot/skills/...).
        // Always confirm with the user unless explicitly auto-approved.
        if (name === 'skill_create' && approvalMode === 'manual' && !skipApproval) {
            const desc = `Create skill "${args && args.name || '?'}" — ${args && args.description || ''}`;
            if (!await this.requestApproval(desc, abortSignal)) return t('deniedByUser');
        }

        // Cache lookup (read-only tools)
        const cache = run && run.toolCache;
        if (cache && ToolExecutor.CACHEABLE.has(name)) {
            const key = this.argsHash(name, args);
            if (cache.has(key)) {
                const entry = cache.get(key);
                if (name === 'read_file' && args.path) {
                    try {
                        const mtime = fs.statSync(resolvePath(args.path)).mtimeMs;
                        if (entry.mtime === mtime) return entry.result + '\n(cached)';
                        cache.delete(key); // stale — fall through to fresh read
                    } catch { /* file gone — fall through */ }
                } else {
                    return entry.result + '\n(cached)';
                }
            }
        }

        // Pre-edit snapshot
        if (run && run.turnSnapshots && isMutating && name !== 'run_shell') {
            this.snapshotForEdit(run, name, args);
        }

        // Dispatch to registry or special handlers — wrapped in a signal-race so
        // tools that don't honour `ctx.abortSignal` internally (sync I/O, third-
        // party libraries, etc.) still let the agent-loop unblock immediately
        // when the user presses Stop.  Issue #58 (P0-3).
        const dispatchPromise = this.dispatch(name, args, run, abortSignal, tcId);
        const result = await this._raceWithAbort(dispatchPromise, abortSignal);

        // Cache store (read-only)
        if (cache && ToolExecutor.CACHEABLE.has(name) && typeof result === 'string' && !result.startsWith('Error:')) {
            const key = this.argsHash(name, args);
            const entry = { result };
            if (name === 'read_file' && args.path) {
                try { entry.mtime = fs.statSync(resolvePath(args.path)).mtimeMs; } catch {}
            }
            cache.set(key, entry);
        }

        // Cache invalidation (mutating)
        if (isMutating) this.invalidateCacheForMutation(run, name, args);

        // After-tool hooks
        if (typeof result === 'string' && !result.startsWith('Error')) {
            const wsR = wsRoot();
            if (wsR) {
                try {
                    const hookOut = await runHooks('after_tool', name, wsR);
                    if (hookOut) return result + '\n\n[hooks]\n' + hookOut;
                } catch (e) { Logger.info('HOOK_ERROR', { name, message: e.message }); }
            }
        }

        // Post-edit diagnostics
        if (typeof result === 'string' && !result.startsWith('Error') &&
            (name === 'write_file' || name === 'str_replace_in_file' || name === 'apply_patch')) {
            const cfg2 = vscode.workspace.getConfiguration('deepseekAgent');
            if (cfg2.get('postEditDiagnostics', true)) {
                try {
                    const diagBlock = await this.collectPostEditDiagnostics(name, args);
                    if (diagBlock) return result + '\n\n' + diagBlock;
                } catch (e) { Logger.info('POST_EDIT_DIAG_ERROR', { message: e.message }); }
            }
        }

        return result;
    }

    // ─── Dispatch ────────────────────────────────────────────────────────────

    async dispatch(name, args, run, abortSignal, tcId) {
        // Registry tools (hot-pluggable)
        const fn = this._registry.get(name);
        if (fn) {
            // Streaming hook: tools that produce live output (run_shell) call
            // ctx.onStreamDelta(chunk) as data arrives; we forward each chunk to
            // the webview tagged with the tool-call id so the card can render
            // a live tail (GH-Copilot-style terminal card).
            const ctx = { abortSignal, secrets: this._context.secrets };
            if (tcId) {
                ctx.onStreamDelta = (delta) => {
                    if (!delta) return;
                    this._postToRun(run, { type: 'toolStreamDelta', id: tcId, delta: String(delta) });
                };
            }
            return fn(args, ctx);
        }

        // Special tools that need run-level state
        if (name === 'update_plan')      return this._handleUpdatePlan(args, run);
        if (name === 'revert_last_turn') return this._handleRevertLastTurn(args, run);

        // Skill subsystem (Issue #61) — skill_invoke needs run.messages to inject
        // a synthetic read_file pair; skill_create is a pure file write.
        if (name === 'skill_invoke')     return skillInvoke(args, run);
        if (name === 'skill_create')     return skillCreate(args);

        // Sub-agent dispatch
        if (name === 'spawn_agent')      return this._handleSpawnAgent(args, run, abortSignal);

        // MCP pass-through
        if (mcpManager.isMcpTool(name)) {
            try { return await mcpManager.callTool(name, args); }
            catch (e) { return `Error: ${e.message}`; }
        }

        return `Unknown tool: ${name}`;
    }

    // ─── Built-in special handlers ───────────────────────────────────────────

    _handleUpdatePlan(args, run) {
        const normStatus = (status, done) => {
            if (done === true) return 'done';
            const s = String(status || '').toLowerCase();
            if (s === 'completed' || s === 'complete' || s === 'done') return 'done';
            if (s === 'inprogress' || s === 'in_progress') return 'in_progress';
            if (s === 'blocked') return 'blocked';
            return 'pending';
        };
        const normTitle = (item, idx) => {
            const raw = item?.title ?? item?.text ?? item?.step ?? item?.content;
            return String(raw || '').trim() || `Step ${idx + 1}`;
        };

        const rawSteps = Array.isArray(args?.plan) ? args.plan
            : Array.isArray(args?.steps) ? args.steps : [];
        const steps = rawSteps.map((item, idx) => ({
            title: normTitle(item, idx), status: normStatus(item?.status, item?.done),
        }));
        const todos = (Array.isArray(args?.todos) ? args.todos : []).map((item, idx) => ({
            title: normTitle(item, idx), status: normStatus(item?.status, item?.done),
        }));

        if (run) {
            this._postToRun(run, { type: 'plan', steps, todos });
            run.plan = { steps, todos };
            run.planUpdatedIter = run._iter ?? -1;
        } else {
            this._post({ type: 'plan', steps, todos });
        }
        return 'Plan updated.';
    }

    _handleRevertLastTurn(args, run) {
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
        let msg = `Reverted ${reverted.length} file(s) to pre-turn state: ${reverted.join(', ')}`;
        if (failed.length) msg += `\nFailed to revert: ${failed.join('; ')}`;
        return msg;
    }

    // ─── spawn_agent ─────────────────────────────────────────────────────────

    _handleSpawnAgent(args, run, abortSignal) {
        // Lazy initialise SubAgentRunner on first use to avoid circular-require at boot.
        if (!this._subAgentRunner) {
            const { SubAgentRunner } = require('./sub-agent');
            this._subAgentRunner = new SubAgentRunner({
                context:   this._context,
                exec:      this,
                postToRun: this._postToRun,
            });
        }
        return this._subAgentRunner.spawn(args, run, abortSignal);
    }
}

module.exports = { ToolExecutor };
