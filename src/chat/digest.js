// Local (no-LLM) digest builder for auto-wake evidence.
//
// Goals:
//   - Extract the few lines that actually matter (errors / progress) from
//     potentially huge bg-job output so the model spends minimum tokens.
//   - Cheap, deterministic, no network. Runs synchronously inside
//     wake-scheduler when a watcher fires.
'use strict';

const ANOMALY_RE = /(?:traceback|exception|^error\b|\bfatal\b|out of memory|\bOOM\b|CUDA error|killed|\bnan\b|\binf\b|segmentation fault|address already in use|connection refused|timed out|timeout|permission denied|access denied|not found|cannot find|no such file|undefined reference)/i;

const PROGRESS_RE = /(?:epoch\s*[:=]?\s*(\d+)\s*[\/of]\s*(\d+)|step\s*[:=]?\s*(\d+)|iter(?:ation)?\s*[:=]?\s*(\d+)|loss\s*[:=]\s*([0-9.eE+-]+)|acc(?:uracy)?\s*[:=]\s*([0-9.eE+-]+)|(\d+)\s*%)/i;

const MAX_OUTPUT_SCAN = 200 * 1024; // hard cap on bytes scanned per digest

function _splitLines(s) {
    return String(s || '').split(/\r?\n/);
}

function extractAnomalies(lines, context = 6) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        if (ANOMALY_RE.test(lines[i])) {
            const start = Math.max(0, i - context);
            const end = Math.min(lines.length, i + context + 1);
            hits.push({
                idx: i,
                line: lines[i].trim(),
                context: lines.slice(start, end).join('\n'),
            });
        }
    }
    return hits;
}

function extractProgress(lines) {
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
        if (PROGRESS_RE.test(lines[i])) {
            matches.push({ idx: i, line: lines[i].trim() });
        }
    }
    if (matches.length <= 4) return matches;
    // Keep first, two interior anchors, last.
    return [
        matches[0],
        matches[Math.floor(matches.length / 3)],
        matches[Math.floor((2 * matches.length) / 3)],
        matches[matches.length - 1],
    ];
}

/**
 * @param {{
 *   trigger: string,
 *   watcherId?: string,
 *   watcherDesc?: string,
 *   jobId?: string|null,
 *   exitCode?: number|null,
 *   durationMs?: number|null,
 *   output?: string,
 *   lastSeenLen?: number|null,
 *   maxChars?: number,
 * }} opts
 * @returns {string} markdown-ish digest, suitable for system-reminder injection.
 */
function buildDigest(opts) {
    const {
        trigger = 'unknown',
        watcherId,
        watcherDesc,
        jobId,
        exitCode,
        durationMs,
        output,
        lastSeenLen,
        maxChars = 6000,
    } = opts || {};

    let outStr = String(output || '');
    if (outStr.length > MAX_OUTPUT_SCAN) outStr = outStr.slice(-MAX_OUTPUT_SCAN);

    const recent = lastSeenLen != null && lastSeenLen >= 0
        ? outStr.slice(Math.max(0, Math.min(lastSeenLen, outStr.length)))
        : outStr;
    const scanLines = _splitLines(recent);
    const allLines = _splitLines(outStr);

    const anomalies = extractAnomalies(scanLines.length ? scanLines : allLines).slice(0, 3);
    const progress = extractProgress(allLines);

    const parts = [];
    parts.push(`[auto-wake at ${new Date().toISOString()} | trigger=${trigger}]`);
    if (watcherId) parts.push(`Watcher: ${watcherId}${watcherDesc ? ' — ' + watcherDesc : ''}`);
    if (jobId) {
        const exitLabel = exitCode == null
            ? 'still-running-or-unknown'
            : exitCode === 0 ? 'SUCCESS' : `FAILED(${exitCode})`;
        const durLabel = durationMs ? ` | duration=${Math.round(durationMs / 1000)}s` : '';
        parts.push(`Job: ${jobId} | ${exitLabel}${durLabel}`);
    }

    if (anomalies.length) {
        parts.push('');
        parts.push('--- anomalies detected (with context) ---');
        for (const a of anomalies) {
            parts.push(a.context);
            parts.push('---');
        }
    }

    if (progress.length) {
        parts.push('');
        parts.push('--- progress snapshot ---');
        for (const p of progress) parts.push(p.line);
    }

    if (!anomalies.length) {
        // No errors — include a small recent tail for context.
        const tail = scanLines.slice(-20).join('\n');
        if (tail.trim()) {
            parts.push('');
            parts.push('--- recent output tail ---');
            parts.push(tail);
        }
    }

    let result = parts.join('\n').trimEnd();
    if (result.length > maxChars) {
        result = result.slice(0, maxChars) + `\n…[digest truncated, ${result.length - maxChars} more chars]`;
    }
    return result;
}

module.exports = { extractAnomalies, extractProgress, buildDigest };
