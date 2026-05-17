// HTML template for the chat webview.
'use strict';

const vscode = require('vscode');
const { isZh, t } = require('../utils/i18n');

function buildWebviewHtml(webview, extensionUri) {
    const cssUri      = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css'));
    const jsUri       = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.js'));
    const logoUri     = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'imgs', 'logo_black_bg.png'));
    const welcomeLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'imgs', 'logo_black_bg.png'));
    const codiconUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css'));
    const katexCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'katex.min.css'));
    const katexJsUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'katex.min.js'));
    const dompurifyUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'purify.min.js'));
    const locale  = isZh() ? 'zh' : 'en';
    const ui = {
        welcomeSub:      t('wvWelcomeSub'),
        welcomeHint:     t('wvWelcomeHint'),
        sessions:        t('wvSessions'),
        workspace:       t('wvWorkspace'),
        workspaceTitle:  t('wvWorkspaceTitle'),
        all:             t('wvAll'),
        searchPh:        t('wvSearchPlaceholder'),
        newSession:      t('wvNewSession'),
        noSessions:      t('wvNoSessions'),
        thinking:        t('wvThinking'),
        inputPh:         t('wvInputPlaceholder'),
        send:            t('wvSend'),
        apiTitle:        t('wvApiTitle'),
        cacheTitle:      t('wvCacheTitle'),
        switchModel:     t('wvSwitchModel'),
        approvalMode:    t('wvApprovalMode'),
        interactionMode: t('wvInteractionMode'),
        balanceTitle:    t('wvBalanceTitle'),
        balanceInit:     t('wvBalanceInit'),
    };
    const nonce   = Buffer.from(Date.now().toString() + Math.random().toString()).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        `font-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${locale}" data-locale="${locale}"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deep Copilot</title>
<link rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${katexCssUri}">
<link rel="stylesheet" href="${cssUri}">
</head><body>
<div id="prog" class="prog"></div>
<!-- #cbt kept hidden: chat.js references it for /clear command & Ctrl+K shortcut -->
<button id="cbt" style="display:none" aria-hidden="true"></button>
<button id="edgeL" class="edge-toggle edge-l" title="Plan / Todos" aria-label="toggle left panel"></button>
<button id="edgeR" class="edge-toggle edge-r" title="${ui.sessions}" aria-label="toggle right panel"></button>
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
    <div class="big"><img class="welcome-logo" src="${welcomeLogoUri}" alt="Deep Copilot"/></div>
    <p><strong>Deep Copilot</strong><br>${ui.welcomeSub}</p>
    <p class="hint">${ui.welcomeHint}</p></div>
  <div id="thk">${ui.thinking}</div>
</div>
<aside id="right">
  <div class="rh">
    <span class="rt">${ui.sessions}</span>
  </div>
  <div class="rscope">
    <button id="scopeWs" class="on" title="${ui.workspaceTitle}">${ui.workspace}</button>
    <button id="scopeAll" title="${ui.all}">${ui.all}</button>
  </div>
  <div class="rsearch"><input id="dsearch" type="text" placeholder="${ui.searchPh}"/></div>
  <div class="rnew">
    <button id="newSessionBtn" class="new-session-btn" title="${ui.newSession}">
      <span class="icon">+</span>
      <span class="text">${ui.newSession}</span>
    </button>
  </div>
  <div class="rlist" id="dlist"><div class="empty">${ui.noSessions}</div></div>
</aside>
<div id="ia">
  <div id="pop" class="pop" style="display:none"></div>
  <div id="composer-card">
    <div id="at-chips"></div>
    <div id="inp-row">
      <div id="skill-notice"></div>
      <textarea id="inp" rows="1" placeholder="${ui.inputPh}"></textarea>
    </div>
    <div id="composer-bar">
      <div class="cb-left">
        <div id="iModePicker" class="mode-picker" data-im="agent">
          <button id="iModeBtn" class="cbtn mode-trigger" title="${ui.interactionMode}"><i class="codicon codicon-tools"></i> Agent</button>
        </div>
        <div id="modelPicker" class="mode-picker" data-model="deepseek-v4-pro">
          <button id="modelBtn" class="cbtn mode-trigger" title="${ui.switchModel}">⚡ v4-pro <span class="mode-chev">▾</span></button>
          <div id="modelDrop" class="mode-drop" style="display:none"></div>
        </div>
        <div id="modePicker" class="mode-picker" data-m="manual">
          <button id="modeBtn" class="cbtn mode-trigger" title="${ui.approvalMode}">🛡 Manual <span class="mode-chev">▾</span></button>
          <div id="modeDrop" class="mode-drop" style="display:none"></div>
        </div>
      </div>
      <button id="sbtn" title="${ui.send}">↑</button>
    </div>
  </div>
</div>
<div id="foot">
  <div class="ft-left">
    <span class="dot" id="dot"></span>
    <span id="ft-mode">agent · deepseek-v4-pro</span>
  </div>
  <div class="ft-right">
    <button class="ft-btn" id="apibt" title="${ui.apiTitle}">🔑</button>
    <span class="pill" id="ft-cache" title="${ui.cacheTitle}">💾 0%</span>
    <span class="pill" id="ft-tokens">0 tokens</span>
    <span class="pill" id="ft-cost" style="color:#e8b86d">¥0.0000</span>
    <span class="pill" id="ft-balance" title="${ui.balanceTitle}" style="display:none">${ui.balanceInit}</span>
  </div>
</div>
<!-- ── Settings Modal ── -->
<div id="settings-overlay" class="settings-overlay" style="display:none" role="dialog" aria-modal="true" aria-labelledby="settings-title">
  <div class="settings-modal">
    <div class="settings-header">
      <span class="settings-title" id="settings-title">⚙ API &amp; Keys</span>
      <button class="settings-close" id="settingsCloseBtn" title="Close" aria-label="Close">✕</button>
    </div>
    <div class="settings-body">
      <div class="settings-section">
        <div class="settings-section-label">AI Provider</div>
        <div class="settings-field">
          <label class="settings-label" for="s-provider">Provider</label>
          <select id="s-provider" class="settings-input" style="cursor:pointer">
            <option value="deepseek">DeepSeek</option>
            <option value="openai">OpenAI</option>
            <option value="groq">Groq</option>
            <option value="ollama">Ollama (local)</option>
            <option value="gemini">Gemini</option>
            <option value="custom">Custom</option>
          </select>
          <span class="settings-hint">Auto-fills Base URL · swap model in VS Code settings</span>
        </div>
        <div class="settings-field">
          <label class="settings-label" for="s-ds-key">API Key <span class="settings-required">*</span></label>
          <div class="settings-input-row">
            <input type="password" id="s-ds-key" class="settings-input" placeholder="sk-..." autocomplete="off" spellcheck="false"/>
            <button class="settings-eye-btn" id="s-ds-key-eye" title="Show / hide" aria-label="Toggle key visibility">👁</button>
          </div>
          <div class="settings-test-row">
            <button class="settings-test-btn" id="s-ds-test">▶ Test connection</button>
            <span class="settings-test-result" id="s-ds-result"></span>
          </div>
          <a class="settings-link" id="s-ds-link" href="#">↗ platform.deepseek.com/api_keys</a>
        </div>
        <div class="settings-field">
          <label class="settings-label" for="s-base-url">Base URL</label>
          <div class="settings-input-row">
            <input type="text" id="s-base-url" class="settings-input" placeholder="https://api.deepseek.com" autocomplete="off" spellcheck="false"/>
            <button class="settings-reset-btn" id="s-base-url-reset" title="Reset to default">↺</button>
          </div>
          <span class="settings-hint">Works with any OpenAI-compatible endpoint</span>
        </div>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-section">
        <div class="settings-section-label">Web Search <span class="settings-section-badge">Tavily</span></div>
        <div class="settings-field">
          <label class="settings-label" for="s-tv-key">API Key <span class="settings-optional">(optional)</span></label>
          <div class="settings-input-row">
            <input type="password" id="s-tv-key" class="settings-input" placeholder="tvly-..." autocomplete="off" spellcheck="false"/>
            <button class="settings-eye-btn" id="s-tv-key-eye" title="Show / hide" aria-label="Toggle key visibility">👁</button>
          </div>
          <div class="settings-test-row">
            <button class="settings-test-btn" id="s-tv-test">▶ Test connection</button>
            <span class="settings-test-result" id="s-tv-result"></span>
          </div>
          <a class="settings-link" id="s-tv-link" href="#">↗ app.tavily.com · 1000 free searches/month</a>
        </div>
      </div>
    </div>
    <div class="settings-dirty-bar" id="s-dirty-bar" style="display:none">
      <span class="settings-dirty-msg">⚠ Unsaved changes</span>
      <button class="settings-discard-btn" id="s-discard">Discard</button>
    </div>
    <div class="settings-footer">
      <button class="settings-cancel-btn" id="settingsCancelBtn">Cancel</button>
      <button class="settings-save-btn" id="settingsSaveBtn">Save</button>
    </div>
  </div>
</div>
<script nonce="${nonce}" src="${katexJsUri}"></script>
<script nonce="${nonce}" src="${dompurifyUri}"></script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body></html>`;
}

module.exports = { buildWebviewHtml };
