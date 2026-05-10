# Deep Copilot

<p align="center">
  <img src="media/logo.png" alt="Deep Copilot" width="180" />
</p>

<p align="center">
  <b>🇨🇳 嵌入 VS Code 的 AI 编程助手 · 由 DeepSeek V4 驱动</b><br/>
  <b>🇬🇧 An AI coding agent embedded in VS Code, powered by DeepSeek V4</b>
</p>

<p align="center">
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS%20Code-%E2%89%A51.95.0-blue" alt="VS Code"/></a>
  <a href="https://github.com/ZhouChaunge/DeepCopilot/releases"><img src="https://img.shields.io/badge/version-0.24.2-success" alt="Version"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"/></a>
</p>

> **🇨🇳** Deep Copilot 是一个把 Copilot 风格的 AI Agent 直接搬进 VS Code 的扩展。它通过 DeepSeek API（OpenAI 兼容协议）与模型对话，调用工具读写文件、搜索代码、执行 Shell 命令，并把整个过程实时呈现在侧边栏中。**无需后端、无需 Docker、无需 Rust**，纯 Node.js / 浏览器 API 实现。
>
> **🇬🇧** Deep Copilot brings a Copilot-style AI agent directly into VS Code. It talks to DeepSeek (OpenAI-compatible) and lets the model call tools to read/write files, search code, and run shell commands — streamed live into the sidebar. **No backend, no Docker, no Rust** — pure Node.js + browser APIs.

---

## 📑 Table of Contents · 目录

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
- [License](#-license)

---

## ✨ Highlights · 亮点

| 🇬🇧 EN | 🇨🇳 中文 |
|---|---|
| **Agentic loop** with multi-turn tool calling on DeepSeek V4 (Pro / Flash / Reasoner) | 与 DeepSeek V4（Pro / Flash / Reasoner）多轮 **tool-calling 循环** |
| **File tools**: read, write, list directory, ripgrep-style full-text search | **文件工具**：读 / 写 / 列目录 / 全文搜索 |
| **Shell tool** with configurable approval policy | **终端工具**，按审批策略弹窗确认 |
| **Plan & Todos** panel — agent maintains a structured plan you can watch tick off | **Plan & Todos** 面板，Agent 自维护结构化任务并实时勾选 |
| **Per-workspace session history** with search, rename, delete | 每工作区独立的**会话历史**，可搜索 / 重命名 / 删除 |
| **Parallel sessions** — switch away from a running task and start another; live replay on return | **多会话并行**：任务跑着可以切走开新对话，回来自动回放进度 |
| **Streaming output** with reasoning expander, blinking cursor, top progress bar | **流式输出**：思维链可展开、闪烁光标、顶部进度条 |
| **Approval modes**: Manual / Auto-Edit / Autopilot / Read-Only | **审批模式**：手动 / 自动编辑 / 全自动 / 只读 |
| **Cost telemetry** in CNY shown in the footer | 状态栏显示 **token 数与人民币成本** |
| **Slash commands** (`/explain`, `/fix`, `/tests` …) and **`@` context refs** | **斜杠命令**与 **`@` 上下文引用** |
| **Smart code-block actions**: Run in terminal · Insert · Copy · Fold long blocks | **代码块操作**：在终端运行 / 插入 / 复制 / 长代码折叠 |
| **Bilingual UI**: auto follows VS Code locale (zh-cn / en) | **中英双语 UI**：跟随 VS Code 语言自动切换 |

---

## 🚀 Quick Start · 快速开始

### Option 1 — Install the prebuilt VSIX · 安装预构建 VSIX（推荐）

```bash
# 🇬🇧 Download the latest release from GitHub
# 🇨🇳 从 GitHub Releases 下载最新版
# https://github.com/ZhouChaunge/DeepCopilot/releases

# Then install:
code --install-extension deep-copilot-0.24.2.vsix
```

Or in VS Code: **Extensions** view → `⋯` menu → **Install from VSIX...** and pick the file.
或在 VS Code 扩展面板右上角 `⋯` → **Install from VSIX...** 选择该文件。

### Option 2 — Set the API key · 配置 API Key

1. Reload window (`Ctrl/Cmd+Shift+P` → `Developer: Reload Window`).
   重载窗口（`Ctrl/Cmd+Shift+P` → `Developer: Reload Window`）。
2. Click the Deep Copilot icon in the activity bar.
   点击活动栏的 Deep Copilot 图标打开侧边栏。
3. Click the 🔑 button in the toolbar, paste your [DeepSeek API key](https://platform.deepseek.com/api_keys).
   点击工具栏 🔑 按钮，粘贴你的 [DeepSeek API Key](https://platform.deepseek.com/api_keys)。
4. Start chatting!  开始对话！

> **🇨🇳 国内用户提示**：如果连接 `api.deepseek.com` 不稳定，点 🔑 旁边的 🌐 图标切到 `https://api.deepseeki.com`。
>
> **🇬🇧 China users**: if `api.deepseek.com` is slow, switch to `https://api.deepseeki.com` via the 🌐 toolbar button.

---

## 🛠 Build from Source · 源码构建

### Prerequisites · 前置依赖

| Tool | Version | Note |
|---|---|---|
| **Node.js** | ≥ 18 | esbuild + vsce |
| **npm**     | ≥ 9  | comes with Node |
| **VS Code** | ≥ 1.95 | extension host |
| **Git**     | any  | optional, to clone |

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
# → outputs out/extension.js (≈ 58 KB minified)
# → 产出 out/extension.js（约 58KB，已压缩）

# 4. Package as VSIX · 打包 VSIX
npm run package
# → outputs release/deep-copilot-0.24.2.vsix
# → 产出 release/deep-copilot-0.24.2.vsix

# 5. Install locally · 本地安装
code --install-extension release/deep-copilot-0.24.2.vsix --force
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

| Path | Tracked? | Purpose |
|---|---|---|
| `src/`              | ✅ yes | Source modules (entry: `src/extension.js`) · 源码（入口 `src/extension.js`） |
| `media/`            | ✅ yes | Webview assets (chat.css / chat.js / icons) · Webview 静态资源 |
| `esbuild.config.js` | ✅ yes | Bundler config · 打包配置 |
| `package.json`      | ✅ yes | Manifest + scripts · 清单与脚本 |
| `package-lock.json` | ✅ yes | Locked dep versions · 锁定依赖版本 |
| `out/extension.js`  | ❌ ignored | Built bundle (regenerated by `npm run build`) · 构建产物 |
| `release/*.vsix`    | ❌ ignored | Packaged extension (regenerated by `npm run package`) · 打包后的 VSIX |
| `node_modules/`     | ❌ ignored | npm cache · npm 依赖缓存 |

> **🇬🇧** Everything required to compile is in the repo. `out/` and `*.vsix` are reproducible artifacts.
> **🇨🇳** 编译所需文件全部在仓库里。`out/` 和 `*.vsix` 是可重现的产物，已 `.gitignore`。

---

## ⚙️ Configuration · 配置

All settings live under the `deepseekAgent.*` namespace in `settings.json`.
所有设置都在 `settings.json` 的 `deepseekAgent.*` 命名空间下。

| Setting | Default | EN | 中文 |
|---|---|---|---|
| `deepseekAgent.defaultModel` | `deepseek-v4-pro` | Default model | 默认模型（`deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-reasoner`） |
| `deepseekAgent.apiBaseUrl` | *(empty → `api.deepseek.com`)* | API endpoint | API 入口（国内可填 `https://api.deepseeki.com`） |
| `deepseekAgent.approvalMode` | `manual` | Tool-call approval policy | 工具调用审批策略 |
| `deepseekAgent.interactionMode` | `agent` | `agent` / `ask` | 交互模式（Agent 可调工具，Ask 纯聊天） |
| `deepseekAgent.autoApproveTools` | `[]` | Tool names to always allow | 始终自动允许的工具名 |
| `deepseekAgent.denyTools` | `[]` | Tool names to always deny | 始终拒绝的工具名 |
| `deepseekAgent.maxIterations` | `15` | Hard ceiling on tool-call rounds | 单次发送的工具调用迭代上限 |
| `deepseekAgent.compactBudgetTokens` | `96000` | Token budget before auto-compaction | 自动压缩历史前的 token 预算 |
| `deepseekAgent.enableDebugLog` | `true` | Log thought / tool / API events to `.deep-copilot/logs/` | 写思维链 / 工具 / API 事件日志 |

### Approval Modes · 审批模式

| Mode | EN behavior | 中文行为 |
|---|---|---|
| **manual**   | Prompt every `write_file` / `run_shell` (safest, default) | 每次写文件或执行命令都弹窗（默认） |
| **auto-edit**| Auto-approve writes; still prompt for shell             | 写文件自动通过；Shell 仍需确认 |
| **autopilot**| Auto-approve everything (trusted workspaces only)        | 全部自动通过（仅适合受信任工作区） |
| **readonly** | Deny all writes & shell                                 | 仅允许只读，禁止任何修改 |

---

## ⌨️ Keybindings · 快捷键

| Key | EN | 中文 |
|---|---|---|
| `Ctrl/Cmd+Shift+D` | Open sidebar | 打开侧边栏 |
| `Ctrl/Cmd+Shift+L` | Open in tab | 在标签页中打开 |
| `Enter`            | Send message | 发送消息 |
| `Shift+Enter`      | Newline | 换行 |
| `Esc`              | Stop generation | 停止生成 |
| `Ctrl/Cmd+K`       | Clear current chat | 清空当前会话 |
| `↑` / `↓` (empty input) | Recall prompt history | 召回历史 prompt |
| `↑` / `↓` (slash menu open) | Navigate suggestions | 切换候选项 |
| `Tab` / `Enter` (slash menu) | Apply suggestion | 应用候选项 |

---

## 🧰 Tools · 工具列表

Deep Copilot exposes a small, deliberately-minimal tool set to the model:
Deep Copilot 给模型暴露的工具集刻意保持精简：

| Tool | EN description | 中文说明 |
|---|---|---|
| `read_file`            | Read part / all of a file with optional line range | 按行号区间读取文件 |
| `write_file`           | Create or overwrite a file (gated by approval) | 新建 / 覆盖文件（受审批控制） |
| `str_replace_in_file`  | Targeted in-place edit by exact string match | 通过字符串精确替换原地编辑 |
| `list_dir`             | List directory entries (depth-limited) | 列出目录（限制深度） |
| `grep_search`          | Ripgrep-style regex search across the workspace | 工作区级正则搜索 |
| `run_shell`            | Run a shell command (gated by approval) | 执行 Shell 命令（受审批控制） |
| `update_plan`          | Push / update structured plan & todos to left panel | 更新左侧 Plan / Todos |
| `open_file_in_editor`  | Reveal a file at a given line in the editor | 在编辑器中打开文件并跳到指定行 |

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

- **🇬🇧 No backend.** Everything runs inside the VS Code extension host. The single bundle `out/extension.js` is ≈58 KB.
  **🇨🇳 无后端。** 全部跑在 VS Code 扩展主机里，单文件构建产物 `out/extension.js` 仅约 58KB。
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
│   ├── chat.js                #   ↳ webview runtime (markdown, tool cards, streaming)
│   ├── icon.svg
│   └── logo.png
├── imgs/
│   └── screenshot.png         # README screenshot · README 截图
└── src/                       # extension source · 扩展源码
    ├── extension.js           #   ↳ activate() entry · 入口
    ├── errors.js              #   ↳ error → friendly bilingual card
    ├── logger.js              #   ↳ debug log writer (.deep-copilot/logs/)
    ├── pricing.js             #   ↳ token → CNY cost calculator
    ├── api/
    │   └── deepseek.js        #   ↳ SSE chat client (OpenAI-compatible)
    ├── chat/
    │   ├── provider.js        #   ↳ ChatViewProvider (the brain)
    │   └── openFile.js        #   ↳ "open file at line" helper
    ├── prompts/
    │   └── system.js          #   ↳ system prompt builder (+DEEPCOPILOT.md merge)
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

### Style & conventions · 代码风格

- Plain JavaScript (no TypeScript) — keep the bundle tiny.
  纯 JavaScript（不用 TypeScript），保持产物极小。
- No runtime dependencies — only VS Code API + Node built-ins.
  无运行时依赖，只用 VS Code API 与 Node 内置模块。
- Webview side communicates via `postMessage`; never imports `vscode`.
  Webview 端通过 `postMessage` 通信，不引用 `vscode`。

---

## 🔧 Troubleshooting · 故障排查

| Symptom · 症状 | 🇬🇧 Fix | 🇨🇳 解决 |
|---|---|---|
| `请先设置 API Key` toast | Click 🔑 in the toolbar, paste the key | 点 🔑 粘贴 Key |
| 401 / 403 errors | Key invalid or revoked — regenerate at platform.deepseek.com | Key 失效，到 platform.deepseek.com 重新生成 |
| 402 errors | Account out of balance — top up | 账户余额不足，请充值 |
| 429 errors | Rate-limited; retry button is shown on the error card | 触发限流，点错误卡上的 🔄 重试 |
| Connection timeouts in mainland China | Switch base URL to `https://api.deepseeki.com` | 切到 `https://api.deepseeki.com` |
| UI still shows "思考中" | Old VSIX still installed — install the new one with `--force` | 装新版用 `--force` 覆盖旧版 |
| Tools not being called | You may be in `Ask` mode — switch to `Agent` in the header | 当前是 `Ask` 模式，切到 `Agent` |
| Hangs mid-task | Click ⏹ Stop or press `Esc`; check Debug Log | 点 ⏹ 或按 `Esc` 停止；查看调试日志 |

---

## 📜 Changelog · 更新日志

### v0.24.2 — Flat tool UI · 工具卡片扁平化
- 🇬🇧 Tool rows are now hairline-bordered, no fill, GitHub-Copilot-Chat style.
- 🇨🇳 工具行改为细线分隔 + 无填充，接近 GitHub Copilot Chat 视觉。

### v0.24.1 — No more "思考中" banner · 取消顶部"思考中"
- 🇬🇧 Removed the global `⚡ 思考中…` status banner. Per-session busy is shown as a pulsing blue dot in the Sessions list (Copilot-style).
- 🇨🇳 移除全局"⚡ 思考中…"状态条。会话级忙碌通过 Sessions 列表里的呼吸蓝点呈现。

### v0.24.0 — Parallel sessions · 多会话并行
- 🇬🇧 Switch sessions while a run is in flight; events buffer and replay on return. Refactored monolithic `extension.js` into modular `src/`.
- 🇨🇳 任务运行中可切走开新对话，事件缓冲、切回自动回放。单文件 `extension.js` 拆分为模块化 `src/`。

### v0.20.0 — Copilot-grade UX overhaul
- 🇬🇧 Stop button + Esc, blinking cursor, top progress bar, terminal code blocks with **Run** / **Insert** / **Copy**, syntax highlighter, fold-long-blocks, hover action bar (copy / regenerate / 👍👎), slash-commands, `@` context refs, prompt history (↑/↓), bilingual error cards with retry.
- 🇨🇳 Stop 按钮 + Esc 中断、闪烁光标、顶部进度条、终端代码块带 **运行/插入/复制**、语法高亮、长代码折叠、悬浮操作栏（复制 / 重新生成 / 👍👎）、斜杠命令、`@` 上下文、↑/↓ 历史召回、双语错误卡 + 重试。

> Full history: see [git log](https://github.com/ZhouChaunge/DeepCopilot/commits/main) and [Releases](https://github.com/ZhouChaunge/DeepCopilot/releases).
> 完整历史：见 [git log](https://github.com/ZhouChaunge/DeepCopilot/commits/main) 与 [Releases](https://github.com/ZhouChaunge/DeepCopilot/releases)。

---

## 📄 License

MIT © [ZhouChaunge](https://github.com/ZhouChaunge). See [LICENSE](./LICENSE).

---

<p align="center">
  <sub>🇨🇳 让高质量 AI 生产力开放、公平、可负担地惠及每个人。</sub><br/>
  <sub>🇬🇧 Make high-quality AI productivity open, fair, and affordable for everyone.</sub>
</p>
