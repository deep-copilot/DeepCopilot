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
    createSkillLabel: 'Create skill: ',
    insertNoEditor: 'Open a file in the editor first.',
    inserted: 'Code inserted.',
    copied: 'Copied to clipboard.',
    feedbackUp: 'Feedback recorded.',
    feedbackDown: 'Feedback recorded.',
    sessionUntitled: 'Untitled',
    errTitle: 'Request failed',
    errTitle401: 'Invalid or expired API Key',
    errTip401: 'Click the 🔑 button to re-enter your API key. Make sure the key has not expired or been disabled.',
    errTitle402: 'Insufficient account balance',
    errTip402: 'Please top up your account and try again.',
    errTitle429: 'Rate limit exceeded',
    errTip429: 'You have hit the provider rate limit. Wait a few seconds and click Retry.',
    errTitle400: 'Bad request',
    errTip400: 'The context may be too long or the message format may be invalid. Try clearing the session (Ctrl+K) and retrying.',
    errTitle5xx: 'Service error',
    errNetwork: 'Network connection failed',
    errTipNetwork: 'Cannot reach the API. Check your network, proxy, or firewall settings.',
    errAborted: 'Generation stopped',
    errTipAborted: 'Generation was interrupted by the user.',
    wvWelcomeSub:       'Open, fair, and accessible AI productivity for all',
    wvWelcomeHint:      'Type a message and press Enter to send',
    wvSessions:         'Sessions',
    wvWorkspace:        'Workspace',
    wvWorkspaceTitle:   'Show only current workspace sessions',
    wvAll:              'All',
    wvSearchPlaceholder:'Search sessions...',
    wvNewSession:       'New Session',
    wvNoSessions:       'No sessions',
    wvThinking:         '● ● ● Thinking...',
    wvInputPlaceholder: 'Describe what you want to build',
    wvSend:             'Send',
    wvApiTitle:         'API settings · DeepSeek / Tavily / Base URL',
    wvCacheTitle:       'Prompt cache hit rate (higher = cheaper)',
    wvSwitchModel:      'Switch model',
    wvApprovalMode:     'Approval Mode',
    wvInteractionMode:  'Interaction Mode',
    wvBalanceTitle:     'Account balance (click to refresh)',
    wvBalanceInit:      '💰 Checking...',

    // run_shell stall/timeout diagnostics — issue #69
    // The bracketed `[Note: ...]` prefix is a stable marker token the LLM is
    // instructed (via tools/schema.js) to detect; keep it identical across
    // locales and only localize the trailing human-readable explanation.
    shellNoOutput:      '[Note: no output for last {sec}s]',
    shellSilentTimeout: '[Note: process was silent for last {sec}s before timeout — likely hung (e.g. port in use, waiting for input, blocked on external resource). Do NOT retry blindly; report the situation to the user.]',
};

const ZH = {
    apiKeyPrompt: '输入 DeepSeek API Key（保存到 VS Code SecretStorage，不会写入 settings.json）',
    apiKeySaved: 'Deep Copilot：API Key 已保存。',
    apiKeyDeleted: 'Deep Copilot：API Key 已删除。',
    apiKeyMissing: '请先设置 API Key — 点击工具栏 🔑 按钮。',
    baseUrlIntl: '🌍 国际版（默认）',
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
    createSkillLabel: '创建技能：',
    insertNoEditor: '请先在编辑器中打开一个文件。',
    inserted: '代码已插入编辑器。',
    copied: '已复制到剪贴板。',
    feedbackUp: '👍 已记录',
    feedbackDown: '👎 已记录',
    sessionUntitled: '未命名',
    errTitle: '请求失败',
    errTitle401: 'API Key 无效或已过期',
    errTip401: '请打开右上角 🔑 重新设置 API Key，确认密钥未过期且未被禁用。',
    errTitle402: '账户余额不足',
    errTip402: '请前往服务商控制台充值后再试。',
    errTitle429: '请求过于频繁(限流)',
    errTip429: '已触发限流。请稍候几秒再点击「重试」。',
    errTitle400: '请求参数错误',
    errTip400: '可能是上下文过长或消息格式异常。可尝试清空会话(Ctrl+K)后重试。',
    errTitle5xx: '服务异常',
    errNetwork: '网络连接失败',
    errTipNetwork: '无法连接 API。请检查网络/代理/防火墙设置。',
    errAborted: '已停止生成',
    errTipAborted: '生成被用户中断。',
    wvWelcomeSub:       '让高质量 AI 生产力开放、公平、普惠',
    wvWelcomeHint:      '输入消息，按 Enter 发送',
    wvSessions:         '历史会话',
    wvWorkspace:        '本工作区',
    wvWorkspaceTitle:   '只显示当前工作区会话',
    wvAll:              '全部',
    wvSearchPlaceholder:'搜索会话...',
    wvNewSession:       '新建会话',
    wvNoSessions:       '暂无会话',
    wvThinking:         '● ● ● 思考中...',
    wvInputPlaceholder: '描述要构建的内容',
    wvSend:             '发送',
    wvApiTitle:         'API 设置 · DeepSeek / Tavily / Base URL',
    wvCacheTitle:       'prompt 缓存命中率（越高越省钱）',
    wvSwitchModel:      '切换模型',
    wvApprovalMode:     '批准策略 (Approval Mode)',
    wvInteractionMode:  '交互模式',
    wvBalanceTitle:     '账户余额（点击刷新）',
    wvBalanceInit:      '💰 查询中…',

    // run_shell stall/timeout diagnostics — issue #69
    // 方括号内的 `[Note: ...]` 是给模型识别的稳定标记，跨语言保持一致；
    // 仅本地化后面的中文说明部分。
    shellNoOutput:      '[Note: no output for last {sec}s]（进程仍在运行，已 {sec} 秒未输出）',
    shellSilentTimeout: '[Note: process was silent for last {sec}s before timeout — likely hung]（超时前 {sec} 秒静默，疑似挂起：端口被占用 / 等待输入 / 外部资源阻塞。不要盲目重试，请向用户报告。）',
};

function t(key) {
    const bundle = isZh() ? ZH : EN;
    return bundle[key] != null ? bundle[key] : (EN[key] != null ? EN[key] : key);
}

// Formatted variant of t() — substitutes {placeholder} tokens with values
// from params. Use for messages that need runtime values interpolated.
function tf(key, params) {
    let s = t(key);
    if (params) {
        for (const k of Object.keys(params)) {
            s = s.split('{' + k + '}').join(String(params[k]));
        }
    }
    return s;
}

module.exports = { t, tf, isZh };
