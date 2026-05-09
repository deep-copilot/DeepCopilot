# Deep Copilot

> **AI coding agent embedded in VS Code. Powered by DeepSeek V4. Standalone �?no backend, no Docker, no Rust required.**

[![VS Code](https://img.shields.io/badge/VS%20Code-%3E%3D1.95.0-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

Deep Copilot is a VS Code extension that brings a Copilot-style AI agent directly into your editor. It talks to the DeepSeek API (OpenAI-compatible), executes tools (read/write files, search, shell), and displays everything in a rich sidebar �?all from a single JavaScript file.

![Deep Copilot screenshot](media/screenshot.png)

---

## Features

- **Agentic Chat** �?multi-turn tool-calling loop with DeepSeek V4 (Pro / Flash / Reasoner)
- **File Tools** �?read, write, list directories, ripgrep-powered search
- **Shell Access** �?run terminal commands with user approval gates
- **Plan & Todos** �?the agent can create and track a structured work plan in the sidebar
- **Session History** �?conversations saved per workspace, browse/search/restore
- **Approval Modes** �?Manual / Auto-Edit / Autopilot / Read-Only
- **Code Insertion** �?one-click insert generated code into the active editor
- **Streaming** �?token-by-token response with thinking/reasoning visualization
- **Cost Tracking** �?real-time token count and cost (CNY) in the status bar

---

## Requirements

| What | Details |
|------|---------|
| **VS Code** | >= 1.95.0 |
| **DeepSeek API Key** | [Get one here](https://platform.deepseek.com/api_keys) |
| **Node.js** | Not required separately (bundled in VS Code) |
| **Backend** | Not required �?calls DeepSeek API directly |

---

## Quick Start

1. Install from `.vsix` or copy `extension.js` + `media/` + `package.json` to `~/.vscode/extensions/deepseek-agent/`
2. Reload VS Code (`Cmd+Shift+P` -> `Developer: Reload Window`)
3. Click the �?icon in the activity bar
4. On first launch you'll be prompted to set your API Key
5. Start chatting �?the agent can read/write files, search code, and run shell commands

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `deepseekAgent.defaultModel` | `deepseek-v4-pro` | Model: v4-pro, v4-flash, reasoner |
| `deepseekAgent.apiBaseUrl` | `https://api.deepseek.com` | API endpoint (China: `https://api.deepseeki.com`) |
| `deepseekAgent.approvalMode` | `manual` | Approval: manual, auto-edit, autopilot, readonly |
| `deepseekAgent.autoApproveTools` | `[]` | Tools to always auto-approve |
| `deepseekAgent.denyTools` | `[]` | Tools to always deny |

---

## Architecture

```
┌─────────────────────────────────────�?�?          VS Code Extension          �?�? extension.js (1688 lines, pure JS) �?�? ┌───────────────────────────────�? �?�? �?    ChatViewProvider          �? �?�? �? - webview (chat.html)        �? �?�? �? - session history            �? �?�? �? - plan/todos sidebar         �? �?�? └──────────┬────────────────────�? �?�?            �?                       �?�? ┌──────────▼────────────────────�? �?�? �?    Agentic Loop              �? �?�? �? - System prompt              �? �?�? �? - Tool definitions           �? �?�? �? - Streaming API calls        �? �?�? �? - Tool execution             �? �?�? └──────────┬────────────────────�? �?�?            �?HTTPS                  �?└─────────────┼───────────────────────�?              �?     ┌────────▼────────�?     �? DeepSeek API    �?     �? api.deepseek.com�?     └─────────────────�?```

No Rust backend. No Docker. No `node_modules` at runtime. Just VS Code's built-in Node.js.

---

## Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+Shift+D` / `Cmd+Shift+D` | Open Deep Copilot sidebar |
| `Ctrl+Shift+L` / `Cmd+Shift+L` | Open in dedicated tab |

---

## License

MIT © 2024-2025 ZhouChaunge

---

## Related

- [Deep Copilot](https://github.com/Hmbown/DeepSeek-TUI) �?the full terminal-based agent suite
- [DeepSeek Platform](https://platform.deepseek.com/) �?get your API key

