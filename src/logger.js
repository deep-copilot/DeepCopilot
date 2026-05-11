// Records the full agent thought-chain, tool calls and API events to a log file
// so the user can share it for offline diagnosis when things hang or misbehave.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

let channel = null;
let filePath = null;
let stream = null;
let enabled = true;
let thinkingBuf = '';
let thinkingTimer = null;

function ts() { return new Date().toISOString(); }

// Remove log files older than MAX_LOG_AGE_MS from the given directory.
function _cleanOldLogs(dir) {
    const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();
    try {
        for (const entry of fs.readdirSync(dir)) {
            if (!entry.startsWith('session-') || !entry.endsWith('.log')) continue;
            const fp = path.join(dir, entry);
            try {
                if (now - fs.statSync(fp).mtimeMs > MAX_LOG_AGE_MS) fs.unlinkSync(fp);
            } catch { /* ignore individual file errors */ }
        }
    } catch { /* ignore if dir unreadable */ }
}

function safeJson(o) {
    try {
        return JSON.stringify(o, (_k, v) => {
            if (typeof v === 'string' && v.length > 4000) return v.slice(0, 4000) + `…(+${v.length - 4000} chars)`;
            return v;
        });
    } catch (e) { return String(o); }
}

function _writeRaw(line) {
    if (!enabled) return;
    try { channel && channel.appendLine(line); } catch (_) {}
    try { stream && stream.write(line + '\n'); } catch (_) {}
}

function _flushThinking() {
    if (thinkingBuf) {
        const text = thinkingBuf;
        thinkingBuf = '';
        _writeRaw(`[${ts()}] [THINK]\n${text}\n[/THINK]`);
    }
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
}

const Logger = {
    init(context) {
        try {
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            enabled = cfg.get('enableDebugLog') !== false;
        } catch (_) { enabled = true; }

        if (!channel) channel = vscode.window.createOutputChannel('Deep Copilot Debug');

        try {
            const folders = vscode.workspace.workspaceFolders;
            const root = (folders && folders[0] && folders[0].uri.fsPath)
                || (context && context.globalStorageUri && context.globalStorageUri.fsPath)
                || os.tmpdir();
            const dir = path.join(root, '.deep-copilot', 'logs');
            fs.mkdirSync(dir, { recursive: true });
            _cleanOldLogs(dir);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            filePath = path.join(dir, `session-${stamp}.log`);
            stream = fs.createWriteStream(filePath, { flags: 'a' });
            _writeRaw(`[${ts()}] [INIT] Deep Copilot debug log started. file=${filePath}`);
        } catch (e) {
            try { channel && channel.appendLine(`[INIT-FAIL] ${e.message}`); } catch (_) {}
        }
    },
    getFilePath() { return filePath; },
    getChannel() { return channel; },
    setEnabled(v) { enabled = !!v; },
    info(tag, obj) {
        _flushThinking();
        const body = obj === undefined ? '' : ' ' + (typeof obj === 'string' ? obj : safeJson(obj));
        _writeRaw(`[${ts()}] [${tag}]${body}`);
    },
    thinking(delta) {
        if (!enabled || !delta) return;
        thinkingBuf += delta;
        if (!thinkingTimer) {
            thinkingTimer = setTimeout(_flushThinking, 400);
        }
    },
    flush() { _flushThinking(); },
};

module.exports = { Logger, safeJson };
