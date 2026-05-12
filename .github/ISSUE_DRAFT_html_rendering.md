# [RFC] 重构聊天渲染管线：从 Markdown-only 升级为 HTML-capable 输出

**Type**: Feature / Refactor (Breaking Change candidate)
**Area**: webview · chat rendering · prompt engineering
**Affected files**: `media/chat.js`, `media/chat.css`, `src/prompts/system.js`, `src/webview/html.js`
**Version baseline**: v0.28.1

---

## 1. 背景与动机 (Background)

当前 Deep Copilot 的聊天渲染链路如下：

```
DeepSeek 模型 ──(stream tokens)──► curText (raw markdown)
       └─► renderMd()  (chat.js:322)  ─► 自定义 MD→HTML 渲染
              ├─► renderInline()      行内（粗体/斜体/链接/行内代码/行内数学）
              ├─► renderMathBlock()   KaTeX 块级公式
              └─► <pre><code> + highlight.js
```

System prompt 中明确要求模型 "use GitHub-flavored markdown"（`src/prompts/system.js:37`）。

### 现有问题

1. **表达力不足**：`<details>/<summary>` 折叠、`<kbd>` 键位、`<mark>` 高亮、`<sub>/<sup>` 上下标、带样式的告警框（callout）在纯 MD 下无法表达。
2. **复杂表格无法对齐**：合并单元格、列宽控制、单元格内换行等场景缺失。
3. **富交互需求**：工具调用结果（diff、文件预览、命令输出）希望以可折叠/可复制/可跳转 UI 呈现，目前只能用纯文本 + 自定义占位符模拟。
4. **业界趋势**：Claude Artifacts、ChatGPT Canvas、Cursor Inline UI 均已让模型生成"受控 HTML / 自定义组件"以扩展输出。

---

## 2. 目标 (Goals)

- **G1**：让模型可以在回答中**安全地**内联 HTML 片段以表达 MD 无法表达的结构。
- **G2**：保持现有流式渲染体验（token-by-token，不卡顿、不出现未闭合标签闪烁）。
- **G3**：保持现有 KaTeX、highlight.js、代码块复制按钮等能力**零回归**。
- **G4**：抵御 XSS（webview 内含 vscode API，权限敏感）。
- **G5**：成本可控——不让 token 数显著膨胀。

## 3. 非目标 (Non-Goals)

- 不引入 React/Vue 等 UI 框架（保持当前轻量 webview 架构）。
- 不让模型输出可执行 `<script>`、`<iframe>`、`on*=` 事件属性。
- 不替换 highlight.js 与 KaTeX 这两个稳定依赖。

---

## 4. 方案对比 (Design Options)

### 方案 A：彻底切换为 HTML 输出（用户原始诉求）

> 让模型直接输出 HTML，而非 Markdown。

**改动点**：
- `src/prompts/system.js` 改为 "respond in safe HTML, use the following whitelisted tags: ..."
- `media/chat.js` 删除 `renderMd / renderInline`，改为：
  ```js
  cur.innerHTML = DOMPurify.sanitize(curText, SAFE_CONFIG);
  ```
- 数学公式从 `$...$` 改为 `<span class="math-inline">...</span>` + 后处理 KaTeX。

**优点**：表达力最大化。
**缺点**：
- ❌ Token 消耗增加 **约 2-3 倍**（`<strong>bold</strong>` vs `**bold**`）。
- ❌ DeepSeek 训练语料以 MD 为主，强制 HTML 输出**遵循度差**，容易出现 `<p>` 嵌套错乱。
- ❌ 流式渲染期间未闭合标签（`<table><tr><td>...`）会导致 DOM 抖动甚至破坏布局。
- ❌ 现有所有用户的历史会话仍是 MD 文本，需迁移或双轨渲染。

### 方案 B：MD-first，混合白名单 HTML 透传（**推荐**）

> 主语料仍是 Markdown，允许模型在必要时使用**白名单 HTML 标签**；前端用 DOMPurify 在 MD 渲染后做二次清洗。

**改动点**：

1. **System prompt 增量**（`src/prompts/system.js`）
   ```
   Use GitHub-flavored markdown as the primary format.
   You may inline HTML *only* from this whitelist when markdown is insufficient:
     <details>, <summary>, <kbd>, <mark>, <sub>, <sup>, <abbr>,
     <ins>, <del>, <dfn>, <samp>, <var>, <br>, <hr>
   Never emit <script>, <iframe>, <style>, <link>, <object>, <embed>,
   inline event handlers (on*), javascript: URLs, or data: URLs except for images.
   ```

2. **`media/chat.js` renderMd 改造**
   - 在 `renderInline()` 中识别白名单标签并透传（而不是 escape）。
   - 在 `_doRender()` 最后接入 DOMPurify：
     ```js
     var html = renderMd(curText);
     cur.innerHTML = DOMPurify.sanitize(html, {
       ALLOWED_TAGS: [...MD_TAGS, ...HTML_PASSTHRU_TAGS],
       ALLOWED_ATTR: ['class', 'href', 'title', 'open', 'colspan', 'rowspan'],
       ALLOWED_URI_REGEXP: /^(https?:|mailto:|vscode:|file:)/i,
       FORBID_TAGS: ['script', 'iframe', 'style', 'object', 'embed'],
       FORBID_ATTR: [/^on/i, 'srcdoc', 'formaction']
     });
     ```

3. **流式安全**：在流式期间用现有 `requestAnimationFrame` 节流；增加"未闭合标签平衡器"——把 `curText` 中未闭合的 `<details>` 临时补全后再渲染，避免布局抖动。

4. **依赖**：新增 `dompurify@^3.1.0`（约 21 KB gzip）到 `media/` 静态文件，或通过 esbuild 打包。

**优点**：
- ✅ 兼容现有所有历史会话（依旧是 MD）。
- ✅ Token 成本不变。
- ✅ 安全可控（DOMPurify + 白名单双保险）。
- ✅ 模型遵循度高（依然以 MD 为主，HTML 是可选增强）。

**缺点**：
- 渲染管线需要重写约 100 行（`renderMd` + `renderInline`）。
- 需要增加 DOMPurify 依赖。

### 方案 C：自定义 DSL（如 `<artifact>` / `:::callout`）

> 类似 Claude 的 Artifacts，让模型输出自定义标签，前端映射为复杂 UI 组件。

适合作为 **后续路线** (Phase 2)，在方案 B 落地后再加入。

---

## 5. 推荐路线 (Recommended Path)

**采纳方案 B**，分阶段实施：

### Phase 1 — 渲染器升级（核心）
- [ ] 引入 `dompurify` 依赖
- [ ] `renderMd` / `renderInline` 支持白名单 HTML 透传
- [ ] 加入流式"未闭合标签平衡器"
- [ ] 单元测试覆盖：XSS 注入、嵌套 `<details>`、HTML + KaTeX 共存、HTML + 代码块共存

### Phase 2 — Prompt 升级
- [ ] `src/prompts/system.js` 增加白名单标签使用指引
- [ ] 增加 few-shot 示例：何时用 `<details>` 折叠长输出、何时用 `<kbd>` 标注快捷键

### Phase 3 — UX 与样式
- [ ] `media/chat.css` 增加 `.msgA details`、`kbd`、`mark`、`.callout-*` 样式
- [ ] 暗色主题适配
- [ ] 折叠组件的可访问性（`aria-expanded`、键盘可达）

### Phase 4 — 自定义组件 (可选)
- [ ] 工具调用结果包装为 `<details class="tool-card">`
- [ ] 探索 `:::warning` / `:::tip` callout 语法

---

## 6. 风险评估 (Risks)

| 风险 | 等级 | 缓解 |
|---|---|---|
| XSS 通过 markdown 链接 `javascript:` 注入 | 高 | DOMPurify `ALLOWED_URI_REGEXP` 白名单 |
| 流式期间 DOM 抖动 | 中 | 未闭合标签平衡器 + `rAF` 节流 |
| DOMPurify 体积 (≈21KB gzip) | 低 | webview 一次加载，可接受 |
| 历史会话渲染差异 | 低 | MD 路径不变，零回归 |
| 模型滥用 HTML 增加 token | 中 | Prompt 明确"only when markdown is insufficient" |

---

## 7. 验收标准 (Acceptance Criteria)

- [ ] 所有现有 KaTeX、代码块、表格、Mermaid 用例无回归。
- [ ] 新增 XSS 测试用例 ≥ 10 条全部通过（`<script>`、`onerror`、`javascript:` URI、SVG 注入等）。
- [ ] 流式回答中包含 `<details>` 时，未闭合期间不破坏后续消息布局。
- [ ] Token 消耗对比基线 ≤ +5%（同一组真实问答的回归测试）。
- [ ] Webview CSP 策略不放宽。

---

## 8. 参考 (References)

- DOMPurify: https://github.com/cure53/DOMPurify
- GitHub allowed HTML in markdown: https://github.github.com/gfm/#disallowed-raw-html-extension-
- VS Code Webview Security: https://code.visualstudio.com/api/extension-guides/webview#content-security-policy
- 现有渲染入口: `media/chat.js` L322 `renderMd`、L460 `_doRender`
- 现有 system prompt: `src/prompts/system.js` L37

---

## 9. 讨论点 (Open Questions)

1. 是否引入 DOMPurify，或者手写一个标签白名单 sanitizer（更轻）？
2. Phase 4 的自定义组件是否走 `:::name` markdown extension，还是直接走 `<custom-tag>` HTML？
3. 是否对工具调用产物 (tool-result) 单独走一条富 UI 渲染路径，与对话主流分离？

---

**Proposed by**: @ZhouChaunge (initial direction) · drafted with Deep Copilot
**Labels**: `enhancement`, `rfc`, `webview`, `breaking-change-candidate`
