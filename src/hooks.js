// Pre/post tool execution hooks for Deep Copilot.
//
// Config file: <workspace>/.deepcopilot/hooks.json  OR  deepcopilot.hooks.json
//
// Schema:
//   {
//     "hooks": [
//       {
//         "event":      "after_tool",         // "before_tool" | "after_tool"
//         "tool":       "write_file",          // optional — specific tool, or omit / "*" for all
//         "run":        "npm test --reporter=dot", // shell command to execute
//         "async":      false,                 // fire-and-forget if true (default false)
//         "on_failure": "inject_error",        // "inject_error" | "ignore" (default "ignore")
//         "timeout_ms": 30000                  // command timeout ms (default 30000)
//       }
//     ]
//   }
//
// Example — auto-run tests after every file edit:
//   { "hooks": [{ "event": "after_tool", "tool": "write_file", "run": "npm test", "on_failure": "inject_error" }] }
'use strict';

const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

const HOOK_CONFIG_CANDIDATES = [
    '.deepcopilot/hooks.json',
    'deepcopilot.hooks.json',
];

/** Load hooks array from workspace config file. Returns [] if not found/invalid. */
function loadHooks(wsRootPath) {
    if (!wsRootPath) return [];
    for (const rel of HOOK_CONFIG_CANDIDATES) {
        try {
            const p = path.join(wsRootPath, rel);
            if (!fs.existsSync(p)) continue;
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (Array.isArray(raw.hooks)) return raw.hooks;
        } catch { /* ignore parse errors */ }
    }
    return [];
}

/** Execute a shell command and return combined stdout+stderr. */
function execCmd(cmd, cwd, timeoutMs) {
    return new Promise((resolve, reject) => {
        cp.exec(cmd, { cwd, timeout: timeoutMs, shell: true }, (err, stdout, stderr) => {
            const combined = (stdout || '') + (stderr || '');
            if (err) {
                const e = new Error(err.message);
                e.output = combined;
                reject(e);
            } else {
                resolve(combined);
            }
        });
    });
}

/**
 * Run hooks matching the given event and tool name.
 * @param {string} event       - 'before_tool' or 'after_tool'
 * @param {string} toolName    - Name of the tool being executed
 * @param {string} wsRootPath  - Absolute workspace root path
 * @returns {Promise<string>}  - Output to inject into the tool result (empty = nothing)
 */
async function runHooks(event, toolName, wsRootPath) {
    const hooks = loadHooks(wsRootPath);
    if (!hooks.length) return '';

    const matching = hooks.filter(h =>
        h.event === event &&
        (!h.tool || h.tool === toolName || h.tool === '*')
    );
    if (!matching.length) return '';

    const outputs = [];
    for (const hook of matching) {
        if (!hook.run) continue;
        const timeout = Number(hook.timeout_ms) || 30000;

        if (hook.async) {
            // Fire-and-forget — do not block or collect output
            execCmd(hook.run, wsRootPath, timeout).catch(() => {});
            continue;
        }

        try {
            const out = (await execCmd(hook.run, wsRootPath, timeout)).trim();
            if (out) outputs.push(`[hook: ${hook.run}]\n${out.slice(0, 2000)}`);
        } catch (e) {
            if (String(hook.on_failure) === 'inject_error') {
                const errOut = e.output ? e.output.trim().slice(0, 500) : '';
                outputs.push(`[hook: ${hook.run}] FAILED: ${e.message}${errOut ? '\n' + errOut : ''}`);
            }
        }
    }
    return outputs.join('\n\n');
}

module.exports = { runHooks };
