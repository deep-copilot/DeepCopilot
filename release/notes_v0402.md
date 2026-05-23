# Deep Copilot v0.40.2

> 中文版在下方 / English notes below.

## 🇨🇳 中文

### ✨ 新功能：待审编辑面板（Pending Edits Panel）

参考 GitHub Copilot 在 VS Code 中的体验，新增「待审编辑」弹窗，让你在 Agent 改动文件后，
能在合并到工作树之前先看到全部变更并决定保留或丢弃。

- 输入框正上方新增一个浮窗，列出本轮 Agent 写入 / 修补 / 替换的所有文件
  - 文件名 + `+xxx -xxx` 行级统计
  - 新建文件标 `new`，删除标 `deleted`，二进制文件标 `binary`
- **行内操作**：鼠标悬停时显示 ✓（保留）和 ✕（丢弃）按钮
- **批量操作**：右上角「全部保留」/「全部丢弃」
- **点击文件名** → 打开 VS Code 原生 Diff 编辑器
  - 左侧：Agent 写入前的快照
  - 右侧：当前磁盘内容
- 「丢弃」会用原始快照恢复磁盘内容；「保留」仅清除面板项，磁盘保持 Agent 版本
- 与现有「回滚本轮」状态栏按钮 / `revert_last_turn` 工具完全联动，
  回滚后面板会自动清空

### 🛠 内部改动

- 新增 `src/chat/diff-utils.js`：基于 LCS 的轻量行级 diff（大文件 > 10k 行时自动降级到集合差异），二进制文件安全检测
- `tool-executor.js`：在 `snapshotForEdit` 基础上同步收集 `run.pendingEdits`，写工具成功后推送 `pendingEdits` 事件
- `provider.js`：新增 `keepEdit / keepAllEdits / discardEdit / discardAllEdits / openEditDiff` 五个消息处理；导出 `getPendingBefore(sid, abs)`
- `extension.js`：注册 `deepcopilot-before:` `TextDocumentContentProvider`，为原生 `vscode.diff` 提供「编辑前」内容

### 🔧 兼容性

- 不改变任何工具的对外行为，纯增量功能
- 复用既有的 `turnSnapshots` 快照机制，零额外磁盘 I/O
- CSP 未放宽

---

## 🇺🇸 English

### ✨ New feature: Pending Edits Panel

Inspired by GitHub Copilot's review-edits experience in VS Code. A new popover sits right
above the composer and lets you inspect every file the agent just wrote / patched, and
decide whether to keep or discard each one before they become part of your "real" edits.

- Popover shows file name + `+xxx -xxx` per file
  - New files tagged `new`, deleted files `deleted`, binaries `binary`
- **Per-file actions**: hover a row to reveal ✓ (Keep) and ✕ (Discard)
- **Bulk actions**: "Keep all" / "Discard all" in the header
- **Click a row** → opens the native VS Code Diff editor
  - Left: pre-edit snapshot captured at write time
  - Right: current on-disk content
- Discard restores the file from the snapshot; Keep just removes the entry (disk stays as the agent wrote it)
- Fully integrated with the existing "Revert this turn" status-bar button and the `revert_last_turn` tool — the panel clears automatically on revert.

### 🛠 Internals

- New `src/chat/diff-utils.js`: LCS-based line diff with graceful fallback for files >10k lines and binary-safety guard
- `tool-executor.js`: piggybacks on `snapshotForEdit` to populate `run.pendingEdits`, emits a `pendingEdits` event after each successful write
- `provider.js`: handles `keepEdit / keepAllEdits / discardEdit / discardAllEdits / openEditDiff`, exposes `getPendingBefore(sid, abs)`
- `extension.js`: registers a `deepcopilot-before:` `TextDocumentContentProvider` so the native `vscode.diff` command can render the "before" side

### 🔧 Compatibility

- Pure additive feature — no existing tool behaviour changes
- Reuses the existing `turnSnapshots` mechanism, no extra disk I/O
- Webview CSP is unchanged
