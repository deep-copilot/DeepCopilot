## 背景

目前底部状态栏（`ft-cost`）只显示**本次对话的累计消耗**（¥0.0000），没有显示账户实际剩余余额。用户无法在编程过程中感知账户是否即将耗尽。

DeepSeek 平台提供了 `GET /user/balance` 接口，可以实时查询账户余额，但当前代码中未调用该接口（全局搜索无 `user/balance` 引用）。

---

## 改动范围

### 1. 后端：新增余额查询函数（`src/api/deepseek.js`）

新增 `fetchBalance(apiKey, baseUrl)` 函数：
- 调用 `GET {baseUrl}/user/balance`（与 `/chat/completions` 同 host）
- 返回 `{ available: boolean, balance_cny: number, balance_usd: number }`
- 对自定义 baseUrl（非 deepseek.com）不报错，静默返回 `null`（第三方兼容 API 不一定支持此端点）

### 2. 后端：定时刷新并推送到 webview（`src/chat/provider.js`）

刷新时机：
- 插件激活时立即查询一次
- 每次 AI 回复结束（`bumpUsage`）后触发一次（节流：距上次 ≥ 30 秒才实际发请求）
- 用户手动点击余额 pill 时强制刷新

通过 `webview.postMessage({ type: 'balanceUpdate', balance_cny, balance_usd, available })` 推送到前端。

### 3. 前端 UI：新增余额 pill（`src/webview/html.js` + `media/chat.js`）

新增 `id="ft-balance"` pill，紧靠 `ft-cost` 右侧：

| 状态 | 显示 |
|------|------|
| 正在查询 | `💰 查询中…` |
| 查询成功 | `💰 ¥123.45` |
| 余额不足（< ¥5） | `⚠️ ¥0.23`（橙色警告） |
| 不可用（is_available: false） | `⛔ 账户不可用`（红色） |
| 接口不支持（自定义 baseUrl） | 隐藏该 pill |

### 4. 前端样式：余额低时的视觉警告（`media/chat.css`）

- 余额 < ¥5：pill 变为警告色 + 轻微闪烁动画
- 账户不可用：红色

### 5. Tooltip：会话消耗 vs. 账户余额对比

鼠标悬停余额 pill 时展示：

```
账户余额: ¥123.45（充值 ¥100.00 + 赠送 ¥23.45）
本次会话消耗: ¥0.0234
```

---

## 验收标准

- [ ] 底部状态栏新增余额 pill，插件激活后 3 秒内显示余额
- [ ] 使用自定义 baseUrl 时余额 pill 自动隐藏，不报错
- [ ] 余额低于 ¥5 时显示橙色警告
- [ ] `is_available: false` 时显示红色提示
- [ ] 点击余额 pill 可手动强制刷新
- [ ] Tooltip 展示本次会话消耗 vs. 账户余额对比

---

## 参考

- DeepSeek 官方文档：https://api-docs.deepseek.com/zh-cn/api/get-user-balance
- 接口响应格式：

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "11.23456789",
      "granted_balance": "0.00000000",
      "topped_up_balance": "11.23456789"
    }
  ]
}
```
