# Issues — hybrid-sandbox

## [2026-03-03] Session ses_359a7787dffefS3NFhth1iXTTo — Initial known issues

### epilogue.ts: intermediate dir inflation
- walk() emits `type: "dir"` ops for EVERY parent dir when creating nested files
- e.g., writing `/home/user/.config/app/file.txt` creates dir ops for `/home`, `/home/user`, `/home/user/.config`, `/home/user/.config/app`
- Tests asserting exact committed/discarded counts fail because they count dir ops
- Fix: filter `type: "dir"` ops from fsViolations, and update test assertions

### epilogue.ts: walks entire overlay, not just HOME
- Current: `walk(opts.upper, opts.upper)` — walks everything
- Should be: `walk(path.join(opts.upper, opts.home), opts.upper)` — only HOME subtree
- Test overlayFile() helper creates files at `upper + target` — needs to create at `upper + HOME + relpath`

### index.ts: old architecture, missing 3 of 4 hooks
- No `tool.execute.after`, no `shell.env`, no `sandbox_review` handler
- Still uses sandbox.ts capture+replay instead of wrapper.ts transparent wrapper

### oc-build: bash.ts review patch uncommitted
- `git diff HEAD` in /home/staly/opencode shows 22-line uncommitted bash.ts changes
- Must amend into single commit (86c74185d) before rebuilding — oc-build rebases HEAD~1
