# Deep Copilot

<p align="center">
  <img src="imgs/main_logo.png" alt="Deep Copilot" width="100%"/>
</p>

<p align="center">
  <b>嵌入 VS Code 的 AI 编程助手 · 由 DeepSeek V4 驱动</b><br/>
  <sub>An AI coding agent embedded in VS Code, powered by DeepSeek V4</sub>
</p>

<p align="center">
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS%20Code-%E2%89%A51.95.0-blue" alt="VS Code"/></a>
  <a href="https://github.com/ZhouChaunge/DeepCopilot/releases"><img src="https://img.shields.io/github/v/release/ZhouChaunge/DeepCopilot?label=version&color=success" alt="Version"/></a>
  <a href="https://github.com/ZhouChaunge/DeepCopilot/stargazers"><img src="https://img.shields.io/github/stars/ZhouChaunge/DeepCopilot?style=flat&color=yellow" alt="GitHub stars"/></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=ZhouChaunge.deep-copilot"><img src="https://img.shields.io/visual-studio-marketplace/i/ZhouChaunge.deep-copilot?label=installs&color=brightgreen" alt="VS Marketplace Installs"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"/></a>
</p>

> Deep Copilot 是一个把 Copilot 风格的 AI Agent 直接搬进 VS Code 的扩展。它通过 DeepSeek API（OpenAI 兼容协议）与模型对话，调用工具读写文件、搜索代码、执行 Shell 命令，并把整个过程实时呈现在侧边栏中。**无需后端、无需 Docker、无需 Rust**，纯 Node.js / 浏览器 API 实现。
>
> Deep Copilot brings a Copilot-style AI agent directly into VS Code. It talks to DeepSeek (OpenAI-compatible) and lets the model call tools to read/write files, search code, and run shell commands — streamed live into the sidebar. **No backend, no Docker, no Rust** — pure Node.js + browser APIs.

---

## 🔑 API Keys Required · 需要配置的 API Key

开始使用前只需准备以下 Key（最少只需第一个）：  
You only need the following keys to get started — at minimum just the first one:

| # | API Key | 用途 · Purpose | 获取地址 · Get it here | 是否必须 · Required |
|---|---|---|---|---|
| 1 | **DeepSeek API Key** | 驱动 AI 对话与 Agent 工具调用 · Powers all AI chat & agent tool calls | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) | ✅ 必须 · Required |
| 2 | **Tavily API Key** | 启用联网搜索工具 `web_search` · Enables the `web_search` tool | [app.tavily.com](https://app.tavily.com) | ⚙️ 可选 · Optional |

### 如何填入 · How to set them

**中文：**
1. 安装扩展后，点击侧边栏活动栏的 🐋 图标打开 Deep Copilot 面板
2. 点击面板**右下角** 🔑 按钮 → 粘贴 **DeepSeek API Key** → 保存
3. 若需要联网搜索，在同一弹窗里继续填入 **Tavily API Key**

**English:**
1. After installing, click the 🐋 icon in the activity bar to open the Deep Copilot panel
2. Click the 🔑 button in the **bottom-right** of the panel → paste your **DeepSeek API Key** → save
3. For web search, fill in your **Tavily API Key** in the same dialog

> 国内用户：若 `api.deepseek.com` 连接不稳定，在 🔑 弹窗中将 Base URL 改为 `https://api.deepseeki.com`。  
> China users: if `api.deepseek.com` is slow, set Base URL to `https://api.deepseeki.com` in the 🔑 dialog.

---

## 📑 Table of Contents · 目录

- [API Keys · 需要配置的 Key](#-api-keys-required--需要配置的-api-key)
- [Highlights · 亮点](#-highlights--亮点)
- [Quick Start · 快速开始](#-quick-start--快速开始)
- [Build from Source · 源码构建](#-build-from-source--源码构建)
- [Configuration · 配置](#%EF%B8%8F-configuration--配置)
- [Keybindings · 快捷键](#%EF%B8%8F-keybindings--快捷键)
- [Tools · 工具列表](#-tools--工具列表)
- [Architecture · 架构](#%EF%B8%8F-architecture--架构)
- [Project Structure · 项目结构](#-project-structure--项目结构)
- [Development · 开发](#-development--开发)
- [Troubleshooting · 故障排查](#-troubleshooting--故障排查)
- [Changelog · 更新日志](#-changelog--更新日志)
- [Star History](#-star-history)
- [License](#-license)

---

## ✨ Highlights · 亮点

| English                                                                                                  | 中文                                                                        |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Agentic loop** with multi-turn tool calling on DeepSeek V4 (Pro / Flash / Reasoner)              | 与 DeepSeek V4（Pro / Flash / Reasoner）多轮**tool-calling 循环**          |
| **File tools**: read, write, str-replace, apply_patch, list dir, find files, ripgrep search        | **文件工具**：读 / 写 / 精准替换 / apply_patch / 列目录 / 查找 / 全文搜索  |
| **Shell tool** with configurable approval policy                                                   | **终端工具**，按审批策略弹窗确认                                           |
| **Web search** via Tavily (optional API key)                                                       | **网络搜索**（Tavily，可选 Key）                                           |
| **Plan & Todos** panel — agent maintains a structured plan you can watch tick off                 | **Plan & Todos** 面板，Agent 自维护结构化任务并实时勾选                    |
| **Revert last turn** — one-click rollback of all file edits in the current agent turn             | **一键回滚**当前 Agent 轮次对文件的所有修改                                |
| **User memory** (`~/.deepcopilot/memory.md`) — cross-project preferences in every system prompt | **用户记忆**（`~/.deepcopilot/memory.md`），跨项目偏好自动注入系统提示词 |
| **MCP client** — connect any MCP-compatible tool server via `deepseekAgent.mcp.servers`         | **MCP 客户端**，通过 `deepseekAgent.mcp.servers` 连接任意 MCP 工具服务器 |
| **Post-tool hooks** — run scripts after any tool call; output injected into model context         | **工具后置钩子**，工具调用后自动执行脚本，输出注入模型上下文               |
| **Post-edit LSP diagnostics** appended to every edit so the model can self-verify                  | 每次编辑后自动附加**LSP 诊断**，模型可自行校验                             |
| **Per-workspace session history** with search, rename, delete                                      | 每工作区独立的**会话历史**，可搜索 / 重命名 / 删除                         |
| **Parallel sessions** — switch away from a running task and start another; live replay on return  | **多会话并行**：任务跑着可以切走开新对话，回来自动回放进度                 |
| **Streaming output** with reasoning expander, blinking cursor, top progress bar                    | **流式输出**：思维链可展开、闪烁光标、顶部进度条                           |
| **HTML rendering** — model responses render full Markdown + HTML; math via KaTeX                  | **HTML 渲染**：响应支持完整 Markdown + HTML + KaTeX 数学公式               |
| **Account balance** display in footer (click to refresh)                                           | **账户余额**实时显示在底栏（点击刷新）                                     |
| **Auto-grow input** — textarea grows with content, GH Copilot style                               | **自适应输入框**：随内容自动增高，对齐 GH Copilot 体验                     |
| **Approval modes**: Manual / Auto-Edit / Autopilot / Read-Only                                     | **审批模式**：手动 / 自动编辑 / 全自动 / 只读                              |
| **Cost telemetry** in CNY shown in the footer                                                      | 底栏显示**token 数与人民币成本**                                           |
| **Slash commands** (`/explain`, `/fix`, `/tests` …), **`@` file refs** and **`#` context refs** — pick `#file`, `#selection`, `#editor`, `#problems`, `#changes`, `#terminal`, `#symbol:Foo`, `#fetch:URL` from the input | **斜杠命令** + **`@` 文件引用** + **`#` 上下文引用**（在输入框键入 `#` 即可挑选文件 / 选区 / 编辑器 / 诊断 / Git 改动 / 终端 / 符号 / 抓取 URL） |
| **Smart code-block actions**: Run in terminal · Insert · Copy · Fold long blocks                | **代码块操作**：在终端运行 / 插入 / 复制 / 长代码折叠                      |
| **Bilingual UI + locale-aware fonts**: auto follows VS Code locale (zh-cn / en) — Chinese font stack for CJK, Latin font stack for EN                        | **中英双语 UI + 语言感知字体**：跟随 VS Code 语言自动切换界面文案与字体（中文环境使用微软雅黑/苹方，英文环境使用 Segoe UI/Inter）    |
| **Skills system** — define reusable SKILL.md packs in `~/.deepcopilot/skills` (or `~/.claude/skills`, `~/.copilot/skills`); YAML frontmatter for workspace gating, invoke via `/skill` or the model's `skill_invoke` tool | **技能系统**：在 `~/.deepcopilot/skills` 等目录放置 SKILL.md 技能包，支持 YAML 元数据与工作区门控，`/skill` 命令或 `skill_invoke` 工具均可唤起 |
| **Inline FIM completions** — DeepSeek ghost-text suggestions as you type; `Tab` to accept; off by default (`deepCopilot.inlineCompletion.enable`) | **行内 FIM 补全**：基于 DeepSeek 的编辑器幽灵文字建议，`Tab` 接受；默认关闭，开关：`deepCopilot.inlineCompletion.enable` |
| **Plan mode** — read-only investigation mode; agent can read/search but never write or run shell commands | **Plan 只读模式**：仅允许读文件/搜索，拒绝任何写操作，适合调查代码结构时使用 |
| **Ecosystem AI-rule discovery** — auto-injects `DEEPCOPILOT.md`, `.github/copilot-instructions.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, `CLAUDE.md` | **项目规则自动发现**：自动注入工作区下的主流 AI 规则文件（GitHub Copilot / Cursor / Claude 等），让模型了解项目约定 |

---

## 🚀 Quick Start · 快速开始

### Option 1 — VS Code Marketplace · 从扩展商城安装（推荐）

1. Open VS Code → Extensions (`Ctrl/Cmd+Shift+X`) → Search **Deep Copilot** → Install.
   打开 VS Code → 扩展面板（`Ctrl/Cmd+Shift+X`）→ 搜索 **Deep Copilot** → 安装。

### Option 2 — Install the prebuilt VSIX · 安装预构建 VSIX

```bash
# 从 GitHub Releases 下载最新版 / Download from GitHub Releases:
# https://github.com/ZhouChaunge/DeepCopilot/releases

code --install-extension deep-copilot-0.35.0.vsix
```

Or in VS Code: **Extensions** view → `⋯` menu → **Install from VSIX...** and pick the file.
或在扩展面板右上角 `⋯` → **Install from VSIX...** 选择文件。

### Step 2 — Set the API key · 配置 API Key

1. Click the 🐋 Deep Copilot icon in the **activity bar** to open the chat panel.点击**活动栏**中的 🐋 Deep Copilot 图标，打开聊天面板。
2. Click the 🔑 button at the **bottom right** of the panel, paste your [DeepSeek API key](https://platform.deepseek.com/api_keys).点击面板**右下角** 🔑 按钮，粘贴你的 [DeepSeek API Key](https://platform.deepseek.com/api_keys)。
3. Start chatting! 开始对话！

---

## 🛠 Build from Source · 源码构建

### Prerequisites · 前置依赖

| Tool              | Version | Note               |
| ----------------- | ------- | ------------------ |
| **Node.js** | ≥ 18   | esbuild + vsce     |
| **npm**     | ≥ 9    | comes with Node    |
| **VS Code** | ≥ 1.95 | extension host     |
| **Git**     | any     | optional, to clone |

### Steps · 构建步骤

```bash
# 1. Clone the repo · 克隆仓库
git clone https://github.com/ZhouChaunge/DeepCopilot.git
cd DeepCopilot

# 2. Install dependencies · 安装依赖
#    (only devDependencies: esbuild + vsce + @types — runtime is pure VS Code API)
#    （只有开发依赖；运行时仅用 VS Code API，无运行时 npm 依赖）
npm install

# 3. Build the bundle · 编译为单文件
npm run build
# -> outputs out/extension.js (~105 KB minified)
# -> 产出 out/extension.js（约 105 KB，已压缩）

# 4. Package as VSIX · 打包 VSIX
npm run package
# -> outputs deep-copilot-0.32.7.vsix
# -> 产出 deep-copilot-0.32.7.vsix

# 5. Install locally · 本地安装
code --install-extension deep-copilot-0.32.7.vsix --force
```

### Watch mode · 监听模式（开发期）

```bash
npm run watch
# Rebuilds out/extension.js on every src/ change.
# 修改 src/ 任何文件即增量重建 out/extension.js。
# Then: F5 in VS Code (with the repo opened) launches the Extension Development Host.
# 然后在 VS Code 里按 F5 启动“扩展开发宿主”加载本地构建。
```

### What gets built · 构建产物说明

| Path                  | Tracked?   | Purpose                                                                          |
| --------------------- | ---------- | -------------------------------------------------------------------------------- |
| `src/`              | ✅ yes     | Source modules (entry:`src/extension.js`) · 源码（入口 `src/extension.js`） |
| `media/`            | ✅ yes     | Webview assets (chat.css / chat.js / icons) · Webview 静态资源                  |
| `esbuild.config.js` | ✅ yes     | Bundler config · 打包配置                                                       |
| `package.json`      | ✅ yes     | Manifest + scripts · 清单与脚本                                                 |
| `package-lock.json` | ✅ yes     | Locked dep versions · 锁定依赖版本                                              |
| `out/extension.js`  | ❌ ignored | Built bundle (regenerated by `npm run build`) · 构建产物                      |
| `release/*.vsix`    | ❌ ignored | Packaged extension (regenerated by `npm run package`) · 打包后的 VSIX         |
| `node_modules/`     | ❌ ignored | npm cache · npm 依赖缓存                                                        |

> **🇬🇧** Everything required to compile is in the repo. `out/` and `*.vsix` are reproducible artifacts.
> **🇨🇳** 编译所需文件全部在仓库里。`out/` 和 `*.vsix` 是可重现的产物，已 `.gitignore`。

---

## ⚙️ Configuration · 配置

All settings live under the `deepseekAgent.*` namespace in `settings.json`.
所有设置都在 `settings.json` 的 `deepseekAgent.*` 命名空间下。

| Setting                               | Default                             | EN                                                         | 中文                                                                            |
| ------------------------------------- | ----------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `deepseekAgent.defaultModel`        | `deepseek-v4-pro`                 | Default model                                              | 默认模型（`deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-reasoner`） |
| `deepseekAgent.apiBaseUrl`          | *(empty → `api.deepseek.com`)* | API endpoint                                               | API 入口（国内可填 `https://api.deepseeki.com`）                              |
| `deepseekAgent.approvalMode`        | `manual`                          | Tool-call approval policy                                  | 工具调用审批策略                                                                |
| `deepseekAgent.interactionMode`     | `agent`                           | `agent` / `ask`                                        | 交互模式（Agent 可调工具，Ask 纯聊天）                                          |
| `deepseekAgent.autoApproveTools`    | `[]`                              | Tool names to always allow                                 | 始终自动允许的工具名                                                            |
| `deepseekAgent.denyTools`           | `[]`                              | Tool names to always deny                                  | 始终拒绝的工具名                                                                |
| `deepseekAgent.maxIterations`       | `15`                              | Hard ceiling on tool-call rounds                           | 单次发送的工具调用迭代上限                                                      |
| `deepseekAgent.compactBudgetTokens` | `600000`                          | Token budget before auto-compaction                        | 自动压缩历史前的 token 预算                                                     |
| `deepseekAgent.postEditDiagnostics` | `true`                            | Append LSP diagnostics after every file edit               | 每次编辑后追加 LSP 诊断结果                                                     |
| `deepseekAgent.mcp.servers`         | `[]`                              | MCP server list (see MCP section below)                    | MCP 工具服务器列表（见下方 MCP 小节）                                           |
| `deepseekAgent.enableDebugLog`      | `true`                            | Log thought / tool / API events to `.deep-copilot/logs/` | 写思维链 / 工具 / API 事件日志                                                  |

### Approval Modes · 审批模式

| Mode                | EN behavior                                                   | 中文行为                           |
| ------------------- | ------------------------------------------------------------- | ---------------------------------- |
| **manual**    | Prompt every `write_file` / `run_shell` (safest, default) | 每次写文件或执行命令都弹窗（默认） |
| **auto-edit** | Auto-approve writes; still prompt for shell                   | 写文件自动通过；Shell 仍需确认     |
| **autopilot** | Auto-approve everything (trusted workspaces only)             | 全部自动通过（仅适合受信任工作区） |
| **readonly**  | Deny all writes & shell                                       | 仅允许只读，禁止任何修改           |

> Issue #89 · Autopilot 与危险命令：`autopilot` 模式下，命中危险命令正则（`rm -rf`、`git reset --hard`、`git push --force` …）的 shell 调用会**静默放行**，并写入 `SHELL_DANGER_AUTO_APPROVE` 审计日志，不再弹模态确认框；其他模式中，同一条命令在一次会话内被批准过一次后也会缓存，不会重复弹框。若把 `run_shell` 加入 `autoApproveTools`，效果等同于显式承担 shell 风险，请仅在受信任工作区开启。

---

## ⌨️ Keybindings · 快捷键

| Key                               | EN                    | 中文            |
| --------------------------------- | --------------------- | --------------- |
| `Ctrl/Cmd+Shift+D`              | Open sidebar          | 打开侧边栏      |
| `Ctrl/Cmd+Shift+L`              | Open in tab           | 在标签页中打开  |
| `Enter`                         | Send message          | 发送消息        |
| `Shift+Enter`                   | Newline               | 换行            |
| `Esc`                           | Stop generation       | 停止生成        |
| `Ctrl/Cmd+K`                    | Clear current chat    | 清空当前会话    |
| `↑` / `↓` (empty input)     | Recall prompt history | 召回历史 prompt |
| `↑` / `↓` (slash menu open) | Navigate suggestions  | 切换候选项      |
| `Tab` / `Enter` (slash menu)  | Apply suggestion      | 应用候选项      |

---

## 🧰 Tools · 工具列表

Deep Copilot exposes a small, deliberately-minimal tool set to the model:
Deep Copilot 给模型暴露的工具集刻意保持精简：

| Tool                      | EN description                                      | 中文说明                             |
| ------------------------- | --------------------------------------------------- | ------------------------------------ |
| `read_file`             | Read part / all of a file with optional line range  | 按行号区间读取文件                   |
| `write_file`            | Create or overwrite a file (gated by approval)      | 新建 / 覆盖文件（受审批控制）        |
| `str_replace_in_file`   | Targeted in-place edit by exact string match        | 通过字符串精确替换原地编辑           |
| `apply_patch`           | Apply a unified-diff patch (multi-hunk, multi-file) | 应用统一格式补丁（多 hunk / 多文件） |
| `list_dir`              | List directory entries (depth-limited)              | 列出目录（限制深度）                 |
| `find_files`            | Glob-pattern file search                            | Glob 模式文件搜索                    |
| `grep_search`           | Ripgrep-style regex search across the workspace     | 工作区级正则搜索                     |
| `run_shell`             | Run a shell command (gated by approval)             | 执行 Shell 命令（受审批控制）        |
| `web_search`            | Web search via Tavily (requires Tavily API key)     | 网络搜索（需 Tavily Key）            |
| `update_plan`           | Push / update structured plan & todos to left panel | 更新左侧 Plan / Todos                |
| `open_file_in_editor`   | Reveal a file at a given line in the editor         | 在编辑器中打开文件并跳到指定行       |
| `revert_last_turn`      | Restore all files to their pre-turn state           | 将本轮所有文件修改回滚到初始状态     |
| `mcp__<server>__<tool>` | Any tool exposed by a connected MCP server          | 已连接 MCP 服务器暴露的任意工具      |

> **🇬🇧** Tool definitions live in [`src/tools/schema.js`](src/tools/schema.js); execution in [`src/tools/exec.js`](src/tools/exec.js).
>
> **🇨🇳** 工具定义见 [`src/tools/schema.js`](src/tools/schema.js)，执行实现见 [`src/tools/exec.js`](src/tools/exec.js)。

---

## 🏗️ Architecture · 架构

```
┌──────────────────────────────────────────────────────────┐
│                  VS Code Extension Host                  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ src/extension.js  (activate / commands)            │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                               │
│                          ▼                               │
│  ┌────────────────────────────────────────────────────┐  │
│  │ src/chat/provider.js  (ChatViewProvider)           │  │
│  │   • Webview ↔ Extension message bus                │  │
│  │   • Per-session run map  (parallel sessions)       │  │
│  │   • Persisted history    (globalState)             │  │
│  │   • Plan / Todos state                             │  │
│  └────────────────────────────────────────────────────┘  │
│            │                            │                │
│            ▼                            ▼                │
│  ┌──────────────────┐        ┌────────────────────────┐  │
│  │ src/api/         │        │ src/tools/             │  │
│  │  deepseek.js     │        │  schema.js  (defs)     │  │
│  │  • SSE streaming │        │  exec.js    (runtime)  │  │
│  │  • Tool calls    │        │  • read/write/list     │  │
│  │  • Reasoning     │        │  • grep / shell        │  │
│  └──────────────────┘        │  • approval gating     │  │
│                              └────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ src/webview/html.js   (HTML shell injected)        │  │
│  │ media/chat.js + chat.css   (UI runtime + styles)   │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                          │  HTTPS (SSE)
                          ▼
              ┌────────────────────────┐
              │  DeepSeek Platform     │
              │  api.deepseek.com      │
              │  (OpenAI-compatible)   │
              └────────────────────────┘
```

### Key design points · 关键设计

- **🇬🇧 No backend.** Everything runs inside the VS Code extension host. The single bundle `out/extension.js` is approx 94 KB.
  **🇨🇳 无后端。** 全部跑在 VS Code 扩展主机里，单文件构建产物 `out/extension.js` 仅约94KB。
- **🇬🇧 Per-session run map.** `provider._runs: Map<sessionId, Run>` lets you switch sessions while a task is running; the run keeps producing events that get buffered and replayed when you return.
  **🇨🇳 按会话隔离的 run 表。** `provider._runs` 让你在任务跑着时切到别的会话，事件继续缓冲，切回来自动回放。
- **🇬🇧 Streaming via SSE.** `src/api/deepseek.js` parses `data:` frames and forwards `delta`, `reasoning`, `tool_calls`, `usage` to the provider.
  **🇨🇳 SSE 流式。** `src/api/deepseek.js` 解析 `data:` 帧，把 `delta` / `reasoning` / `tool_calls` / `usage` 转发给 provider。
- **🇬🇧 Auto-compaction.** Once estimated tokens exceed `compactBudgetTokens`, older tool results are dropped before the next round.
  **🇨🇳 自动压缩。** 估算 token 超过 `compactBudgetTokens` 时，下一轮前丢弃较老的工具结果。
- **🇬🇧 Approval is enforced server-side (in the extension), not just UI.** A model-issued `write_file` will not execute unless the policy or user explicitly allows it.
  **🇨🇳 审批在扩展端强制执行**（不仅是 UI 层）：模型发出的 `write_file` 必须经策略或用户放行才会真的写盘。

---

## 📁 Project Structure · 项目结构

```
.
├── esbuild.config.js          # esbuild bundler config · 打包配置
├── package.json               # extension manifest + scripts · 清单与脚本
├── package-lock.json          # locked deps · 锁定依赖
├── README.md                  # this file · 本文件
├── LICENSE                    # MIT
├── media/                     # webview assets (loaded as static files)
│   ├── chat.css               #   ↳ all UI styles · 全部 UI 样式
│   └── chat.js                #   ↳ webview runtime (markdown, tool cards, streaming)
├── imgs/
│   ├── logo_black_bg.png      #   ↳ extension icon + webview logo
│   ├── logo_black_bg.svg      #   ↳ activity bar icon (vector)
│   ├── logo.png               #   ↳ marketplace icon (white background)
│   ├── logo_white_bg.svg      #   ↳ activity bar icon (white variant)
│   ├── logo_white_bg.png      #   ↳ logo (base)
│   └── screenshot.png         # README screenshot · README 截图
└── src/                       # extension source · 扩展源码
    ├── extension.js           #   ↳ activate() entry · 入口
    ├── errors.js              #   ↳ error → friendly bilingual card
    ├── logger.js              #   ↳ debug log writer (.deep-copilot/logs/)
    ├── pricing.js             #   ↳ token → CNY cost calculator
    ├── hooks.js               #   ↳ post-tool hooks runner (.deepcopilot/hooks.json)
    ├── mcp.js                 #   ↳ MCP stdio client (McpClient + McpManager)
    ├── api/
    │   └── deepseek.js        #   ↳ SSE chat client (OpenAI-compatible)
    ├── chat/
    │   ├── provider.js        #   ↳ ChatViewProvider (the brain)
    │   └── openFile.js        #   ↳ "open file at line" helper
    ├── prompts/
    │   └── system.js          #   ↳ system prompt builder (+DEEPCOPILOT.md +user memory)
    ├── tools/
    │   ├── schema.js          #   ↳ tool JSON-schema definitions
    │   └── exec.js            #   ↳ tool runtime (file IO, ripgrep, shell)
    ├── utils/
    │   ├── i18n.js            #   ↳ zh-cn / en strings + locale detection
    │   └── paths.js           #   ↳ path safety / workspace root resolution
    └── webview/
        └── html.js            #   ↳ generates the webview HTML shell
```

> **🇨🇳 编译入口**：`src/extension.js` → esbuild → `out/extension.js`（package.json 中 `main` 字段指向 `out/extension.js`）。
>
> **🇬🇧 Build entry**: `src/extension.js` → esbuild → `out/extension.js` (referenced by `main` in `package.json`).

---

## 💻 Development · 开发

### Run the dev host · 启动扩展开发宿主

```bash
git clone https://github.com/ZhouChaunge/DeepCopilot.git
cd DeepCopilot
npm install
code .
# Press F5 inside VS Code → Extension Development Host opens
# 在 VS Code 里按 F5 → 弹出扩展开发宿主窗口
```

### Live edit cycle · 改一改试一试

```bash
npm run watch     # esbuild watch — rebuilds on save · 保存即重建
# In the dev host: Ctrl+R / Cmd+R reloads the window after a rebuild
# 在宿主窗口里按 Ctrl+R / Cmd+R 重载即可看到效果
```

### Debug logs · 调试日志

- Output panel → **Deep Copilot** channel
  Output 面板 → 选择 **Deep Copilot** 频道
- Or open via command palette: `Deep Copilot: Open Debug Log`
  或命令面板：`Deep Copilot: Open Debug Log`
- Files: `<workspace>/.deep-copilot/logs/session-*.log`
  日志文件：`<工作区>/.deep-copilot/logs/session-*.log`

### Workspace-specific instructions · 工作区级提示词

Create a `DEEPCOPILOT.md` at the workspace root and Deep Copilot will inject its content into the system prompt for every request in this workspace — useful for project conventions, build commands, "do/don't" lists.

在工作区根目录新建 `DEEPCOPILOT.md`，其内容会自动并入系统提示词，用来声明项目约定、构建命令、do/don't 等。

### User memory · 用户记忆

Create `~/.deepcopilot/memory.md` for cross-project preferences that apply everywhere — preferred coding style, always/never rules, personal shortcuts. It is injected (capped at 4 KB) into every system prompt.

在家目录新建 `~/.deepcopilot/memory.md`，写入跨项目的个人偏好（代码风格、禁忌事项等），Deep Copilot 会在每次对话时自动注入（最多 4KB）。

### MCP servers · MCP 工具服务器

Add external tool servers via VS Code settings:

```json
"deepseekAgent.mcp.servers": [
  { "name": "my-db", "command": "npx", "args": ["my-db-mcp-server"] }
]
```

Tools appear as `mcp__my-db__<toolName>` alongside built-in tools. Any MCP-compatible stdio server works.

通过 VS Code 设置连接外部 MCP 工具服务器，工具以 `mcp__<server>__<toolName>` 格式出现。任何兼容 MCP stdio 协议的服务器均可接入。

### Post-tool hooks · 工具后置钩子

Create `.deepcopilot/hooks.json` in your workspace:

```json
{ "hooks": [
  { "event": "after_tool", "tool": "write_file",
    "run": "npm test", "on_failure": "inject_error", "timeout_ms": 30000 }
]}
```

The hook's stdout/stderr is appended to the tool result so the model can react — e.g., auto-fix test failures immediately after writing a file.

在工作区创建 `.deepcopilot/hooks.json`，每次写文件后自动跑 `npm test`，测试输出注入模型上下文让其自动修复。

### Style & conventions · 代码风格

- Plain JavaScript (no TypeScript) — keep the bundle tiny.
  纯 JavaScript（不用 TypeScript），保持产物极小。
- No runtime dependencies — only VS Code API + Node built-ins.
  无运行时依赖，只用 VS Code API 与 Node 内置模块。
- Webview side communicates via `postMessage`; never imports `vscode`.
  Webview 端通过 `postMessage` 通信，不引用 `vscode`。

---

## 🔧 Troubleshooting · 故障排查

| Symptom · 症状                       | English Fix                                                      | 中文解决                                   |
| ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `请先设置 API Key` toast            | Click 🔑 in the bottom-right of the panel                        | 点面板右下角 🔑 粘贴 Key                    |
| 401 / 403 errors                      | Key invalid or revoked — regenerate at platform.deepseek.com    | Key 失效，到 platform.deepseek.com 重新生成 |
| 402 errors                            | Account out of balance — top up                                 | 账户余额不足，请充值                        |
| 429 errors                            | Rate-limited; retry button is shown on the error card            | 触发限流，点错误卡上的 🔄 重试              |
| Connection timeouts in mainland China | Switch base URL to `https://api.deepseeki.com`                 | 切到 `https://api.deepseeki.com`          |
| UI still shows "思考中"               | Old VSIX still installed — install the new one with `--force` | 装新版用 `--force` 覆盖旧版               |
| Tools not being called                | You may be in `Ask` mode — switch to `Agent` in the header  | 当前是 `Ask` 模式，切到 `Agent`         |
| Hangs mid-task                        | Click ⏹ Stop or press `Esc`; check Debug Log                  | 点 ⏹ 或按 `Esc` 停止；查看调试日志       |
| Status bar "Deep Copilot" missing     | Right-click the status bar → enable "Deep Copilot"              | 右键状态栏 → 勾选 "Deep Copilot"           |

---

## 📜 Changelog · 更新日志

<details>
<summary>点击展开完整更新日志 · Click to expand full changelog</summary>

### v0.40.0 — UI 视觉统一 · Terminal Early-Exit · 打包清理

- 中文：①**聊天 UI 视觉重构**：引入 `--dc-indent / --dc-fg-* / --dc-accent / --dc-rule` 设计变量，8 大容器统一为「2px 左侧色条 + 16px 缩进」结构；`.tool` 卡片头部、`.tl` 工具行、`.tl-detail` 详情区与 `.tool .b` 主体全部按同一节奏对齐，视觉杂讯显著降低。②**工具类型色条**：新增 `k-read / k-write / k-search / k-shell / k-agent / k-plan / k-other` 类型染色，不同工具一眼可分；同时 `.tl-group .tl-summary` 的折叠摘要也统一为 2px 色条样式。③**Thinking 块体验**：模型开始正文输出后，思考块头部自动汇总为 `Thought for Ns` 并折叠，但保留头部入口，用户随时可展开复盘思考过程。④**chip 语义统一**：工具名 chip 由 `<span>` 改为 `<code>`，与正文 monospace 一致。⑤**Output style contract**：系统提示词新增"输出风格契约"段，约束等宽规则、列表语义、段落控制、禁用装饰性 emoji，对话排版更稳定。⑥**Terminal Early-Exit Window**：`run_shell_bg` 提交后增加 2.5s 早退捕获窗口——若命令在窗口内崩溃/退出，会同步返回真实的 `exit_code` + 输出，模型立刻看见错误，不再出现"提交完任务就摆烂"的现象；窗口超时则按原 `running` 流程异步推进。配套 `terminal-monitor` 新增 `markSyncReturnedJob/wasSyncReturned` 防重复注入，避免事件回放污染上下文。⑦**`.vscodeignore` 清理**：移除 14 条失效规则（已删除的 `test/` `data/` `models/` `runs/` 及一系列 `.pt` 权重等），新增 `.github/**` `.eslintrc.json` `.gitleaksignore`，按用途分组并加注释，vsix 体积更精简。
- English: ①**Chat UI visual refresh**: introduced design tokens `--dc-indent / --dc-fg-* / --dc-accent / --dc-rule`; eight container types now share one "2px left rule + 16px indent" rhythm — `.tool` card headers, `.tl` tool rows, `.tl-detail` panels and `.tool .b` body are visually aligned, dramatically reducing noise. ②**Tool-type color rails**: new `k-read / k-write / k-search / k-shell / k-agent / k-plan / k-other` accent classes so different tools are distinguishable at a glance; `.tl-group .tl-summary` adopts the same 2px rail. ③**Thinking-block UX**: as soon as the model starts streaming the reply, the thought block auto-collapses with a `Thought for Ns` summary while keeping the header visible for on-demand review. ④**Chip semantics**: tool-name chip changed from `<span>` to `<code>` to align with monospace body text. ⑤**Output style contract**: system prompt gains a new "Output style contract" section governing monospace usage, list semantics, paragraph control, and banning decorative emoji — markdown output is far more consistent. ⑥**Terminal early-exit window**: `run_shell_bg` now races the spawn against a 2.5s capture window — if the command crashes/exits inside the window, the real `exit_code` + output are returned **synchronously**, so the model sees failures immediately instead of "giving up" after a fire-and-forget submission; on timeout, the original async `running` path takes over. `terminal-monitor` exposes `markSyncReturnedJob/wasSyncReturned` to deduplicate the late `bg-job-end` event so the agent loop never re-injects what was already returned synchronously. ⑦**`.vscodeignore` cleanup**: removed 14 stale rules (deleted `test/` `data/` `models/` `runs/` directories and a batch of `.pt` weights), added `.github/**` `.eslintrc.json` `.gitleaksignore`, and grouped/commented the file by purpose — vsix payload is leaner.

### v0.35.2 — Explorer 附加 · read_terminal · Agent 验证闭环 · save_plan

- 中文：①**Explorer 右键附加**：在 VS Code 资源管理器右键任意文件或文件夹，点击「附加到 Deep Copilot」可将文件内容或目录结构以 chip 形式注入聊天上下文；文件超 64 KB 自动截断，文件夹递归遍历（最深 3 层 / 最多 200 条，跳过 `node_modules` / `.git` 等噪音目录）。②**`read_terminal` 工具**：模型可主动读取 VS Code 集成终端的最新输出，无需用户手动粘贴；支持按终端名称过滤，输出自动截断并脱敏敏感路径。③**Agent 主动验证闭环**：Agent 执行关键写操作或命令后，自动生成"下一步验证"tool call（如读文件确认内容、运行测试）；`run_shell` 结果结构化为 `{exit_code, stdout, stderr}`，模型可直接判断成功/失败。④**`save_plan` 工具**：Plan 模式调查结束时将结构化计划（标题、目标、步骤、涉及文件、风险）持久化到 `.deep-copilot/plans/` 目录，以时间戳命名为标准 Markdown 文件。⑤**上下文 chip 自动附加当前文件**：打开编辑器文件后，该文件路径自动以 chip 形式出现在输入框，发送时作为上下文附加；切换文件 chip 实时更新，聚焦聊天面板时 chip 保持不变（不再误清除）。⑥修复：技能路径跨 home / 工作区目录解析；工具卡片边框改为主题感知色；工具头部状态栏恢复显示；Composer 区域移除多余分隔线。
- English: ①**Explorer context-menu attach**: right-click any file or folder in VS Code Explorer → "Attach to Deep Copilot" injects its content or directory tree as a chip into the chat input. Files auto-truncated at 64 KB; folders walked recursively (max depth 3, max 200 entries; `node_modules` / `.git` / `dist` etc. skipped). ②**`read_terminal` tool**: the model can proactively read the latest output of the VS Code integrated terminal without the user manually copy-pasting; supports filtering by terminal name; output auto-truncated with sensitive paths sanitised. ③**Agent proactive verification loop**: after critical writes or shell commands, the agent automatically emits a follow-up tool call to verify the result (e.g. re-read a file to confirm content, or run tests); `run_shell` result is structured as `{exit_code, stdout, stderr}` so the model can branch on success/failure. ④**`save_plan` tool**: at the end of a Plan-mode investigation, the structured plan (title, goal, steps, files, risks) is persisted to `.deep-copilot/plans/` as a timestamped Markdown file. ⑤**Context-chip auto-attach current file**: when an editor file is focused, its path appears as a chip in the input bar; chip updates live as the active file changes; chip is preserved (no longer cleared) when focus moves to the chat panel. ⑥Fixes: skill SKILL.md path resolution across home / workspace directories; tool-card borders replaced with theme-aware `var(--vscode-panel-border)`; tool header status bar restored; Composer top separator removed.

### v0.35.0 — Skills · FIM 行内补全 · Plan 模式 · 项目规则发现

- 中文：①**技能系统升级**：三目录扫描（`~/.deepcopilot/skills` / `~/.claude/skills` / `~/.copilot/skills`），YAML 元数据解析（`name`/`description`/`applies_to` 工作区门控），稳定字母排序，新增 `skill_invoke` 工具让模型按需加载技能，斜杠命令 `/skill <name>` 手动唤起。②**DeepSeek FIM 行内补全**：在编辑器停止输入约 350ms 后，以前缀/后缀上下文调用 DeepSeek FIM 接口，建议以幽灵文字呈现，`Tab` 接受；默认关闭（`deepCopilot.inlineCompletion.enable`），静默失败，请求自动取消，日志脱敏。③**Plan 只读交互模式**：新增 Plan 模式，系统提示词追加只读约束，模型只可读文件/搜索，任何写操作或 shell 执行均被工具层拦截，适合先调查后动手。④**项目级 AI 规则自动发现**：启动时扫描 `DEEPCOPILOT.md`、`.github/copilot-instructions.md`、`AGENTS.md`、`.cursor/rules/*.mdc`、`CLAUDE.md`，全量注入系统提示词（总量不超过 8 KB）。⑤**AUTOCOMPACT 持久通知**：上下文自动压缩时在聊天界面插入持久通知卡片。⑥修复：autopilot 模式下危险命令弹窗跳过 + 每会话缓存；Shell 心跳超时 + SIGKILL 兜底；孤立工具消息 HTTP 400 自愈；IME 输入法 Enter 防误触。
- English: ①**Skills upgrade**: three-directory scan, YAML frontmatter (`name`/`description`/`applies_to` workspace gating), stable alpha sort, new `skill_invoke` tool for on-demand model-side loading, `/skill <name>` slash command for manual invocation. ②**DeepSeek FIM inline completions**: ghost-text suggestions using surrounding context (4 000 chars prefix / 2 000 chars suffix) after ~350 ms idle; `Tab` to accept; off by default (`deepCopilot.inlineCompletion.enable`); silent failure; auto-cancel on next keystroke; sanitised error logs. ③**Plan read-only mode**: new Plan option in the mode selector; system prompt gains a read-only constraint — only read/search tools permitted; any write/shell call returns a tool error; ideal for investigation before editing. ④**Ecosystem AI-rule discovery**: on startup, scans `DEEPCOPILOT.md`, `.github/copilot-instructions.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, `CLAUDE.md` and injects all found content into the system prompt (capped at 8 KB). ⑤**AUTOCOMPACT persistent notice**: when auto-compaction fires, a permanent in-chat card is inserted so users understand why older tool outputs may be gone. ⑥Fixes: autopilot skips danger-cmd modal with per-session cache; shell heartbeat + SIGKILL fallback; orphan tool-message HTTP 400 self-heal; IME composition Enter guard.

### v0.34.0 — `#` Context-Reference Picker · GitHub Copilot 风格的 # 上下文选择器

- 中文：在聊天输入框键入 `#` 弹出上下文引用选择器，可一键附加：`#file`（工作区文件）/ `#selection`（当前选区）/ `#editor`（当前整文件）/ `#problems`（诊断信息）/ `#changes`（`git diff` 未提交改动）/ `#terminal`（终端选中文本）/ `#symbol:Foo`（工作区符号）/ `#fetch:URL`（抓取链接内容）。所有引用以 `<attachment path="…">` 块形式注入模型上下文；带参引用支持空格自动转 chip，未提交的 `#ref:arg` 在发送时由扩展端原子解析后随消息一并下发，避免异步竞态。`#fetch` 复用 `web-fetch.js` 的 SSRF 拦截；`#file` / `#editor` 严格校验路径在工作区内。
- English: Typing `#` in the chat input opens a context-reference picker. One-click attach: `#file` (any workspace file), `#selection` (active selection), `#editor` (active file), `#problems` (diagnostics), `#changes` (unstaged `git diff`), `#terminal` (selected terminal text), `#symbol:Foo` (workspace symbols), `#fetch:URL` (web fetch). All refs ride as `<attachment path="…">` blocks with synthetic paths (`<problems>`, `<git-changes>`, `<symbol:Foo>`, `<fetch:URL>`) so the model can tell them apart from real files. Inline `#ref:arg` tokens are resolved race-free on the extension side before the agent loop runs. SSRF blocklist enforced for `#fetch`; workspace-containment check for `#file` / `#editor`.

### v0.33.0 — Compact Tool UI · Sonar Spinner Redesign · 工具栏精简与进度动画重设计

- 中文：大幅精简工具调用的显示方式，隐藏图标、三角形与分栏，改为单行灰色文本，文件路径更淡化，点击后展开详情；移除所有中间"思考中"气泡的耗时显示；底部进度动画全面重设计——保留蓝色 sonar 光波，去除背景色与边框，加入 20 个英文动词随机轮播（每 3 秒切换，渐显动画）与实时计时器；修复长回复时 spinner 被输入框遮挡的问题（requestAnimationFrame 布局时序修正 + 每秒兜底滚动）。
- English: Heavily simplified tool-call display — icons, chevrons, and column layout removed in favour of a single-line grey text row with faded file paths and click-to-expand detail. Removed elapsed-time labels from all intermediate "Thinking" chips. Completely redesigned the bottom progress indicator: keeps the blue sonar dot, removes background / border / shimmer, adds a 20-word English verb carousel (randomised every 3 s with a fade-in animation) and a live elapsed timer. Fixed the spinner being obscured by the input box during long streaming responses via `requestAnimationFrame`-deferred scrolling and a per-second scroll safety net.

### v0.32.9 — Autopilot 静默放行工作区外路径 · Silent pass-through for out-of-workspace paths

- 中文：在 `src/tools/utils.js` 的 `ensurePathAllowed()` 中新增审批模式检测。当 `approvalMode === 'autopilot'` 时，访问工作区外的路径（如 `~/.deepcopilot/memory.md`）**静默放行**，不再弹出“访问工作区之外”对话框，与 autopilot 语义保持一致。其他模式（`manual` / `auto-edit`）行为不变。
- English: `ensurePathAllowed()` in `src/tools/utils.js` now checks the approval mode. In `autopilot`, paths outside the workspace (e.g. `~/.deepcopilot/memory.md`) are silently allowed and cached for the session, eliminating the previously dialog. `manual` / `auto-edit` behaviour is unchanged.

### v0.32.8 — 允许 Agent 启动桌面应用 · Allow agent to launch desktop applications

- 中文：在系统提示词的 Using tools 章节尊明确声明 `run_shell` 拥有**完整的操作系统访问能力**，并给出 Windows `Start-Process` / macOS `open` / Linux `xdg-open` 的调起范例，禁止 Agent 以“无法启动桌面应用”为由拒绝任务；修复 autopilot 下“打开某某软件”请求被静默拒绝的问题。
- English: Added an explicit positive clause to the Using-tools section of the system prompt that declares `run_shell` has full OS-level access, with platform-specific launchers (`Start-Process`, `open`, `xdg-open`). Fixes the regression where the agent refused to attempt launching desktop apps in autopilot mode (`tool_calls=0`).

### v0.32.7 — Locale-Aware Fonts & Full Webview i18n · 语言感知字体与界面全面本地化

- 🇬🇧 **Locale-aware font switching**: on startup, reads `vscode.env.language`; `zh-*` locales use a CJK-optimised font stack (Microsoft YaHei UI / PingFang SC / Noto Sans CJK SC, with Linux fallback), all other locales use a Latin-optimised stack (Segoe UI / Inter / system-ui). Implemented via `html[data-locale]` CSS attribute selectors — zero bundle-size increase.
  **🇨🇳 语言感知字体切换**：启动时读取 `vscode.env.language`，`zh-*` 语言使用中文优化字体栈（微软雅黑 UI / 苹方 / Noto Sans CJK / WenQuanYi，覆盖 Win/Mac/Linux），其他语言切换为 Latin 优化字体栈（Segoe UI / Inter / system-ui）。通过 `html[data-locale]` CSS 属性选择器实现，零打包体积增加。
- 🇬🇧 **Full webview i18n**: all 20 hardcoded Chinese strings in the webview HTML template (welcome subtitle, input placeholder, session panel labels & buttons, empty-state text, thinking indicator, all tooltips) now route through the existing `t()` i18n system. English VS Code users see a fully English interface.
  **🇨🇳 Webview 界面全面本地化**：`src/webview/html.js` 中 20 处硬编码中文字符串全部接入现有 `t()` 国际化系统（欢迎页副标题、输入框提示、会话面板标签与按钮、空状态文本、思考中指示器、所有工具提示）。英文 VS Code 用户现在看到完整的英文界面。

### v0.32.0 — Unified API Settings UI · API 设置一站式面板

- 🇬🇧 **One-click access to all API keys**: clicking the 🔑 button now opens a unified QuickPick panel with three items — **DeepSeek API Key (required)**, **Tavily API Key (optional)**, and **Base URL** — each showing live status, masked key preview, and inline help. The Tavily key, previously only accessible via the command palette, is now visible in the UI.
  **🇨🇳 一键访问所有 API 配置**：点击 🔑 按钮现会弹出统一的 QuickPick 面板，包含三项设置——**DeepSeek API Key（必填）**、**Tavily API Key（可选）**、**Base URL**，每项都显示实时状态、脱敏后的 Key 预览与说明。Tavily Key 之前只能通过命令面板访问，现在在 UI 中可见。
- 🇬🇧 **Status indicators**: codicon icons (`pass-filled` / `circle-large-outline`) show at a glance which keys are configured.
  **🇨🇳 状态图标**：使用 codicon 图标（`pass-filled` / `circle-large-outline`）一眼看出哪些 Key 已配置。
- 🇬🇧 **Looped UI**: after configuring one item, the panel returns automatically so users can set multiple keys without reopening.
  **🇨🇳 循环面板**：设置完一项后面板自动返回列表，可连续配置多项无需重新点击。
- 🇬🇧 **README**: added a “API Keys Required” section near the top to help new users get set up faster.
  **🇨🇳 README 更新**：顶部新增「API Keys Required」章节，帮助新用户更快上手。

### v0.31.6 — HTML Rendering Fixes · 1M Context Window · HTML 渲染全面修复与上下文扩容

- 🇬🇧 **HTML inline tag whitelist expanded**: `SAFE_HTML_TAGS` now covers all common inline HTML elements — `strong`, `em`, `b`, `i`, `span`, `code`, `a`, `p`, `time`, `data`, `wbr`, `bdi`, `bdo`, `ruby`/`rt`/`rp`/`rb` and all previous tags. Model-output HTML inline tags no longer appear as escaped text.
  **🇨🇳 内联标签白名单全面扩充**：新增 `strong`、`em`、`b`、`i`、`span`、`code`、`a`、`p`、`time`、`data`、`wbr`、`bdi`/`bdo`、`ruby`/`rt`/`rp`/`rb` 等标签，模型输出的内联 HTML 不再显示为转义文本。
- 🇬🇧 **Block-level heading tags** (`h1`–`h6`) added to the `HB_TAGS` extractor and DOMPurify `ADD_TAGS` — headings now render correctly instead of showing as raw HTML.
  **🇨🇳 块级标题标签**（`h1`–`h6`）加入 `HB_TAGS` 提取器与 DOMPurify `ADD_TAGS`，标题不再显示为原始 HTML。
- 🇬🇧 **Fixed placeholder token ordering bug**: `HBRAW` blocks are now restored before `HTML` inline tokens, fixing the `HTML12ρHTML13` artefact that appeared when inline tags (`<var>`, `<sub>` etc.) were nested inside block elements (`<ul>`, `<div>` etc.).
  **🇨🇳 修复占位符还原顺序 Bug**：将 `HBRAW` 块的还原调整到 `HTML` 内联 token 之前，修复 `<var>` 等标签嵌套在 `<ul>` 内时出现 `HTML12ρHTML13` 乱码的问题。
- 🇬🇧 **1M context window support**: `COMPACT_BUDGET` raised to 600K, `MODEL_CTX_HARD_LIMIT` raised to 900K, and `max_tokens` raised to 32 768 — matching DeepSeek's actual 1M input / 384K output limits. Long conversations no longer hit the 60K hard cap that previously caused premature compaction.
  **🇨🇳 支持 1M 上下文**：`COMPACT_BUDGET` 提升至 60 万，`MODEL_CTX_HARD_LIMIT` 提升至 90 万，`max_tokens` 提升至 32 768，完全匹配 DeepSeek 1M 输入 / 384K 输出的实际规格，彻底解决长对话过早触发压缩或报错的问题。
- 🇬🇧 **System prompt updated**: `h1`–`h6` tags added to the safe HTML tag list; model instructed not to use inline `style=` attributes.
  **🇨🇳 系统提示词更新**：新增 `h1`–`h6` 进安全标签列表，并明确告知模型不要使用内联 `style=` 属性。

### v0.31.0 — Parallel Sub-Agents · Streaming Terminal Cards · v0.31.0

- 🇬🇧 **`spawn_agent`**: launch isolated sub-agents with their own context; multiple sub-agent calls in the same turn now execute in parallel (Phase 1), matching `read_file` / `grep_search` behaviour.
  **🇨🇳 `spawn_agent`**：启动独立上下文的子 Agent；同一轮次的多个子 Agent 调用现在并行执行，与 `read_file` / `grep_search` 行为一致。
- 🇬🇧 **Streaming terminal cards**: `run_shell`, `web_search`, `spawn_agent` outputs now render in expandable cards with live-streaming content.
  **🇨🇳 流式终端卡片**：`run_shell`、`web_search`、`spawn_agent` 输出以可展开卡片实时渲染。
- 🇬🇧 TLS keep-alive retry and large-file streaming safety improvements.
  **🇨🇳** TLS keep-alive 重试与大文件流式安全改进。

### v0.30.13 — Skill Notice UI Refactor · Skill 提示栏重构

- 🇬🇧 **Skill notice bar**: `/skill` chip is now displayed as a dedicated blue pill inside the input row (outside the file-chip area), making the active skill always visible alongside the textarea.
  **🇨🇳 Skill 提示栏**：激活的 `/skill` 现以独立蓝色胶囊显示在输入行内（与文件附件 chip 区分），一眼即可看到当前挂载的 Skill。
- 🇬🇧 File attachment chips and skill chip are now rendered in separate DOM elements — no z-index conflicts, no invisible chips.
  **🇨🇳** 文件附件 chip 与 Skill chip 分离为独立 DOM 元素，彻底消除层叠冲突与不可见 chip 问题。
- 🇬🇧 Input row (`#inp-row`) wraps the skill notice and textarea as a flex row so both are always in view.
  **🇨🇳** 输入行（`#inp-row`）以 flex 布局将提示栏与输入框并排，互不遮挡。

### v0.30.2 — Skill Discovery · Image Attachment · Asset Cleanup · v0.30.2

- 🇬🇧 **Skill discovery**: scans `~/.claude/skills/` & `~/.copilot/skills/` for `SKILL.md` at startup; skills appear in the `/` slash-command menu.
  **🇨🇳 Skill 自动发现**：启动时扫描 `~/.claude/skills/` 与 `~/.copilot/skills/`，发现的 Skill 自动合并进 `/` 菜单。
- 🇬🇧 **Image attachments**: drag or click-attach PNG/JPG/GIF/WebP; thumbnail preview in chip bar; binary-file guard; multimodal `image_url` format sent to DeepSeek vision API.
  **🇨🇳 图片附件**：拖拽或点击附加 PNG/JPG/GIF/WebP；chip 栏缩略图预览；二进制文件友好报错；以 `image_url` 格式发送给视觉 API。
- 🇬🇧 All logo/icon assets consolidated under `imgs/`; webview `localResourceRoots` updated.
  **🇨🇳** 所有 logo 文件统一移入 `imgs/`，Webview 资源根路径同步更新。
- 🇬🇧 Auto-creates `~/.deepcopilot/skills/` directory on activation.
  **🇨🇳** 激活时自动创建 `~/.deepcopilot/skills/` 目录。

### v0.28.14 — UI Overhaul · UI 全面改版

- 🇬🇧 **New branding**: white whale logo on dark background, SVG vector activity bar icon.**🇨🇳 全新品牌形象**：黑底白色小鲸鱼 logo，活动栏矢量图标。
- 🇬🇧 **Cleaner layout**: top toolbar removed; API key 🔑 moved to footer bottom-right.**🇨🇳 更简洁的布局**：顶部工具栏移除，API Key 🔑 移至右下角底栏。
- 🇬🇧 **Auto-grow textarea**: input box grows with content, GH Copilot style (max 200px).**🇨🇳 自适应输入框**：随内容自动增高（对齐 GH Copilot 风格，最高 200px）。
- 🇬🇧 Stability fixes: activation crash from unescaped backtick in system prompt; JS null reference from removed DOM element.
  **🇨🇳** 稳定性修复：系统提示词反引号导致的激活崩溃；DOM 元素删除后 JS 空引用。

### v0.28.3 — HTML Rendering · Account Balance · v0.28.3

- 🇬🇧 **HTML rendering** in chat: model responses render full Markdown + HTML + KaTeX math.**🇨🇳 HTML 渲染**：响应支持完整 Markdown + HTML + KaTeX 数学公式。
- 🇬🇧 **Account balance** widget in footer: shows remaining DeepSeek credit, click to refresh.**🇨🇳 账户余额**：底栏实时显示 DeepSeek 余额，点击刷新。
- 🇬🇧 PR automation tooling improvements.
  **🇨🇳** PR 自动化工具改进。

### v0.28.0 — MCP · Hooks · User Memory · Revert Last Turn

- 🇬🇧 **MCP client** (`src/mcp.js`): connect any MCP stdio tool server; tools appear as `mcp__<server>__<tool>`. Configure via `deepseekAgent.mcp.servers`.
- 🇨🇳 **MCP 客户端**（`src/mcp.js`）：连接任意 MCP stdio 工具服务器，工具以 `mcp__<server>__<tool>` 并列出现，通过 `deepseekAgent.mcp.servers` 配置。
- 🇬🇧 **Post-tool hooks** (`src/hooks.js`): run custom scripts after any tool call. Configure via `.deepcopilot/hooks.json`. Output injected into model context.
- 🇨🇳 **工具后置钩子**（`src/hooks.js`）：任意工具调用后自动执行用户脚本，输出注入模型上下文。
- 🇬🇧 **User memory**: `~/.deepcopilot/memory.md` is injected (capped 4 KB) into every system prompt as "User preferences".
- 🇨🇳 **用户记忆**：`~/.deepcopilot/memory.md`（最多 4KB）注入每次对话的系统提示词。
- 🇬🇧 **Revert last turn**: `revert_last_turn` tool + `deepseekAgent.revertLastTurn` command — roll back all file changes from the current agent turn in one click.
- 🇨🇳 **一键回滚**：`revert_last_turn` 工具与 `deepseekAgent.revertLastTurn` 命令，一键撤销当前轮次所有文件改动。
- 🇬🇧 **Post-edit LSP diagnostics**: errors & warnings auto-appended after every file edit so the model can self-verify.
- 🇨🇳 **编辑后 LSP 诊断**：每次文件编辑后自动追加错误与警告，模型可据此自行修复。

### v0.26.0 — Parallel tools · @file attach · apply_patch · Tool cache

- 🇬🇧 Multiple independent tool calls in one model turn (parallel execution). `@filename` attachment. `apply_patch` for multi-hunk edits. Tool result caching.
- 🇨🇳 单轮多工具并行执行；`@文件名` 附件；`apply_patch` 多 hunk 编辑；工具结果缓存。

### v0.25.0 — Web search

- 🇬🇧 Added `web_search` tool powered by Tavily API.
- 🇨🇳 新增 `web_search` 工具，基于 Tavily API。

### v0.24.2 — Flat tool UI · 工具卡片扁平化

- 🇬🇧 Tool rows are now hairline-bordered, no fill, GitHub-Copilot-Chat style.
- 🇨🇳 工具行改为细线分隔 + 无填充，接近 GitHub Copilot Chat 视觉。

### v0.24.0 — Parallel sessions · 多会话并行

- 🇬🇧 Switch sessions while a run is in flight; events buffer and replay on return. Refactored into modular `src/`.
- 🇨🇳 任务运行中可切走开新对话，事件缓冲、切回自动回放；代码拆分为模块化 `src/`。

### v0.20.0 — Copilot-grade UX overhaul

- 🇬🇧 Stop + Esc, blinking cursor, progress bar, code blocks with Run/Insert/Copy, syntax highlight, fold, hover bar, slash-commands, `@` refs, prompt history, bilingual error cards.
- 🇨🇳 Stop + Esc 中断、闪烁光标、进度条、代码块操作、语法高亮、折叠、悬浮操作栏、斜杠命令、`@` 上下文、↑/↓ 历史、双语错误卡。

> Full history: see [git log](https://github.com/ZhouChaunge/DeepCopilot/commits/main) and [Releases](https://github.com/ZhouChaunge/DeepCopilot/releases).
> 完整历史：见 [git log](https://github.com/ZhouChaunge/DeepCopilot/commits/main) 与 [Releases](https://github.com/ZhouChaunge/DeepCopilot/releases)。

</details>

---

## 📄 License

MIT © [ZhouChaunge](https://github.com/ZhouChaunge). See [LICENSE](./LICENSE).

---

## ⭐ Star History

<a href="https://www.star-history.com/#ZhouChaunge/DeepCopilot&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="https://api.star-history.com/svg?repos=ZhouChaunge/DeepCopilot&type=Date&theme=dark&legend=top-left&_=20260518" />
    <source media="(prefers-color-scheme: light)"
            srcset="https://api.star-history.com/svg?repos=ZhouChaunge/DeepCopilot&type=Date&legend=top-left&_=20260518" />
    <img alt="Deep Copilot Star History"
         src="https://api.star-history.com/svg?repos=ZhouChaunge/DeepCopilot&type=Date&legend=top-left&_=20260518" />
  </picture>
</a>

---

<p align="center">
  <sub>🇨🇳 让高质量 AI 生产力开放、公平、普惠，触手可及。</sub><br/>
  <sub>🇬🇧 Make high-quality AI productivity open, fair, and affordable for everyone.</sub>
</p>

