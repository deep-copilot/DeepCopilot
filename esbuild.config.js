// Bundle the VS Code extension source (src/) into a single CJS file (out/extension.js).
// The webview front-end (media/chat.js, chat.css) is shipped as-is; if you later split it
// into src/webview-src/, add a second build target below pointing at media/chat.js.
'use strict';

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const isProd = !watch && process.env.NODE_ENV !== 'development';

const extConfig = {
    entryPoints: ['src/extension.js'],
    outfile: 'out/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
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
