// Open a file path (from a chat message) in the editor.
// Routes binary formats (images / PDFs / archives / model weights ...) to
// VS Code's default handler instead of the text editor, which would error out.
'use strict';

const vscode = require('vscode');
const path = require('path');

const BINARY_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.ico', '.svg',
    '.pdf', '.ps', '.eps', '.dvi',
    '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.ogg', '.flac',
    '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf',
    '.parquet', '.arrow', '.feather', '.hdf5', '.h5', '.nc', '.mat', '.npy', '.npz',
    '.pkl', '.pickle', '.pt', '.pth', '.onnx', '.safetensors', '.ckpt', '.bin', '.gguf',
    '.odb', '.cae', '.fil', '.stl', '.step', '.stp', '.iges', '.igs', '.obj', '.fbx', '.gltf', '.glb',
]);

async function openFile(p, line) {
    if (!p) return;
    try {
        const folders = vscode.workspace.workspaceFolders || [];
        const tries = [];
        if (path.isAbsolute(p)) tries.push(vscode.Uri.file(p));
        for (const f of folders) tries.push(vscode.Uri.joinPath(f.uri, p));
        let target = null;
        for (const u of tries) {
            try { await vscode.workspace.fs.stat(u); target = u; break; } catch (_) {}
        }
        if (!target) {
            const found = await vscode.workspace.findFiles(`**/${path.basename(p)}`, undefined, 5);
            if (found.length === 1) target = found[0];
            else if (found.length > 1) {
                const picks = found.map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));
                const c = await vscode.window.showQuickPick(picks, { placeHolder: `选择 ${path.basename(p)}` });
                if (c) target = c.uri;
            }
        }
        if (!target) { vscode.window.showWarningMessage(`找不到文件：${p}`); return; }

        const ext = path.extname(target.fsPath).toLowerCase();
        if (BINARY_EXT.has(ext)) {
            try {
                await vscode.commands.executeCommand('vscode.open', target, { viewColumn: vscode.ViewColumn.One, preview: false });
            } catch (_) {
                await vscode.env.openExternal(target);
            }
            return;
        }
        const opts = { preview: false, viewColumn: vscode.ViewColumn.One, preserveFocus: false };
        if (line && line > 0) {
            const pos = new vscode.Position(Math.max(0, line - 1), 0);
            opts.selection = new vscode.Range(pos, pos);
        }
        await vscode.window.showTextDocument(target, opts);
    } catch (err) {
        vscode.window.showErrorMessage('打开文件失败：' + (err?.message || err));
    }
}

module.exports = { openFile, BINARY_EXT };
