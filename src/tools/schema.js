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
            description: 'Execute a shell command in the workspace root. Use ONLY for things that genuinely need a shell: package managers (npm/pip/cargo), build tools, git, test runners, system info. Do NOT use to read, write, list, or search files — use the dedicated read_file / write_file / list_dir / grep_search tools instead.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute.' },
                    timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 30000).' },
                },
                required: ['command'],
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
    // ─── network / research tool ────────────────────────────────────────
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
