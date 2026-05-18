// Deep Copilot — VS Code extension entry point.
'use strict';

const vscode = require('vscode');

const { Logger } = require('./logger');
const { ChatViewProvider } = require('./chat/provider');
const { t, isZh } = require('./utils/i18n');
const { getDiscountWarning } = require('./pricing');
const { registerInlineCompletionProvider } = require('./completion/provider');

function activate(context) {
    Logger.init(context);
    Logger.info('ACTIVATE', { version: (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || 'unknown' });

    // ─── Ensure ~/.deepcopilot/skills directory exists ────────────────────
    try {
        const { DEEPCOPILOT_SKILLS_DIR } = require('./skills');
        const fs = require('fs');
        if (!fs.existsSync(DEEPCOPILOT_SKILLS_DIR)) {
            fs.mkdirSync(DEEPCOPILOT_SKILLS_DIR, { recursive: true });
        }
    } catch { /* non-fatal */ }

    // ─── Status bar button (registered FIRST so it shows even if anything below throws) ──
    // VS Code persists per-user "hide" state for status bar items keyed by `id`.
    // We use a stable id + explicit `name` so users can find & re-enable it via
    // right-click on the status bar → toggle "Deep Copilot".
    try {
        const statusItem = vscode.window.createStatusBarItem(
            'deepseekAgent.statusBar',
            vscode.StatusBarAlignment.Left,
            100
        );
        statusItem.name    = 'Deep Copilot';
        statusItem.text    = '$(robot) Deep Copilot';
        statusItem.tooltip = isZh() ? '点击打开 Deep Copilot' : 'Click to open Deep Copilot';
        statusItem.command = 'deepseekAgent.openInTab';
        statusItem.show();
        context.subscriptions.push(statusItem);
        Logger.info('STATUSBAR_REGISTERED', { id: 'deepseekAgent.statusBar' });
    } catch (e) {
        Logger.info('STATUSBAR_FAILED', { err: String(e && e.message || e) });
    }

    const chatProvider = new ChatViewProvider(context);

    // ─── Discount expiry warning (shown once per state change) ────────────
    const dw = getDiscountWarning();
    const dwState = dw.expired ? 'expired' : dw.expiring ? `expiring-${dw.days}` : '';
    const dwKey = 'deepseekAgent.discountWarnShown';
    if (dwState && context.globalState.get(dwKey) !== dwState) {
        context.globalState.update(dwKey, dwState);
        const msg = dw.expired
            ? (isZh()
                ? 'Deep Copilot：DeepSeek v4-pro 折扣已结束，当前正价为 ¥12 / ¥0.1 / ¥24（输入/缓存命中/输出，每百万 token）。'
                : 'Deep Copilot: The DeepSeek v4-pro discount has ended. Full pricing ¥12 / ¥0.1 / ¥24 per 1M tokens is now active.')
            : (isZh()
                ? `Deep Copilot：DeepSeek v4-pro 折扣将在 ${dw.days} 天后到期（2026-05-31 23:59 北京时间）。`
                : `Deep Copilot: The DeepSeek v4-pro discount expires in ${dw.days} day(s) (2026-05-31 23:59 CST).`);
        setTimeout(() => vscode.window.showWarningMessage(msg), 2000);
    }

    // ─── API key / base URL management ────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.setApiKey', async () => {
            const existing = await context.secrets.get('deepseekAgent.apiKey');
            const key = await vscode.window.showInputBox({
                prompt: t('apiKeyPrompt'),
                placeHolder: 'sk-...',
                value: existing || '',
                password: true,
                ignoreFocusOut: true,
            });
            if (key === undefined) return;
            if (key.trim() === '') {
                await context.secrets.delete('deepseekAgent.apiKey');
                vscode.window.showInformationMessage(t('apiKeyDeleted'));
            } else {
                await context.secrets.store('deepseekAgent.apiKey', key.trim());
                vscode.window.showInformationMessage(t('apiKeySaved'));
            }
        }),
        vscode.commands.registerCommand('deepseekAgent.setBaseUrl', async () => {
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            const cur = cfg.get('apiBaseUrl') || '';
            const choice = await vscode.window.showQuickPick(
                [
                    { label: t('baseUrlIntl'), description: 'https://api.deepseek.com', value: 'https://api.deepseek.com' },
                    { label: t('baseUrlCustom'), description: '', value: '__custom__' },
                    { label: t('baseUrlClear'),  description: '', value: '' },
                ],
                { placeHolder: (isZh() ? '当前：' : 'Current: ') + (cur || (isZh() ? '默认（国际版）' : 'default (international)')) }
            );
            if (!choice) return;
            let url = choice.value;
            if (url === '__custom__') {
                url = await vscode.window.showInputBox({
                    prompt: t('baseUrlEnter'),
                    value: cur,
                    placeHolder: 'https://api.example.com',
                    ignoreFocusOut: true,
                });
                if (url === undefined) return;
            }
            await cfg.update('apiBaseUrl', url, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(t('baseUrlSet') + (url || (isZh() ? '（默认国际版）' : '(default international)')));
        }),
        vscode.commands.registerCommand('deepseekAgent.setTavilyKey', async () => {
            const existing = await context.secrets.get('deepseekAgent.tavilyKey');
            const key = await vscode.window.showInputBox({
                prompt: isZh()
                    ? '输入 Tavily API Key（用于 web_search 联网搜索；从 https://app.tavily.com 获取，免费 1000 次/月）'
                    : 'Enter your Tavily API key (for web_search; get one at https://app.tavily.com — 1000 free searches/month)',
                placeHolder: 'tvly-...',
                value: existing || '',
                password: true,
                ignoreFocusOut: true,
            });
            if (key === undefined) return;
            if (key.trim() === '') {
                await context.secrets.delete('deepseekAgent.tavilyKey');
                vscode.window.showInformationMessage(isZh() ? 'Deep Copilot：Tavily API Key 已删除。' : 'Deep Copilot: Tavily API key removed.');
            } else {
                await context.secrets.store('deepseekAgent.tavilyKey', key.trim());
                vscode.window.showInformationMessage(isZh() ? 'Deep Copilot：Tavily API Key 已保存。' : 'Deep Copilot: Tavily API key saved.');
            }
        }),
        vscode.commands.registerCommand('deepseekAgent.showApiStatus', async () => {
            // Looped QuickPick: shows all key/URL settings with live status in one place.
            // Users can configure DeepSeek key, Tavily key, and Base URL without hunting
            // through the command palette. Re-opens after each action until dismissed.
            const zh = isZh();
            while (true) {
                const cfg       = vscode.workspace.getConfiguration('deepseekAgent');
                const dsKey     = await context.secrets.get('deepseekAgent.apiKey');
                const tvKey     = await context.secrets.get('deepseekAgent.tavilyKey');
                const baseUrl   = cfg.get('apiBaseUrl') || 'https://api.deepseek.com';
                const model     = cfg.get('defaultModel') || 'deepseek-v4-pro';
                const mode      = cfg.get('approvalMode') || 'manual';

                const dsLabel   = zh ? 'DeepSeek API Key' : 'DeepSeek API Key';
                const dsTag     = zh ? '（必填）' : ' (required)';
                const tvLabel   = zh ? 'Tavily API Key' : 'Tavily API Key';
                const tvTag     = zh ? '（可选）' : ' (optional)';

                const items = [
                    {
                        label: `$(${dsKey ? 'pass-filled' : 'circle-large-outline'}) ${dsLabel}${dsTag}`,
                        description: dsKey
                            ? (zh ? '已配置 · ' : 'Configured · ') + dsKey.slice(0, 6) + '…' + dsKey.slice(-4)
                            : (zh ? '未配置' : 'Not set'),
                        detail: zh
                            ? '驱动 AI 对话与工具调用 · 获取地址：platform.deepseek.com/api_keys'
                            : 'Powers AI chat & tool calls · Get one at platform.deepseek.com/api_keys',
                        action: 'deepseekAgent.setApiKey',
                    },
                    {
                        label: `$(${tvKey ? 'pass-filled' : 'circle-large-outline'}) ${tvLabel}${tvTag}`,
                        description: tvKey
                            ? (zh ? '已配置 · ' : 'Configured · ') + tvKey.slice(0, 6) + '…' + tvKey.slice(-4)
                            : (zh ? '未配置（联网搜索不可用）' : 'Not set (web_search disabled)'),
                        detail: zh
                            ? '启用 web_search 联网搜索工具 · 获取地址：app.tavily.com（免费 1000 次/月）'
                            : 'Enables the web_search tool · Get one at app.tavily.com (1000 free/month)',
                        action: 'deepseekAgent.setTavilyKey',
                    },
                    {
                        label: `$(globe) ${zh ? 'Base URL' : 'Base URL'}`,
                        description: baseUrl,
                        detail: zh
                            ? '支持任意 OpenAI 兼容接口'
                            : 'Works with any OpenAI-compatible endpoint',
                        action: 'deepseekAgent.setBaseUrl',
                    },
                    {
                        label: `$(info) ${zh ? '当前配置' : 'Current config'}`,
                        description: `${model} · ${mode}`,
                        detail: zh
                            ? `模型：${model} · 审批模式：${mode}（在 VS Code 设置中修改）`
                            : `Model: ${model} · Approval mode: ${mode} (change in VS Code settings)`,
                        action: '__noop__',
                    },
                ];

                const pick = await vscode.window.showQuickPick(items, {
                    title: zh ? 'Deep Copilot · API 设置' : 'Deep Copilot · API Settings',
                    placeHolder: zh
                        ? '选择要配置的项目（按 Esc 关闭）'
                        : 'Pick an item to configure (Esc to close)',
                    ignoreFocusOut: false,
                });
                if (!pick) return;
                if (pick.action === '__noop__') continue;
                await vscode.commands.executeCommand(pick.action);
                // Loop back to show updated status
            }
        }),
        vscode.commands.registerCommand('deepseekAgent.restartServer', () => {
            vscode.window.showInformationMessage(t('standaloneNoServer'));
        }),
        vscode.commands.registerCommand('deepseekAgent.openTerminal', () => {
            vscode.window.showInformationMessage(t('standaloneNoTui'));
        }),
        vscode.commands.registerCommand('deepseekAgent.openDebugLog', async () => {
            const ch = Logger.getChannel();
            if (ch) ch.show(true);
            const fp = Logger.getFilePath();
            if (fp) {
                const pick = await vscode.window.showInformationMessage(
                    t('logFileLabel') + fp,
                    t('logOpenInEditor'), t('logCopyPath'), t('logRevealInOS')
                );
                if (pick === t('logOpenInEditor')) {
                    const doc = await vscode.workspace.openTextDocument(fp);
                    vscode.window.showTextDocument(doc, { preview: false });
                } else if (pick === t('logCopyPath')) {
                    await vscode.env.clipboard.writeText(fp);
                    vscode.window.setStatusBarMessage(t('logPathCopied'), 2000);
                } else if (pick === t('logRevealInOS')) {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fp));
                }
            } else {
                vscode.window.showWarningMessage(t('logNotInit'));
            }
        }),
    );

    // Revert last turn command (#25)
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.revertLastTurn', async () => {
            await chatProvider.revertLastTurn();
        })
    );

    // Attach selection / file to chat (editor context menu + command palette)
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.attachSelection', () => {
            chatProvider.attachSelection();
        })
    );

    // Auto-attach live selection chip when the user selects text in any editor
    // Issue #97: previously the empty-selection branch called clearLiveSelection,
    // which hid the chip the moment the user clicked into a file without dragging
    // a selection. We now keep the file chip (the provider supports a "no range"
    // variant) and only clear when the editor itself is gone.
    let _selDebounce = null;
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (_selDebounce) clearTimeout(_selDebounce);
            _selDebounce = setTimeout(() => {
                _selDebounce = null;
                chatProvider.attachLiveSelection(e.textEditor);
            }, 300);
        })
    );

    // Issue #97: react to active-editor changes (Ctrl+Tab, Explorer click,
    // closing the last tab, etc.). onDidChangeTextEditorSelection does NOT
    // fire when only the active editor changes, so without this listener the
    // chip was stuck on whichever editor last had a selection event.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) chatProvider.attachLiveSelection(editor);
            else chatProvider.clearLiveSelection();
        })
    );

    // Sidebar WebviewView (Activity Bar — left)
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Secondary Sidebar WebviewView (Auxiliary Bar — right). Same provider
    // instance broadcasts to both, so state stays in sync wherever the user
    // pins it.
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'deepseek.chatViewAux',
            chatProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // First-launch auto-reveal in the Secondary Side Bar so users discover the
    // new auxiliary view (mirrors how Codex/Copilot Chat surface themselves).
    // We only do this ONCE per machine (flag stored in globalState) to avoid
    // hijacking the user's layout on every window open.
    try {
        const REVEAL_FLAG = 'deepseekAgent.auxRevealed.v0313';
        if (!context.globalState.get(REVEAL_FLAG)) {
            // Defer slightly so VS Code finishes registering the contributed
            // viewsContainer before we ask it to switch to it.
            setTimeout(() => {
                // `workbench.view.extension.<containerId>` is auto-generated by
                // VS Code for every contributed viewsContainer and reliably
                // switches the host side bar (primary or auxiliary) to that
                // container regardless of what was previously shown there.
                vscode.commands.executeCommand('workbench.view.extension.deepseek-aux').then(
                    () => { context.globalState.update(REVEAL_FLAG, true); },
                    () => { /* ignore — user may have customized the layout */ }
                );
            }, 800);
        }
    } catch { /* non-fatal */ }

    // Open sidebar command
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.open', () => {
            vscode.commands.executeCommand('workbench.view.extension.deepseek-sidebar');
        })
    );

    // Open as dedicated editor tab
    let activeTabPanel = null;
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekAgent.openInTab', () => {
            if (activeTabPanel) { activeTabPanel.reveal(vscode.ViewColumn.Beside, false); return; }
            const panel = vscode.window.createWebviewPanel(
                'deepseek.chatPanel', 'Deep Copilot',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'imgs')] }
            );
            try { panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'imgs', 'logo_black_bg.png'); } catch (_) {}
            activeTabPanel = panel;
            panel.onDidDispose(() => { if (activeTabPanel === panel) activeTabPanel = null; });
            chatProvider.bindPanel(panel);
        }),
        vscode.commands.registerCommand('deepseekAgent.moveToRight', async () => {
            try { await vscode.commands.executeCommand('workbench.view.extension.deepseek-aux'); } catch (_) {}
        }),
    );

    // Status bar button (already registered at top of activate; nothing to do here).

    // Inline FIM completion (Issue #60) — registered last so a failure here cannot
    // block chat activation. Off by default; controlled by `deepCopilot.inlineCompletion.enable`.
    try { registerInlineCompletionProvider(context); } catch (e) { Logger.info('INLINE_COMPLETION_REGISTER_FAILED', { message: e && e.message }); }

    // First-run: prompt for API key
    context.secrets.get('deepseekAgent.apiKey').then(key => {
        if (!key && !context.globalState.get('deepseekAgent.keyPrompted')) {
            context.globalState.update('deepseekAgent.keyPrompted', true);
            setTimeout(() => {
                const msg = isZh()
                    ? 'Deep Copilot 已安装！请先设置 DeepSeek API Key 才能开始使用。'
                    : 'Deep Copilot installed. Set your DeepSeek API key to get started.';
                const action = t('statusBtnSetKey');
                const later  = isZh() ? '稍后' : 'Later';
                vscode.window.showInformationMessage(msg, action, later).then(pick => {
                    if (pick === action) vscode.commands.executeCommand('deepseekAgent.setApiKey');
                });
            }, 1500);
        }
    });
}

function deactivate() {}

module.exports = { activate, deactivate };
