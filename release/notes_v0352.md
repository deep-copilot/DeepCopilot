# Deep Copilot v0.35.2 — Explorer 右键附加 · save_plan · UI 优化

> 本版本聚焦于三项增强：资源管理器右键上下文附加、Plan 模式计划持久化，以及多项 bug 修复与界面调优。

---

## 🇨🇳 中文说明

### 一、Explorer 右键附加文件 / 文件夹 📁

在 VS Code 资源管理器（Explorer）中右键点击任意文件或文件夹，即可看到新增的「**附加到 Deep Copilot**」菜单项，一键将文件内容或文件夹结构注入聊天上下文。

**文件场景**
- 读取文件完整文本内容并以 **file chip** 形式附加到输入框
- 内容超过 64 KB 时自动截断并标注 `... [截断]`，防止 token 过载

**文件夹场景**
- 递归遍历文件夹（最深 3 层，最多 200 条目），生成结构化文件树
- 以 **folder chip**（文件夹图标 + ` /` 后缀）呈现，AI 可据此理解项目目录结构
- 自动跳过 `node_modules`、`.git`、`dist`、`__pycache__` 等噪音目录

**从命令面板调用**
- 若通过命令面板触发且无活跃文件，自动回退为附加当前编辑器选区

---

### 二、Plan 模式：`save_plan` 工具 📋

Plan 模式现在会在调查结束时自动调用 `save_plan` 工具，将结构化计划持久化到工作区的 `.deep-copilot/plans/` 目录，方便会话结束后随时查阅。

**保存内容**
- 计划标题（用于生成文件名）
- 目标描述、方案概述
- 有序执行步骤（每步可带备注）
- 涉及文件列表
- 风险提示与后续步骤

**输出格式**：标准 Markdown，文件名形如 `20260518-143022-add-explorer-attach.md`

> 提示：生成的计划文件路径会在 AI 的最终摘要中引用，点击即可用 VS Code 打开。

---

### 三、Bug 修复

#### live-selection chip 点击输入框时意外消失

**问题**：在编辑器中选中代码后，点击聊天输入框，上下文 chip 会突然消失。

**根因**：聚焦 webview 侧边栏时 `onDidChangeActiveTextEditor` 会触发 `editor = undefined`，之前的逻辑将此误判为"关闭了所有编辑器"并清除了 chip。

**修复**：仅当 `vscode.window.visibleTextEditors.length === 0`（真正没有任何可见编辑器）时才清除 chip；切换焦点到聊天面板时保留 chip 不变。

---

### 四、UI 调整

| 改动 | 说明 |
|------|------|
| 工具卡片边框 | 原来的 `#4ec9b0` / `#dcdcaa` / `#b5cea8` 等硬编码颜色改为 `var(--vscode-panel-border)`，适配浅色、深色、高对比度主题 |
| 工具头部状态栏 | 恢复显示（此前被 `display:none` 意外隐藏） |
| 流式写入预览框 | 左侧强调色边框同步改为主题感知色 |
| Composer 区域 | 移除顶部分隔线，视觉更简洁 |
| 错误工具名称 | 不透明度从 0.9 调整到 0.75，与整体风格更协调 |

---

### 升级方式

**方式一（推荐）**：在 VS Code 扩展面板搜索「Deep Copilot」点击更新

**方式二**：手动安装 `deep-copilot-0.35.2.vsix`
```
Extensions → ··· → Install from VSIX
```

---

## 🇬🇧 English

### 1. Explorer Context Menu — Attach File / Folder 📁

Right-click any file or folder in the VS Code Explorer to find the new **"附加到 Deep Copilot"** ("Attach to Deep Copilot") menu entry. It injects the file content or folder structure directly into the chat context with a single click.

**For files**
- Reads the full text content and attaches it as a **file chip**
- Automatically truncates at 64 KB with a `... [truncated]` marker to avoid token overload

**For folders**
- Recursively walks the folder tree (max depth 3, max 200 entries) and generates a structured file-tree listing
- Displayed as a **folder chip** (folder icon + ` /` suffix) so the AI can understand the project layout
- Automatically skips noisy directories: `node_modules`, `.git`, `dist`, `__pycache__`, `.venv`, etc.

**From the command palette**
- When invoked without an Explorer URI (no right-click target), falls back to attaching the current editor selection

---

### 2. Plan Mode: `save_plan` Tool 📋

At the end of a Plan-mode turn, the AI now automatically calls `save_plan` to persist the structured plan as a Markdown file under `.deep-copilot/plans/` in your workspace — so you can reopen it any time after the session ends.

**What gets saved**
- Plan title (used to derive the filename)
- Goal statement and high-level approach
- Ordered execution steps (each step optionally carrying a note)
- List of affected files
- Risks and follow-up next steps

**Output format**: Standard Markdown, filename like `20260518-143022-add-explorer-attach.md`

> Tip: The AI's final summary message will reference the saved file path — click it to open directly in VS Code.

---

### 3. Bug Fixes

#### Live-selection chip disappears when clicking the chat input

**Issue**: After selecting code in an editor, clicking into the chat input box caused the context chip to vanish.

**Root cause**: Focusing the webview sidebar fires `onDidChangeActiveTextEditor` with `editor = undefined`. The previous logic misread this as "all editors closed" and called `clearLiveSelection()`.

**Fix**: `clearLiveSelection()` is now only called when `vscode.window.visibleTextEditors.length === 0` (i.e. there are genuinely no visible text editors left). Switching focus to the chat panel leaves the chip intact.

---

### 4. UI Tweaks

| Change | Details |
|--------|---------|
| Tool card borders | Hard-coded accent colours (`#4ec9b0`, `#dcdcaa`, `#b5cea8`) replaced with `var(--vscode-panel-border)` — now adapts to light, dark, and high-contrast themes |
| Tool header status | Restored visibility (was accidentally hidden via `display:none`) |
| Streaming preview border | Left-side accent colour also switched to theme-aware token |
| Composer area | Top border removed for a cleaner look |
| Error tool name | Opacity changed from 0.9 → 0.75 to better match the overall style |

---

### How to upgrade

**Option 1 (recommended)**: Search "Deep Copilot" in the VS Code Extensions panel and click **Update**

**Option 2 — manual VSIX**:
```
Extensions → ··· → Install from VSIX → deep-copilot-0.35.2.vsix
```

---

*Released: 2026-05-18 · [GitHub](https://github.com/ZhouChaunge/DeepCopilot) · [Marketplace](https://marketplace.visualstudio.com/items?itemName=ZhouChaunge.deep-copilot)*
