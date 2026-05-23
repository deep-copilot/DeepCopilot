// SubAgentRunner: launches isolated read-only nested AgentLoops on behalf of
// the parent agent via the `spawn_agent` tool call.
//
// Design (mirrors GitHub Copilot's `runSubagent` pattern):
//   - Sub-agents run in the same Extension Host process (no subprocess).
//   - Each sub-agent gets a fresh, isolated messages[] — it sees ONLY the
//     `prompt` argument, never the parent conversation.
//   - Only the sub-agent's final assistant reply is returned to the parent;
//     intermediate tool calls are invisible to the parent context window.
//   - Max nesting depth = 1 (sub-agents cannot spawn sub-sub-agents).
//   - `explore` type: read-only tool whitelist only (safe, default).
//   - Parent AbortController cascades to all live children.
'use strict';

const https = require('https');
const vscode = require('vscode');
const { Logger }         = require('../logger');
const { streamChat } = require('../api/adapter');
const { getProvider } = require('../providers');
const { getToolDefs }    = require('../tools/schema');
const { mcpManager }     = require('../mcp');
const { autoCompactIfNeeded } = require('./compact');

const READ_ONLY_TOOLS = new Set([
    'read_file', 'list_dir', 'grep_search', 'find_files',
    'web_search', 'web_fetch',
    'get_diagnostics',
    'git_status', 'git_diff', 'git_log',
    'find_references', 'go_to_definition',
    'memory_read',
]);

// Maximum nesting depth — prevents fork bombs.
const MAX_SUB_DEPTH = 1;

// ─── Sub-agent system prompts ─────────────────────────────────────────────────

function buildSubAgentSystemPrompt(agentType) {
    const common = `You are a focused sub-agent of Deep Copilot. Your job is to complete ONE specific research task and return a clear, structured Markdown summary to the parent agent.

# Rules
- Work autonomously. Do not ask clarifying questions.
- Be efficient: use targeted tool calls rather than broad exploration.
- When you have enough information to answer the task, stop calling tools and write your final summary.
- Do not produce long explanations — the parent agent needs structured facts.
- Format your output as a concise Markdown summary with headers and code references where useful.

# File Reading Strategy (IMPORTANT — minimise API round-trips)
- When reading a file, use large line ranges: read at least 200 lines per call (e.g. 1-250, 251-500 …).
- For files ≤ 400 lines: read in ONE call with no start/end range (full file).
- For files 401-800 lines: read in TWO calls (1-400, 401-end).
- For files > 800 lines: read in chunks of 300 lines; you may skip boilerplate sections once you have enough context.
- Prefer grep_search to locate specific symbols rather than scanning the whole file line-by-line.`;

    if (agentType === 'explore') {
        return `${common}

# Mode: READ-ONLY (explore)
- You may ONLY use: read_file, list_dir, grep_search, find_files, web_search.
- You may NOT write files, run shell commands, or make any changes to the workspace.`;
    }

    return `${common}

# Mode: GENERAL
- You have access to the full tool set.
- Prefer read-only operations; only write or run shell commands if the task explicitly requires it.
- Apply the same caution as the parent agent: confirm before destructive actions.`;
}

// ─── SubAgentRunner ───────────────────────────────────────────────────────────

class SubAgentRunner {
    /**
     * @param {{
     *   context  : import('vscode').ExtensionContext,
     *   exec     : import('./tool-executor').ToolExecutor,
     *   postToRun: (run: object, msg: object) => void,
     * }} opts
     */
    constructor({ context, exec, postToRun }) {
        this._context   = context;
        this._exec      = exec;
        this._postToRun = postToRun || (() => {});
    }

    /**
     * Spawn a sub-agent and return its final reply as a string.
     *
     * @param {object} args         — spawn_agent tool arguments
     * @param {object} parentRun    — parent run object (for cascade-abort, cache sharing)
     * @param {AbortSignal} signal  — parent abort signal
     * @returns {Promise<string>}
     */
    async spawn(args, parentRun, signal) {
        const {
            prompt,
            description = 'sub-task',
            agent_type  = 'explore',
            max_iters   = 20,
        } = args || {};

        // ── Safety guards ──────────────────────────────────────────────────
        if ((parentRun._subDepth || 0) >= MAX_SUB_DEPTH) {
            return '[spawn_agent] Error: sub-agents cannot spawn further sub-agents (max nesting depth = 1).';
        }
        if (!prompt || !String(prompt).trim()) {
            return '[spawn_agent] Error: `prompt` argument is required and must be non-empty.';
        }

        const apiKey = await this._context.secrets.get('deepseekAgent.apiKey');
        const cfg     = vscode.workspace.getConfiguration('deepseekAgent');
        const provider = cfg.get('provider') || 'deepseek';
        const p = getProvider(provider) || getProvider('custom');
        const needsKey = !p?.noApiKey;
        if (needsKey && !apiKey) return '[spawn_agent] Error: no API key configured.';

        // Sub-agents use each provider's declared `subAgentModel` (cheaper/faster
        // variant) and fall back to `defaultModel` when none is set.
        const model = p?.subAgentModel || p?.defaultModel || 'gpt-4o';
        const baseUrl = (cfg.get('apiBaseUrl') || '').trim();

        // ── Keep-alive HTTPS agent ─────────────────────────────────────────
        // Re-use the same TLS connection for every API call in this sub-agent's
        // while-loop.  Without this, each iteration performs a full TLS handshake;
        // for a 18-iteration sub-agent that's 18 independent TLS sessions which
        // dramatically increases the probability of a mid-session socket reset.
        const keepAliveAgent = new https.Agent({
            keepAlive:           true,
            keepAliveMsecs:      10000,
            maxSockets:          1,
            scheduling:          'lifo',
        });

        const MAX_ITERS = Math.min(40, Math.max(1, Number(max_iters) || 20));
        const agentType = agent_type === 'general' ? 'general' : 'explore';

        // ── Tool list ──────────────────────────────────────────────────────
        // Exclude spawn_agent itself from the child tool list to prevent recursion
        // even if agentType === 'general'.
        const allToolDefs = getToolDefs(mcpManager.getToolDefs());
        const childTools = agentType === 'explore'
            ? allToolDefs.filter(t => READ_ONLY_TOOLS.has(t.function && t.function.name))
            : allToolDefs.filter(t => (t.function && t.function.name) !== 'spawn_agent');

        // ── Isolated child context ─────────────────────────────────────────
        const childRun = {
            sessionId:          `${parentRun.sessionId || 'anon'}::sub::${Date.now()}`,
            messages:           [],
            _subDepth:          (parentRun._subDepth || 0) + 1,
            // Share parent's read cache — sub-agent reads same workspace files; safe for R/O.
            toolCache:          parentRun.toolCache || new Map(),
            // Isolated write-snapshot map so sub-agent edits (general mode) don't pollute parent revert.
            turnSnapshots:      new Map(),
            _earlyStartedTools: new Set(),
        };

        // ── Cascade abort ──────────────────────────────────────────────────
        const childAbort = new AbortController();
        const onParentAbort = () => childAbort.abort();
        if (signal) {
            if (signal.aborted) { childAbort.abort(); }
            else signal.addEventListener('abort', onParentAbort, { once: true });
        }

        const sysPrompt = buildSubAgentSystemPrompt(agentType);
        childRun.messages.push({ role: 'user', content: String(prompt).trim() });

        Logger.info('SUB_AGENT_START', {
            parent: parentRun.sessionId,
            child:  childRun.sessionId,
            agentType,
            maxIters: MAX_ITERS,
            description,
            promptLen: String(prompt).length,
        });

        const t0 = Date.now();
        let finalText    = '';
        let toolCallsRan = 0;
        let iters        = 0;

        // ── Retry-aware streamDeepSeek wrapper ────────────────────────────
        // Transient network errors (TLS reset, ECONNRESET, ETIMEDOUT) are
        // retried up to MAX_NET_RETRIES times with exponential back-off.
        // Abort signals and non-network errors are NOT retried.
        const MAX_NET_RETRIES = 3;
        const RETRYABLE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|TLS|socket\s+hang\s+up|Client\s+network\s+socket\s+disconnected/i;
        const streamWithRetry = async (params, callbacks) => {
            let lastErr;
            for (let attempt = 0; attempt <= MAX_NET_RETRIES; attempt++) {
                if (childAbort.signal.aborted) throw new Error('aborted');
                try {
                    return await streamChat(
                        { ...params, httpAgent: keepAliveAgent },
                        callbacks,
                        childAbort.signal,
                    );
                } catch (e) {
                    lastErr = e;
                    const isNet = RETRYABLE.test(e && e.message ? e.message : String(e));
                    if (!isNet || attempt >= MAX_NET_RETRIES) throw e;
                    const backoffMs = 800 * Math.pow(2, attempt); // 800ms, 1.6s, 3.2s
                    Logger.info('SUB_AGENT_NET_RETRY', {
                        child: childRun.sessionId, attempt: attempt + 1, backoffMs, error: e.message,
                    });
                    await new Promise(r => setTimeout(r, backoffMs));
                }
            }
            throw lastErr;
        };

        try {
            const COMPACT_BUDGET = 48000; // smaller budget for sub-agents

            while (iters < MAX_ITERS) {
                iters++;

                // Light compaction to avoid context blowout in deep read tasks.
                // No LLM summarisation here — sub-agent uses a fast model and needs
                // to stay responsive; structured fact fallback is sufficient.
                const compact = await autoCompactIfNeeded(childRun.messages, COMPACT_BUDGET, 12, null);
                if (compact.compacted) {
                    childRun.messages = compact.messages;
                    Logger.info('SUB_AGENT_COMPACT', { child: childRun.sessionId, dropped: compact.dropped });
                }

                const apiMessages = [
                    { role: 'system', content: sysPrompt },
                    ...childRun.messages,
                ];

                let assistantText = '';
                let reasoningText  = ''; // must be passed back to DeepSeek in thinking mode
                const { toolCalls } = await streamWithRetry(
                    { provider, apiKey, baseUrl, messages: apiMessages, model, noTools: false, tools: childTools },
                    {
                        onDelta:    d => { assistantText += d; },
                        onThinking: d => { reasoningText  += d; }, // keep — API requires passback
                    },
                );

                if (!toolCalls || !toolCalls.length) {
                    // No more tool calls — sub-agent has finished
                    childRun.messages.push({
                        role: 'assistant',
                        content: assistantText,
                        ...(reasoningText ? { reasoning_content: reasoningText } : {}),
                    });
                    finalText = assistantText;
                    break;
                }

                childRun.messages.push({
                    role: 'assistant',
                    content: assistantText || null,
                    ...(reasoningText ? { reasoning_content: reasoningText } : {}),
                    tool_calls: toolCalls.map(tc => ({
                        id:   tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.args },
                    })),
                });

                // Execute tools in parallel — safe for read-only tools and general
                // mode (mutating tools are serialised by ToolExecutor internally).
                // Using Promise.all cuts wall-clock time when the model emits
                // multiple tool calls in one turn (e.g. reading 3 files at once).
                const toolResults = await Promise.all(toolCalls.map(async (tc) => {
                    let tcArgs = {};
                    try { tcArgs = JSON.parse(tc.args || '{}'); } catch { /* ignore */ }

                    const toolName = tc.name;
                    let result = '(tool not permitted in sub-agent context)';

                    if (agentType === 'explore' && READ_ONLY_TOOLS.has(toolName)) {
                        try {
                            // 'readonly' mode ensures no approval dialogs or writes occur
                            result = await this._exec.execute(toolName, tcArgs, 'readonly', childRun, childAbort.signal);
                            toolCallsRan++;
                        } catch (e) {
                            result = `Error: ${e.message}`;
                        }
                    } else if (agentType === 'general' && toolName !== 'spawn_agent') {
                        try {
                            result = await this._exec.execute(toolName, tcArgs, 'readonly', childRun, childAbort.signal);
                            toolCallsRan++;
                        } catch (e) {
                            result = `Error: ${e.message}`;
                        }
                    }

                    return { id: tc.id, result };
                }));

                // Push tool results in the original order (API requires tool_call_id order)
                for (const { id, result } of toolResults) {
                    childRun.messages.push({ role: 'tool', tool_call_id: id, content: String(result) });
                }
            } // end while
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            Logger.info('SUB_AGENT_ERROR', { child: childRun.sessionId, message: msg });
            if (msg !== 'aborted') {
                finalText = `[spawn_agent] Error during sub-agent execution: ${msg}`;
            } else {
                finalText = '[spawn_agent] Sub-agent was aborted.';
            }
        } finally {
            // Always destroy the keep-alive agent so the TCP socket is released
            // and doesn't linger after the sub-agent completes or fails.
            try { keepAliveAgent.destroy(); } catch { /* ignore */ }
            if (signal) {
                try { signal.removeEventListener('abort', onParentAbort); } catch { /* ignore */ }
            }
        }

        const elapsed = Date.now() - t0;
        Logger.info('SUB_AGENT_END', {
            child:      childRun.sessionId,
            elapsed_ms: elapsed,
            iters,
            tool_calls: toolCallsRan,
            finalLen:   finalText.length,
        });

        if (!finalText || !finalText.trim()) {
            return `[spawn_agent] Sub-agent produced no output after ${iters} iteration(s) and ${toolCallsRan} tool call(s).`;
        }

        // Prepend a compact metadata line so the parent agent knows what this result represents.
        return `[Sub-agent result for: ${description}]\n` +
               `(${toolCallsRan} tool calls · ${iters} iter · ${Math.round(elapsed / 100) / 10}s)\n\n` +
               finalText;
    }
}

module.exports = { SubAgentRunner, READ_ONLY_TOOLS };
