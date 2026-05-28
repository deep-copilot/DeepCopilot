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
        pendingEditsTitle:      t('wvPendingEditsTitle'),
        pendingEditsKeep:       t('wvPendingEditsKeep'),
        pendingEditsKeepAll:    t('wvPendingEditsKeepAll'),
        pendingEditsDiscard:    t('wvPendingEditsDiscard'),
        pendingEditsDiscardAll: t('wvPendingEditsDiscardAll'),
        pendingEditsNew:        t('wvPendingEditsNew'),
        pendingEditsDeleted:    t('wvPendingEditsDeleted'),
        pendingEditsBinary:     t('wvPendingEditsBinary'),
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
<div id="topbar">
  <button id="sb-sessions-btn" title="${ui.sessions}" aria-label="Session history"><i class="codicon codicon-history"></i></button>
  <button id="sb-new-btn" title="${ui.newSession}" aria-label="New session"><i class="codicon codicon-comment-add"></i></button>
</div>
<div id="sb"></div>
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
  <div id="todo-pop" class="todo-pop" style="display:none">
    <div class="todo-pop-hd" id="todo-pop-hd">
      <span class="todo-pop-chev" id="todo-pop-chev">&#8250;</span><span class="todo-pop-title">Tasks</span>
      <span class="todo-pop-cnt" id="todo-pop-cnt"></span>
      <button class="todo-pop-close" id="todo-pop-close" title="Close">✕</button>
    </div>
    <ul class="todo-pop-list" id="todo-pop-list"></ul>
  </div>
  <div id="composer-card">
    <div id="pending-edits-panel" class="pending-edits-panel" style="display:none">
      <div class="pe-header">
        <span class="pe-title">${ui.pendingEditsTitle || 'Pending edits'}</span>
        <span class="pe-count" id="pe-count">0</span>
        <span class="pe-spacer"></span>
        <button class="pe-btn pe-btn-secondary" id="pe-discard-all" title="${ui.pendingEditsDiscardAll || 'Discard all'}">${ui.pendingEditsDiscardAll || 'Discard all'}</button>
        <button class="pe-btn pe-btn-primary"   id="pe-keep-all"    title="${ui.pendingEditsKeepAll    || 'Keep all'}">${ui.pendingEditsKeepAll    || 'Keep all'}</button>
      </div>
      <ul class="pe-list" id="pe-list"></ul>
    </div>
    <div id="at-chips"></div>
    <div id="inp-row">
      <div id="skill-notice"></div>
      <textarea id="inp" rows="1" placeholder="${ui.inputPh}"></textarea>
    </div>
    <div id="composer-bar">
      <div class="cb-left">
        <div id="iModePicker" class="mode-picker" data-im="agent">
          <button id="iModeBtn" class="cbtn mode-trigger" title="${ui.interactionMode}"><i class="codicon codicon-tools"></i>&#160;Agent&#160;<span class="mode-chev">▾</span></button>
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
    <button id="ft-ctx" class="ft-ctx" title="Context usage — click for details" aria-label="Context usage">
      <svg class="ft-ctx-svg" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.25"></circle>
        <circle id="ft-ctx-ring" cx="10" cy="10" r="8" fill="none" stroke="#66bb6a" stroke-width="2.5"
                stroke-dasharray="50.27" stroke-dashoffset="50.27" stroke-linecap="round"
                transform="rotate(-90 10 10)"></circle>
      </svg>
      <span id="ft-ctx-pct">--</span>
    </button>
  </div>
  <div class="ft-right">
    <button class="ft-btn" id="apibt" title="${ui.apiTitle}">🔑</button>
    <span class="pill" id="ft-cache" title="${ui.cacheTitle}">💾 0%</span>
    <span class="pill" id="ft-tokens">0 tokens</span>
    <span class="pill" id="ft-cost" style="color:#e8b86d">¥0.0000</span>
    <span class="pill" id="ft-balance" title="${ui.balanceTitle}" style="display:none">${ui.balanceInit}</span>
  </div>
</div>
<!-- ── Session drawer backdrop (narrow mode) ── -->
<div id="session-backdrop"></div>
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
          <select id="s-provider" class="settings-input settings-select">
            <!-- Options populated dynamically from the provider registry (chat.js handles 'providersInfo'). -->
          </select>
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

module.exports = { buildWebviewHtml, buildSidebarHintHtml };

/**
 * Minimal launcher page shown in the left-sidebar WebviewView.
 * Replaces the full chat UI so the sidebar acts only as an entry point,
 * directing users to open Deep Copilot as an editor-area tab (status bar).
 */
function buildSidebarHintHtml(webview, extensionUri) {
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'imgs', 'logo_black_bg.png'));
    const locale  = isZh() ? 'zh' : 'en';
    const lead    = t('sidebarHintLead');
    const b1      = t('sidebarHintBenefit1');
    const b2      = t('sidebarHintBenefit2');
    const btnLbl  = t('sidebarHintButton');
    const hint    = t('sidebarHintFooter');
    const nonce   = Buffer.from(Date.now().toString() + Math.random().toString())
        .toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data:`,
        `style-src 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${locale}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Deep Copilot</title><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{display:flex;flex-direction:column;
  background:var(--vscode-sideBar-background,#252526);
  color:var(--vscode-foreground,#cccccc);
  font-family:var(--vscode-font-family,'Segoe UI',sans-serif);font-size:13px}
.main{flex:1;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:16px;padding:24px 22px;text-align:center}
img{width:56px;height:56px;border-radius:12px;opacity:.88}
.title-block{display:flex;flex-direction:column;gap:3px}
h2{font-size:15px;font-weight:700;letter-spacing:-.01em}
.lead{font-size:12px;font-weight:600;
  color:var(--vscode-foreground,#cccccc);opacity:1;line-height:1.5}
.benefits{list-style:none;width:100%;display:flex;flex-direction:column;gap:6px;
  text-align:center}
.benefits li{display:flex;align-items:flex-start;justify-content:center;gap:8px;font-size:12px;
  opacity:.72;line-height:1.45}
.benefits li::before{content:'\u2713';flex-shrink:0;
  color:var(--vscode-focusBorder,#007fd4);font-weight:700;margin-top:1px}
.btn{padding:7px 26px;border:none;border-radius:4px;cursor:pointer;
  background:var(--vscode-button-background,#0e639c);
  color:var(--vscode-button-foreground,#fff);
  font-size:13px;font-family:inherit;font-weight:500;letter-spacing:.01em}
.btn:hover{background:var(--vscode-button-hoverBackground,#1177bb)}
.footer{flex-shrink:0;padding:10px 16px;text-align:center;font-size:11px;
  opacity:.4;line-height:1.4;
  border-top:1px solid var(--vscode-sideBarSectionHeader-border,rgba(127,127,127,.15))}
</style></head><body>
<div class="main">
  <img src="${logoUri}" alt="Deep Copilot"/>
  <div class="title-block">
    <h2>Deep Copilot</h2>
    <p class="lead">${lead}</p>
  </div>
  <ul class="benefits">
    <li>${b1}</li>
    <li>${b2}</li>
  </ul>
  <button class="btn" id="ob">${btnLbl}</button>
</div>
<div class="footer">${hint}</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
document.getElementById('ob').addEventListener('click',function(){
  vscode.postMessage({type:'openInTab'});
});
</script>
</body></html>`;
}
