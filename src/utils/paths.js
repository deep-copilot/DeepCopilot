// Workspace path helpers.
'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');

function wsRoot() {
    const f = vscode.workspace.workspaceFolders;
    return (f && f[0] && f[0].uri.fsPath) || os.homedir();
}

/**
 * Expand a leading "~" (or "~/", "~\") to the user's home directory.
 * Returns the original string when no expansion applies. We intentionally
 * do NOT support "~user" since Node has no portable accessor for it.
 * Issue #94: paths from skill discovery / synthetic injections may carry
 * a literal "~" prefix, and `path.isAbsolute` returns false for those on
 * Windows, causing them to be joined with the workspace root incorrectly.
 */
function expandHome(p) {
    if (typeof p !== 'string' || !p) return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

function resolvePath(p) {
    if (!p) return wsRoot();
    const expanded = expandHome(p);
    if (path.isAbsolute(expanded)) return expanded;
    return path.join(wsRoot(), expanded);
}

/**
 * Test whether `absPath` is lexically contained by `rootPath`. Uses
 * path.relative so platform-specific normalization (case-insensitive on
 * Windows, drive-letter handling) is delegated to Node. Symlinks are not
 * resolved — following them to escape the boundary is itself a signal we
 * want to flag at the caller.
 */
function _isContainedBy(absPath, rootPath) {
    if (!rootPath) return false;
    const rel = path.relative(rootPath, absPath);
    if (!rel) return true; // exact root
    if (rel.startsWith('..')) return false;
    if (path.isAbsolute(rel)) return false; // different drive on Windows
    return true;
}

/**
 * Find the workspace folder that contains `absPath`.
 *
 * Issue #97: in a multi-root workspace, the first folder is not the only
 * valid root. Callers that need to label a file relative to its owning
 * folder (e.g. chat context chips) must walk *all* `workspaceFolders` and
 * pick the one that lexically contains the path. Returns `null` when the
 * path is outside every folder (an "external" file).
 *
 * @param {string} absPath
 * @returns {{ folder: import('vscode').WorkspaceFolder, rel: string } | null}
 */
function findContainingFolder(absPath) {
    if (!absPath) return null;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    // Iterate longest-first so that nested folders win over their parents
    // (rare, but possible when a user adds both a repo and one of its
    // subdirectories as roots).
    const sorted = [...folders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);
    for (const folder of sorted) {
        const root = folder.uri.fsPath;
        if (_isContainedBy(absPath, root)) {
            const rel = path.relative(root, absPath).replace(/\\/g, '/');
            return { folder, rel };
        }
    }
    return null;
}

/**
 * Determine whether `absPath` is inside *any* workspace folder.
 * Multi-root aware (#97).
 */
function isInsideWorkspace(absPath) {
    return findContainingFolder(absPath) !== null;
}

module.exports = { wsRoot, resolvePath, isInsideWorkspace, expandHome, findContainingFolder };
