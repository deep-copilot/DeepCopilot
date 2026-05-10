// i18n — locale-aware UI strings for Deep Copilot.
// Auto-detects from vscode.env.language. Brand names ("Deep Copilot",
// "DeepSeek") are intentionally NEVER translated.
'use strict';

const vscode = require('vscode');

function isZh() {
    try {
        const lang = (vscode.env && vscode.env.language) || 'en';
        return lang.toLowerCase().startsWith('zh');
    } catch { return false; }
}

const EN = {
    apiKeyPrompt: 'Enter your DeepSeek API key (saved to VS Code SecretStorage)',
    apiKeySaved: 'Deep Copilot: API key saved.',
    apiKeyDeleted: 'Deep Copilot: API key removed.',
    apiKeyMissing: 'Please set your DeepSeek API key first — click the key icon in the toolbar.',
    baseUrlIntl: 'International (default)',
    baseUrlCN: 'China',
    baseUrlCustom: 'Custom...',
    baseUrlClear: 'Clear (use default)',
    baseUrlEnter: 'Enter an OpenAI-compatible Base URL',
    baseUrlSet: 'Deep Copilot: Base URL = ',
    statusKey: 'API Key',
    statusKeyOn: 'set',
    statusKeyOff: 'not set (click "Set Key")',
    statusBaseUrl: 'Base URL',
    statusModel: 'Model',
    statusMode: 'Approval Mode',
    statusBtnSetKey: 'Set API Key',
    statusBtnSwitchUrl: 'Switch Base URL',
    standaloneNoServer: 'Deep Copilot is standalone — no backend server needed.',
    standaloneNoTui: 'Deep Copilot standalone build does not include a TUI terminal.',
    logFileLabel: 'Log file: ',
    logOpenInEditor: 'Open in Editor',
    logCopyPath: 'Copy Path',
    logRevealInOS: 'Reveal in File Explorer',
    logPathCopied: 'Log path copied.',
    logNotInit: 'Log not initialized yet (send a message first).',
    approvalRequest: 'Deep Copilot wants to: ',
    approvalApprove: 'Approve',
    approvalDeny: 'Deny',
    deniedByUser: 'Denied by user.',
    dangerCmdTitle: 'Deep Copilot wants to run a potentially destructive command:',
    dangerAllowOnce: 'Allow once',
    dangerDeny: 'Deny',
    dangerBlocked: 'Blocked: command flagged as potentially destructive and the user declined to approve it. Do NOT retry the same command. Explain to the user what you intended and ask whether to proceed, or propose a safer alternative.',
    blockedOutsideWs: 'Blocked: path is outside the workspace and was not approved.',
    pathOutsideWsConfirm: 'Deep Copilot wants to access a path outside the workspace:',
    deniedReadonly: 'Denied: Read-Only mode is active.',
    writeFileLabel: 'Write file: ',
    runCmdLabel: 'Run: ',
    insertNoEditor: 'Open a file in the editor first.',
    inserted: 'Code inserted.',
    copied: 'Copied to clipboard.',
    feedbackUp: 'Feedback recorded.',
    feedbackDown: 'Feedback recorded.',
    sessionUntitled: 'Untitled',
};

const ZH = {
    apiKeyPrompt: '输入 DeepSeek API Key（保存到 VS Code SecretStorage，不会写入 settings.json）',
    apiKeySaved: 'Deep Copilot：API Key 已保存。',
    apiKeyDeleted: 'Deep Copilot：API Key 已删除。',
    apiKeyMissing: '请先设置 API Key — 点击工具栏 🔑 按钮。',
    baseUrlIntl: '🌍 国际版（默认）',
    baseUrlCN: '🇨🇳 中国大陆',
    baseUrlCustom: '✏️ 自定义…',
    baseUrlClear: '↩ 清空（用默认）',
    baseUrlEnter: '输入 OpenAI 兼容 Base URL',
    baseUrlSet: 'Deep Copilot：Base URL = ',
    statusKey: 'API Key',
    statusKeyOn: '已设置',
    statusKeyOff: '未设置（点击「设置 Key」）',
    statusBaseUrl: 'Base URL',
    statusModel: '模型',
    statusMode: '批准策略',
    statusBtnSetKey: '设置 API Key',
    statusBtnSwitchUrl: '切换 Base URL',
    standaloneNoServer: 'Deep Copilot 是独立扩展，无需后端服务器。',
    standaloneNoTui: 'Deep Copilot 独立版不需要 TUI 终端。',
    logFileLabel: '日志文件：',
    logOpenInEditor: '在编辑器中打开',
    logCopyPath: '复制路径',
    logRevealInOS: '在文件夹中显示',
    logPathCopied: '日志路径已复制。',
    logNotInit: '日志尚未初始化（请先发送一次消息）。',
    approvalRequest: 'Deep Copilot 请求：',
    approvalApprove: '允许',
    approvalDeny: '拒绝',
    deniedByUser: '已被用户拒绝。',
    dangerCmdTitle: 'Deep Copilot 想执行一条可能具有破坏性的命令：',
    dangerAllowOnce: '本次允许',
    dangerDeny: '拒绝',
    dangerBlocked: '已拦截：命令被识别为可能的破坏性操作且用户拒绝放行。不要重试同一条命令。请向用户说明你的意图并询问，或换一种更安全的方案。',
    blockedOutsideWs: '已拦截：路径在工作区之外且未获得用户授权。',
    pathOutsideWsConfirm: 'Deep Copilot 想访问工作区之外的路径：',
    deniedReadonly: '已拒绝：当前为只读模式。',
    writeFileLabel: '写入文件：',
    runCmdLabel: '执行命令：',
    insertNoEditor: '请先在编辑器中打开一个文件。',
    inserted: '代码已插入编辑器。',
    copied: '已复制到剪贴板。',
    feedbackUp: '👍 已记录',
    feedbackDown: '👎 已记录',
    sessionUntitled: '未命名',
};

function t(key) {
    const bundle = isZh() ? ZH : EN;
    return bundle[key] != null ? bundle[key] : (EN[key] != null ? EN[key] : key);
}

module.exports = { t, isZh };
