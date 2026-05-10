// HTML template for the chat webview.
'use strict';

const vscode = require('vscode');

function buildWebviewHtml(webview, extensionUri) {
    const cssUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css'));
    const jsUri   = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.js'));
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logo.png'));
    const nonce   = Buffer.from(Date.now().toString() + Math.random().toString()).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deep Copilot</title>
<link rel="stylesheet" href="${cssUri}">
</head><body>
<div id="prog" class="prog"></div>
<div id="tb">
  <span class="logo">
    <img class="logo-img" src="${logoUri}" alt="logo"/>
    <span style="font-weight:600">Deep Copilot</span>
  </span>
  <button class="tbb" id="apibt" title="API 设置（Key / Base URL）">🔑</button>
  <button class="tbb" id="cbt" title="清空当前会话(不存档)">🗑</button>
</div>
<button id="edgeL" class="edge-toggle edge-l" title="Plan / Todos" aria-label="toggle left panel"></button>
<button id="edgeR" class="edge-toggle edge-r" title="历史会话" aria-label="toggle right panel"></button>
<div id="sb"></div>
<aside id="left">
  <section class="pnl" id="planPnl" data-open="1">
    <div class="ph"><span class="pchev">▾</span> Plan <span class="cnt" id="plan-cnt"></span></div>
    <div class="pb" id="plan-body"><div class="empty">No active plan</div></div>
  </section>
  <section class="pnl" id="todoPnl" data-open="1">
    <div class="ph"><span class="pchev">▾</span> Todos <span class="cnt" id="todo-cnt"></span></div>
    <div class="pb" id="todo-body"><div class="empty">No todos</div></div>
  </section>
  <section class="pnl pnl-mini" id="agentPnl" data-open="0">
    <div class="ph"><span class="pchev">▸</span> Agents <span class="cnt" id="agent-cnt">0</span></div>
    <div class="pb" id="agent-body" style="display:none"><div class="empty">No agents</div></div>
  </section>
</aside>
<div id="main">
  <div id="es">
    <p><strong>Deep Copilot</strong><br>让高质量 AI 生产力开放、公平、可负担地惠及每个人</p>
    <p class="hint">输入消息，按 Enter 发送</p></div>
  <div id="thk">● ● ● 思考中...</div>
</div>
<aside id="right">
  <div class="rh">
    <span class="rt">Sessions</span>
  </div>
  <div class="rscope">
    <button id="scopeWs" class="on" title="只显示当前工作区会话">本工作区</button>
    <button id="scopeAll" title="显示全部会话">全部</button>
  </div>
  <div class="rsearch"><input id="dsearch" type="text" placeholder="搜索会话..."/></div>
  <div class="rnew">
    <button id="newSessionBtn" class="new-session-btn" title="新建会话">
      <span class="icon">+</span>
      <span class="text">新建会话</span>
    </button>
  </div>
  <div class="rlist" id="dlist"><div class="empty">暂无会话</div></div>
</aside>
<div id="ia">
  <div id="cxb">📎 将附带当前文件 / 选中代码</div>
  <div id="pop" class="pop" style="display:none"></div>
  <div id="composer-card">
    <textarea id="inp" rows="1" placeholder="向 Deep Copilot 提问... (Enter 发送 / Shift+Enter 换行 / / 命令 / @ 上下文 / Ctrl+K 清空)"></textarea>
    <div id="composer-bar">
      <div class="cb-left">
        <button id="cxbt" class="cbtn" title="包含当前文件 / 选中代码">📎</button>
        <select class="cbsel" id="modelSel" title="模型">
          <option value="deepseek-v4-pro">v4-pro</option>
          <option value="deepseek-v4-flash">v4-flash</option>
          <option value="deepseek-reasoner">reasoner</option>
        </select>
        <select class="cbsel" id="modeSel" title="批准策略 (Approval Mode)">
          <option value="manual">🛡 Manual</option>
          <option value="auto-edit">✏️ Auto-Edit</option>
          <option value="autopilot">🚀 Autopilot</option>
          <option value="readonly">👁 Read-Only</option>
        </select>
      </div>
      <button id="sbtn" title="发送">↑</button>
    </div>
  </div>
</div>
<div id="foot">
  <div class="ft-left">
    <span class="dot" id="dot"></span>
    <span id="ft-mode">agent · deepseek-v4-pro</span>
  </div>
  <div class="ft-right">
    <span class="pill" id="ft-cache" title="prompt 缓存命中率（越高越省钱）">💾 0%</span>
    <span class="pill" id="ft-tokens">0 tokens</span>
    <span class="pill" id="ft-cost" style="color:#e8b86d">¥0.0000</span>
  </div>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body></html>`;
}

module.exports = { buildWebviewHtml };
