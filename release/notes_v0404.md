# Deep Copilot v0.40.4

> 中文版在下方 / English notes below.

## 🇨🇳 中文

### ✨ 新功能：待审编辑面板（Pending Edits Panel）

参考 GitHub Copilot 在 VS Code 中的体验，新增「待审编辑」弹窗，让你在 Agent 改动文件后，
能在合并到工作树之前先看到全部变更并决定保留或丢弃。

- 输入框正上方新增一个浮窗，列出本会话中 Agent 写入 / 修补 / 替换的所有文件
  - 文件名 + `+xxx -xxx` 行级统计
  - 新建文件标 `new`，删除标 `deleted`，二进制文件标 `binary`
- **行内操作**：鼠标悬停时显示 ✓（保留）和 ✕（丢弃）按钮
- **批量操作**：右上角「全部保留」/「全部丢弃」
- **点击文件名 → 原生 Diff 编辑器**
  - 左侧：Agent 写入前的快照（由新的 `deepcopilot-before:` `TextDocumentContentProvider` 提供）
  - 右侧：当前磁盘内容
  - URI 带时间戳防缓存，并通过 `onDidChange` 主动刷新，保证可以**反复点击**
- **跨轮次持久**：`pendingEdits` 以 session 为维度维护，即使本轮对话结束、`run` 实例被回收，
  面板项仍可继续点击查看 / 保留 / 丢弃，与 GH Copilot 行为一致
- 「丢弃」会用原始快照恢复磁盘内容；「保留」仅清除面板项
- 与现有「回滚本轮」状态栏按钮 / `revert_last_turn` 工具完全联动，回滚后面板会自动清空

### 🔧 模型参数刷新（同版本携带）

- DeepSeek `v4-pro` / `v4-flash`：最大输出提升至 **384 000 tokens**
- OpenAI `gpt-5.5` / `gpt-5.4`：上下文提升至 **1 050 000 tokens**
- Anthropic Opus 4-7 / 4-6：上下文提升至 **1 000 000 tokens**、最大输出提升至 **128 000 tokens**
- Anthropic Sonnet 4-6：上下文提升至 **1 000 000 tokens**
- 按官方公告将 DeepSeek v4-pro **2.5 折折扣**有效期延长至 2099 年（实质永久 2.5 折）

### 🛠 内部改动

- 新增 `src/chat/diff-utils.js`：基于 LCS 的轻量行级 diff，大文件（>10k 行 / >100k 字符）自动降级，二进制文件安全检测
- `src/chat/tool-executor.js`：`snapshotForEdit` 同步填充 session 级 `pendingEdits`，
  写工具成功后调用 `recordEditResult` + 推送 `pendingEdits` 事件
- `src/chat/provider.js`：`pendingEdits` 改为 `_pendingEditsBySession` 维护，新增
  `keepEdit / keepAllEdits / discardEdit / discardAllEdits / openEditDiff` 五个消息处理
- `src/extension.js`：注册 `deepcopilot-before:` `TextDocumentContentProvider` 与 `onDidChange` 事件源
- `media/chat.{css,js}` / `src/webview/html.js` / `src/utils/i18n.js`：新增 `#pending-edits-panel` UI + 中英双语文案
- 把 `toolMap` / `_readTermCardMap` 从普通对象改为原生 `Map`，彻底消除 CodeQL 标记的
  remote-property-injection / prototype-pollution sink

### 🔒 安全 / 兼容性

- 不改变任何工具的对外行为，纯增量功能
- 复用既有的 `turnSnapshots` 快照机制，零额外磁盘 I/O
- Webview CSP 未放宽
- content provider 仅返回内存中的快照，不读取任何新路径
- 不引入新依赖

---

## 🇺🇸 English

### ✨ New feature: Pending Edits Panel

Inspired by GitHub Copilot's review-edits experience in VS Code. A new popover sits right
above the composer and lets you inspect every file the agent just wrote / patched, and
decide whether to keep or discard each one before they become part of your "real" edits.

- Popover lists every file the agent wrote / patched / replaced in the current session
  - File name + per-file `+xxx -xxx` line stats
  - `new` / `deleted` / `binary` tags where relevant
- **Per-file actions**: hover a row to reveal ✓ (Keep) and ✕ (Discard)
- **Bulk actions**: "Keep all" / "Discard all" in the header
- **Click a row → native VS Code Diff editor**
  - Left: pre-edit snapshot served by a new `deepcopilot-before:` `TextDocumentContentProvider`
  - Right: current on-disk content
  - URI carries a cache-busting timestamp and the provider fires `onDidChange`, so **repeat clicks always re-open**
- **Survives turn end**: `pendingEdits` is now keyed by session rather than by run, so panel rows remain
  clickable even after the agent finishes the turn and AgentLoop reaps the run — matching GH Copilot UX
- Discard restores the file from the snapshot; Keep just removes the entry (disk stays as the agent wrote it)
- Fully integrated with the existing "Revert this turn" status-bar button and the `revert_last_turn` tool —
  the panel clears automatically on revert

### 🔧 Model spec refresh (bundled)

- DeepSeek `v4-pro` / `v4-flash`: max output → **384 000 tokens**
- OpenAI `gpt-5.5` / `gpt-5.4`: context → **1 050 000 tokens**
- Anthropic Opus 4-7 / 4-6: context → **1 000 000 tokens**, max output → **128 000 tokens**
- Anthropic Sonnet 4-6: context → **1 000 000 tokens**
- DeepSeek v4-pro **2.5× discount** extended to 2099 per the official announcement (effectively permanent)

### 🛠 Internals

- New `src/chat/diff-utils.js`: LCS-based line diff with graceful fallback for files >10k lines / >100k chars and a binary-safety guard
- `src/chat/tool-executor.js`: `snapshotForEdit` now also populates session-level `pendingEdits`; new `recordEditResult` / `serializePendingEdits` helpers fire after every successful `write_file` / `str_replace_in_file` / `apply_patch`
- `src/chat/provider.js`: pending state moved to a session-keyed `_pendingEditsBySession` map; new `keepEdit` / `keepAllEdits` / `discardEdit` / `discardAllEdits` / `openEditDiff` webview handlers
- `src/extension.js`: registers `deepcopilot-before:` `TextDocumentContentProvider` + `onDidChange` emitter
- `media/chat.{css,js}` / `src/webview/html.js` / `src/utils/i18n.js`: new `#pending-edits-panel` UI markup, styling, dispatcher entry, bilingual EN/ZH strings
- Switched `toolMap` / `_readTermCardMap` from plain objects to native `Map`, eliminating the CodeQL remote-property-injection and prototype-pollution sinks

### 🔒 Security / compatibility

- No tool surface changes; the feature is purely additive
- Reuses the existing `turnSnapshots` mechanism, zero extra disk I/O
- Webview CSP unchanged
- The content provider only returns in-memory snapshots and never touches new paths on disk
- No new dependencies
