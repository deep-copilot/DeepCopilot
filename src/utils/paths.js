// Workspace path helpers.
'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');

function wsRoot() {
    const f = vscode.workspace.workspaceFolders;
    return (f && f[0] && f[0].uri.fsPath) || os.homedir();
}

function resolvePath(p) {
    if (!p) return wsRoot();
    if (path.isAbsolute(p)) return p;
    return path.join(wsRoot(), p);
}

/**
 * Determine whether `absPath` is inside the workspace root (or equal to it).
 * Uses path.relative + safe start checks so symbolic resolution does not
 * matter — we only consider lexical containment, since following symlinks
 * to escape the workspace is itself a signal we want to flag.
 */
function isInsideWorkspace(absPath) {
    const root = wsRoot();
    if (!root) return false;
    const rel = path.relative(root, absPath);
    if (!rel) return true; // exact root
    if (rel.startsWith('..')) return false;
    if (path.isAbsolute(rel)) return false; // different drive on Windows
    return true;
}

module.exports = { wsRoot, resolvePath, isInsideWorkspace };
