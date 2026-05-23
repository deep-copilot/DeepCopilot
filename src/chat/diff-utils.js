// Minimal line-diff utility for the Pending-Edits panel.
//
// We don't need a fully-fledged diff package: the UI only shows `+N -M` and
// "isNew/isDelete" flags. The implementation is a standard LCS table with a
// graceful fall-back for huge files (>10k lines or >100k chars), where we
// degrade to a cheap line-set diff to avoid blocking the extension host.
'use strict';

const MAX_LINES_LCS = 10000;
const MAX_CHARS_LCS = 100000;

/**
 * Detect if a buffer looks binary (UTF-8 incompatible). Cheap heuristic:
 * scan the first 8 KiB for a NUL byte. Avoids garbled +/- counts on PNGs etc.
 */
function isProbablyBinary(text) {
    if (typeof text !== 'string') return true;
    const slice = text.length > 8192 ? text.slice(0, 8192) : text;
    return slice.indexOf('\u0000') !== -1;
}

function _splitLines(text) {
    if (text === '' || text == null) return [];
    return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Set-based fallback: counts lines that exist only in one side. Not as
 * accurate as LCS for repeated lines but gives a reasonable order of
 * magnitude without burning CPU.
 */
function _setDiff(beforeLines, afterLines) {
    const beforeMap = new Map();
    for (const l of beforeLines) beforeMap.set(l, (beforeMap.get(l) || 0) + 1);
    let removed = 0;
    for (const l of afterLines) {
        const c = beforeMap.get(l);
        if (c) beforeMap.set(l, c - 1);
    }
    for (const c of beforeMap.values()) removed += c;
    const afterMap = new Map();
    for (const l of afterLines) afterMap.set(l, (afterMap.get(l) || 0) + 1);
    let added = 0;
    for (const l of beforeLines) {
        const c = afterMap.get(l);
        if (c) afterMap.set(l, c - 1);
    }
    for (const c of afterMap.values()) added += c;
    return { added, removed };
}

/**
 * Standard LCS line diff. Returns { added, removed } counting lines that are
 * not part of the longest common subsequence.
 */
function _lcsDiff(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return { added: n, removed: 0 };
    if (n === 0) return { added: 0, removed: m };

    // Two-row DP to keep memory at O(min(m,n)). We only need to keep the DP
    // table on the shorter axis; `added`/`removed` are still derived from the
    // original a/b lengths below, so we don't need to track which side was
    // swapped here.
    const [shorter, longer] = m <= n ? [a, b] : [b, a];
    const sm = shorter.length, lm = longer.length;
    let prev = new Uint32Array(sm + 1);
    let curr = new Uint32Array(sm + 1);
    for (let i = 1; i <= lm; i++) {
        for (let j = 1; j <= sm; j++) {
            curr[j] = longer[i - 1] === shorter[j - 1]
                ? prev[j - 1] + 1
                : (prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1]);
        }
        const tmp = prev; prev = curr; curr = tmp;
        curr.fill(0);
    }
    const lcsLen = prev[sm];
    // `a` is always the "before" side and `b` is the "after" side; the swap
    // above only exists to keep the DP table on the shorter axis.
    const added   = b.length - lcsLen;
    const removed = a.length - lcsLen;
    return { added, removed };
}

/**
 * Public entry point. `before === null` means the file is new; `after === null`
 * (rare) means the file was removed. Both null → no-op.
 */
function lineDiffStats(before, after) {
    const isNew    = before === null || before === undefined;
    const isDelete = after  === null || after  === undefined;

    if (isNew && isDelete) return { added: 0, removed: 0, isNew: false, isDelete: false };

    // Binary safety net: if either side looks binary, just report "modified".
    if ((!isNew    && isProbablyBinary(before)) ||
        (!isDelete && isProbablyBinary(after))) {
        return { added: 0, removed: 0, isNew, isDelete, binary: true };
    }

    if (isNew) {
        const lines = _splitLines(after);
        return { added: lines.length, removed: 0, isNew: true, isDelete: false };
    }
    if (isDelete) {
        const lines = _splitLines(before);
        return { added: 0, removed: lines.length, isNew: false, isDelete: true };
    }

    if (before === after) return { added: 0, removed: 0, isNew: false, isDelete: false };

    const beforeLines = _splitLines(before);
    const afterLines  = _splitLines(after);
    const tooBig = beforeLines.length > MAX_LINES_LCS ||
                   afterLines.length  > MAX_LINES_LCS ||
                   (before.length + after.length) > MAX_CHARS_LCS * 2;

    const { added, removed } = tooBig
        ? _setDiff(beforeLines, afterLines)
        : _lcsDiff(beforeLines, afterLines);
    return { added, removed, isNew: false, isDelete: false, approximate: !!tooBig };
}

module.exports = { lineDiffStats, isProbablyBinary };
