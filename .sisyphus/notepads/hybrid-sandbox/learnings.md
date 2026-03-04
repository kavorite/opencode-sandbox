# Learnings — hybrid-sandbox

## [2026-03-03] Session ses_359a7787dffefS3NFhth1iXTTo — Atlas setup

### Architecture
- Hybrid: `--bind $PROJECT` (direct writes) + `--overlay $HOME` (violation capture) 
- bwrap mount ordering: `--ro-bind / /` → `--overlay $HOME` → `--bind $PROJECT` (later overrides earlier)
- PROJECT === HOME edge case: skip bind-mount, overlay everything
- PROJECT outside HOME: both `--bind $PROJECT` and `--overlay $HOME`

### Key File Locations
- wrapper.ts: `src/wrapper.ts` (121 lines, command() at L42)
- epilogue.ts: `src/epilogue.ts` (161 lines, run() at L115, walk() at L28)
- index.ts: `src/index.ts` (162 lines — OLD capture+replay, needs full rewrite)
- bin/epilogue.ts: does NOT exist yet (Task 2 creates it)
- Makefile: 29 lines (build/clean/test/check targets)
- opencode patched branch: has permission.ask patch committed (86c74185d) + bash.ts review UNCOMMITTED

### Test State
- 180/188 passing; 8 failing (transparent-wrapper only — epilogue 8 FIXED)
- Epilogue: 19/19 passing after HOME-scoped walk + test project moved inside HOME
- Stable test files (do NOT modify): overlay, observe, proxy, protocol, degradation, integration, e2e-permission

### Code Style Constraints
- Single word variable names, no `any`, no `else`, `const` over `let`, no destructuring, Bun APIs
- ZERO console output at runtime (remove all console.log/warn/error from all src/ files)

## [2026-03-02] Task 1 — Hybrid bind-mount in wrapper.ts

### Changes Made
- `src/wrapper.ts` L73-82: Replaced cwd-based overlay with hybrid bind-mount logic
- Old: overlayArgs(opts.cwd) when cwd outside home → New: `--bind opts.project opts.project` (unless project===home)
- `test/wrapper.test.ts`: Updated "overlay for cwd outside home" test assertions (now expects NOT overlay), added 5 hybrid tests
- Total tests: 31 (26 existing + 5 new), all passing

### Evidence Verified
- project inside HOME: `--overlay-src /home/user` then `--bind /home/user/proj /home/user/proj` ✓
- project === HOME: overlay only, no bind-mount ✓
- project outside HOME: `--overlay-src /home/user` then `--bind /opt/work /opt/work` ✓
- Mount ordering: `--overlay` always before `--bind` ✓
- No `--overlay-src $PROJECT` in any scenario ✓


## [2026-03-03] Wave 1 Complete

### wrapper.ts changes (Task 1)
- Lines 73-82: overlay HOME always; bind PROJECT only if project !== home
- `isHome` check: `opts.project === opts.home || opts.project === opts.home + "/"`
- Bug fixed by Atlas: epilogue invocation was missing `--home` arg (lines 106-113 now include it)
- 31 wrapper tests pass

### epilogue.ts changes (Task 2)
- RunOptions.home added (required field)
- walk() call changed to: `walk(path.join(opts.upper, opts.home), opts.upper)`
- TEST PROJECT must be inside HOME for epilogue to see it — tests use `path.join(os.homedir(), "oc-epilogue-test-project")`
- 19 epilogue tests pass

### bin/epilogue.ts created (Task 2)
- CLI entry point: parses --upper, --project, --call-id, --allow, --home, --observe-log
- Always exits 0 (never non-zero on errors)

### observe.c --log flag (Task 3)
- `--log` flag implemented at lines 521-532: opens file in append mode, uses `logfd` for all fprintf calls
- Recompiled OK, tested OK

### Epilogue invocation in wrapper.ts
Command format: `epilogue --upper U --project P --call-id C --allow A --home H [--observe-log L]`

## [2026-03-02] Task 4 — Transparent wrapper index.ts rewrite

### Architecture Change
- Replaced capture+replay with 4 hooks: tool.execute.before, permission.ask, tool.execute.after, shell.env
- tool.execute.before: stash args ref, create overlay upper+work dirs, pre-create subdirs for HOME + system overlay dirs
- permission.ask (bash): build wrapper command via wrapper.command(), mutate stashed args.command, auto-allow
- permission.ask (edit/write/apply_patch): policy check via policy.writable()
- permission.ask (sandbox_review): commit discarded ops via exported epilogue.commit(), clean overlay, allow
- tool.execute.after: cleanup stale overlays (safety net)
- shell.env: set OC_SANDBOX=1, OC_SANDBOX_PROJECT, OC_SANDBOX_WRITABLE

### System Overlay Discovery
- Can't overlay `/` — kernel EINVAL (upper/work can't be inside lowerdir)
- Can't overlay dirs with nested overlayfs (e.g., /var with Docker overlay2) — kernel EINVAL
- Solution: probe each top-level dir with bwrap at plugin init, filter incompatible ones
- Overlays HOME (always) + compatible system dirs (e.g., /opt, /usr, /srv, /etc, /boot)
- wrapper.ts got `overlayDirs?: string[]` option; epilogue --home set to "/" when overlayDirs present

### Files Modified
- src/index.ts: full rewrite (154→170 lines)
- src/wrapper.ts: added overlayDirs option (+8 lines)
- src/epilogue.ts: exported commit() function
- src/deps.ts: removed 2 console.warn calls
- src/config.ts: removed 2 console.warn calls
- src/sandbox.ts: added @deprecated, removed 1 console.warn
- src/commit.ts: added @deprecated
- bin/epilogue.ts: added shebang, chmod +x

### Test Impact
- 16/16 transparent-wrapper tests: ALL PASS
- 8 old-architecture tests (e2e-permission, execute-once, integration) now fail — expected, they test the capture+replay flow