// Export a chat session to a Markdown file under the workspace.
//
// Issue #165: the right-click "📦 Archive" action used to be a soft hide
// (toggle `archived` flag). Users expected real archiving — a Markdown
// snapshot they can grep, commit, or share. This module renders the
// session record to Markdown and writes it under
// `<workspace>/.deepcopilot/archives/yyyyMMdd-HHmmss-<title>.md`.
//
// Edge cases handled:
//   - No workspace open      → fall back to vscode.window.showSaveDialog.
//   - Multi-root workspace   → showWorkspaceFolderPick to choose target.
//   - Path traversal         → resolved path must stay under chosen root
//                              (defence in depth even though titles are
//                              already sanitised).
//   - Name collision         → append "-1", "-2", … suffix.
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs/promises');
const { t } = require('../utils/i18n');

const ARCHIVE_SUBDIR = '.deepcopilot/archives';

/** Strip filesystem-hostile characters and trim length. */
function _safeTitle(raw) {
    const s = String(raw || '').trim();
    if (!s) return 'untitled';
    // Forbidden on Windows: \ / : * ? " < > |  — plus control chars.
    // Also drop leading dots so we never produce a hidden file.
    const cleaned = s
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '_')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || 'untitled').slice(0, 60);
}

/** "20260526-143012" — local time, fixed-width, sortable. */
function _timestamp(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
        d.getFullYear().toString() +
        pad(d.getMonth() + 1) +
        pad(d.getDate()) +
        '-' +
        pad(d.getHours()) +
        pad(d.getMinutes()) +
        pad(d.getSeconds())
    );
}

/** Render YAML frontmatter from primitive key/value pairs. */
function _frontmatter(meta) {
    const lines = ['---'];
    for (const [k, v] of Object.entries(meta)) {
        if (v == null || v === '') continue;
        // YAML-safe: quote strings containing colons or leading whitespace.
        const s = String(v);
        const needsQuote = /[:#\n]/.test(s) || /^\s/.test(s);
        lines.push(`${k}: ${needsQuote ? JSON.stringify(s) : s}`);
    }
    lines.push('---', '');
    return lines.join('\n');
}

/** Wrap reasoning/thoughts in a collapsible <details> block. */
function _renderThoughts(thoughts) {
    if (!thoughts) return '';
    return [
        '<details>',
        `<summary>${t('archiveThoughtsLabel')}</summary>`,
        '',
        thoughts.trim(),
        '',
        '</details>',
        '',
    ].join('\n');
}

/**
 * Render a session record to a Markdown string.
 * The record shape mirrors what SessionStore.append() persists:
 *   { id, title, createdAt, updatedAt, model, mode, ws, msgCount,
 *     messages: [{ role: 'user'|'assistant', text, thoughts? }, ...] }
 */
function renderSessionMarkdown(session) {
    const created = session.createdAt ? new Date(session.createdAt).toISOString() : '';
    const updated = session.updatedAt ? new Date(session.updatedAt).toISOString() : '';
    const archived = new Date().toISOString();

    const head = _frontmatter({
        sessionId: session.id || '',
        title: session.title || '',
        createdAt: created,
        updatedAt: updated,
        archivedAt: archived,
        model: session.model || '',
        mode: session.mode || '',
        messageCount: session.msgCount || (session.messages || []).length,
        workspace: session.ws || '',
    });

    const parts = [head, `# ${session.title || t('sessionUntitled')}`, ''];
    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (const m of messages) {
        if (!m) continue;
        if (m.role === 'user') {
            parts.push(`### 🧑 ${t('archiveRoleUser')}`, '', String(m.text || '').trim(), '');
        } else if (m.role === 'assistant') {
            parts.push(`### 🤖 ${t('archiveRoleAssistant')}`, '');
            const thoughts = _renderThoughts(m.thoughts);
            if (thoughts) parts.push(thoughts);
            const body = String(m.text || '').trim();
            if (body) parts.push(body, '');
        } else {
            // Defensive: render unknown roles verbatim so nothing is silently lost.
            parts.push(`### ${m.role || 'message'}`, '', String(m.text || '').trim(), '');
        }
    }

    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * Pick the target workspace folder. Returns the folder fsPath or null.
 *   - 0 folders → null (caller falls back to save dialog).
 *   - 1 folder  → use it.
 *   - 2+        → prompt the user.
 * @param {string} sessionWs — the workspace the session was created in; used
 *   as a strong hint to skip the picker in multi-root scenarios.
 */
async function _pickWorkspaceRoot(sessionWs) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    if (folders.length === 1) return folders[0].uri.fsPath;
    if (sessionWs) {
        const match = folders.find((f) => f.uri.fsPath === sessionWs);
        if (match) return match.uri.fsPath;
    }
    const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: t('archivePickWorkspace'),
    });
    return picked ? picked.uri.fsPath : null;
}

/** Find a non-colliding path by appending "-1", "-2", … before ".md". */
async function _uniquePath(dir, baseName) {
    const ext = '.md';
    const stem = baseName.replace(/\.md$/i, '');
    let candidate = path.join(dir, stem + ext);
    for (let i = 1; i < 1000; i++) {
        try {
            await fs.access(candidate);
        } catch {
            return candidate;
        }
        candidate = path.join(dir, `${stem}-${i}${ext}`);
    }
    // Extremely unlikely; bail out with a timestamped name.
    return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/**
 * Resolve the destination path, then write the markdown.
 * Returns the absolute path written, or null if the user cancelled the
 * save dialog in the no-workspace fallback.
 * Throws on filesystem errors so the caller can surface a friendly message.
 */
async function exportSessionToMarkdown(session) {
    const md = renderSessionMarkdown(session);
    const fileName = `${_timestamp()}-${_safeTitle(session.title)}.md`;

    const root = await _pickWorkspaceRoot(session.ws);
    let target;
    if (root) {
        const archiveDir = path.join(root, ARCHIVE_SUBDIR);
        // Defence in depth: even though fileName is sanitised, verify the
        // resolved path stays inside the chosen root before writing.
        const resolved = path.resolve(archiveDir, fileName);
        const rel = path.relative(root, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error('Resolved archive path escapes the workspace root.');
        }
        await fs.mkdir(archiveDir, { recursive: true });
        target = await _uniquePath(archiveDir, fileName);
    } else {
        // No workspace open — ask the user where to put it.
        const uri = await vscode.window.showSaveDialog({
            saveLabel: t('archiveSaveLabel'),
            filters: { Markdown: ['md'] },
            defaultUri: vscode.Uri.file(fileName),
        });
        if (!uri) return null;
        target = uri.fsPath;
    }

    await fs.writeFile(target, md, 'utf8');
    return target;
}

module.exports = { exportSessionToMarkdown, renderSessionMarkdown };
