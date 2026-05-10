# DeepCopilot v0.24.2

> AI 编码助手 · DeepSeek V4 驱动 · VS Code 原生扩展
> AI Coding Assistant powered by DeepSeek V4 · Native VS Code Extension

## 📦 下载安装 / Download & Install

直接下载下方附件 `deep-copilot-0.24.2.vsix`，然后执行：

Download the `deep-copilot-0.24.2.vsix` attachment below, then run:

```bash
code --install-extension deep-copilot-0.24.2.vsix --force
```

或在 VS Code 中：`扩展面板 → ⋯ → 从 VSIX 安装…`
Or in VS Code: `Extensions Panel → ⋯ → Install from VSIX…`

安装后按 `Ctrl+L` 打开聊天侧栏，首次使用会提示输入 DeepSeek API Key（保存在系统 Secret Storage）。
After install, press `Ctrl+L` to open the chat sidebar. First run will prompt for your DeepSeek API key (stored in the OS secret storage).

---

## ✨ 本版本更新 / What's New in v0.24.2

### UI 重构 / UI Refresh

- **移除全局"⚡ 思考中"横幅** — 顶部不再有打扰式状态条
  *Removed the global "⚡ thinking" banner — no more intrusive top-bar status*
- **会话级忙碌指示器** — 正在思考的会话标题前显示一个呼吸蓝点（仿 GitHub Copilot Chat）
  *Per-session busy indicator — a breathing blue dot next to active session titles, GitHub Copilot Chat style*
- **多会话并行** — 多个会话可同时独立思考，切换会话不会中断后台任务
  *Multi-session parallelism — independent reasoning per session, switching does not interrupt background work*
- **扁平化工具卡** — 工具调用展示从盒装样式改为单线 hairline 样式，去除滑块/装饰元素，整体更接近 Copilot Chat
  *Flattened tool cards — switched from boxed style to hairline rows; removed decorative sliders; closer to Copilot Chat*

### 工程化 / Engineering

- **模块化重构** — 单文件 `extension.js` 拆分为 `src/{api,chat,tools,prompts,utils,webview}` 多模块结构
  *Modular refactor — monolithic `extension.js` split into `src/{api,chat,tools,prompts,utils,webview}`*
- **esbuild 打包** — 引入 `esbuild` 构建管线，产物 `out/extension.js` 约 58KB
  *esbuild bundling — added build pipeline; output `out/extension.js` ~58KB*
- **完整中英对照 README** — 涵盖快速开始、源码构建、配置、架构、故障排查
  *Comprehensive bilingual README — covers quick start, build from source, configuration, architecture, troubleshooting*

---

## 🔑 主要特性 / Key Features

| 中文 | English |
| --- | --- |
| 原生侧栏聊天，支持流式输出 | Native sidebar chat with streaming output |
| 内置工具：读写文件、执行命令、搜索、Diff | Built-in tools: file I/O, shell exec, search, diff |
| 多会话并行思考 | Multi-session parallel reasoning |
| Markdown / 代码块 / Mermaid 渲染 | Markdown / code-block / Mermaid rendering |
| API Key 安全存储（系统 Secret Storage） | Secure API key storage (OS Secret Storage) |
| 支持 DeepSeek Pro / Flash / Reasoner | Supports DeepSeek Pro / Flash / Reasoner |

---

## 🛠️ 系统要求 / Requirements

- VS Code ≥ 1.95.0
- DeepSeek API Key（从 https://platform.deepseek.com 获取）
- *DeepSeek API key from https://platform.deepseek.com*

---

## 📋 完整变更日志 / Full Changelog

详见 [README.md](https://github.com/ZhouChaunge/DeepCopilot/blob/main/README.md#changelog--更新日志)
See [README.md](https://github.com/ZhouChaunge/DeepCopilot/blob/main/README.md#changelog--更新日志) for full details.

**Diff:** [`v0.24.0...v0.24.2`](https://github.com/ZhouChaunge/DeepCopilot/compare/v0.24.0...v0.24.2)

---

## 🐛 反馈 / Feedback

遇到问题请提 Issue：https://github.com/ZhouChaunge/DeepCopilot/issues
Found a bug? Open an issue: https://github.com/ZhouChaunge/DeepCopilot/issues
