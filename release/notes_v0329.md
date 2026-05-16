# Deep Copilot v0.32.8 + v0.32.9 — Release Notes

> 累积说明：本次包含 v0.32.8 和 v0.32.9 两个补丁版本，均为 bug 修复，相对于 v0.32.7 的累积更新。

---

## 🇨🇳 中文说明

### v0.32.8 — 修复：Agent 拒绝打开桌面应用程序

**问题背景**

在 autopilot 模式下，当用户请求"请打开我的 CAD 软件"或类似打开桌面应用的指令时，Agent 会回复"作为 AI 助手我无法打开桌面应用程序"，实际上完全没有尝试调用 `run_shell` 工具（日志显示 `tool_calls=0`）。

这是模型训练先验（"我只是编程助手"）覆盖了对 `run_shell` 能力的认知导致的。

**修复内容**

在系统提示词的"Using tools"小节中，新增了一段明确的正向指令：

- 声明 `run_shell` 拥有**完整的操作系统访问权限**，不只是执行代码命令。
- 列出各平台的桌面应用启动方式：Windows 用 `Start-Process`，macOS 用 `open`，Linux 用 `xdg-open`。
- 明确禁止 Agent 以"无法启动应用"为由拒绝任务，要求始终先用 `run_shell` 尝试。

**受影响的文件**
- `src/prompts/system.js` — 在 Using tools 章节新增 run_shell 操作系统级能力说明

---

### v0.32.9 — 修复：Autopilot 模式下仍弹出"工作区外文件访问"对话框

**问题背景**

用户将审批模式设置为 `autopilot`（无需人工确认）后，Agent 在读写工作区之外的文件时（如 `~/.deepcopilot/memory.md`、系统配置文件等），仍会弹出"Deep Copilot 想访问工作区之外的路径"对话框，需要用户手动点击确认，与 autopilot 模式的语义相悖。

**修复内容**

在 `src/tools/utils.js` 的 `ensurePathAllowed()` 函数中，在调用 VS Code 对话框之前增加审批模式检测：

- 当 `approvalMode === 'autopilot'` 时，**静默放行**所有工作区外路径，并将其加入本轮会话的缓存集合（`_outsideWsApprovals`），避免后续重复检查。
- 其他模式（`manual`、`auto-edit`）行为不变，依然弹出对话框请求确认。

**受影响的文件**
- `src/tools/utils.js` — `ensurePathAllowed()` 新增 autopilot 模式快速通行逻辑

---

## 🇺🇸 English Release Notes

### v0.32.8 — Fix: Agent refuses to open desktop applications

**Background**

In autopilot mode, requests like "please open my CAD software" caused the agent to reply with "As an AI assistant I cannot open desktop applications" — without even attempting to call `run_shell` (logs showed `tool_calls=0`).

This was caused by the model's training prior ("I'm just a coding assistant") overriding its awareness of `run_shell` capabilities.

**Changes**

Added an explicit positive instruction in the "Using tools" section of the system prompt:

- Declares that `run_shell` has **full OS-level access**, not just code execution.
- Lists the platform-specific application launch commands: `Start-Process` on Windows, `open` on macOS, `xdg-open` on Linux.
- Explicitly prohibits the agent from declining a task by claiming it "cannot launch applications" — it must always attempt with `run_shell` first.

**Affected files**
- `src/prompts/system.js` — added OS-capability clause to the run_shell tool description in the Using tools section

---

### v0.32.9 — Fix: "Access outside workspace" dialog appears in autopilot mode

**Background**

Even with the approval mode set to `autopilot` (no human confirmation required), the agent would still show a "Deep Copilot wants to access a path outside the workspace" dialog when reading or writing files outside the workspace (e.g. `~/.deepcopilot/memory.md`, system config files). This contradicted the intended semantics of autopilot mode.

**Changes**

Added an approval-mode check in `ensurePathAllowed()` in `src/tools/utils.js`, before the VS Code dialog is invoked:

- When `approvalMode === 'autopilot'`: **silently allow** all out-of-workspace paths and add them to the session cache (`_outsideWsApprovals`) to skip repeated checks.
- Other modes (`manual`, `auto-edit`) are unaffected — the confirmation dialog continues to appear as before.

**Affected files**
- `src/tools/utils.js` — `ensurePathAllowed()` gains an autopilot fast-path before the dialog call
