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

/**
 * Strip filesystem-hostile characters and trim length.
 * Removed character classes:
 *   - `\ / : * ? " < > |` are reserved on Windows.
 *   - `\u0000-\u001f` covers C0 control codes (NUL, newlines, tabs, ESC, …),
 *     which corrupt filenames and can be abused for terminal injection when
 *     the path is later printed to a log.
 * Leading dots are also stripped so we never produce a hidden file (`.foo`)
 * or a relative-path escape (`..`).
 */
function _safeTitle(raw) {
    const s = String(raw || '').trim();
    if (!s) return 'untitled';
    const cleaned = s
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '_')
        .replace(/\s+/g, ' ')
        .trim()
        // Windows: Win32 APIs strip/normalise trailing spaces and dots from
        // path components, which turns "foo ." / "foo " into "foo" silently
        // — or rejects the write outright. Strip them ourselves so the
        // on-disk name matches what we report back to the user and the
        // collision counter in _writeUnique can’t be defeated.
        .replace(/[. ]+$/, '');
    return (cleaned || 'untitled').slice(0, 60).replace(/[. ]+$/, '') || 'untitled';
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
        // Always quote string values: bare YAML scalars like `true`,
        // `2026-05-26`, `null`, `123` would be coerced to bool/date/null/
        // number by any YAML parser, silently corrupting the exported
        // metadata if a session title or model name happens to match one
        // of those forms. Numbers stay bare because their identity is
        // preserved either way and bare numerics read more naturally.
        if (typeof v === 'number' && Number.isFinite(v)) {
            lines.push(`${k}: ${v}`);
        } else {
            lines.push(`${k}: ${JSON.stringify(String(v))}`);
        }
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
 * Collapse newlines/tabs/control chars in a session title down to a single
 * space before it is injected into a Markdown `# ...` heading. Without this,
 * a title that contains "\n" (e.g. taken from the first user message or a
 * pasted rename) would split the heading and break the document structure.
 */
function _safeHeadingTitle(raw) {
    return String(raw || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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

    const heading = _safeHeadingTitle(session.title) || t('sessionUntitled');
    const parts = [head, `# ${heading}`, ''];
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

    // Compose the document. We intentionally do NOT run a global
    // `\n{3,}` collapse here — that would mutate verbatim user/assistant
    // text and break formatting inside fenced code blocks. Instead, each
    // section pushes its own controlled trailing blank line.
    return parts.join('\n').trimEnd() + '\n';
}

/**
 * Sentinel returned by `_pickWorkspaceRoot` when the user explicitly
 * dismissed the multi-root workspace folder picker. We MUST distinguish this
 * from the "no workspace open" case (returns `null`): in the cancel case we
 * should abort the archive cleanly, not silently fall back to a save dialog
 * (which would happily let the user save outside any workspace).
 */
const PICK_CANCELLED = Symbol('pick-cancelled');

/**
 * Pick the target workspace folder.
 *   - 0 folders → returns `null` (caller falls back to save dialog).
 *   - 1 folder  → returns its fsPath.
 *   - 2+        → returns the picked fsPath, or `PICK_CANCELLED` if the
 *                user dismissed the picker.
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
    return picked ? picked.uri.fsPath : PICK_CANCELLED;
}

/**
 * Reserve a non-colliding path AND write content atomically through an
 * exclusive handle. `fs.open(..., 'wx')` closes the TOCTOU window that an
 * `fs.access` pre-check would leave open (two concurrent archive clicks in
 * the same second could otherwise pick the same name).
 *
 * Writing through the exclusive handle — rather than reserving an empty
 * placeholder and then re-opening with `fs.writeFile` — prevents zero-byte
 * residue when the write itself fails (disk full / permission revoked
 * mid-write). On error we close the handle and `unlink` the placeholder so
 * subsequent archives don't skip the now-orphaned name.
 */
async function _writeUnique(dir, baseName, content) {
    const ext = '.md';
    const stem = baseName.replace(/\.md$/i, '');
    for (let i = 0; i < 1000; i++) {
        const candidate = path.join(dir, i === 0 ? stem + ext : `${stem}-${i}${ext}`);
        let handle;
        try {
            handle = await fs.open(candidate, 'wx');
        } catch (err) {
            if (err && err.code === 'EEXIST') continue;
            throw err;
        }
        try {
            await handle.writeFile(content, 'utf8');
            await handle.close();
            return candidate;
        } catch (writeErr) {
            // Close best-effort, then remove the empty/partial placeholder.
            try { await handle.close(); } catch { /* ignore */ }
            try { await fs.unlink(candidate); } catch { /* ignore */ }
            throw writeErr;
        }
    }
    // Extremely unlikely (1000 same-second collisions); bail out with a
    // timestamped name and a regular write — still safer than overwriting.
    const fallback = path.join(dir, `${stem}-${Date.now()}${ext}`);
    await fs.writeFile(fallback, content, { encoding: 'utf8', flag: 'wx' });
    return fallback;
}

/**
 * Resolve the destination path, then write the markdown.
 * Returns the absolute path written, or `null` if:
 *   - the user cancelled the multi-root workspace folder picker, OR
 *   - the user cancelled the save dialog in the no-workspace fallback.
 * Throws on filesystem errors so the caller can surface a friendly message.
 */
async function exportSessionToMarkdown(session) {
    const md = renderSessionMarkdown(session);
    const fileName = `${_timestamp()}-${_safeTitle(session.title)}.md`;

    const root = await _pickWorkspaceRoot(session.ws);
    if (root === PICK_CANCELLED) return null;  // user dismissed the picker
    if (root) {
        const archiveDir = path.join(root, ARCHIVE_SUBDIR);
        // Defence in depth: even though fileName is sanitised, verify the
        // resolved path stays inside the chosen root before writing.
        const resolved = path.resolve(archiveDir, fileName);
        const rel = path.relative(root, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            // i18n'd, user-facing — see archiveErrEscape in src/utils/i18n.js.
            throw new Error(t('archiveErrEscape'));
        }
        await fs.mkdir(archiveDir, { recursive: true });
        return await _writeUnique(archiveDir, fileName, md);
    }

    // No workspace open — ask the user where to put it. `Uri.file()` requires
    // an absolute path: passing a bare filename resolves to a confusing
    // location (drive root on Windows, `/` on POSIX). Anchor the default at
    // the user's home so the dialog opens somewhere predictable.
    const os = require('os');
    const uri = await vscode.window.showSaveDialog({
        saveLabel: t('archiveSaveLabel'),
        filters: { Markdown: ['md'] },
        defaultUri: vscode.Uri.file(path.join(os.homedir(), fileName)),
    });
    if (!uri) return null;
    await fs.writeFile(uri.fsPath, md, 'utf8');
    return uri.fsPath;
}

module.exports = { exportSessionToMarkdown, renderSessionMarkdown };
