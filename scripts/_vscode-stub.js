// Minimal stub for the `vscode` module, used by scripts/test-*.js so that
// pure helpers inside src/chat/session-store.js can be required outside the
// VS Code extension host. Only the surface used at module load is provided.
'use strict';

module.exports = {
    workspace: {
        getConfiguration: () => ({ get: (_k, def) => def }),
    },
    EventEmitter: class { constructor() { this.event = () => () => {}; } fire() {} dispose() {} },
    Disposable: class { dispose() {} },
    Uri: { file: (p) => ({ fsPath: p }) },
};
