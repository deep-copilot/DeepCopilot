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
            name: 'str_replace_in_file',
            description: 'Apply a surgical edit to an existing file by literal find-and-replace. Use this for editing existing files. The old_string must match exactly (whitespace, indentation, line endings included). If old_string is not unique, include more surrounding context, or set expected_replacements to the actual occurrence count. Prefer this over write_file for any edit that is not a full rewrite.',
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
    // ─── meta / UI tool ─────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'update_plan',
            description: 'Update the Plan and Todos panels visible to the user in the sidebar. Use ONLY for non-trivial multi-step tasks where the user benefits from seeing the breakdown. Do not use for one-shot edits or simple questions.',
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

module.exports = { TOOL_DEFS };
