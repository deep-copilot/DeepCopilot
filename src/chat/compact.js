// Compact utilities: token estimation, history auto-compaction, and
// tool-argument streaming parser.
//
// No VS Code dependencies. Uses global `fetch` (Node 18+) only for the
// optional LLM-backed summarisation path in autoCompactIfNeeded.
// Safe to import from any layer without circular-dep risk.
'use strict';

// ─── Token estimator ───────────────────────────────────────────────────────
// CJK characters (Chinese / Japanese / Korean) tokenize at ~1.5 chars/token;
// Latin text and code at ~3.6 chars/token.
// Used only for autoCompact triggers, never for billing.

function estimateTokens(text) {
    if (!text) return 0;
    const str = String(text);
    // Unicode ranges: CJK Unified Ideographs, Hiragana/Katakana, Hangul, CJK Compatibility
    const cjkCount = (str.match(/[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) || []).length;
    const otherCount = str.length - cjkCount;
    // CJK chars: ~1 char/token (conservative: 1.0 denominator = 1 token per char);
    // Latin/code: ~3.6 chars/token.
    return Math.ceil(cjkCount / 1.0 + otherCount / 3.6);
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

// ─── Tool-result truncation ────────────────────────────────────────────────
// Truncate oversized tool results to preserve semantic content while reducing
// token count.  Non-destructive: returns new message objects; originals untouched.

const TOOL_RESULT_LONG = 2000; // chars — threshold for truncation
const TOOL_RESULT_KEEP = 500;  // chars — keep this many from the front

function truncateLongToolResults(messages) {
    let truncCount = 0;
    const result = messages.map(m => {
        if (m.role !== 'tool') return m;
        const body = typeof m.content === 'string' ? m.content
            : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('') : '');
        if (body.length <= TOOL_RESULT_LONG) return m;
        truncCount++;
        return { ...m, content: body.slice(0, TOOL_RESULT_KEEP) + `\n…[truncated — original ${body.length} chars]` };
    });
    return { messages: result, truncCount };
}

// ─── Head-facts extractor ──────────────────────────────────────────────────
// Pulls key structured events from messages about to be dropped: tool calls
// with their primary argument (file path, command, URL) and short snippets
// of assistant prose.  Used to build the compact-summary placeholder.

function extractHeadFacts(messages) {
    const lines = [];
    for (const m of messages) {
        if (m.role === 'assistant' && m.tool_calls) {
            for (const tc of m.tool_calls) {
                const name = tc.function?.name || '?';
                let detail = '';
                try {
                    const args = JSON.parse(tc.function?.arguments || '{}');
                    const target = args.path || args.file || args.file_path || args.filename
                        || args.command || args.url || '';
                    if (target) detail = ` → ${String(target).slice(0, 100)}`;
                } catch {}
                lines.push(`tool:${name}${detail}`);
            }
        }
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
            const snip = m.content.trim().slice(0, 200).replace(/\n+/g, ' ');
            lines.push(`asst:${snip}${m.content.trim().length > 200 ? '…' : ''}`);
        }
    }
    return lines;
}

// ─── LLM-backed summarisation ─────────────────────────────────────────────
// Calls the configured API to produce a concise semantic summary of the
// messages about to be dropped.  Silent failure: returns null on any error
// so the caller can fall back to the structured fact-extraction path.

async function summariseHead(headMessages, apiConfig) {
    const { apiKey, baseUrl: rawBaseUrl, model, provider = 'deepseek' } = apiConfig || {};
    if (!model) return null;

    // Resolve effective base URL from the provider registry (single source of truth).
    const { getProvider } = require('../providers');
    const presetUrl = getProvider(provider)?.baseUrl || 'https://api.deepseek.com';
    const effectiveBaseUrl = (rawBaseUrl || presetUrl).replace(/\/$/, '');

    // Build a compact text representation of the messages to summarise.
    const lines = [];
    for (const m of headMessages) {
        if (m.role === 'assistant' && m.tool_calls) {
            const names = m.tool_calls.map(tc => tc.function?.name || '?').join(', ');
            lines.push(`[assistant called: ${names}]`);
        }
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
            lines.push(`[assistant]: ${m.content.trim().slice(0, 400)}`);
        }
        if (m.role === 'tool') {
            const body = typeof m.content === 'string' ? m.content : '';
            lines.push(`[tool result]: ${body.slice(0, 300)}`);
        }
        if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
            lines.push(`[user]: ${m.content.trim().slice(0, 400)}`);
        }
    }
    const historyText = lines.join('\n');
    if (!historyText.trim()) return null;

    try {
        const url = new URL(effectiveBaseUrl + '/chat/completions');
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const resp = await fetch(url.toString(), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: 'You are a conversation summarizer. Be extremely concise.' },
                    {
                        role: 'user',
                        content:
                            'Summarize the following conversation history in ≤300 words. ' +
                            'Focus on: what files were read or modified, what problems were found, ' +
                            'what decisions were made, what code was written.\n\n' + historyText,
                    },
                ],
                max_tokens: 400,
                stream: false,
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.choices?.[0]?.message?.content?.trim() || null;
    } catch {
        return null;
    }
}

// ─── Compact-summary helpers ───────────────────────────────────────────────

function _isCompactSummary(m) {
    return m.role === 'user' && typeof m.content === 'string' && m.content.includes('<compact-summary>');
}

function _hasAttachment(m) {
    if (Array.isArray(m.content)) {
        return m.content.some(p => p && (p.type === 'file' || p.type === 'image_url'));
    }
    // Heuristic: long user messages likely contain attached file content.
    return typeof m.content === 'string' && m.content.length > 3000;
}

// ─── Auto-compaction ────────────────────────────────────────────────────────
// Strategy:
//   1. Try truncating oversized tool results first (non-destructive, no messages dropped).
//   2. If still over budget, drop the head portion of messages:
//      - Keep the most recent keepTail messages verbatim.
//      - Always keep the first user message (task anchor).
//      - Keep the most recent user message with file attachments (if any, and different).
//      - Accumulate prior compact-summaries rather than overwriting them.
//   3. Inject a structured <compact-summary> placeholder.
//   4. If apiConfig provided, attempt LLM summarisation; fall back to structured facts.
//
// Returns { messages, compacted, dropped, truncated }

async function autoCompactIfNeeded(messages, budgetTokens, keepTail = 12, apiConfig = null) {
    let working = messages;
    let truncCount = 0;

    // Step 1: truncate long tool results to recover tokens without dropping messages.
    if (estimateMessagesTokens(working) > budgetTokens) {
        const res = truncateLongToolResults(working);
        if (res.truncCount > 0) {
            working = res.messages;
            truncCount = res.truncCount;
        }
    }

    if (estimateMessagesTokens(working) <= budgetTokens) {
        return truncCount > 0
            ? { messages: working, compacted: true,  dropped: 0, truncated: truncCount }
            : { messages: working, compacted: false, dropped: 0, truncated: 0 };
    }

    // Step 2: head-drop.
    if (working.length <= keepTail + 2) {
        return { messages: working, compacted: truncCount > 0, dropped: 0, truncated: truncCount };
    }

    // Walk the split point backwards past any leading tool messages so the tail
    // never starts in the middle of a tool_calls group.  The API requires that
    // all tool result messages immediately follow their assistant{tool_calls}
    // message with no other roles interleaved between them.
    let splitIdx = working.length - keepTail;
    while (splitIdx > 0 && working[splitIdx].role === 'tool') splitIdx--;
    if (splitIdx <= 0) {
        return { messages: working, compacted: truncCount > 0, dropped: 0, truncated: truncCount };
    }

    const tail = working.slice(splitIdx);
    const head = working.slice(0, splitIdx);

    // (a) First non-summary user message — anchors the original task.
    const firstUserIdx = head.findIndex(m => m.role === 'user' && !_isCompactSummary(m));
    const firstUser = firstUserIdx >= 0 ? head[firstUserIdx] : null;

    // (b) Most recent user message with file attachments, if different from firstUser.
    let lastAttachUser = null;
    for (let i = head.length - 1; i >= 0; i--) {
        const m = head[i];
        if (m === firstUser) break;
        if (m.role === 'user' && !_isCompactSummary(m) && _hasAttachment(m)) {
            lastAttachUser = m;
            break;
        }
    }

    // (c) Accumulate text from any prior compact-summaries so history is never lost.
    const priorSummaryParts = [];
    for (const m of head) {
        if (!_isCompactSummary(m)) continue;
        const inner = String(m.content).replace(
            /[\s\S]*?<compact-summary>([\s\S]*?)<\/compact-summary>[\s\S]*/,
            '$1',
        ).trim();
        if (inner && inner !== m.content) priorSummaryParts.push(inner);
    }

    const kept = new Set([firstUser, lastAttachUser].filter(Boolean));
    const toDropMsgs = head.filter(m => !kept.has(m) && !_isCompactSummary(m));
    const dropped = head.length - kept.size - head.filter(_isCompactSummary).length;

    // Step 3: produce summary content — LLM first, structured fallback.
    let summaryBody = '';
    if (apiConfig && toDropMsgs.length > 0) {
        const llmText = await summariseHead(toDropMsgs, apiConfig);
        if (llmText) summaryBody = llmText;
    }
    if (!summaryBody) {
        const factLines = extractHeadFacts(toDropMsgs);
        summaryBody = `${dropped} messages dropped`;
        if (truncCount > 0) summaryBody += `, ${truncCount} tool results truncated`;
        if (factLines.length > 0) summaryBody += `.\nKey events:\n${factLines.join('\n')}`;
    }

    // Prepend accumulated prior summaries so nothing is silently lost across rounds.
    if (priorSummaryParts.length > 0) {
        summaryBody = `Prior compactions:\n${priorSummaryParts.join('\n---\n')}\n\nThis compaction:\n${summaryBody}`;
    }

    const summary = {
        role: 'user',
        content:
            `<system-reminder>\n<compact-summary>\n${summaryBody}\n</compact-summary>\n` +
            `Refer to the user's most recent messages for current intent.\n</system-reminder>`,
    };

    const out = [];
    if (firstUser) out.push(firstUser);
    if (lastAttachUser) out.push(lastAttachUser);
    out.push(summary);
    out.push(...tail);
    return { messages: out, compacted: true, dropped, truncated: truncCount };
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

module.exports = { estimateTokens, estimateMessagesTokens, autoCompactIfNeeded, summariseHead, ToolArgsStreamer };
