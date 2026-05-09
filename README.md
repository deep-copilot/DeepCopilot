<div align="center">

# ⚡ DeepPilot

**A GitHub Copilot-style coding agent for VS Code, powered by DeepSeek V4.**

中文 · [English](#english)

[![VS Code](https://img.shields.io/badge/VS%20Code-1.95+-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![DeepSeek](https://img.shields.io/badge/DeepSeek-V4-3F2DDF)](https://www.deepseek.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-active-brightgreen)

</div>

---

## ✨ 它是什么

**DeepPilot** 把 GitHub Copilot 那种"侧栏对话 + 工具调用 + 计划/待办"的现代体验，搬到了 **DeepSeek V4** 上 —— 全开源、本地后端、可控审批、零订阅费。

> 一句话：**Copilot 的体验，DeepSeek 的成本，自己机器上的隐私。**

## 🚀 核心特性

- **三栏工作区**
  - 左：📋 Plan + ✓ Todos + 🤝 Agents
  - 中：流式对话（Markdown / 代码块 / 文件链接 / 思考链）
  - 右：📁 历史会话（按工作区自动分组）
- **Copilot 风格的会话记忆**：每个项目独立保留对话历史，**重新打开项目自动恢复上次会话**
- **6 个原生工具**：`read_file` · `list_dir` · `grep_search` · `write_file` · `run_shell` · `update_plan`
- **4 档审批策略**：🛡 Manual / ✏️ Auto-Edit / 🚀 Autopilot / 👁 Read-Only
- **DeepSeek V4 双模型**：`v4-pro`（强）/ `v4-flash`（快）+ 思考链可视化
- **极致简洁的工具卡片**：单行 `▶ Read · path/to/file.rs · ✓` 风格，不刷屏
- **代码块工具栏**：一键复制 / 插入到光标 / 跳转文件:行
- **API Key 安全保管**：VS Code SecretStorage，不写明文配置

## 📦 安装

### 方式一：从 Release 下载 vsix（推荐）
1. 到 [Releases](https://github.com/ZhouChaunge/DeepPilot/releases) 下载最新 `deeppilot-x.x.x.vsix`
2. VS Code → 命令面板 → `Extensions: Install from VSIX...`

### 方式二：从源码构建
```powershell
git clone https://github.com/ZhouChaunge/DeepPilot.git
cd DeepPilot
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension deeppilot-*.vsix
```

## 🔑 首次配置

1. 命令面板 → `DeepSeek: 设置 API Key` → 粘贴 [DeepSeek API Key](https://platform.deepseek.com/)
2. 命令面板 → `DeepSeek: 切换 API Base URL` → 选择「国际」或「中国」
3. 活动栏点击 ⚡ 图标 → 开始对话

> **后端二进制**：DeepPilot 需要 `deepseek-app-server` 作为本地代理。它会从工作区 `target/release/` 自动发现，或在配置项 `deepseekAgent.serverExecutablePath` 指定路径。预编译产物可在 [DeepSeek-TUI Releases](https://github.com/Hmbown/DeepSeek-TUI/releases) 获取。

## 🎬 使用

| 操作 | 快捷方式 |
|---|---|
| 打开侧栏 | 活动栏 ⚡ |
| 开新窗口标签 | `DeepSeek: 在新标签页中打开` |
| 切左栏 | 工具栏 ▦ |
| 切右栏（会话） | 工具栏 ☰ |
| 新建会话 | 工具栏 ➕ |
| 仅本工作区 / 全部 | 右栏头部 📁 / 🌐 |
| 包含当前文件 | 工具栏 📎 |

## 🧠 它和 Copilot 的差异

| | DeepPilot | GitHub Copilot |
|---|---|---|
| 模型 | DeepSeek V4 (Pro/Flash) | GPT/Claude（订阅） |
| 价格 | 按量计费，¥0.5–¥16 / Mtok | $10/月起 |
| 本地后端 | ✅ Rust 二进制 | ❌ 仅云端 |
| 审批粒度 | 4 档（含 Read-Only） | 较粗 |
| 会话按工作区记忆 | ✅ 默认开启 | ✅ |
| 思考链可视 | ✅ Reasoner 模型完整展示 | 部分 |
| 完全开源 | ✅ MIT | ❌ |

## 🛠️ 配置项

```jsonc
{
  "deepseekAgent.defaultModel": "deepseek-v4-pro",
  "deepseekAgent.approvalMode": "manual",
  "deepseekAgent.apiBaseUrl": "",      // 留空=国际站
  "deepseekAgent.serverPort": 8787,
  "deepseekAgent.serverExecutablePath": ""
}
```

## 🗺️ Roadmap

- [ ] Marketplace 正式上架
- [ ] 内置后端二进制（无需手动部署 deepseek-app-server）
- [ ] @-mentions（文件 / 符号 / 选区）
- [ ] 内联 Quick Fix（错误一键问 DeepPilot）
- [ ] MCP 工具协议支持
- [ ] 多 Agent 协作（Planner / Coder / Reviewer）

## 🤝 贡献

PR / Issue 都欢迎。请先看 [CHANGELOG](CHANGELOG.md) 了解最近改动。

## 📄 License

[MIT](LICENSE) © 2026 ZhouChaunge

> Built on top of the excellent [DeepSeek-TUI](https://github.com/Hmbown/DeepSeek-TUI) Rust workspace by Hmbown.

---

<a id="english"></a>

## English (TL;DR)

**DeepPilot** is an open-source VS Code extension that brings a GitHub Copilot-class experience to **DeepSeek V4**:

- **3-column workspace** (Plan/Todos · Chat · Sessions)
- **Per-workspace session memory** — reopen a project, your last conversation comes back
- **Native tools**: read/list/search/write/shell/plan, with 4-tier approval
- **Streaming markdown + reasoning + file-link jumps + one-click insert**
- **MIT licensed**, self-hosted backend, no subscription

Install the latest `.vsix` from [Releases](https://github.com/ZhouChaunge/DeepPilot/releases), set your DeepSeek API key, and click the ⚡ icon in the Activity Bar.
