// Deep Copilot — VS Code extension entry point.
'use strict';

const vscode = require('vscode');

const { Logger } = require('./logger');
const { ChatViewProvider } = require('./chat/provider');
const { t, isZh } = require('./utils/i18n');
const { getDiscountWarning } = require('./pricing');

function activate(context) {
    Logger.init(context);
    Logger.info('ACTIVATE', { version: (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || 'unknown' });

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
                    { label: t('baseUrlCN'),   description: 'https://api.deepseeki.com', value: 'https://api.deepseeki.com' },
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
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            const key = await context.secrets.get('deepseekAgent.apiKey');
            const lines = [
                `**${t('statusKey')}**：${key ? '✅ ' + t('statusKeyOn') : '❌ ' + t('statusKeyOff')}`,
                `**${t('statusBaseUrl')}**：${cfg.get('apiBaseUrl') || 'https://api.deepseek.com'}`,
                `**${t('statusModel')}**：${cfg.get('defaultModel') || 'deepseek-v4-pro'}`,
                `**${t('statusMode')}**：${cfg.get('approvalMode') || 'manual'}`,
            ];
            const action = await vscode.window.showInformationMessage(lines.join(' · '), t('statusBtnSetKey'), t('statusBtnSwitchUrl'));
            if      (action === t('statusBtnSetKey'))     vscode.commands.executeCommand('deepseekAgent.setApiKey');
            else if (action === t('statusBtnSwitchUrl')) vscode.commands.executeCommand('deepseekAgent.setBaseUrl');
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

    // Sidebar WebviewView
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

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
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
            );
            try { panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.png'); } catch (_) {}
            activeTabPanel = panel;
            panel.onDidDispose(() => { if (activeTabPanel === panel) activeTabPanel = null; });
            chatProvider.bindPanel(panel);
        }),
        vscode.commands.registerCommand('deepseekAgent.moveToRight', async () => {
            try { await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar'); } catch (_) {}
            try { await vscode.commands.executeCommand('workbench.view.extension.deepseek-sidebar'); } catch (_) {}
            vscode.window.showInformationMessage(
                isZh()
                    ? '把活动栏的 ⚡ 图标拖到右侧 Secondary Side Bar 即可，VS Code 会记住位置。'
                    : 'Drag the ⚡ icon from the activity bar to the Secondary Side Bar on the right; VS Code will remember the position.'
            );
        }),
    );

    // Status bar button (already registered at top of activate; nothing to do here).

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
