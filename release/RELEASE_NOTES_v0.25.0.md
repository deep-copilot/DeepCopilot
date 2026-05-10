# DeepCopilot v0.25.0 — Web Search 🌐

> **新增联网搜索能力 · Adds live web search via Tavily**

## ✨ 本版本亮点 / Highlights

### 🌐 实时联网搜索 / Live Web Search

**新增 `web_search` 工具**，由 [Tavily](https://app.tavily.com) 提供 LLM-optimized 搜索结果。

- ✅ 询问最新事件、最新文档、最新版本号 —— 模型现在可以直接联网查
- ✅ 返回 `{title, url, content}` 结构化结果 + 可选的合成 `answer` 段落
- ✅ 与 LangChain / OpenAI Agents SDK / CrewAI 同款方案（Tavily 是 LLM 工具调用的事实标准）

**Added `web_search` tool** powered by [Tavily](https://app.tavily.com) — the de-facto standard search backend for LLM agents (used by LangChain, OpenAI Agents SDK, CrewAI).

- ✅ Ask about recent events, latest docs, current versions — the model can now look it up
- ✅ Returns structured `{title, url, content}` snippets + optional synthesized `answer`
- ✅ Same backend used by all major Agent frameworks

---

## 🔑 配置 / Configuration

### Step 1 · 申请免费 Key

1. 访问 https://app.tavily.com
2. 邮箱/Google 登录（**无需信用卡**）
3. Dashboard 复制 API Key（格式 `tvly-xxxxxxxx`）
4. **免费额度：1000 次/月**

### Step 2 · 在 VS Code 中配置

打开命令面板（`Ctrl+Shift+P`），运行：

```
Deep Copilot: Set Tavily API Key (Web Search)
```

粘贴你的 key —— 加密保存到 VS Code SecretStorage（与 DeepSeek key 同等保护级别）。

完成后，模型会在适当时机自动调用 `web_search`，例如：
- *"Tell me what happened in AI this week"*
- *"What's the latest version of Vite?"*
- *"Find the official Tavily pricing page"*

### Step 1 · Get a free key

1. Visit https://app.tavily.com
2. Sign in with email/Google (**no credit card needed**)
3. Copy your API key (format `tvly-xxxxxxxx`)
4. **Free tier: 1000 searches/month**

### Step 2 · Configure in VS Code

Open the Command Palette (`Ctrl+Shift+P`) and run:

```
Deep Copilot: Set Tavily API Key (Web Search)
```

The key is encrypted in VS Code SecretStorage (same protection as the DeepSeek key).

---

## 📦 安装 / Install

下载下方附件 `deep-copilot-0.25.0.vsix`，然后：
Download `deep-copilot-0.25.0.vsix` below, then run:

```bash
code --install-extension deep-copilot-0.25.0.vsix --force
```

---

## 🛠️ 工具列表更新 / Updated Tool List

| Tool | Purpose | Network |
| --- | --- | :---: |
| `str_replace_in_file` | Surgical file edit | — |
| `write_file` | Write/overwrite file | — |
| `run_shell` | Run shell command | — |
| `read_file` | Read file content | — |
| `grep_search` | Workspace text search | — |
| `find_files` | Workspace file search | — |
| `list_dir` | List directory | — |
| **`web_search`** | **Live web search (Tavily)** | **🌐 NEW** |
| `update_plan` | Update plan/todos sidebar | — |

---

## 🔒 隐私 / Privacy

- Tavily API key 存于 VS Code SecretStorage（OS Keychain），不写入 `settings.json`
- 仅当模型主动决定调用 `web_search` 时才向 Tavily 发出请求
- 工作区代码不会被发送到 Tavily —— 只发送你显式触发的搜索 query

The Tavily key is stored in VS Code SecretStorage (OS Keychain), never in `settings.json`. Requests to Tavily only happen when the model explicitly decides to call `web_search`. Your workspace code is not sent to Tavily — only the search query you trigger.

---

## 📋 完整变更 / Full Changelog

**Diff:** [`v0.24.2...v0.25.0`](https://github.com/ZhouChaunge/DeepCopilot/compare/v0.24.2...v0.25.0)

- `+` `web_search` tool (Tavily backend, no npm dependency, uses Node `https`)
- `+` Command `deepseekAgent.setTavilyKey` (Set Tavily API Key)
- `+` Tavily key storage in SecretStorage (`deepseekAgent.tavilyKey`)
- `~` Bumped version `0.24.2 → 0.25.0`

---

## 🐛 反馈 / Feedback

https://github.com/ZhouChaunge/DeepCopilot/issues
