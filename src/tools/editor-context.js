// editor-context.js — read the active editor state (open file, cursor, selection, tabs).
// Safe, read-only, synchronous calls only — no file I/O.
'use strict';

const path   = require('path');
const vscode = require('vscode');

const { wsRoot } = require('../utils/paths');

/**
 * Return active editor state as a JSON string:
 *   active_file, language, cursor_line/col, selected_text, open_files.
 */
async function toolGetEditorContext() {
    const editor = vscode.window.activeTextEditor;
    const out    = {};

    if (editor) {
        const doc  = editor.document;
        const sel  = editor.selection;
        const root = wsRoot();

        out.active_file  = root
            ? path.relative(root, doc.fileName).replace(/\\/g, '/')
            : doc.fileName;
        out.language     = doc.languageId;
        out.total_lines  = doc.lineCount;
        out.cursor_line  = sel.active.line + 1;
        out.cursor_col   = sel.active.character + 1;

        if (!sel.isEmpty) {
            out.selection_start_line = sel.start.line + 1;
            out.selection_end_line   = sel.end.line + 1;
            out.selected_text        = doc.getText(sel).slice(0, 4000);
        }
    } else {
        out.active_file = null;
        out.note        = 'No file is currently open in the editor.';
    }

    // Collect open file paths from all tab groups (VS Code ≥ 1.71)
    const openFiles = [];
    try {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input && tab.input.uri) {
                    const root = wsRoot();
                    const rel  = root
                        ? path.relative(root, tab.input.uri.fsPath).replace(/\\/g, '/')
                        : tab.input.uri.fsPath;
                    if (!openFiles.includes(rel)) openFiles.push(rel);
                }
            }
        }
    } catch {
        // tabGroups API not available on this VS Code version
    }
    out.open_files = openFiles;

    return JSON.stringify(out, null, 2);
}

module.exports = { toolGetEditorContext };
