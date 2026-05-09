# Deep Copilot

<p align="center">
  <img src="media/logo.png" alt="Deep Copilot" width="180" />
</p>

> 嵌入 VS Code 的 AI 编程助手，由 DeepSeek V4 驱动。无需后端、无需 Docker、无需 Rust —— 纯 JavaScript 单文件扩展，开箱即用。

[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.95.0-blue)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-0.20.0-success)](https://github.com/ZhouChaunge/DeepCopilot/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

Deep Copilot 是一个把 Copilot 风格的 AI Agent 直接搬进 VS Code 的扩展。它通过 DeepSeek API（OpenAI 兼容协议）与模型对话，调用工具读写文件、搜索代码、执行 Shell 命令，并把整个过程实时呈现在侧边栏中。

---

## 目录

- [核心能力](#核心能力)
- [v0.20 新增 UX](#v020-新增-ux)
- [快速开始](#快速开始)
- [配置项](#配置项)
- [快捷键](#快捷键)
- [使用技巧](#使用技巧)
- [架构](#架构)
- [开发与构建](#开发与构建)
- [License](#license)

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **Agent 多轮对话** | 与 DeepSeek V4（Pro / Flash / Reasoner）多轮 tool-calling 循环 |
| **文件工具** | 读文件、写文件、列目录、ripgrep 全文搜索 |
| **终端工具** | 执行 Shell 命令，按审批模式决定是否需用户确认 |
| **Plan & Todos** | Agent 可在左侧栏建立结构化计划并实时勾选 |
| **会话历史** | 每个工作区独立保存，可浏览 / 搜索 / 恢复 |
| **审批模式** | Manual / Auto-Edit / Autopilot / Read-Only |
| **流式输出** | 逐 token 渲染，思考过程（reasoning）可单独展开 |
| **成本统计** | 状态栏实时显示 token 数与人民币花费 |

---

## v0.20 新增 UX

完整 Copilot 级体验改造，覆盖输入、流式控制、代码块、错误处理等所有交互面：

### 流式控制
- ⏹ **Stop 按钮** —— 生成中点击或按 `Esc` 立即中断
- ▍ **闪烁光标** —— 流式输出尾部实时跟随
- **顶部进度条** —— 2px 渐变动画，生成完成自动消失

### 代码块
- **终端块** —— `bash` / `sh` / `zsh` / `powershell` / `cmd` 自动渲染为黑色终端外观，带 `$` 或 `PS>` 提示符
  - **▶ 运行** —— 在专用 `Deep Copilot` 终端中执行
  - **→ 插入终端** —— 仅插入命令文本，不回车
  - **复制**
- **语法高亮** —— 零依赖正则高亮器，支持 js / ts / py / json / css / rs / go / c / c++ / java / yaml / toml / md，light/dark 自适应
- **长代码折叠** —— 超过 24 行自动折叠到 16 行 + 渐变遮罩 + `… 展开全部 N 行` 按钮

### 消息操作
- **悬浮操作栏** —— 鼠标悬停每条 assistant 消息，右上角出现：
  - 📋 **复制** —— 复制原始 Markdown 源文（不是渲染后的 HTML）
  - 🔄 **重新生成** —— 删除当前回复，以同一问题重跑
  - 👍 / 👎 —— 本地反馈，不上报任何遥测

### 输入增强
- **斜杠命令** —— 输入 `/` 弹出命令面板：

  | 命令 | 含义 |
  |------|------|
  | `/explain` | 详细解释下面这段代码 |
  | `/fix`     | 找 bug 并修复 |
  | `/tests`   | 写完整的单元测试 |
  | `/doc`     | 补全文档注释 |
  | `/refactor` | 重构提升清晰度/性能 |
  | `/clear`   | 清空当前会话 |

- **@ 上下文** —— 输入 `@` 弹出：`@file` `@selection` `@terminal`，自动开启相应的上下文附带
- **历史召回** —— 输入框为空时按 ↑/↓ 翻最近 50 条历史 prompt
- **键盘** —— `Ctrl/Cmd+K` 清空 · `Esc` 停止 · `Enter` 发送 · `Shift+Enter` 换行

### 错误处理
- **中文错误卡片** —— 401/402/403/429/400/5xx/网络错误/Abort 全部映射为友好中文标题 + 解决建议
- **HTTP 状态徽章** + **🔄 重试按钮**（仅可重试错误显示）+ **可折叠原始详情**

### 文件引用
- 回复中的 `path/to/file.ext:42` 自动渲染为可点击锚点
- 后端按工作区根多重 try，匹配不到时用 `findFiles` 模糊搜索；多结果弹出 QuickPick 让你选

---

## 快速开始

### 方式 1：从 Release 安装（推荐）

1. 前往 [Releases](https://github.com/ZhouChaunge/DeepCopilot/releases) 下载最新 `deep-copilot-0.20.0.vsix`
2. 在 VS Code 中执行：

   ```bash
   code --install-extension deep-copilot-0.20.0.vsix
   ```

   或：扩展视图右上角「⋯」菜单 → `Install from VSIX...`

### 方式 2：源码安装

```bash
git clone https://github.com/ZhouChaunge/DeepCopilot.git
cd DeepCopilot
npm install -g @vscode/vsce
vsce package --no-dependencies
code --install-extension deep-copilot-0.20.0.vsix
```

### 配置 API Key

1. 重新加载 VS Code（`Ctrl+Shift+P` → `Developer: Reload Window`）
2. 点击活动栏的 Deep Copilot 图标打开侧边栏
3. 点击工具栏右上角 🔑 按钮，粘贴你的 [DeepSeek API Key](https://platform.deepseek.com/api_keys)
4. 开始对话

---

## 配置项

在 `settings.json` 中可调：

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `deepseekAgent.defaultModel` | `deepseek-v4-pro` | 模型：`deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-reasoner` |
| `deepseekAgent.apiBaseUrl` | `https://api.deepseek.com` | API 入口（国内可改 `https://api.deepseeki.com`） |
| `deepseekAgent.approvalMode` | `manual` | `manual` / `auto-edit` / `autopilot` / `readonly` |
| `deepseekAgent.autoApproveTools` | `[]` | 始终自动允许的工具名列表 |
| `deepseekAgent.denyTools` | `[]` | 始终拒绝的工具名列表 |

### 审批模式说明

| 模式 | 行为 |
|------|------|
| **manual** | 所有写文件 / 跑 Shell 都弹窗确认 |
| **auto-edit** | 自动允许文件修改，但 Shell 仍需确认 |
| **autopilot** | 全部自动放行（适合受信任的工作区） |
| **readonly** | 只允许读操作，完全禁止写入 |

---

## 快捷键

| 按键 | 动作 |
|------|------|
| `Ctrl/Cmd+Shift+D` | 打开 Deep Copilot 侧边栏 |
| `Ctrl/Cmd+Shift+L` | 在独立标签页中打开 |
| `Enter`             | 发送消息 |
| `Shift+Enter`       | 换行 |
| `Esc`               | 停止当前生成 |
| `Ctrl/Cmd+K`        | 清空当前会话 |
| `↑` / `↓`（输入框为空时） | 召回历史 prompt |
| `↑` / `↓`（命令面板内） | 切换候选项 |
| `Tab` / `Enter`（命令面板内） | 应用候选项 |

---

## 使用技巧

### 让 Agent 关注特定文件

在输入框点 📎 按钮，或输入 `@file` / `@selection`，Agent 在下次对话时会自动附带当前文件 / 选中区。

### 一句话生成测试

输入 `/tests` 后按 Tab，自动展开为「请为下列代码编写完整的单元测试…」，把代码贴在后面发送即可。

### 直接运行命令

让 Agent 给你一段 bash / pwsh 命令后，点代码块右上角 **▶ 运行** 即可在专用终端执行，无需复制粘贴。

### 跳到引用的文件

回复中出现 `src/extension.js:147` 这样的链接时，直接点击 → VS Code 打开文件并跳到对应行。

---

## 架构

```
┌────────────────────────────────────────────┐
│       VS Code Extension Host               │
│  ┌──────────────────────────────────────┐  │
│  │ extension.js（约 1700 行，纯 JS）     │  │
│  │  ├─ ChatViewProvider                  │  │
│  │  │   ├─ Webview UI（侧边栏 / Tab）    │  │
│  │  │   ├─ 会话存储（workspaceState）    │  │
│  │  │   └─ Plan / Todos 渲染             │  │
│  │  ├─ Agentic Loop                      │  │
│  │  │   ├─ System Prompt                 │  │
│  │  │   ├─ Tool Definitions              │  │
│  │  │   ├─ DeepSeek SSE 流式调用         │  │
│  │  │   └─ Tool 执行 + 审批              │  │
│  │  └─ Friendly Error Mapping            │  │
│  └─────────────────┬────────────────────┘   │
└────────────────────┼───────────────────────┘
                     │ HTTPS
              ┌──────▼──────────────┐
              │   DeepSeek API      │
              │ api.deepseek.com    │
              └─────────────────────┘
```

**Webview 资源**：`media/chat.css`（样式）+ `media/chat.js`（前端逻辑），通过 `webview.asWebviewUri` + CSP nonce 安全加载，不内联。

无 Rust 后端、无 Docker、运行时无 `node_modules` 依赖 —— 仅依赖 VS Code 内置的 Node.js。

---

## 开发与构建

### 本地调试

```bash
git clone https://github.com/ZhouChaunge/DeepCopilot.git
cd DeepCopilot
code .
# 按 F5 启动 Extension Development Host
```

### 打包发布

```bash
npm install -g @vscode/vsce
vsce package --no-dependencies
# → deep-copilot-0.20.0.vsix
```

### 验证语法（无构建过程）

```powershell
node -c extension.js
node -e "new Function(require('fs').readFileSync('media/chat.js','utf8'))"
```

---

## 路线图

v0.20 的所有阶段（参见 [Issue #1](https://github.com/ZhouChaunge/DeepCopilot/issues/1)）：

| Phase | 内容 | 状态 |
|-------|------|------|
| 0 | Webview 资源外置 | ✅ |
| 1 | Stop 按钮 + 流式光标 | ✅ |
| 2 | 终端命令块 + Run / Insert | ✅ |
| 3 | 语法高亮 + 长代码折叠 | ✅ |
| 4 | 消息悬浮操作栏 | ✅ |
| 5 | 斜杠命令 + @ 上下文 + 历史 | ✅ |
| 6 | 错误卡片 + 进度条 | ✅ |
| 7 | 文件引用 chip | ✅ |
| 8 | 打包 + Release v0.20.0 | ✅ |

---

## License

MIT © 2024-2026 ZhouChaunge

---

## 相关

- [DeepSeek 平台](https://platform.deepseek.com/) —— 注册 / 充值 / 拿 API Key
- [DeepSeek API 文档](https://api-docs.deepseek.com/) —— 模型、计费、参数说明
- [VS Code Extension API](https://code.visualstudio.com/api) —— 扩展开发参考
