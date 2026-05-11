// Shared helpers used by multiple tool modules.
// - truncate: cap output to bound LLM context spend
// - ensurePathAllowed: workspace boundary enforcement (with user-approval cache)
//
// Keep this file small — only add things needed by ≥2 tool sub-modules.
'use strict';

const vscode = require('vscode');
const { t } = require('../utils/i18n');

// ─── Output truncation ───────────────────────────────────────────────────────

const MAX_OUTPUT = 32000;

function truncate(text, max = MAX_OUTPUT) {
    if (typeof text !== 'string') text = String(text);
    if (text.length <= max) return text;
    const headLen = Math.floor(max * 0.6);
    const tailLen = Math.floor(max * 0.3);
    const dropped = text.length - headLen - tailLen;
    return `${text.slice(0, headLen)}\n\n... [${dropped} chars truncated] ...\n\n${text.slice(text.length - tailLen)}`;
}

// ─── Workspace boundary ──────────────────────────────────────────────────────
// Paths approved for out-of-workspace access are cached per extension session.
// The set survives reloads but not a full VS Code restart.

const _outsideWsApprovals = new Set();

async function ensurePathAllowed(absPath, intent /* 'read' | 'write' */) {
    const { isInsideWorkspace } = require('../utils/paths');
    if (isInsideWorkspace(absPath)) return true;
    if (_outsideWsApprovals.has(absPath)) return true;
    try {
        const choice = await vscode.window.showWarningMessage(
            `${t('pathOutsideWsConfirm')}\n\n${absPath}\n\n(${intent})`,
            { modal: true },
            t('dangerAllowOnce'),
            t('dangerDeny'),
        );
        if (choice === t('dangerAllowOnce')) {
            _outsideWsApprovals.add(absPath);
            return true;
        }
    } catch { /* fall through */ }
    return false;
}

module.exports = { truncate, ensurePathAllowed };
