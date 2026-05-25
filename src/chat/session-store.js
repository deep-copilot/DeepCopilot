// SessionStore: persistence layer for all chat sessions.
// Owns sessionId (current foreground session), CRUD via VS Code globalState,
// and the auto-naming heuristic.
//
// Dependencies: vscode, i18n. Never imports provider or agent-loop.
'use strict';

const vscode = require('vscode');
const { randomBytes } = require('crypto');
const { t } = require('../utils/i18n');

// ─── Orphan tool_calls sanitizer ───────────────────────────────────────────
// Removes ANY incomplete assistant{tool_calls} group from a message array,
// regardless of position (head / middle / tail).
//
// DeepSeek/OpenAI Chat Completions require every `assistant` message that
// declares `tool_calls` to be IMMEDIATELY followed by a contiguous block of
// `tool` messages — one per declared `tool_call_id`. If any id is missing
// (or the block is interrupted by a non-tool message), the API returns
// HTTP 400 "insufficient tool messages following tool_calls message".
//
// Earlier versions only fixed orphan groups at the very tail (issue #70).
// Issue #145 showed that history compaction, truncation, or a mid-turn crash
// can also produce orphans in the MIDDLE of the array — those slipped past
// the old tail-only check and corrupted every subsequent turn.
//
// Algorithm (single forward pass):
//   - Skip any leading orphan `tool` messages.
//   - On each `assistant` with non-empty `tool_calls`:
//       1. Collect the expected `tool_call_id` set.
//       2. Walk forward consuming the contiguous `tool` block, recording the
//          ids actually present.
//       3. If every expected id is present → keep the whole group.
//          Otherwise → drop the assistant message AND the (partial) tool
//          block that followed it. The next iteration resumes at the first
//          non-tool message after the dropped block.
//   - All other messages pass through unchanged.
//
// Returns a NEW array. Original input is never mutated.
function _dropOrphanToolCallGroups(msgs) {
    if (!Array.isArray(msgs) || msgs.length === 0) return msgs;
    const out = [];
    let i = 0;
    // Skip leading orphan tool messages.
    while (i < msgs.length && msgs[i].role === 'tool') i++;
    while (i < msgs.length) {
        const m = msgs[i];
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            const expectedIds = m.tool_calls.map(tc => tc && tc.id).filter(Boolean);
            const expectedSet = new Set(expectedIds);
            // Walk forward through the contiguous tool block.  We accept ONLY
            // tool messages whose tool_call_id belongs to expectedIds; extras
            // (unknown id, duplicate id, missing id) are dropped even when the
            // group is otherwise complete — leaving them would re-introduce
            // the exact HTTP 400 this sanitizer is meant to prevent.
            let j = i + 1;
            const seenIds = new Set();
            const acceptedToolBlock = [];
            while (j < msgs.length && msgs[j].role === 'tool') {
                const tid = msgs[j].tool_call_id;
                if (tid && expectedSet.has(tid) && !seenIds.has(tid)) {
                    seenIds.add(tid);
                    acceptedToolBlock.push(msgs[j]);
                }
                // tool messages with missing / unknown / duplicate ids are
                // silently dropped from the block.
                j++;
            }
            const complete = expectedIds.length > 0 && expectedIds.every(id => seenIds.has(id));
            if (complete) {
                out.push(m);
                for (const t of acceptedToolBlock) out.push(t);
            }
            // If incomplete, drop both the assistant and its partial tool block.
            i = j;
            continue;
        }
        // Orphan `tool` message mid-stream (assistant{tool_calls} above was
        // already dropped, or it never existed). Skip it — keeping it would
        // re-introduce the same HTTP 400.
        if (m.role === 'tool') { i++; continue; }
        out.push(m);
        i++;
    }
    return out;
}

class SessionStore {
    /**
     * @param {vscode.Memento}  globalState
     * @param {{
     *   getCurrentWs : () => string,
     *   post         : (msg: object) => void,
     *   getBusy      : (id: string) => boolean,
     *   onDeleteRun  : (id: string) => void,
     * }} opts
     */
    constructor(globalState, { getCurrentWs, post, getBusy, onDeleteRun }) {
        this._gs         = globalState;
        this._getCurrentWs = getCurrentWs;  // () => workspace root path
        this._post       = post;            // (msg) => void  (direct webview send)
        this._getBusy    = getBusy;         // (id) => bool   (is that session's run busy?)
        this._onDeleteRun = onDeleteRun;    // (id) => void   (abort + remove from _runs)
        this.sessionId   = null;            // currently displayed session id (null = empty view)
    }

    // ─── Raw storage ────────────────────────────────────────────────────────

    all() {
        return this._gs.get('deepseekAgent.sessions', []);
    }

    async set(list) {
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        if (list.length > 100) list = list.slice(0, 100);
        await this._gs.update('deepseekAgent.sessions', list);
    }

    // ─── Session list broadcast ─────────────────────────────────────────────

    postList() {
        this._post({
            type: 'sessions',
            currentWs: this._getCurrentWs(),
            items: this.all().filter(s => !s.archived).map(s => ({
                id: s.id, title: s.title, preview: s.preview, msgCount: s.msgCount,
                model: s.model, mode: s.mode, ws: s.ws || '',
                createdAt: s.createdAt, updatedAt: s.updatedAt,
                busy: this._getBusy(s.id),
                pinned: !!s.pinned, unread: !!s.unread,
            })),
            activeId: this.sessionId,
        });
    }

    // ─── Session lifecycle ──────────────────────────────────────────────────

    /** Ensure a session exists and return its id. Creates one if needed. */
    async ensure(initialUserText) {
        if (this.sessionId) return this.sessionId;
        const id = 's_' + Date.now().toString(36) + '_' + randomBytes(2).toString('hex');
        const list = this.all();
        list.unshift({
            id,
            title: (initialUserText || t('sessionUntitled')).slice(0, 15),
            createdAt: Date.now(), updatedAt: Date.now(),
            ws: this._getCurrentWs(),
            messages: [], preview: '', msgCount: 0,
        });
        this.sessionId = id;
        await this.set(list);
        this.postList();
        return id;
    }

    /** Return persisted API-format messages for cross-turn context restore. */
    loadApiMessages(sid) {
        const s = this.all().find(x => x.id === sid);
        if (!s || !Array.isArray(s.apiMessages)) return [];
        // Self-heal legacy sessions: drop ANY orphan `assistant{tool_calls}`
        // group (head, middle, or tail) plus any orphan `tool` messages.
        // See issues #70 and #145 — a mid-array orphan was the missing case
        // that the old tail-only sanitizer could not repair, causing every
        // subsequent API call on that session to fail with HTTP 400.
        return _dropOrphanToolCallGroups(s.apiMessages);
    }

    /**
     * Append one completed turn to a session record.
     * @param {string}   sid
     * @param {string}   userText
     * @param {string}   asstText
     * @param {string}   thoughts
     * @param {object}   usage        — { prompt_tokens, completion_tokens, cost_cny, … }
     * @param {object[]} apiMessages  — full API-format history to persist
     */
    async append(sid, userText, asstText, thoughts, usage, apiMessages) {
        if (!sid) return;
        // Issue #142 P3-1: allow apiMessages-only updates (used by the
        // /compact command which persists a compacted history without
        // adding a new user/assistant turn).
        if (!userText && !asstText && apiMessages === undefined) return;
        const list = this.all();
        let s = list.find(x => x.id === sid);
        if (!s) {
            s = {
                id: sid,
                title: (userText || t('sessionUntitled')).slice(0, 15),
                createdAt: Date.now(), updatedAt: Date.now(),
                ws: this._getCurrentWs(), messages: [],
            };
            list.unshift(s);
        } else if (!s.ws) {
            s.ws = this._getCurrentWs();
        }

        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        s.model = cfg.get('defaultModel') || 'deepseek-v4-pro';
        s.mode  = cfg.get('approvalMode') || 'manual';

        if (userText) s.messages.push({ role: 'user', text: userText });
        if (asstText || thoughts) s.messages.push({ role: 'assistant', text: asstText || '', thoughts: thoughts || '' });
        if (s.messages.length > 200) s.messages = s.messages.slice(-200);

        if (apiMessages !== undefined) {
            const MAX_API = 200;
            // reasoning_content is intentionally kept here.  Stripping it at
            // persist time caused HTTP 400 ("reasoning_content must be passed
            // back") when a session was reloaded after a VS Code restart —
            // the in-memory run was gone, messages came back from storage
            // without the field, and DeepSeek rejected the next turn.
            // sanitizeMessages() in adapter.js already handles per-model
            // stripping at API-call time, so we don't need to do it here.
            const messagesToPersist = Array.isArray(apiMessages) ? [...apiMessages] : [];
            // Truncate to the last MAX_API messages, but never start with an
            // orphan `tool` message — DeepSeek requires every tool message to
            // follow its assistant{tool_calls}. See issue #70.
            let sanitized = messagesToPersist;
            if (messagesToPersist.length > MAX_API) {
                let startIdx = messagesToPersist.length - MAX_API;
                while (startIdx < messagesToPersist.length && messagesToPersist[startIdx].role === 'tool') {
                    startIdx++;
                }
                sanitized = messagesToPersist.slice(startIdx);
            }
            // Drop ANY orphan assistant{tool_calls} group (head/middle/tail)
            // so a mid-turn interruption or a slice-induced split never
            // persists a broken sequence. See issue #145.
            sanitized = _dropOrphanToolCallGroups(sanitized);

            // Issue #142 P0-3: token-aware pre-compaction before persistence.
            // Without this, a "full" session is reloaded as-is on next open and
            // immediately bumps into the context limit again.  We aim for ~40%
            // of the model's window so the next turn has plenty of headroom.
            try {
                const { getModel, resolveModel } = require('../providers');
                const { autoCompactIfNeeded, estimateMessagesTokens } = require('./compact');
                const provider = cfg.get('provider') || 'deepseek';
                const modelName = cfg.get('defaultModel') || 'deepseek-v4-pro';
                const modelCfg  = getModel(provider, resolveModel(provider, modelName)) || { contextWindow: 65536 };
                const persistBudget = Math.floor(modelCfg.contextWindow * 0.4);
                if (estimateMessagesTokens(sanitized) > persistBudget) {
                    const res = await autoCompactIfNeeded(sanitized, persistBudget, 12, null);
                    if (res && res.compacted) {
                        // Compaction itself may slice through a tool_calls block;
                        // run the full-array sanitizer rather than tail-only.
                        sanitized = _dropOrphanToolCallGroups(res.messages);
                    }
                }
            } catch (_e) {
                // Silent failure — never block persistence on compaction error.
            }

            s.apiMessages = sanitized;
        }

        const last = s.messages[s.messages.length - 1];
        s.preview   = (last && last.text || '').replace(/\s+/g, ' ').slice(0, 80);
        s.msgCount  = s.messages.length;
        s.updatedAt = Date.now();

        if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
            s.totals = s.totals || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_cny: 0, turns: 0 };
            s.totals.prompt_tokens     += Number(usage.prompt_tokens     || 0);
            s.totals.completion_tokens += Number(usage.completion_tokens || 0);
            s.totals.total_tokens      += Number(usage.total_tokens      || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
            s.totals.cost_cny          += Number(usage.cost_cny          || 0);
            s.totals.turns             += 1;
        }

        await this.set(list);
        this.postList();
    }

    // ─── Session commands (webview → extension) ─────────────────────────────

    async load(id, opts = {}) {
        const s = this.all().find(x => x.id === id);
        if (!s) return;
        this.sessionId = s.id;
        // Include busy flag so the webview only restores the spinner for
        // sessions that are genuinely still running (not stale timer entries).
        this._post({ type: 'sessionLoaded', id: s.id, messages: s.messages || [], busy: !!opts.busy });
        this.postList();
        // Return buffered run events so the caller can replay them.
        return id;
    }

    async newSession() {
        this.sessionId = null;
        this._post({ type: 'sessionLoaded', id: null, messages: [] });
        this.postList();
    }

    async delete(id) {
        this._onDeleteRun(id); // let provider abort + remove run
        let list = this.all().filter(x => x.id !== id);
        if (this.sessionId === id) this.sessionId = null;
        await this.set(list);
        this.postList();
        if (!this.sessionId) this._post({ type: 'sessionLoaded', id: null, messages: [] });
    }

    async rename(id, title) {
        const list = this.all();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.title = String(title || '').slice(0, 80) || s.title;
        s.updatedAt = Date.now();
        await this.set(list);
        this.postList();
    }

    // Issue #142 P3-5: deep-clone an existing session under a new id.  The
    // resulting session has its own message history; subsequent edits do not
    // affect the original.  Caller may pass a custom title.
    async fork(id, title) {
        const list = this.all();
        const src = list.find(x => x.id === id);
        if (!src) return null;
        const clone = JSON.parse(JSON.stringify(src));
        // Use crypto.randomBytes for fork id rather than Math.random to satisfy
        // CodeQL js/insecure-randomness, though session ids are not security-critical.
        let _rand4 = '0000';
        try {
            const _crypto = require('crypto');
            _rand4 = _crypto.randomBytes(2).toString('hex');
        } catch { /* fallback only if node:crypto unavailable */ }
        // Keep id shape consistent with ensure(): `s_<ts>_<rand>` (Copilot
        // review feedback on PR #144).
        clone.id = `s_${Date.now().toString(36)}_${_rand4}`;
        clone.title = String(title || `${src.title || 'Fork'} (fork)`).slice(0, 80);
        clone.createdAt = Date.now();
        clone.updatedAt = Date.now();
        clone.pinned = false;
        delete clone.busy;
        list.unshift(clone);
        await this.set(list);
        this.sessionId = clone.id;
        this._post({ type: 'sessionLoaded', id: clone.id, messages: clone.messages || [] });
        this.postList();
        return clone.id;
    }

    async pin(id) {
        const list = this.all();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.pinned = !s.pinned;
        await this.set(list);
        this.postList();
    }

    async unread(id) {
        const list = this.all();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.unread = !s.unread;
        await this.set(list);
        this.postList();
    }

    async archive(id) {
        const list = this.all();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.archived = !s.archived;
        if (this.sessionId === id && s.archived) {
            this.sessionId = null;
            this._post({ type: 'sessionLoaded', id: null, messages: [] });
        }
        await this.set(list);
        this.postList();
    }

    // ─── Auto-naming ────────────────────────────────────────────────────────

    /**
     * Attempt to name a session from its first turn.
     * @param {() => Promise<string>} getApiKey
     * @param {() => string}          getApiBase
     */
    async maybeAutoName(sid, userText, asstText, getApiKey, getApiBase) {
        const list = this.all();
        const s = list.find(x => x.id === sid);
        if (!s) return;
        if (s.msgCount > 2) return; // only name on first turn
        const originalPrefix = (userText || '').slice(0, 40);
        if (s.title && s.title !== originalPrefix && s.title !== t('sessionUntitled')) return;

        let title = null;

        // LLM-powered title (tiny non-streaming call).
        try {
            const apiKey = await getApiKey();
            if (apiKey) title = await this._llmTitle(apiKey, getApiBase(), userText, asstText);
        } catch (_) { /* fall through */ }

        // Heuristic fallback.
        if (!title) {
            const stripCode = (txt) => String(txt || '')
                .replace(/```[\s\S]*?```/g, ' ')
                .replace(/`[^`]*`/g, ' ');
            const firstSentence = (txt) => {
                const cleaned = stripCode(txt).replace(/\s+/g, ' ').trim();
                if (!cleaned) return '';
                const m = cleaned.match(/^(.{8,80}?)([。.!?！？\n]|$)/);
                return m ? m[1].trim() : cleaned.slice(0, 60);
            };
            title = firstSentence(asstText);
            if (title.length < 8) title = firstSentence(userText);
            title = title.slice(0, 15).trim();
        }

        if (!title) return;
        s.title = title;
        s.updatedAt = Date.now();
        await this.set(list);
        this.postList();
    }

    /** Fire a tiny non-streaming API call to get a ≤15-char session title. */
    async _llmTitle(apiKey, baseUrl, userText, asstText) {
        const https = require('https');
        const http  = require('http');
        const base  = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
        const urlObj = new URL('/chat/completions', base);
        const isHttps = urlObj.protocol === 'https:';

        const strip = (t) => String(t || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`[^`]*`/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300);

        const prompt =
            '请用不超过10个汉字概括下方对话的主题，只输出标题，不加任何标点和解释：\n' +
            `用户：${strip(userText)}\n助手：${strip(asstText)}`;

        const body = JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            stream: false, max_tokens: 20, temperature: 0.3,
        });

        return new Promise((resolve) => {
            const mod = isHttps ? https : http;
            const req = mod.request({
                hostname: urlObj.hostname,
                port:     urlObj.port || (isHttps ? 443 : 80),
                path:     urlObj.pathname + (urlObj.search || ''),
                method:   'POST',
                headers: {
                    'Authorization':  `Bearer ${apiKey}`,
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 8000,
            }, (res) => {
                let raw = '';
                res.on('data', (d) => { raw += d; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(raw);
                        const text = (data?.choices?.[0]?.message?.content || '').trim();
                        const clean = text
                            .replace(/["""''「」『』【】《》<>（）()\[\]{}\.\!\?。！？，,、；;：:\-—\s]/g, '')
                            .slice(0, 15);
                        resolve(clean || null);
                    } catch (_) { resolve(null); }
                });
            });
            req.on('error',   () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { SessionStore, _dropOrphanToolCallGroups };
