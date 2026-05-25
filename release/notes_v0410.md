# Deep Copilot v0.41.0

> 中文版在下方 / English notes below.

## 🇨🇳 中文

主题：**Context Window 优化套件 · 三个新斜杠命令 · 底部 Context Ring · 会话切换闪屏修复**

### ✨ 新功能 1：上下文窗口管理重构（Issue #142）

长对话越来越容易吃满 token 窗口，0.41.0 把"上下文管理"做成了一套完整的机制：

- **结构感知截断（structure-aware truncation）**
  - 保留最新工具调用的**完整内容**
  - 较旧的轮次自动折叠为"摘要骨架"（保留语义，丢弃大段冗余）
- **同文件读取去重**
  - 多次读取同一路径时，**只保留最后一次完整内容**
  - 较早的读取被折叠为占位符：`<file path=... read-collapsed='true'/>`
- **滚动摘要（rolling summary）**
  - 超阈值时按需调用模型，把更早的对话压缩为结构化摘要节点
  - 会话历史持久化层（`session-store.js`）已适配，重新加载会话能正确回放摘要节点
- **MCP per-server opt-out**：可以为某个 MCP server 显式关闭上下文压缩参与
- **大文件读取提示**：`file-read.js` 在读取大文件时附带 `read-large-file` hint，引导模型先用 grep 而非整文件读入

### ✨ 新功能 2：三个新斜杠命令

| 命令 | 说明 |
|---|---|
| `/compact [focus]` | 立即压缩当前会话历史；`[focus]` 可选，作为摘要方向偏置；会自动合并工作区根目录下的 `.deepcopilot/compact.md` 或 `CLAUDE.md` 中的项目级 compact 指令 |
| `/context` | 弹出当前会话的 token 占用细分（system / messages / tools / files / hints） |
| `/fork [name]` | 把当前会话从某一条消息派生为一个**新会话**，保留该消息之前的全部上下文作为起点 |

### ✨ 新功能 3：底部 Context Ring 指示器

- 替换原本底栏右下角的状态点（`#foot .dot`）
- 新的环形进度（`#ft-ctx`）实时显示上下文窗口占用百分比
- 颜色按阈值渐变：`<60%` 绿 → `<85%` 黄 → `<100%` 橙 → 满 红
- 点击环形展开 popover，显示与 `/context` 一致的占用细分
- 数据源：agent-loop 每轮回写的 `ctxUsage` 事件

### 🐞 修复：会话切换闪屏 / 滚动条抖动（Issue #143）

切走再切回正在运行的会话时，缓冲事件被同步全部重放，每个事件触发一次 `requestAnimationFrame` 滚动，导致：

- 聊天面板明显闪烁
- 滚动条来回抖动
- 重放期间用户无法稳定阅读

**修复手法**：

- `_loadSession` 用 `setTimeout(..., 0)` 把事件重放推到下一个宏任务
- 重放序列由 `replayStart` / `replayEnd` 信封包裹
- Webview 端新增 `_replaying` 标志，在重放期间 `ascroll()` 静默
- 重放结束时一次性滚到底部，体验与单条事件流入一致

### 🛠 内部改动

- `src/chat/agent-loop.js` / `src/chat/provider.js`：上下文窗口管理主逻辑、`ctxUsage` 事件源
- `src/chat/compact.js`：滚动摘要 + `/compact` 实现
- `src/chat/context-refs.js`：`/context` token 细分
- `src/chat/session-store.js`：摘要节点的持久化与回放
- `src/tools/file-read.js`：大文件 hint 输出
- `src/api/anthropic-client.js` / `src/api/openai-client.js`：客户端小幅清理
- `src/errors.js`：错误文案微调
- `media/chat.{css,js}` / `src/webview/html.js`：`#ft-ctx` 环形指示器 + popover；`_replaying` 抑制
- `src/utils/i18n.js`：新增上下文管理相关中英双语文案

### 🔒 安全 / 兼容性

- 不放宽 Webview CSP
- 不引入新运行时依赖（运行时仍仅 `@anthropic-ai/sdk` / `openai` / `js-tiktoken`）
- 滚动摘要使用既有 API 通道，无新网络入口
- 所有 token 统计在本地完成，不上送任何额外信息

---

## 🇺🇸 English

Theme: **Context-window overhaul · three new slash commands · footer context ring · session-switch flash fix**

### ✨ Feature 1 — Context-window overhaul (Issue #142)

Long conversations chew through the token window quickly. 0.41.0 turns "context management" into a real mechanism:

- **Structure-aware truncation**
  - Latest tool results kept **verbatim**
  - Older turns collapse to summary skeletons (semantics preserved, bulk dropped)
- **Per-file read dedup**
  - Multiple reads of the same path keep only the **latest** payload
  - Earlier reads become placeholders: `<file path=... read-collapsed='true'/>`
- **Rolling summary fallback**
  - When thresholds are crossed, the model is invoked on-demand to compress older history into structured summary nodes
  - `session-store.js` persists & replays these nodes correctly when sessions are reloaded
- **MCP per-server opt-out**: any MCP server can explicitly opt out of compaction
- **Large-file read hint**: `file-read.js` now ships a `read-large-file` hint nudging the model to grep first instead of slurping the whole file

### ✨ Feature 2 — Three new slash commands

| Command | Behaviour |
|---|---|
| `/compact [focus]` | Force-compacts the active session; optional `focus` biases the summarisation; merges project-level instructions from `.deepcopilot/compact.md` or `CLAUDE.md` in the workspace root |
| `/context` | Opens a breakdown popover (system / messages / tools / files / hints) of the current token spend |
| `/fork [name]` | Forks the current session from a chosen message into a brand-new session, with that message as the new origin |

### ✨ Feature 3 — Footer context ring

- Replaces the legacy footer status dot (`#foot .dot`)
- The new ring indicator (`#ft-ctx`) shows live context-window usage
- Colour ramps green → yellow → orange → red across the 60% / 85% / 100% thresholds
- Click to open the same breakdown popover used by `/context`
- Data source: the `ctxUsage` event written by the agent loop after every round

### 🐞 Fix — Session-switch flash / scrollbar jitter (Issue #143)

Switching away from and back to a running session previously replayed every buffered event in a tight loop, each one scheduling its own RAF scroll-to-bottom. Symptoms:

- Visible flash in the chat panel
- Scrollbar oscillating up/down
- Unreadable during the replay burst

**Fix**:

- `_loadSession` defers the replay via `setTimeout(..., 0)` into the next macrotask
- The replay burst is wrapped with `replayStart` / `replayEnd` envelopes
- The webview adds a `_replaying` flag that silences `ascroll()` for the duration
- A single final scroll-to-bottom is performed on `replayEnd`

### 🛠 Internals

- `src/chat/agent-loop.js` / `src/chat/provider.js` — context-window management core + `ctxUsage` event source
- `src/chat/compact.js` — rolling summary + `/compact` implementation
- `src/chat/context-refs.js` — `/context` token breakdown
- `src/chat/session-store.js` — persist & replay summary nodes
- `src/tools/file-read.js` — large-file hint output
- `src/api/anthropic-client.js` / `src/api/openai-client.js` — minor cleanups
- `src/errors.js` — copy tweaks
- `media/chat.{css,js}` / `src/webview/html.js` — `#ft-ctx` ring + popover; `_replaying` suppression
- `src/utils/i18n.js` — new bilingual strings for context management

### 🔒 Security / compatibility

- Webview CSP unchanged
- No new runtime dependencies (still just `@anthropic-ai/sdk` / `openai` / `js-tiktoken`)
- Rolling summary uses the existing API channel — no new network entrypoints
- All token accounting happens locally; nothing extra is transmitted
