// Barrel re-export 鈥?keeps backward-compatible imports while the real
// implementations live in focused sub-modules:
//
//   src/tools/file-read.js   鈥?read_file, list_dir, grep_search, find_files
//   src/tools/file-write.js  鈥?write_file, str_replace_in_file, apply_patch
//   src/tools/shell.js       鈥?run_shell
//   src/tools/web-search.js  鈥?web_search
//   src/tools/utils.js       鈥?truncate, ensurePathAllowed (shared helpers)
//
// To add a new tool: create a new sub-module and re-export it here, then
// register it in ToolExecutor (src/chat/tool-executor.js).
'use strict';

const { toolReadFile, toolListDir, toolGrepSearch, toolFindFiles } = require('./file-read');
const { toolWriteFile, toolStrReplaceInFile, toolApplyPatch }     = require('./file-write');
const { toolRunShell, isDangerous }                               = require('./shell');
const { toolWebSearch }                                           = require('./web-search');
const { truncate }                                                = require('./utils');

module.exports = {
    toolReadFile,
    toolListDir,
    toolGrepSearch,
    toolFindFiles,
    toolWriteFile,
    toolStrReplaceInFile,
    toolApplyPatch,
    toolRunShell,
    toolWebSearch,
    truncate,
    isDangerous,
};

