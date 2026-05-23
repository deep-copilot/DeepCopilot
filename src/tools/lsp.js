// lsp.js — LSP-backed symbol navigation: find_references, go_to_definition.
// Delegates to VS Code's language server via executeCommand.
'use strict';

const path   = require('path');
const vscode = require('vscode');

const { resolvePath, wsRoot } = require('../utils/paths');

/**
 * Open (or re-use) a document and locate the first occurrence of `symbol`.
 * Returns { uri, position } or null.
 */
async function _findPosition(filePath, symbol) {
    let abs;
    try { abs = resolvePath(filePath); } catch { return null; }

    const uri = vscode.Uri.file(abs);
    let doc;
    try { doc = await vscode.workspace.openTextDocument(uri); } catch { return null; }

    const idx = doc.getText().indexOf(symbol);
    if (idx === -1) return null;
    return { uri, position: doc.positionAt(idx) };
}

function _relPath(fsPath) {
    const root = wsRoot();
    return root ? path.relative(root, fsPath).replace(/\\/g, '/') : fsPath;
}

/** Find all references to a symbol using the active language server. */
async function toolFindReferences(args) {
    if (!args || !args.path || !args.symbol)
        return 'Error: path and symbol are required.';

    const loc = await _findPosition(String(args.path), String(args.symbol));
    if (!loc) return `Symbol "${args.symbol}" not found in ${args.path}. Try grep_search for a text-based search.`;

    let refs;
    try {
        refs = await vscode.commands.executeCommand(
            'vscode.executeReferenceProvider', loc.uri, loc.position
        );
    } catch (e) { return `Error: ${e.message}`; }

    if (!refs || !refs.length)
        return `No references found for "${args.symbol}". (Language server may not be ready — try grep_search.)`;

    const lines = refs.map(r =>
        `  ${_relPath(r.uri.fsPath)}:${r.range.start.line + 1}:${r.range.start.character + 1}`
    );
    return `References to "${args.symbol}" (${refs.length} total):\n${lines.join('\n')}`;
}

/** Find the definition of a symbol using the active language server. */
async function toolGoToDefinition(args) {
    if (!args || !args.path || !args.symbol)
        return 'Error: path and symbol are required.';

    const loc = await _findPosition(String(args.path), String(args.symbol));
    if (!loc) return `Symbol "${args.symbol}" not found in ${args.path}. Try grep_search for a text-based search.`;

    let defs;
    try {
        defs = await vscode.commands.executeCommand(
            'vscode.executeDefinitionProvider', loc.uri, loc.position
        );
    } catch (e) { return `Error: ${e.message}`; }

    if (!defs || !defs.length)
        return `No definition found for "${args.symbol}". (Language server may not be ready — try grep_search.)`;

    const lines = defs.map(d => {
        const defUri   = d.uri   || d.targetUri;
        const defRange = d.range || d.targetSelectionRange || d.targetRange;
        const line     = defRange ? defRange.start.line + 1 : '?';
        return `  ${_relPath(defUri.fsPath)}:${line}`;
    });
    return `Definition of "${args.symbol}":\n${lines.join('\n')}`;
}

module.exports = { toolFindReferences, toolGoToDefinition };
