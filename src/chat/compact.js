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
//
// Strategy (Issue #142 P0-4 / P1-1): keep HEAD + TAIL with omitted-middle marker.
// Head preserves prelude (file header, command echo, first error); tail preserves
// the conclusive part (exit code, last error, summary line).

const TOOL_RESULT_LONG      = 2000; // chars — threshold for truncation
const TOOL_RESULT_KEEP_HEAD = 1200; // chars — keep from the front
const TOOL_RESULT_KEEP_TAIL = 400;  // chars — keep from the end
// nuclearCompact uses inline 800/200 head/tail values; the earlier constants
// were never read — removed to satisfy CodeQL js/useless-assignment-to-local.

function _truncateBody(body, headKeep, tailKeep) {
    const total = body.length;
    if (total <= headKeep + tailKeep + 80) return body;
    const head = body.slice(0, headKeep);
    const tail = body.slice(total - tailKeep);
    const omitted = total - headKeep - tailKeep;
    return `${head}\n…[truncated — ${omitted} chars omitted, original ${total} chars]…\n${tail}`;
}

// ─── Structure-aware truncation (Issue #142 P1-1) ──────────────────────────
// Inspect the tool name and apply the strategy best suited to its output:
//   - grep_search    : dedup duplicate file:line entries, cap to N hits
//   - list_dir       : keep first/last entries with omitted-middle hint
//   - find_files     : same as list_dir
//   - read_file      : preserve numbered head + tail (line-aware)
//   - run_shell      : preserve error-bearing lines + tail (exit code lives there)
//   - default        : generic head + tail body truncation
//
// Returns a (possibly identical) body string.
function _smartTruncateByTool(body, toolName, headKeep, tailKeep) {
    if (body.length <= headKeep + tailKeep + 80) return body;
    const lines = body.split('\n');
    const totalLines = lines.length;

    if (toolName === 'grep_search') {
        // Dedup by (file:line) prefix, keep first occurrence.
        const seen = new Set();
        const deduped = [];
        for (const ln of lines) {
            const key = ln.match(/^([^:]+:\d+):/);
            const k = key ? key[1] : ln;
            if (seen.has(k)) continue;
            seen.add(k);
            deduped.push(ln);
            if (deduped.length >= 80) break; // hard cap
        }
        const out = deduped.join('\n');
        if (deduped.length < totalLines) {
            return `${out}\n…[${totalLines - deduped.length} duplicate/extra matches dropped — original ${totalLines} lines]`;
        }
        return _truncateBody(out, headKeep, tailKeep);
    }

    if (toolName === 'list_dir' || toolName === 'find_files') {
        // Keep first 40 + last 20 entries.
        if (totalLines <= 80) return _truncateBody(body, headKeep, tailKeep);
        const headLines = lines.slice(0, 40);
        const tailLines = lines.slice(-20);
        return [
            ...headLines,
            `… [${totalLines - 60} entries omitted from middle, original ${totalLines}]`,
            ...tailLines,
        ].join('\n');
    }

    if (toolName === 'read_file') {
        // Numbered-line aware: bias head heavier (often holds imports / class signatures).
        return _truncateBody(body, Math.floor(headKeep * 1.4), tailKeep);
    }

    if (toolName === 'run_shell' || toolName === 'run_shell_bg' || toolName === 'read_terminal') {
        // Error-aware: extract lines containing error markers; combine with tail.
        const errLines = [];
        for (const ln of lines) {
            if (/error|fail|exception|traceback|panic|fatal/i.test(ln)) {
                errLines.push(ln);
                if (errLines.length >= 30) break;
            }
        }
        const tail = lines.slice(-30).join('\n');
        const errBlock = errLines.length ? `[error lines]\n${errLines.join('\n')}\n\n` : '';
        const combined = `${errBlock}…[${totalLines} total lines — only errors + tail shown]…\n[tail]\n${tail}`;
        // If still larger than budget, fall back to generic truncation.
        return combined.length <= headKeep + tailKeep + 200
            ? combined
            : _truncateBody(combined, headKeep, tailKeep);
    }

    return _truncateBody(body, headKeep, tailKeep);
}

// Build a Map<tool_call_id, tool_name> by walking assistant{tool_calls}
// messages.  Used so tool result messages can be truncated using the
// appropriate per-tool strategy.
function _buildToolIdNameMap(messages) {
    const map = new Map();
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (tc && tc.id && tc.function && tc.function.name) {
                    map.set(tc.id, tc.function.name);
                }
            }
        }
    }
    return map;
}

function truncateLongToolResults(messages, opts = {}) {
    const headKeep = opts.headKeep || TOOL_RESULT_KEEP_HEAD;
    const tailKeep = opts.tailKeep || TOOL_RESULT_KEEP_TAIL;
    const threshold = opts.threshold || TOOL_RESULT_LONG;
    const idToName = _buildToolIdNameMap(messages);
    let truncCount = 0;
    const result = messages.map(m => {
        if (m.role !== 'tool') return m;
        const body = typeof m.content === 'string' ? m.content
            : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('') : '');
        if (body.length <= threshold) return m;
        truncCount++;
        const toolName = m.tool_call_id ? idToName.get(m.tool_call_id) : null;
        const newBody = _smartTruncateByTool(body, toolName, headKeep, tailKeep);
        return { ...m, content: newBody };
    });
    return { messages: result, truncCount };
}

// Truncate ANY oversized message body (user / assistant / tool).  Used by the
// nuclear path and by autoCompactIfNeeded's last-resort branch when even the
// firstUser anchor or tail messages are individually too large to fit.
function _truncateAnyLongMessage(m, headKeep, tailKeep, threshold) {
    if (typeof m.content === 'string') {
        if (m.content.length <= threshold) return m;
        return { ...m, content: _truncateBody(m.content, headKeep, tailKeep) };
    }
    if (Array.isArray(m.content)) {
        const newContent = m.content.map(p => {
            if (p && typeof p.text === 'string' && p.text.length > threshold) {
                return { ...p, text: _truncateBody(p.text, headKeep, tailKeep) };
            }
            return p;
        });
        return { ...m, content: newContent };
    }
    return m;
}

// ─── File-read deduplication (Issue #142 P1-3) ─────────────────────────────
// When the same file path is read multiple times in a session, all but the
// LAST occurrence are replaced with a tiny placeholder.  The latest read is
// always the most up-to-date snapshot, so older copies waste tokens.
//
// Detection: walks assistant{tool_calls} entries where function.name is
// `read_file` (or list_dir / web_fetch) with a `path` (or `url`) argument.
// The matching tool result message (by tool_call_id) gets its content
// replaced.  Returns { messages, replaced }.
function dedupRepeatedReads(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { messages, replaced: 0 };
    }
    // Build (tool_call_id → {key, name}) for repeatable read tools.
    const idMeta = new Map();
    for (const m of messages) {
        if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        for (const tc of m.tool_calls) {
            const name = tc?.function?.name;
            if (!name || !tc.id) continue;
            if (name !== 'read_file' && name !== 'web_fetch' && name !== 'list_dir') continue;
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
            const target = args.path || args.url || args.file || args.file_path;
            if (!target) continue;
            // Range-aware key for read_file: same path + range is the "same read".
            const range = (args.start_line || args.end_line)
                ? `:${args.start_line || ''}-${args.end_line || ''}`
                : '';
            idMeta.set(tc.id, { key: `${name}::${target}${range}`, name });
        }
    }
    // Find the LAST tool_call_id for each key.
    const lastIdForKey = new Map();
    for (const m of messages) {
        if (m.role !== 'tool' || !m.tool_call_id) continue;
        const meta = idMeta.get(m.tool_call_id);
        if (!meta) continue;
        lastIdForKey.set(meta.key, m.tool_call_id);
    }
    // Replace any non-last tool message body with a placeholder.
    let replaced = 0;
    const out = messages.map(m => {
        if (m.role !== 'tool' || !m.tool_call_id) return m;
        const meta = idMeta.get(m.tool_call_id);
        if (!meta) return m;
        const lastId = lastIdForKey.get(meta.key);
        if (!lastId || lastId === m.tool_call_id) return m;
        const body = typeof m.content === 'string' ? m.content : '';
        if (body.length < 400) return m; // not worth replacing small ones
        replaced++;
        return {
            ...m,
            content: `[deduped — this ${meta.name} of "${meta.key.split('::')[1]}" was re-read later in the conversation; see the later tool result for current contents]`,
        };
    });
    return { messages: out, replaced };
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
    const { apiKey, baseUrl: rawBaseUrl, model, provider = 'deepseek', focus } = apiConfig || {};
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
                            'what decisions were made, what code was written.' +
                            (focus ? `\n\nIMPORTANT — bias the summary toward: ${focus}` : '') +
                            '\n\n' + historyText,
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

    // Step 0 (Issue #142 P1-3): dedup repeated file reads — cheap, lossless
    // (latest copy preserved), runs before token measurement.
    if (estimateMessagesTokens(working) > budgetTokens * 0.8) {
        const ded = dedupRepeatedReads(working);
        if (ded.replaced > 0) {
            working = ded.messages;
            truncCount += ded.replaced;
        }
    }

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
    // (Issue #142 P0-1) When the message array is too short to head-drop but we
    // are still over budget, fall through to a body-truncation pass below so a
    // single oversized message (e.g. a 100KB read_file or huge first user prompt)
    // can still be brought back under budget.
    if (working.length <= keepTail + 2) {
        const fitted = _bodyTruncateUntilFits(working, budgetTokens);
        if (fitted.changed) {
            return { messages: fitted.messages, compacted: true, dropped: 0, truncated: truncCount + fitted.count };
        }
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

    let out = [];
    if (firstUser) out.push(firstUser);
    if (lastAttachUser) out.push(lastAttachUser);
    out.push(summary);
    out.push(...tail);

    // Issue #142 P0-1: if STILL over budget after head-drop (typical when
    // firstUser or the tail contains a huge attachment / read_file payload),
    // perform body-truncation on the kept messages so we never return with
    // tokens > budget when there is content we could shrink.
    if (estimateMessagesTokens(out) > budgetTokens) {
        const fitted = _bodyTruncateUntilFits(out, budgetTokens);
        if (fitted.changed) {
            out = fitted.messages;
            truncCount += fitted.count;
        }
    }
    return { messages: out, compacted: true, dropped, truncated: truncCount };
}

// ─── Body-truncate fallback ────────────────────────────────────────────────
// Walk messages from longest to shortest, progressively tightening head/tail
// keep limits until total tokens fit under `budgetTokens` or we hit the
// minimum floor.  Used by autoCompactIfNeeded when head-dropping cannot
// reduce the working set further (single oversized message, or first-user
// anchor that exceeds budget on its own).
function _bodyTruncateUntilFits(messages, budgetTokens) {
    const tiers = [
        { head: 1200, tail: 400, threshold: 2000 },
        { head: 600,  tail: 200, threshold: 1200 },
        { head: 300,  tail: 120, threshold: 600  },
        { head: 200,  tail: 80,  threshold: 400  },
        { head: 100,  tail: 40,  threshold: 200  },
    ];
    let cur = messages;
    let changed = false;
    let count = 0;
    for (const tier of tiers) {
        if (estimateMessagesTokens(cur) <= budgetTokens) break;
        const next = cur.map(m => {
            // Apply to ANY role — tool / user / assistant — when content is large.
            // The firstUser anchor is intentionally NOT exempt at this stage:
            // an oversized first message would otherwise lock us out forever.
            const truncated = _truncateAnyLongMessage(m, tier.head, tier.tail, tier.threshold);
            if (truncated !== m) count++;
            return truncated;
        });
        if (next.some((m, i) => m !== cur[i])) {
            cur = next;
            changed = true;
        }
    }
    return { messages: cur, changed, count };
}

// ─── Nuclear compaction ────────────────────────────────────────────────────
// Last-resort path used when the emergency keepTail ladder still leaves us
// over the model's hard context limit.  Drops EVERYTHING except:
//   - The first user message (heavily truncated to 800 chars)
//   - An aggregated <compact-summary> stub
//   - The most recent user message (the current intent)
// Any in-flight assistant{tool_calls} / tool result groups are discarded —
// the cost of nuclear is losing the current turn's tool history, but the
// session is preserved and the user can continue talking.
//
// Returns the rebuilt messages array (sync, no API call).
function nuclearCompact(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    // Find first non-summary user message — task anchor.
    let firstUser = null;
    for (const m of messages) {
        if (m.role === 'user' && !_isCompactSummary(m)) { firstUser = m; break; }
    }

    // Find most recent non-summary user message — current intent.
    let lastUser = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' && !_isCompactSummary(m)) { lastUser = m; break; }
    }

    // Aggregate any existing compact-summary text so prior compactions are not
    // silently erased.
    const priorSummaryParts = [];
    for (const m of messages) {
        if (!_isCompactSummary(m)) continue;
        const raw = typeof m.content === 'string' ? m.content : '';
        const inner = raw.replace(
            /[\s\S]*?<compact-summary>([\s\S]*?)<\/compact-summary>[\s\S]*/,
            '$1',
        ).trim();
        if (inner && inner !== raw) priorSummaryParts.push(inner);
    }

    // Truncate firstUser content aggressively (head 800 / tail 200) so that
    // even a 100KB first attachment cannot lock the session.
    let truncatedFirstUser = firstUser;
    if (firstUser) {
        truncatedFirstUser = _truncateAnyLongMessage(firstUser, 800, 200, 1200);
    }

    const summaryBody = (priorSummaryParts.length > 0
        ? `Prior compactions:\n${priorSummaryParts.join('\n---\n')}\n\n`
        : '')
        + `Emergency nuclear compaction applied — interim history discarded to fit the context window. `
        + `Only the original task and the user's most recent message are retained.`;

    const summary = {
        role: 'user',
        content:
            `<system-reminder>\n<compact-summary>\n${summaryBody}\n</compact-summary>\n` +
            `Refer to the user's most recent message for current intent.\n</system-reminder>`,
    };

    const out = [];
    if (truncatedFirstUser) out.push(truncatedFirstUser);
    out.push(summary);
    if (lastUser && lastUser !== firstUser) {
        // Also truncate lastUser body if it is itself huge.
        out.push(_truncateAnyLongMessage(lastUser, 1200, 400, 2000));
    }
    return out;
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

module.exports = {
    estimateTokens, estimateMessagesTokens,
    autoCompactIfNeeded, summariseHead, nuclearCompact, dedupRepeatedReads,
    ToolArgsStreamer,
};
