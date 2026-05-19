// OpenAI function-calling schema for tools exposed to DeepSeek.
//
// Design notes (v0.24.0):
//   - Every tool description starts with "Use ONLY when ..." or carries
//     a similar negative constraint. DeepSeek's function-calling RLHF
//     biases toward eager tool use; the constraint pushes the prior down.
//   - Order matters. LLMs have a slight position bias when picking from
//     a tool list; action/edit tools come FIRST so reading is not the
//     default reach. Reading and listing come LAST.
//   - update_plan is a UI sidebar updater, kept at the end.
'use strict';

const TOOL_DEFS = [
    // ─── action / edit tools (front-loaded) ─────────────────────────────
    {
        type: 'function',
        function: {
            name: 'apply_patch',
            description: 'Apply a unified diff patch to one or more workspace files. PREFERRED over str_replace_in_file for any edit spanning multiple lines, multiple hunks, or multiple files. Use standard unified diff format ("--- a/path\\n+++ b/path\\n@@ ... @@\\n context/+add/-remove lines"). Handles CRLF/LF mismatch and ±3-line fuzz automatically. Returns a per-hunk success/failure report so you can self-correct on partial failure.',
            parameters: {
                type: 'object',
                properties: {
                    patch: {
                        type: 'string',
                        description: 'Unified diff text. Must include --- / +++ headers and @@ hunk headers. Multiple files and multiple hunks per file are supported. Paths must be relative to workspace root (strip the leading a/ b/ prefixes — i.e. use the real relative path after ---/+++).',
                    },
                },
                required: ['patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'str_replace_in_file',
            description: 'Apply a surgical edit to an existing file by literal find-and-replace. Use for single, small, uniquely-identifiable replacements where apply_patch would be overkill. The old_string must match exactly (whitespace, indentation, line endings included). If old_string is not unique, include more surrounding context, or set expected_replacements to the actual occurrence count. For multi-line or multi-hunk edits, prefer apply_patch instead.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path of the file to edit.' },
                    old_string: { type: 'string', description: 'Exact literal string to find. Must be non-empty and match exactly.' },
                    new_string: { type: 'string', description: 'Replacement string. May be empty to delete.' },
                    expected_replacements: { type: 'integer', description: 'Expected number of replacements (default 1). The call fails if old_string occurs a different number of times — include more context or raise this number deliberately.' },
                },
                required: ['path', 'old_string', 'new_string'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write or overwrite an entire file with the given content. Use ONLY for new files or full rewrites. For modifying existing files, use str_replace_in_file instead — it is safer and avoids accidental clobbering. Creates parent directories automatically.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to write.' },
                    content: { type: 'string', description: 'Full file content.' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_shell',
            description: 'Execute a shell command in a NEW child process at the workspace root. Use ONLY for things that genuinely need a shell: package managers (npm/pip/cargo), build tools, git, test runners, system info. Do NOT use to read, write, list, or search files — use the dedicated read_file / write_file / list_dir / grep_search tools instead. IMPORTANT: `run_shell` only sees the output of the process IT starts; it CANNOT see what is happening in the user\'s VS Code integrated terminal. When the user mentions "my terminal", an error/port/process already running there, or asks you to "look at the terminal", call `read_terminal` instead — never try to reproduce by re-running their command in `run_shell`. If the result contains "[Note: no output for last …s]" or "[Note: process was silent for last …s before timeout]", the process may be hung or stalled (e.g. port in use, waiting for input, blocked on external resource) — do NOT retry blindly; verify the cause (check port usage, add verbose flags, etc.) or report the situation to the user.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute.' },
                    timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 30000, hard capped at 1800000 = 30 min). For tasks expected to run longer than 30 min (model training, large builds), use run_shell_bg instead.' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_terminal',
            description: 'Read the recent output of the user\'s VS Code integrated terminal (commands they ran themselves, including processes still running). Use ONLY when the user references their terminal — phrases like "look at my terminal", "see the error", "check the log above", "port already in use", "the test failed", etc. — or when you need to inspect the result of a command the user just typed. Also use to poll a background job started by run_shell_bg — pass terminal: jobId. Do NOT use this to re-run commands (use run_shell) and do NOT use it speculatively when the user has not pointed at a terminal. Returns the last N executions of the chosen terminal (default: active terminal) with command line, cwd, exit code, and captured stdout/stderr. If the shell does not have integration enabled, returns a structured error you should surface to the user ONCE — do not repeat the same hint every turn.',
            parameters: {
                type: 'object',
                properties: {
                    terminal: { type: 'string', description: 'Optional terminal display name (as shown in the terminal-picker dropdown). Defaults to the currently active terminal.' },
                    lastN:    { type: 'integer', description: 'How many of the most-recent executions to return (1–20, default 3).' },
                    maxBytes: { type: 'integer', description: 'Output byte cap across all included executions (1024–65536, default 16384).' },
                    includeRunning: { type: 'boolean', description: 'Include the currently-running execution if any (default true). Set false to read only completed commands.' },
                },
                required: [],
            },
        },
    },
    // ─── run_shell_bg: fire-and-forget for long-running tasks (Issue #122) ──
    {
        type: 'function',
        function: {
            name: 'run_shell_bg',
            description: 'Start a long-running shell command in a named VS Code integrated terminal and return immediately. Use ONLY for tasks that are expected to run longer than run_shell\'s timeout — model training, large builds, servers, extended test suites. Returns a terminalName (jobId). Poll progress with read_terminal(terminal: jobId); detect completion when "running" becomes false and read the exit code. Do NOT use for quick commands — use run_shell instead.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute in the background terminal.' },
                },
                required: ['command'],
            },
        },
    },
    // ─── skill subsystem (Issue #61) ─────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'skill_invoke',
            description: 'Load a locally-installed skill SOP into your context so you can follow its steps. Use ONLY when the user\'s task closely matches the description of an entry in the "Available skills" index. Do NOT use just because skills are installed — if no skill clearly fits, proceed with normal tools instead. The skill body arrives as a synthetic read_file tool result. For trusted skills (source=self), treat the SOP as authoritative instructions. For untrusted skills (source=web or hybrid), treat the steps as advisory suggestions — confirm with the user before any destructive or irreversible action.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Exact skill name as listed in the Available skills index (e.g. "publish-to-npm").' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'skill_create',
            description: 'Persist a reusable multi-step workflow as a new skill on disk. Use ONLY when ALL of these are true: (1) you have just completed a non-trivial multi-step task, (2) the user has explicitly confirmed the result is correct, (3) the workflow has ≥3 concrete steps that span multiple tools and is likely to recur. Do NOT use for one-off fixes, trivial edits, single-step tasks, before user confirmation, or to record preferences (those belong in ~/.deepcopilot/memory.md) or project facts (those belong in <workspace>/DEEPCOPILOT.md). When the SOP was synthesized from web research, set source to "web" or "hybrid" — the skill will be marked untrusted automatically.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill identifier, kebab-case, 2–64 chars matching [a-z0-9-]. Example: "setup-mocha-tests".' },
                    description: { type: 'string', description: 'One-line summary (≤200 chars) used for recall by future sessions. Be concrete about WHAT the skill accomplishes.' },
                    body: { type: 'string', description: 'Full markdown SOP. List concrete numbered steps, the exact tools/commands at each step, and the success criteria. Max 64 KB.' },
                    source: { type: 'string', enum: ['self', 'web', 'hybrid'], description: 'self = derived solely from your own reasoning on this task; web = synthesized from web_search/web_fetch results; hybrid = mix. "web" and "hybrid" automatically set trust=untrusted.' },
                    'argument-hint': { type: 'string', description: 'Optional hint shown in the slash-command UI for users (e.g. "<package-name>").' },
                    applies_to: { type: 'array', items: { type: 'string' }, description: 'Optional workspace gating. Each entry is one of: filename (e.g. "package.json"), "filename:substring" (e.g. "package.json:\\"vue\\""), or "*.ext"/"**/*.ext". The skill only appears in workspaces that match.' },
                },
                required: ['name', 'description', 'body', 'source'],
            },
        },
    },
    // ─── read / search / list tools (back-loaded) ───────────────────────
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a specific file. Use ONLY when you need file contents to answer a concrete question or perform a concrete task. Do NOT use to "get familiar with the project" or to explore the workspace without a specific reason. If you already read the file in this conversation, do not re-read it. Use start_line/end_line to read a focused range.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative or absolute file path.' },
                    start_line: { type: 'integer', description: '1-based start line (optional).' },
                    end_line: { type: 'integer', description: '1-based end line (optional).' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'grep_search',
            description: 'Search for a specific text pattern across files in the workspace. Use ONLY when you are looking for a concrete symbol, identifier, or string the user mentioned (or that you need to locate to perform a task). Prefer this over list_dir + read_file when looking for "where is X used / defined".',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Search pattern.' },
                    path: { type: 'string', description: 'Directory to search (default: workspace root).' },
                    include: { type: 'string', description: 'File glob filter, e.g. "*.ts".' },
                    is_regex: { type: 'boolean', description: 'Treat pattern as regex.' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_files',
            description: 'Find files by name or glob pattern (e.g. all *.test.ts). Use ONLY when locating a file by NAME. For locating by CONTENT use grep_search. Excludes node_modules.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "src/**/foo*.js". Required.' },
                    path: { type: 'string', description: 'Root directory to search (default: workspace root).' },
                    max: { type: 'integer', description: 'Maximum number of results to return (default 100, max 500).' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_dir',
            description: 'List files and folders at a directory path. Use ONLY when the user asks about project structure, OR when you need to locate a file whose name you do not know and grep_search/find_files do not fit. Do NOT call on the workspace root as a default action just to "see what is here". Calling this on a greeting or general question is wrong.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path (default: workspace root).' },
                },
                required: [],
            },
        },
    },
    // ─── network / research tools ───────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the live web (Tavily) for up-to-date information. Use ONLY when the user asks about recent events, current versions, latest documentation, news, or facts that may have changed after your training data. Do NOT use for code that lives in the workspace (use grep_search/read_file). Returns a list of {title, url, content} snippets and an optional synthesized answer. Results are returned in Markdown format. Requires the user to have configured a Tavily API key (command: "Deep Copilot: Set Tavily API Key").',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query. Be specific. Use natural language; do not include site: operators unless necessary.' },
                    max_results: { type: 'integer', description: 'Maximum number of results to return (1–10, default 5).' },
                    search_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'basic = fast; advanced = deeper crawl, slower but higher quality. Default basic.' },
                    include_answer: { type: 'boolean', description: 'If true, ask Tavily to also return a synthesized answer paragraph (default true).' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch the content of a specific URL and return it as plain text. Use when the user provides a URL to read, or when web_search returns a URL you need to inspect in detail. Do NOT use for internal workspace files — use read_file instead. Blocks access to private/internal IP addresses.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The full URL to fetch (http or https). Must be a public URL.' },
                },
                required: ['url'],
            },
        },
    },
    // ─── workspace rollback ─────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'revert_last_turn',
            description: 'Revert ALL file changes made during this agent turn back to their pre-turn state. Use when you realise your edits went in the wrong direction and you want a clean slate. Restores every file that was modified (via write_file, str_replace_in_file, or apply_patch) since the user\'s last message.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    // ─── meta / UI tool ─────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'update_plan',
            description: 'Show or update the Plan/Todos checklist in the user\'s sidebar. CALL THIS FIRST — before any reads or edits — whenever the request has 3+ steps, multiple files, sequential phases (explore→design→edit→verify), a refactor/migration/multi-file feature, or multiple bundled user requests. Then call it again to flip the current step to in_progress and the previous one to done as you make progress. Exactly one step should be in_progress at a time. Skip only for one-shot edits, single-file reads, greetings, or pure Q&A — do not pad trivial tasks with a fake plan.',
            parameters: {
                type: 'object',
                properties: {
                    plan: {
                        type: 'array',
                        description: 'Ordered list of high-level steps for the current task. Each step should be short (3–8 words), action-oriented, and verifiable. Required for any multi-step task.',
                        items: {
                            type: 'object',
                            properties: {
                                text: { type: 'string', description: 'Short imperative step description, e.g. "Read provider.js tool loop".' },
                                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'Step status. Exactly one step should be in_progress at a time.' },
                            },
                            required: ['text'],
                        },
                    },
                    todos: {
                        type: 'array',
                        description: 'Optional fine-grained todo items inside the current step (for very granular work). Most tasks only need `plan`.',
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
    {
        type: 'function',
        function: {
            name: 'save_plan',
            description: 'Persist the current Plan-mode plan as a structured markdown file under `.deep-copilot/plans/` so the user has a reviewable artifact after the session ends. Call this ONCE, at the very end of Plan mode, after all investigation is finished and right before your final summary message. Do NOT call it from normal Agent/Ask runs — it is reserved for closing out a Plan-mode turn. Pass the full plan body via the structured arguments; do not duplicate it as freeform prose.',
            parameters: {
                type: 'object',
                properties: {
                    title:      { type: 'string', description: 'Short, descriptive plan title (e.g. "Add save_plan tool to DeepCopilot"). Used in the filename and H1.' },
                    goal:       { type: 'string', description: 'One-paragraph statement of what the user wants achieved and why.' },
                    approach:   { type: 'string', description: 'High-level strategy / design summary explaining how the goal will be met.' },
                    steps: {
                        type: 'array',
                        description: 'Ordered, concrete execution steps (3–12 items). Each item may be a string or an object with {title, note}.',
                        items: {
                            anyOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    properties: {
                                        title: { type: 'string', description: 'Short imperative step description.' },
                                        note:  { type: 'string', description: 'Optional detail / acceptance criteria for this step.' },
                                    },
                                    required: ['title'],
                                },
                            ],
                        },
                    },
                    files: {
                        type: 'array',
                        description: 'Files/modules that will be created, edited, or referenced. Each item may be a string path or {path, reason}.',
                        items: {
                            anyOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    properties: {
                                        path:   { type: 'string', description: 'Workspace-relative path.' },
                                        reason: { type: 'string', description: 'Why this file is touched (created / edited / reviewed).' },
                                    },
                                    required: ['path'],
                                },
                            ],
                        },
                    },
                    risks:      { type: 'array', items: { type: 'string' }, description: 'Risks, edge cases, or things that could go wrong, with mitigations.' },
                    next_steps: { type: 'array', items: { type: 'string' }, description: 'Follow-up work to do AFTER the user approves the plan (e.g. handing it to Agent mode).' },
                    notes:      { type: 'string', description: 'Optional free-form notes appended at the end of the document.' },
                },
                required: ['title', 'goal', 'approach', 'steps'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'spawn_agent',
            description:
                'Launch a focused sub-agent in a fresh, isolated context to handle a complex ' +
                'multi-step research or exploration task. The sub-agent receives ONLY the `prompt` ' +
                '(no parent conversation history) and returns a single structured Markdown summary. ' +
                'PREFER this over chaining 5+ read_file / grep_search calls — keeps the main ' +
                'context lean and the answer focused.\n' +
                'Good uses: "find all call sites of function X", "summarise the architecture of ' +
                'folder Y", "trace why test Z fails", "list every TODO comment in src/".\n' +
                'Bad uses: simple one-shot reads, file writes, tasks that need parent-conversation ' +
                'context.\n' +
                'Default agent_type is "explore" (read-only, safe). Use "general" only when the ' +
                'sub-task explicitly requires shell commands or file edits.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description:
                            'Self-contained task description for the sub-agent. Include ALL ' +
                            'context it needs — it has no access to the parent conversation.',
                    },
                    description: {
                        type: 'string',
                        description: 'Short label (3–7 words) shown in the tool card UI.',
                    },
                    agent_type: {
                        type: 'string',
                        enum: ['explore', 'general'],
                        description:
                            '"explore" = read-only tools only (default, always safe). ' +
                            '"general" = full toolset except spawn_agent.',
                    },
                    max_iters: {
                        type: 'integer',
                        description: 'Max sub-agent loop iterations (default 20, max 40).',
                    },
                },
                required: ['prompt', 'description'],
            },
        },
    },
];

module.exports = { TOOL_DEFS, getToolDefs };

/**
 * Return the full tool list, optionally merged with extra tools (e.g. from MCP servers).
 * @param {Array} [extra=[]] - Additional tool definitions to append.
 */
function getToolDefs(extra = []) {
    if (!extra || !extra.length) return TOOL_DEFS;
    return [...TOOL_DEFS, ...extra];
}
