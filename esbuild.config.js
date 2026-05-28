// Bundle the VS Code extension source (src/) into a single CJS file (out/extension.js).
// The webview front-end (media/chat.js, chat.css) is shipped as-is; if you later split it
// into src/webview-src/, add a second build target below pointing at media/chat.js.
'use strict';

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Keep codicons font files in media/ in sync with node_modules on every build.
function syncCodicons() {
    const src = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
    const dst = path.join(__dirname, 'media');
    for (const f of ['codicon.css', 'codicon.ttf']) {
        const s = path.join(src, f), d = path.join(dst, f);
        if (fs.existsSync(s)) fs.copyFileSync(s, d);
    }
}
// Keep DOMPurify distributable in sync with node_modules on every build.
// Used by media/chat.js to sanitize whitelisted HTML passthrough in
// markdown rendering (see Issue #35 / RFC: HTML-capable rendering).
function syncDomPurify() {
    const src = path.join(__dirname, 'node_modules', 'dompurify', 'dist', 'purify.min.js');
    const dst = path.join(__dirname, 'media', 'purify.min.js');
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
}

// Copy provider definition JSONs from src/providers/ → out/providers/.
// The runtime registry (src/providers/index.js) does fs.readdirSync on this
// directory; esbuild would otherwise inline JSON via require() and the
// dynamic discovery / user providersDir feature would not work.
function syncProviders() {
    const src = path.join(__dirname, 'src', 'providers');
    const dst = path.join(__dirname, 'out', 'providers');
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
        if (!f.endsWith('.json')) continue;
        fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
}

// Keep KaTeX distributable in sync with node_modules on every build.
function syncKatex() {
    const src = path.join(__dirname, 'node_modules', 'katex', 'dist');
    const dst = path.join(__dirname, 'media');
    const fontsDir = path.join(dst, 'fonts');
    if (!fs.existsSync(fontsDir)) fs.mkdirSync(fontsDir, { recursive: true });
    for (const f of ['katex.min.js', 'katex.min.css']) {
        const s = path.join(src, f), d = path.join(dst, f);
        if (fs.existsSync(s)) fs.copyFileSync(s, d);
    }
    const srcFonts = path.join(src, 'fonts');
    if (fs.existsSync(srcFonts)) {
        for (const f of fs.readdirSync(srcFonts)) {
            fs.copyFileSync(path.join(srcFonts, f), path.join(fontsDir, f));
        }
    }
}
syncCodicons();
syncKatex();
syncDomPurify();
syncProviders();

const watch = process.argv.includes('--watch');
const isProd = !watch && process.env.NODE_ENV !== 'development';

const extConfig = {
    entryPoints: ['src/extension.js'],
    outfile: 'out/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node18',
    external: ['vscode', 'js-tiktoken'],
    format: 'cjs',
    minify: isProd,
    sourcemap: !isProd,
    logLevel: 'info',
    legalComments: 'none',
};

(async () => {
    if (watch) {
        const ctx = await esbuild.context(extConfig);
        await ctx.watch();
        console.log('[esbuild] watching src/ → out/extension.js ...');
    } else {
        await esbuild.build(extConfig);
        console.log('[esbuild] built out/extension.js (minified)');
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
