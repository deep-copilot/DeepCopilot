// @ts-check
const { danger, warn, fail, message } = require('danger');

const modifiedFiles = danger.git.modified_files;
const createdFiles = danger.git.created_files;
const allChangedFiles = [...modifiedFiles, ...createdFiles];

// ── 1. PR 描述不能太短 ──────────────────────────────────────────
const bodyLength = (danger.github.pr.body || '').trim().length;
if (bodyLength < 30) {
  warn('PR 描述过短，请补充说明改动原因和影响范围（至少 30 个字符）。');
}

// ── 2. package.json 改了版本号要同步改 CHANGELOG ──────────────
const pkgChanged = modifiedFiles.includes('package.json');
const changelogChanged = modifiedFiles.some(f => f.match(/CHANGELOG/i));
if (pkgChanged && !changelogChanged) {
  warn('`package.json` 版本号有变动，但未更新 `CHANGELOG.md`，请确认是否需要记录变更。');
}

// ── 3. chat.js 改了要确认 chat.css 同步 ───────────────────────
const chatJsChanged = allChangedFiles.includes('media/chat.js');
const chatCssChanged = allChangedFiles.includes('media/chat.css');
if (chatJsChanged && !chatCssChanged) {
  warn('`media/chat.js` 有改动，但 `media/chat.css` 未变动。如果涉及新增 UI 元素，请确认样式是否需要同步。');
}

// ── 4. 渲染逻辑改了要确认 system prompt 一致 ──────────────────
const renderChanged = allChangedFiles.includes('media/chat.js');
const promptChanged = allChangedFiles.includes('src/prompts/system.js');
if (renderChanged && !promptChanged) {
  message('`media/chat.js` 有改动，如果涉及渲染能力变化，请确认 `src/prompts/system.js` 中的说明是否需要同步。');
}

// ── 5. 禁止直接提交 release/ 目录下的 .vsix ──────────────────
const vsixInPR = allChangedFiles.some(f => f.startsWith('release/') && f.endsWith('.vsix'));
if (vsixInPR) {
  fail('不应在 PR 中提交 `release/*.vsix` 文件，请将其加入 `.gitignore`，通过 CI 构建产物分发。');
}

// ── 6. 核心工具文件变动提示 ───────────────────────────────────
const coreToolFiles = [
  'src/tools/exec.js',
  'src/tools/file-write.js',
  'src/tools/shell.js',
  'src/chat/agent-loop.js',
];
const coreChanged = coreToolFiles.filter(f => allChangedFiles.includes(f));
if (coreChanged.length > 0) {
  warn(`核心工具文件有改动：${coreChanged.map(f => `\`${f}\``).join(', ')}。请确认变更经过充分测试，避免工具执行安全问题。`);
}

// ── 7. PR 规模提示（超大 PR 建议拆分）────────────────────────
if (danger.github.pr.additions + danger.github.pr.deletions > 600) {
  warn(`本 PR 变更行数较多（+${danger.github.pr.additions} / -${danger.github.pr.deletions}），建议拆分为更小的 PR 以便 review。`);
}
