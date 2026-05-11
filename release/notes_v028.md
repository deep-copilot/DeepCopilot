## Deep Copilot v0.28.0

### Install · 安装

Download **deep-copilot-0.28.0.vsix** from the Assets below, then:

```
code --install-extension deep-copilot-0.28.0.vsix --force
```

Or: VS Code Extensions panel → `⋯` → **Install from VSIX...**

---

## What's New · 新功能

### 🔌 MCP Client · MCP 客户端

**EN** Connect any MCP-compatible stdio tool server. Tools appear as `mcp__<server>__<toolName>` alongside built-ins. Configure via VS Code settings:

**中文** 连接任意 MCP stdio 工具服务器，工具以 `mcp__<server>__<toolName>` 形式并列出现。

```json
"deepseekAgent.mcp.servers": [
  { "name": "my-db", "command": "npx", "args": ["my-db-mcp-server"] }
]
```

---

### 🪝 Post-Tool Hooks · 工具后置钩子

**EN** Run custom scripts automatically after any tool call. Hook output is injected into model context so it can react (e.g., auto-fix test failures). Configure via `.deepcopilot/hooks.json`:

**中文** 任意工具调用后自动执行用户脚本，脚本输出注入模型上下文（例如写文件后自动跑测试并自动修复）。

```json
{ "hooks": [
  { "event": "after_tool", "tool": "write_file",
    "run": "npm test", "on_failure": "inject_error", "timeout_ms": 30000 }
]}
```

---

### 🧠 User Memory · 用户记忆

**EN** Create `~/.deepcopilot/memory.md` for cross-project preferences. Content (capped at 4 KB) is injected into every system prompt as *User preferences*.

**中文** 在家目录新建 `~/.deepcopilot/memory.md`，写入跨项目个人偏好，Deep Copilot 在每次对话时自动注入（最多 4KB）。

---

### ↩️ Revert Last Turn · 一键回滚

**EN** Roll back all file changes from the current agent turn in one click:
- Tool: `revert_last_turn` (model-callable)
- Command palette: `Deep Copilot: Revert Last Turn`

**中文** 一键撤销当前 Agent 轮次对所有文件的改动：
- 工具：`revert_last_turn`（模型可主动调用）
- 命令面板：`Deep Copilot: Revert Last Turn`

---

### 🩺 Post-Edit LSP Diagnostics · 编辑后 LSP 诊断

**EN** After every file edit, current language server errors and warnings are appended to the tool result so the model can self-verify and fix without a second prompt.

**中文** 每次文件编辑后，语言服务器的错误与警告自动追加到工具结果，模型可据此自行修复。

---

## Bug Fixes · Bug 修复

- Fixed `opts is not defined` crash in agent mode — destructuring mismatch in `src/api/deepseek.js` when passing custom tool lists.

---

## Full Changelog

https://github.com/ZhouChaunge/DeepCopilot/compare/v0.26.0...v0.28.0
