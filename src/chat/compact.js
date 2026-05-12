// Compact utilities: token estimation, history auto-compaction, and
// tool-argument streaming parser.
//
// Pure module — no VS Code or Node built-in dependencies beyond String/Array.
// Safe to import from any layer without circular-dep risk.
'use strict';

// ─── Token estimator ───────────────────────────────────────────────────────
// Approx ~3.6 chars/token (conservative for English + code; CJK is denser
// but DeepSeek's vocab matches this closely). Used only for autoCompact
// triggers, never for billing.

function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 3.6);
}

function estimateMessagesTokens(messages) {
    let n = 0;
    for (const m of messages) {
        if (typeof m.content === 'string') n += estimateTokens(m.content);
        else if (Array.isArray(m.content)) {
            for (const p of m.content) if (p && typeof p.text === 'string') n += estimateTokens(p.text);
        }
        if (m.tool_calls) for (const tc of m.tool_calls) n += estimateTokens(tc.function?.arguments || '');
        n += 8; // role + structural overhead
    }
    return n;
}

// ─── Auto-compaction ────────────────────────────────────────────────────────
// Compact older tool messages when the conversation grows too large.
// Strategy (Claude-Code style, simplified):
//   - Keep the most recent KEEP_TAIL messages verbatim.
//   - Replace older tool result bodies with a compact placeholder.
//   - Always keep the FIRST user message (anchors the task).

function autoCompactIfNeeded(messages, budgetTokens, keepTail = 12) {
    const total = estimateMessagesTokens(messages);
    if (total <= budgetTokens) return { messages, compacted: false, dropped: 0 };

    const KEEP_TAIL = keepTail;
    if (messages.length <= KEEP_TAIL + 2) return { messages, compacted: false, dropped: 0 };

    const tail = messages.slice(-KEEP_TAIL);
    const head = messages.slice(0, -KEEP_TAIL);

    const firstUserIdx = head.findIndex(m => m.role === 'user');
    const firstUser = firstUserIdx >= 0 ? head[firstUserIdx] : null;

    let droppedToolBytes = 0;
    let droppedAsstChars = 0;
    let droppedUserChars = 0;
    for (const m of head) {
        if (m === firstUser) continue;
        if (m.role === 'tool')      droppedToolBytes  += String(m.content || '').length;
        else if (m.role === 'assistant') droppedAsstChars += String(m.content || '').length;
        else if (m.role === 'user')  droppedUserChars += String(m.content || '').length;
    }

    const dropped = head.length - (firstUser ? 1 : 0);
    const summary = {
        role: 'user',
        content:
            `<system-reminder>\nEarlier conversation auto-compacted to fit the context window. ` +
            `Original first user message preserved above. ${dropped} earlier messages summarised: ` +
            `${droppedAsstChars} chars assistant text, ${droppedUserChars} chars user text, ` +
            `${droppedToolBytes} chars tool output. Refer to the user's most recent messages for current intent.\n</system-reminder>`,
    };

    const out = [];
    if (firstUser) out.push(firstUser);
    out.push(summary);
    out.push(...tail);
    return { messages: out, compacted: true, dropped };
}

// ─── ToolArgsStreamer ───────────────────────────────────────────────────────
// Incrementally extracts `path` and the body of `content` (or `new_string` /
// `new_content` / `text`) fields from a tool-call arguments JSON string that
// arrives in chunks. Lets us surface "Editing foo.py" the instant the path
// field is finished streaming and forward the file body as it streams —
// mirroring GitHub Copilot's live-edit preview.

class ToolArgsStreamer {
    constructor() {
        this.acc = '';
        this.pathEmitted = false;
        this.path = '';
        this.inContent = false;
        this.contentEnded = false;
        this.contentReadPos = 0;
        this.escapePending = false;
    }

    feed(chunk) {
        this.acc += chunk;
        const out = { newPath: null, contentDelta: '' };

        if (!this.pathEmitted) {
            const m = this.acc.match(/"(?:path|file|file_path|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m) {
                let p;
                try { p = JSON.parse('"' + m[1] + '"'); } catch { p = m[1]; }
                this.pathEmitted = true;
                this.path = p;
                out.newPath = p;
            }
        }

        if (!this.inContent && !this.contentEnded) {
            const sm = this.acc.match(/"(?:content|new_string|new_content|text)"\s*:\s*"/);
            if (sm) {
                this.inContent = true;
                this.contentReadPos = sm.index + sm[0].length;
            }
        }

        if (this.inContent && !this.contentEnded) {
            let i = this.contentReadPos;
            let buf = '';
            const len = this.acc.length;
            while (i < len) {
                if (this.escapePending) {
                    const c = this.acc[i];
                    let resolved = c;
                    if      (c === 'n') resolved = '\n';
                    else if (c === 't') resolved = '\t';
                    else if (c === 'r') resolved = '\r';
                    else if (c === '"') resolved = '"';
                    else if (c === '\\') resolved = '\\';
                    else if (c === '/') resolved = '/';
                    else if (c === 'b') resolved = '\b';
                    else if (c === 'f') resolved = '\f';
                    else if (c === 'u') {
                        if (i + 4 >= len) break;
                        const hex = this.acc.slice(i + 1, i + 5);
                        const code = parseInt(hex, 16);
                        resolved = Number.isNaN(code) ? '' : String.fromCharCode(code);
                        i += 4;
                    }
                    buf += resolved;
                    this.escapePending = false;
                    i++;
                    continue;
                }
                const c = this.acc[i];
                if (c === '\\') {
                    if (i + 1 >= len) break;
                    this.escapePending = true;
                    i++;
                    continue;
                }
                if (c === '"') { this.contentEnded = true; i++; break; }
                buf += c;
                i++;
            }
            this.contentReadPos = i;
            out.contentDelta = buf;
        }

        return out;
    }
}

module.exports = { estimateTokens, estimateMessagesTokens, autoCompactIfNeeded, ToolArgsStreamer };
