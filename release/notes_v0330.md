# Deep Copilot v0.33.0 — 史诗级 UI 重构 · Epic UI Overhaul

> 这是 DeepCopilot 有史以来最大规模的界面体验升级，全面对标顶级 AI 编程助手的交互标准。

---

## 🇨🇳 中文说明

### 总览

v0.33.0 以"**少即是多**"为核心理念，对聊天界面进行了三大方向的深度重构：

1. **工具调用展示** — 从繁琐的卡片式布局，蜕变为 Sema / GitHub Copilot 同款的极简单行文本
2. **进度动画** — 彻底重设计底部 Sonar Spinner，删繁就简、加入动态文字与计时
3. **滚动体验** — 修复长回复时进度条被遮挡的顽固性 bug

---

### 一、工具调用 UI 极简化 🔧

**之前的样子：**
每次工具调用都会渲染一个带有图标、三角形展开符、状态标签、分栏的完整卡片，信息密集、视觉嘈杂，尤其在 Agent 连续调用十几个工具时，界面几乎被工具卡堆满。

**现在的样子：**

```
read_file  src/extension.js                       ← 单行灰色文本，点击展开
write_file  media/chat.css                        ← 文件路径更淡、字更小
run_shell  npm run package                        ← 无图标、无边框、无背景
```

**具体改动：**

- **隐藏所有图标**（`display:none`），彻底不占位
- **隐藏三角形展开符**，用更自然的点击交互替代
- **隐藏状态标签**（Running / Done / Error），状态通过动态小点暗示
- **工具名称**：字体缩小至 10.5px，颜色使用 `descriptionForeground`，透明度降至 65%
- **文件/目标路径**：等宽字体 10px，透明度仅 42%，几乎退到背景
- **运行中小动画**：工具名称后接一个琥珀色呼吸小点（`::after` 伪元素），静默指示执行中状态
- **点击展开**：整行可点击，展开后显示完整参数与输出结果
- **思考气泡（Thought）**：移除所有"思考中 Xs"耗时标签，不再在每步工具调用前显示累计秒数——安静专注

**视觉层级（文字颜色由深到浅）：**

| 元素 | 颜色/透明度 |
|------|------------|
| 正文回复 | `foreground`（白色/深色）|
| 工具名称 | `descriptionForeground` × 65% |
| 文件路径 | `descriptionForeground` × 42% |
| 详情内容 | `descriptionForeground` × 68% |

---

### 二、底部进度动画全面重设计 🌊

底部的"正在思考"动画是用户感知 AI 状态的核心视觉元素，此版本对其进行了颠覆性重设计。

**旧版问题：**
- 带背景色、边框、光扫 shimmer 效果，视觉噪声过大
- 没有任何文字信息，用户不知道 AI 在做什么
- 计时信息散落在各思考气泡中，难以追踪

**新版设计语言：**

```
●        Reasoning…   3s  · Esc
↑蓝光波   ↑18px留白   ↑动词  ↑计时 ↑中断提示
```

**Sonar 光波（保留并增强）：**
蓝色同心圆扩散动画完整保留，以 VS Code 主题色（`button.background`）为准，双层脉冲：
- 外层：环形扩散，从 scale(1) 放大至 scale(4)，透明度渐出
- 内层：box-shadow 脉冲，延迟 0.7s，错峰制造连续感
- 停止时：两层动画同时冻结，透明度降至 25%

**透明背景：**
去除所有 `background`、`border`、`shimmer` 效果，整个 spinner 悬浮于内容之上，不遮挡视线、不增加视觉层级。

**英文动词轮播：**
20 个精心挑选的英文动词，每 3 秒随机切换一次，切换时触发 0.55s 渐显动画（`opacity: 0.1 → 1 → 0.85`）：

> `Reasoning…` · `Synthesizing…` · `Cogitating…` · `Deliberating…` · `Computing…` · `Inferring…` · `Distilling…` · `Modeling…` · `Weaving…` · `Decoding…` · `Manifesting…` · `Orchestrating…` · `Ruminating…` · `Pondering…` · `Crafting…` · `Assembling…` · `Percolating…` · `Ideating…` · `Transmuting…` · `Conjuring…`

**实时计时器：**
动词右侧显示已用时间，格式 `1s` / `2m5s`，每秒刷新。让用户清晰感知每一步的耗时。

**中断提示：**
计时器后显示 `· Esc` 提示，窗口宽度不足时自动隐藏（Container Query）。

**停止状态：**
按下 Esc 后，动词立即变为 `Stopping…`，文字颜色切换至 `errorForeground`（红色），Sonar 动画冻结，边框变暗红。

**空间设计：**
光波与动词之间留有 **18px 留白**，给视觉以呼吸感，避免拥挤。

---

### 三、滚动体验修复 📜

**问题：** 在长回复生成过程中，底部进度条会随内容增加而下沉，最终被输入框遮挡，只露出上半部分，用户无法看到完整的动画与计时信息。

**根本原因：**
`ascroll()` 在内容刚插入 DOM 时立即读取 `scrollHeight`，而此时浏览器尚未完成布局计算，`scrollHeight` 返回旧值，导致滚动量不足。

**修复方案（三管齐下）：**

1. **`requestAnimationFrame` 包裹**：将 `msgs.scrollTop = msgs.scrollHeight` 推迟到浏览器完成当帧布局后执行，确保读取的是最新高度
2. **每秒兜底滚动**：在 `_renderStatus` 计时回调末尾追加 `ascroll()` 调用，每秒主动确认一次 spinner 可见性
3. **nearBottom 阈值扩大**：从 80px 提高到 120px，给 spinner 自身高度留出余量，防止过早脱离吸底模式

---

### 受影响文件

| 文件 | 变更内容 |
|------|---------|
| `media/chat.js` | DC_VERBS 动词表、setBusy 重构、_renderStatus 更新、ascroll rAF 修复、makeThinkChip 置空 |
| `media/chat.css` | 工具卡片 CSS 全量重写、dc-spinner 新样式、dcTextFlash 动画 |
| `README.md` | 版本徽章更新、v0.33.0 changelog 条目 |
| `src/` | 其他后端累积修复 |

---

## 🇺🇸 English Release Notes

### Overview

v0.33.0 is the **largest UI overhaul in DeepCopilot's history**, built around the philosophy of *less is more*. Three major areas were redesigned from the ground up:

1. **Tool-call display** — from verbose card-based layout to the same minimal single-line style used by Sema and GitHub Copilot
2. **Progress animation** — completely redesigned Sonar Spinner with dynamic text and a live timer
3. **Scroll experience** — fixed the long-standing bug where the spinner was obscured by the input box

---

### 1. Minimal Tool-Call UI 🔧

**Before:**
Every tool invocation rendered a full card with icons, a chevron toggle, status labels, and multi-column layout. With agents making a dozen+ tool calls, the chat window was effectively buried under cards.

**After:**

```
read_file  src/extension.js                       ← single grey line, click to expand
write_file  media/chat.css                        ← path dimmer, smaller font
run_shell  npm run package                        ← no icon, no border, no background
```

**What changed:**

- **Icons hidden** (`display:none`) — zero pixel footprint
- **Chevrons hidden** — natural click-to-expand replaces the toggle
- **Status badges hidden** — running state indicated by a subtle amber breathing dot
- **Tool name**: 10.5px, `descriptionForeground` at 65% opacity
- **File/target path**: monospace 10px, 42% opacity — almost invisible background detail
- **Running indicator**: an amber breathing dot via `::after` pseudo-element silently signals in-progress state
- **Click to expand**: the entire row is clickable; expands to show full args and output
- **Thought chips**: removed all "Thinking Xs" elapsed labels — no more per-step countdown noise

**Visual hierarchy (text colour, darkest to lightest):**

| Element | Color / Opacity |
|---------|----------------|
| AI reply text | `foreground` (full) |
| Tool name | `descriptionForeground` × 65% |
| File path | `descriptionForeground` × 42% |
| Expanded detail | `descriptionForeground` × 68% |

---

### 2. Sonar Spinner — Complete Redesign 🌊

The bottom progress indicator is the primary visual signal that the AI is working. This version delivers a ground-up redesign.

**Old problems:**
- Background colour, border, and shimmer effect added visual noise
- No text information — users had no idea what the AI was doing
- Elapsed time scattered across thinking chips, hard to track

**New design:**

```
●        Reasoning…   3s  · Esc
↑sonar   ↑18px gap   ↑verb  ↑timer ↑interrupt hint
```

**Sonar wave (retained and enhanced):**
The blue concentric-ring pulse animation is fully preserved, using VS Code theme colour (`button.background`), with a two-layer pulse:
- Outer ring: expands from scale(1) to scale(4), fading out
- Inner glow: `box-shadow` pulse with a 0.7s delay, creating a continuous wave effect
- On stop: both layers freeze, opacity drops to 25%

**Transparent background:**
All `background`, `border`, and `shimmer` effects removed. The spinner floats over content with zero visual weight.

**English verb carousel:**
20 hand-picked English verbs rotate randomly every 3 seconds. Each transition triggers a 0.55s fade-in animation (`opacity: 0.1 → 1 → 0.85`):

> `Reasoning…` · `Synthesizing…` · `Cogitating…` · `Deliberating…` · `Computing…` · `Inferring…` · `Distilling…` · `Modeling…` · `Weaving…` · `Decoding…` · `Manifesting…` · `Orchestrating…` · `Ruminating…` · `Pondering…` · `Crafting…` · `Assembling…` · `Percolating…` · `Ideating…` · `Transmuting…` · `Conjuring…`

**Live elapsed timer:**
Displayed to the right of the verb in `1s` / `2m5s` format, updating every second. Gives users a clear sense of how long each step is taking.

**Interrupt hint:**
`· Esc` displayed after the timer. Auto-hidden when the panel is too narrow (Container Query).

**Stopping state:**
On Esc, the verb immediately changes to `Stopping…`, text colour switches to `errorForeground` (red), the Sonar animation freezes, and the dot dims.

**Breathing room:**
An **18px gap** between the sonar dot and the verb text gives the design room to breathe.

---

### 3. Scroll Fix 📜

**Problem:** During long streaming responses, the spinner sank toward the bottom of the chat area and was eventually hidden behind the input box — only the top half of the animation was visible.

**Root cause:**
`ascroll()` read `scrollHeight` immediately after DOM insertion, before the browser had completed layout. This returned a stale (shorter) height, causing the scroll to fall short.

**Fix — three-pronged approach:**

1. **`requestAnimationFrame` wrapper**: defers `msgs.scrollTop = msgs.scrollHeight` until after the browser finishes the current frame's layout, ensuring the height is fresh
2. **Per-second safety net**: `_renderStatus` now calls `ascroll()` at the end of every 1-second tick, actively verifying spinner visibility
3. **Wider nearBottom threshold**: raised from 80px to 120px, leaving headroom for the spinner's own height and preventing premature detachment from sticky-scroll mode

---

### Files Changed

| File | Change |
|------|--------|
| `media/chat.js` | DC_VERBS array, setBusy rewrite, _renderStatus update, ascroll rAF fix, makeThinkChip no-op |
| `media/chat.css` | Tool card CSS fully rewritten, dc-spinner new styles, dcTextFlash keyframe |
| `README.md` | Version badge updated, v0.33.0 changelog entry added |
| `src/` | Accumulated backend fixes |

---

## 📦 Installation

1. Download `deep-copilot-0.33.0.vsix` below
2. In VS Code: `Extensions` → `···` → `Install from VSIX…`
3. Select the downloaded file and reload

Or via terminal:
```bash
code --install-extension deep-copilot-0.33.0.vsix
```
