// Friendly error mapping for the chat error card.
'use strict';

function friendlyError(e) {
    const code = e && e.statusCode;
    const raw = (e && e.message) || String(e || '');
    let title = '请求失败', tip = raw, retryable = true;

    if (code === 401 || code === 403) {
        title = 'API Key 无效或已过期';
        tip = '请打开右上角 🔑 重新设置 DeepSeek API Key,确认密钥未过期且未被禁用。';
        retryable = false;
    } else if (code === 402) {
        title = '账户余额不足';
        tip = '请前往 DeepSeek 控制台充值后再试。';
        retryable = false;
    } else if (code === 429) {
        title = '请求过于频繁(限流)';
        tip = '已触发 DeepSeek 限流。请稍候几秒再点击「重试」。';
    } else if (code === 400) {
        title = '请求参数错误';
        tip = '可能是上下文过长或消息格式异常。可尝试清空会话(Ctrl+K)后重试。';
    } else if (code && code >= 500) {
        title = 'DeepSeek 服务异常';
        tip = `服务端返回 ${code}。这通常是临时故障,几秒后重试即可。`;
    } else if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|fetch failed/i.test(raw)) {
        title = '网络连接失败';
        tip = '无法连接 DeepSeek API。请检查网络/代理/防火墙设置。';
    } else if (/aborted/i.test(raw)) {
        title = '已停止生成';
        tip = '生成被用户中断。';
        retryable = false;
    }
    return { title, tip, code: code || null, retryable, raw };
}

module.exports = { friendlyError };
