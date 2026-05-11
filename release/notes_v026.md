## v0.26.0 New Features

### #11 parallel_tool_calls
- API now sends parallel_tool_calls: true
- Read-only tools run concurrently (read_file, grep_search, find_files, list_dir, web_search)
- Mutating tools still run serially for safety
- Significantly faster multi-tool scenarios

### #12 @file Attach + Drag-and-Drop
- Type @ in the input to fuzzy-search workspace files with a popup
- Selected files appear as removable chips above the input box
- Drag files from the VS Code Explorer onto the composer
- File contents are injected as attachment XML blocks on send (64KB per file, 256KB total)

### #13 apply_patch Tool
- New apply_patch tool supporting standard unified diff format
- Built-in diff parser — no external dependencies
- fuzz=0/1/2 tolerance cascade for minor context drift
- Per-hunk success/failure diagnostics for model self-correction
- System prompt updated to guide model toward apply_patch for multi-line edits

### #14 Codeblock Action Toolbar
- Non-shell code blocks gain Apply button — smart-applies to active editor
- New File button — opens code in a new untitled document
- Apply auto-detects unified diff and routes through apply_patch engine
- Language ID auto-mapping (js->javascript, py->python, rs->rust, etc.)

### #15 Per-session Tool Result Cache
- Each session maintains an independent cache for read-only tool results
- mtime-based invalidation for file reads
- Mutating tools (write_file, str_replace_in_file, apply_patch) auto-invalidate affected cache
- run_shell clears all file caches
- Reduces redundant reads and API token usage
