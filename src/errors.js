// Friendly error mapping for the chat error card.
'use strict';

const { t, isZh } = require('./utils/i18n');

function friendlyError(e) {
    const code = e && e.statusCode;
    const raw = (e && e.message) || String(e || '');
    let title = t('errTitle'), tip = raw, retryable = true;

    if (code === 401 || code === 403) {
        title = t('errTitle401');
        tip = t('errTip401');
        retryable = false;
    } else if (code === 402) {
        title = t('errTitle402');
        tip = t('errTip402');
        retryable = false;
    } else if (code === 429) {
        title = t('errTitle429');
        tip = t('errTip429');
    } else if (code === 400) {
        title = t('errTitle400');
        tip = t('errTip400');
    } else if (code && code >= 500) {
        title = t('errTitle5xx');
        tip = isZh()
            ? `服务端返回 ${code}。这通常是临时故障，几秒后重试即可。`
            : `Server returned ${code}. This is usually a temporary issue — retry in a few seconds.`;
    } else if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|fetch failed/i.test(raw)) {
        title = t('errNetwork');
        tip = t('errTipNetwork');
    } else if (/aborted/i.test(raw)) {
        title = t('errAborted');
        tip = t('errTipAborted');
        retryable = false;
    }
    return { title, tip, code: code || null, retryable, raw };
}

module.exports = { friendlyError };
