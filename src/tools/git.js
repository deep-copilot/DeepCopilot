// git.js — Git status / diff / log tools.
// Uses execFile (not shell), so no shell-injection risk.
'use strict';

const cp = require('child_process');

const { wsRoot }  = require('../utils/paths');
const { truncate } = require('./utils');

/**
 * Run a git command in the workspace root.
 * Returns { ok, output } — never rejects.
 */
function runGit(args, cwd) {
    return new Promise(resolve => {
        cp.execFile('git', args, { cwd, maxBuffer: 1024 * 512, timeout: 15000 }, (err, stdout, stderr) => {
            if (err && !stdout) {
                resolve({ ok: false, output: stderr || err.message });
            } else {
                resolve({ ok: true, output: stdout });
            }
        });
    });
}

/** git status --short --branch */
async function toolGitStatus() {
    const cwd = wsRoot();
    if (!cwd) return 'Error: no workspace folder open.';
    const { ok, output } = await runGit(['status', '--short', '--branch'], cwd);
    if (!ok) return `Error: ${output}`;
    return output.trim() || '(clean working tree)';
}

/** git diff [--cached] [-- path] */
async function toolGitDiff(args) {
    const cwd = wsRoot();
    if (!cwd) return 'Error: no workspace folder open.';
    const argv = ['diff'];
    if (args && args.staged) argv.push('--cached');
    if (args && args.path) argv.push('--', String(args.path));
    const { ok, output } = await runGit(argv, cwd);
    if (!ok) return `Error: ${output}`;
    return truncate(output.trim() || '(no diff)', 24000);
}

/** git log --oneline --decorate -N */
async function toolGitLog(args) {
    const cwd = wsRoot();
    if (!cwd) return 'Error: no workspace folder open.';
    const n = Math.min(50, Math.max(1, Number((args && args.n) || 10)));
    const { ok, output } = await runGit(['log', `--max-count=${n}`, '--oneline', '--decorate'], cwd);
    if (!ok) return `Error: ${output}`;
    return output.trim() || '(no commits)';
}

module.exports = { toolGitStatus, toolGitDiff, toolGitLog };
