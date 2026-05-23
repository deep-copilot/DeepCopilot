# Deep Copilot v0.40.0 — UI 视觉统一 · Terminal Early-Exit · 打包清理

> 本版本聚焦三件事：聊天界面的设计语言统一、`run_shell_bg` 的早退捕获窗口、`.vscodeignore` 与发布产物清理。同时修复了 PR #130 的 CodeQL 安全告警。

---

## 🇨🇳 中文说明

### 1. 聊天 UI 视觉重构 🎨
- 引入设计令牌：`--dc-indent` / `--dc-fg-*` / `--dc-accent` / `--dc-rule`
- 8 大容器统一为「2px 左侧色条 + 16px 缩进」节奏：`.tool` 卡片头部、`.tl` 工具行、`.tl-detail` 详情区、`.tool .b` 主体全部对齐
- 工具类型色条：`k-read` / `k-write` / `k-search` / `k-shell` / `k-agent` / `k-plan` / `k-other`,一眼可分
- `.tl-group .tl-summary` 折叠摘要同步采用 2px 色条
- 工具名 chip 由 `<span>` 改为 `<code>`，与正文 monospace 一致

### 2. Thinking 块体验 🧠
模型开始正文输出后，思考块头部自动汇总为 `Thought for Ns` 并折叠，保留头部入口可随时展开复盘。

### 3. Output Style Contract 📝
系统提示词新增"输出风格契约"段，约束等宽规则、列表语义、段落控制、禁用装饰性 emoji，对话排版更稳定。

### 4. Terminal Early-Exit Window ⚡
- `run_shell_bg` 提交后增加 **2.5 秒早退捕获窗口**：若命令在窗口内崩溃/退出（缺依赖、错 cwd、语法错误），同步返回真实的 `exit_code` + 输出，模型立刻看见错误
- 窗口超时则按原 `running` 流程异步推进
- `terminal-monitor` 新增 `markSyncReturnedJob` / `wasSyncReturned`，避免延迟到达的 `bg-job-end` 事件被重复注入

### 5. `.vscodeignore` 清理 🧹
- 移除 14 条失效规则（已删除的 `test/` `data/` `models/` `runs/` 及一批 `.pt` 权重）
- 新增 `.github/**` / `.eslintrc.json` / `.gitleaksignore`
- 按用途分组并加注释，vsix 体积更精简

### 6. 安全修复 🔒
- `media/chat.js`：新增 `isUnsafeKey` 守卫，过滤 `__proto__` / `prototype` / `constructor`，消除 7 处 Remote Property Injection（High）与 2 处 Prototype-Polluting Assignment（Medium）
- `src/chat/agent-loop.js`：移除 `lastSnapshotAt` 死赋值

---

## 🇬🇧 English

### 1. Chat UI Visual Refresh 🎨
- New design tokens: `--dc-indent` / `--dc-fg-*` / `--dc-accent` / `--dc-rule`
- Eight container types now share one **"2px left rule + 16px indent"** rhythm — `.tool` card headers, `.tl` tool rows, `.tl-detail` panels, and `.tool .b` body all align
- Tool-type color rails: `k-read` / `k-write` / `k-search` / `k-shell` / `k-agent` / `k-plan` / `k-other`
- `.tl-group .tl-summary` adopts the same 2px rail
- Tool-name chip changed from `<span>` to `<code>` for monospace alignment

### 2. Thinking-Block UX 🧠
As soon as the model starts streaming, the thought block auto-collapses with a `Thought for Ns` summary while keeping the header clickable for on-demand review.

### 3. Output Style Contract 📝
System prompt gains an "Output style contract" section governing monospace usage, list semantics, paragraph control, and banning decorative emoji — markdown output is far more consistent.

### 4. Terminal Early-Exit Window ⚡
- `run_shell_bg` now races the spawn against a **2.5 s capture window**: if the command crashes/exits inside the window (missing deps, bad cwd, syntax errors), the real `exit_code` + output are returned **synchronously**, so the model sees failures immediately instead of giving up after a fire-and-forget submission
- On timeout, the original async `running` path takes over
- `terminal-monitor` exposes `markSyncReturnedJob` / `wasSyncReturned` to deduplicate the late `bg-job-end` event so the agent loop never re-injects what was already returned

### 5. `.vscodeignore` Cleanup 🧹
- Removed 14 stale rules (deleted `test/` `data/` `models/` `runs/` and a batch of `.pt` weights)
- Added `.github/**` / `.eslintrc.json` / `.gitleaksignore`
- Grouped and commented by purpose — leaner vsix payload

### 6. Security Hardening 🔒
- `media/chat.js`: new `isUnsafeKey` guard filters `__proto__` / `prototype` / `constructor` before any dynamic key write — closes 7× Remote Property Injection (High) and 2× Prototype-Polluting Assignment (Medium) CodeQL findings
- `src/chat/agent-loop.js`: removed dead `lastSnapshotAt` assignment

---

## 🙏 致谢 / Acknowledgements

特别感谢仓库管理员 **[@YSMsimon SY](https://github.com/YSMsimon)** 在本版本中的代码审查、安全告警跟进与发布把关工作。Deep Copilot 的稳定迭代离不开你的支持 💙

Special thanks to repository admin **[@YSMsimon SY](https://github.com/YSMsimon)** for code review, security-alert triage, and release gatekeeping on this version. Deep Copilot would not iterate this smoothly without your support 💙

---

## 📦 安装 / Install

下载附件 `deep-copilot-0.40.0.vsix`，在 VS Code 中：
- 命令面板 → `Extensions: Install from VSIX...` → 选择文件
- 或终端：`code --install-extension deep-copilot-0.40.0.vsix`

Download the attached `deep-copilot-0.40.0.vsix` and install via:
- Command Palette → `Extensions: Install from VSIX...`
- Or CLI: `code --install-extension deep-copilot-0.40.0.vsix`
