# Deep Copilot v0.40.1 — 模型参数刷新（上下文窗口 / 最大输出）

> 本版本只更新 `src/providers/*.json` 里的模型容量参数，使其对齐各厂商最新公开规格；同时把 DeepSeek V4 Pro 的 2.5 折优惠延长为永久（与官方价格调整后的正式定价一致）。无功能代码改动。

---

## 🇨🇳 中文说明

### 一、模型上下文窗口 / 最大输出 全面拉满

| Provider | 模型 | contextWindow | maxOutputTokens |
|---|---|---:|---:|
| DeepSeek | `deepseek-v4-pro` | 1,000,000 | **65,536 → 384,000** |
| DeepSeek | `deepseek-v4-flash` | 1,000,000 | **65,536 → 384,000** |
| OpenAI | `gpt-5.5` | **1,000,000 → 1,050,000** | 128,000 |
| OpenAI | `gpt-5.4` | **1,000,000 → 1,050,000** | 128,000 |
| Anthropic | `claude-opus-4-7` | **200,000 → 1,000,000** | **32,000 → 128,000** |
| Anthropic | `claude-opus-4-6` | **200,000 → 1,000,000** | **32,000 → 128,000** |
| Anthropic | `claude-sonnet-4-6` | **200,000 → 1,000,000** | 64,000 |

> 实际可用上限以各厂商 API 服务端为准；超出的 `max_tokens` 通常会被服务端自动夹到其当前允许的最大值。

### 二、DeepSeek V4 Pro 永久 2.5 折

依据 DeepSeek 官方公告 —— 2026/05/31 23:59 之后官价正式调整为原定价的 **1/4**（即 2.5 折永久化），本版本将 `pricing.discount.until` 从 `2026-05-31T15:59:00Z` 延长到 `2099-12-31T15:59:00Z`，**计费始终按折扣价生效**：

| | 缓存命中 | 缓存未命中 | 输出 |
|---|---:|---:|---:|
| `deepseek-v4-pro`（2.5 折，CNY/1M tokens） | 0.025 | 3.0 | 6.0 |
| `deepseek-v4-flash`（CNY/1M tokens） | 0.02 | 1.0 | 2.0 |

### 三、定价 / 协议层无改动

- OpenAI、Anthropic 仓库中本就未配置 `pricing`，本版本依然保持未配置。
- 所有 provider quirks、协议字段、`max_tokens` / `max_completion_tokens` 切换逻辑均无变更。

---

### 升级方式

**方式一（推荐）**：在 VS Code 扩展面板搜索「Deep Copilot」点击更新。

**方式二**：手动安装 `release/deep-copilot-0.40.1.vsix`
```
Extensions → ··· → Install from VSIX
```

---

## 🇬🇧 English

### 1. Bumped model capacity (context window / max output)

| Provider | Model | contextWindow | maxOutputTokens |
|---|---|---:|---:|
| DeepSeek | `deepseek-v4-pro` | 1,000,000 | **65,536 → 384,000** |
| DeepSeek | `deepseek-v4-flash` | 1,000,000 | **65,536 → 384,000** |
| OpenAI | `gpt-5.5` | **1,000,000 → 1,050,000** | 128,000 |
| OpenAI | `gpt-5.4` | **1,000,000 → 1,050,000** | 128,000 |
| Anthropic | `claude-opus-4-7` | **200,000 → 1,000,000** | **32,000 → 128,000** |
| Anthropic | `claude-opus-4-6` | **200,000 → 1,000,000** | **32,000 → 128,000** |
| Anthropic | `claude-sonnet-4-6` | **200,000 → 1,000,000** | 64,000 |

Server-side caps still apply; oversized `max_tokens` is typically clamped by the provider.

### 2. DeepSeek V4 Pro — 2.5x promo extended indefinitely

Per DeepSeek's announcement, after 2026/05/31 the official price is permanently set to 1/4 of the original list price (i.e. the 2.5x promo becomes the new base). We extended `pricing.discount.until` to `2099-12-31T15:59:00Z` so billing always uses the discounted rate.

### 3. No code changes

Only `src/providers/*.json` were touched. Provider quirks, wire-protocol fields, and the `max_tokens` / `max_completion_tokens` switching logic are unchanged.

### Install

- VS Code Extensions panel → search “Deep Copilot” → Update; or
- Manually: `release/deep-copilot-0.40.1.vsix` → Extensions → ··· → Install from VSIX.
