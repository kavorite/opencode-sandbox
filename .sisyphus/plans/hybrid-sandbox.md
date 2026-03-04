# Hybrid Bind-Mount + Overlay Sandbox Architecture

## TL;DR

> **Quick Summary**: Migrate the opencode-sandbox plugin from capture+replay to a transparent hybrid architecture: bind-mount the project directory read-write (direct writes), overlay only HOME for violation capture + review, with post-execution prompting via bash.ts manifest.
> 
> **Deliverables**:
> - Updated `wrapper.ts` generating hybrid bwrap commands (`--bind` project + `--overlay` HOME)
> - Updated `epilogue.ts` walking only HOME overlay, with CLI binary (`bin/oc-epilogue`)
> - Rewritten `index.ts` with new hook flow (tool.execute.before, permission.ask, tool.execute.after, shell.env)
> - All 188+ tests passing (currently 172/188)
> - Compiled epilogue binary
> - Rebuilt opencode with both upstream patches (permission.ask + bash.ts review) as single commit
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 waves (2 parallel in Wave 1)
> **Critical Path**: Task 1/2 (parallel) → Task 3 → Task 4 → Task 6 → Task 7

---

## Context

### Original Request
Implement the hybrid bind-mount + overlay architecture selected during the architecture pivot discussion. The user chose "Hybrid" after questioning why the overlay needs walking at all — the insight being that project directory writes can go through directly via bind-mount, with overlay reserved only for HOME to capture violations for review.

### Interview Summary
**Key Discussions**:
- Architecture evolved: capture+replay → transparent wrapper → hybrid bind-mount + overlay
- User selected hybrid after analyzing overlay walking necessity
- TDD approach: tests first, drive implementation from failing tests
- bash.ts upstream patch must be managed alongside permission.ask as single commit
- FS violations need user prompts via ctx.ask(), not auto-discard
- Observe mode needed in Phase 1, not deferred
- Remove blocking fallback — error if oc-observe missing when observe mode configured
- Shell hook (shell.env) provides direnv-style environment variables to inform agent about sandbox
- Epilogue can be compiled TS binary via `bun build --compile`

**Research Findings**:
- bwrap processes mounts left-to-right; later mounts override earlier ones (child `--bind` after parent `--overlay` "punches through")
- overlayfs whiteout = character device with rdev 0
- `ctx.ask()` works post-process-exit in bash.ts before tool returns
- shell.env hook fires before process spawn, sets env vars on spawned process
- oc-build rebases exactly `HEAD~1` — both patches must be in one commit

### Metis Review
**Identified Gaps** (addressed):
- PROJECT inside HOME mount ordering: `--overlay HOME` then `--bind PROJECT` — bind overrides overlay for subtree. Added as explicit test requirement.
- PROJECT === HOME edge case: if user runs from `~`, bind-mount would defeat overlay. Must skip bind-mount and overlay everything.
- oc-build `HEAD~1` limitation: bash.ts review patch is currently uncommitted. Must be amend-committed into the single patched commit.
- Strace disappearance: in new architecture, strace only runs when observe mode is configured. In block mode, no syscall visibility — overlay walking replaces strace for filesystem mutation detection. This is intentional and correct.
- Epilogue CLI arg parsing: bin/epilogue.ts needs `--upper`, `--project`, `--call-id`, `--allow`, `--home`, `--observe-log` parsing.
- `home_readable: false` config: deferred — not supported in hybrid Phase 1.
- sandbox.ts and commit.ts become dead code: mark `@deprecated`, don't delete.

---

## Work Objectives

### Core Objective
Replace the capture+replay sandbox architecture with a transparent hybrid wrapper that bind-mounts the project directory (direct writes) and overlays only HOME (violation capture + review), eliminating agent confusion from command rewriting while maintaining security boundaries.

### Concrete Deliverables
- `src/wrapper.ts` — generates hybrid bwrap command with `--bind $PROJECT` + `--overlay $HOME`
- `src/epilogue.ts` — walks only HOME overlay, filters intermediate dirs, builds manifest
- `bin/epilogue.ts` — CLI entry point for epilogue binary
- `bin/oc-epilogue` — compiled standalone binary
- `src/index.ts` — new hook flow: tool.execute.before, permission.ask, tool.execute.after, shell.env
- Updated `Makefile` with epilogue build target
- Opencode patched commit with both patches (permission.ask + bash.ts review)

### Definition of Done
- [ ] `bun test` → 0 failures, all tests pass
- [ ] `bin/oc-epilogue` exists and runs: `bin/oc-epilogue --help` or exits cleanly
- [ ] wrapper output contains `--bind $PROJECT` (not overlay for project)
- [ ] wrapper output contains `--overlay` for HOME only
- [ ] index.ts exports all 4 hooks: tool.execute.before, permission.ask, tool.execute.after, shell.env
- [ ] `~/.local/bin/oc-build` exits 0
- [ ] Plugin produces zero console output: `grep -rn 'console\.' src/ | grep -v '@deprecated' | grep -v '//'` returns only guarded or removed calls

### Must Have
- Bind-mount project directory read-write (direct writes, no overlay walking)
- Overlay HOME directory for violation capture and review
- Post-execution review via manifest file + ctx.ask() in bash.ts
- shell.env hook setting OC_SANDBOX=1 and OC_SANDBOX_PROJECT
- Hard error when observe mode configured but oc-observe binary missing
- Epilogue compiled as standalone binary
- All existing 172 passing tests continue passing
- All 16 currently-failing tests fixed
- Zero console output from the plugin at runtime — remove or silence all console.log, console.warn, console.error calls across all src/ files (index.ts, deps.ts, sandbox.ts, config.ts)

### Must NOT Have (Guardrails)
- Do NOT modify `policy.ts`, `strace.ts`, `protocol.ts`, `dns.ts`, `store.ts` — stable modules (exception: `config.ts` and `deps.ts` may have console calls removed)
- Do NOT modify passing test files: `overlay.test.ts`, `observe.test.ts`, `proxy.test.ts`, `protocol.test.ts`, `degradation.test.ts`, `integration.test.ts`, `e2e-permission.test.ts`
- Do NOT add new config fields to sandbox.json
- Do NOT modify proxy/MITM functionality (ca-gen, --proxy, TLS interception)
- Do NOT delete sandbox.ts or commit.ts — mark `@deprecated` only
- Do NOT add "smart" features (git-aware filtering, auto-detection, heuristics)
- Do NOT modify strace parsing or protocol detection
- Do NOT add Docker/container support
- Do NOT write E2E tests with real opencode sessions
- Do NOT push to sst/opencode remote
- Do NOT add "push branch" or "create PR" as tasks
- Avoid `any` type, `else` statements, `let` over `const`, unnecessary destructuring

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (bun:test)
- **Automated tests**: TDD (tests updated first, then implementation driven by them)
- **Framework**: bun test

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **CLI/Module**: Use Bash (bun) — Run commands, import modules, compare output
- **Binary**: Use Bash — Compile, run with args, check exit code and output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — module updates, parallel):
├── Task 1: Update wrapper.ts — hybrid bind-mount + overlay [unspecified-high]
├── Task 2: Update epilogue.ts — HOME-only walk + filter + CLI binary [unspecified-high]
└── Task 3: Verify observe.c --log flag + recompile [quick]

Wave 2 (After Wave 1 — core integration):
├── Task 4: Rewrite index.ts — new hook flow [deep]
└── Task 5: Fix and update all test files [unspecified-high]

Wave 3 (After Wave 2 — build + deploy):
├── Task 6: Compile epilogue binary + update Makefile [quick]
└── Task 7: Commit bash.ts patch + rebuild opencode [quick]

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 4 → Task 5 → Task 6 → Task 7 → F1-F4
Parallel Speedup: ~40% (Wave 1 parallelizes 3 independent modules)
Max Concurrent: 3 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 (wrapper.ts) | — | 4, 5 | 1 |
| 2 (epilogue.ts) | — | 4, 5, 6 | 1 |
| 3 (observe.c) | — | 4 | 1 |
| 4 (index.ts) | 1, 2, 3 | 5 | 2 |
| 5 (tests) | 1, 2, 4 | 6, 7 | 2 |
| 6 (build) | 2, 5 | 7 | 3 |
| 7 (opencode) | 5, 6 | F1-F4 | 3 |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks — T1 → `unspecified-high`, T2 → `unspecified-high`, T3 → `quick`
- **Wave 2**: 2 tasks — T4 → `deep`, T5 → `unspecified-high`
- **Wave 3**: 2 tasks — T6 → `quick`, T7 → `quick`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs


- [ ] 1. Update wrapper.ts — hybrid bind-mount + overlay

  **What to do**:
  - Modify `command()` in `src/wrapper.ts` to generate hybrid bwrap commands:
    - `--ro-bind / /` as base (everything read-only)
    - `--overlay-src $HOME --overlay $UPPER/$HOME $WORK/$HOME $HOME` (overlay HOME for violation capture)
    - `--bind $PROJECT $PROJECT` AFTER the overlay (bind-mount punches through overlay for project subtree)
    - `--tmpfs /tmp`, `--tmpfs /dev/shm`, `--tmpfs /run` (ephemeral)
    - `--dev /dev`, `--unshare-pid`, `--proc /proc`, `--die-with-parent`
    - `--unshare-net` when no observe mode
  - Handle edge case: PROJECT === HOME — skip `--bind`, only overlay (bind would defeat the overlay)
  - Handle edge case: PROJECT outside HOME — `--bind` for project, `--overlay` for home, no conflict
  - Remove old `overlayArgs(opts.cwd, ...)` logic for CWD outside home — project bind-mount handles this
  - Keep observe mode chain (oc-observe + strace prefix) unchanged
  - Keep epilogue invocation unchanged
  - Keep exit code preservation unchanged
  - Update `test/wrapper.test.ts` FIRST (TDD):
    - Add test: output contains `--bind $PROJECT $PROJECT` when project inside HOME
    - Add test: output does NOT contain `--overlay-src $PROJECT` (project not overlaid)
    - Add test: `--bind` appears AFTER `--overlay` in command (mount ordering)
    - Add test: when project === HOME, no `--bind` line, only `--overlay` for HOME
    - Add test: when project outside HOME (e.g., /opt/work), both `--bind /opt/work` and `--overlay $HOME` present
    - Existing 26 tests may need assertion updates for changed overlay structure

  **Must NOT do**:
  - Do NOT overlay the project directory
  - Do NOT modify observe mode chain or epilogue invocation
  - Do NOT touch policy.ts or config.ts

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Module rewrite with mount ordering semantics, not trivially simple but well-scoped
  - **Skills**: `[]`
    - No specialized skills needed — pure TypeScript/bwrap command generation
  - **Skills Evaluated but Omitted**:
    - `git-master`: No git operations
    - `playwright`: No browser work

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `src/wrapper.ts:42-121` — Current `command()` function. Lines 73-79 are the HOME overlay + CWD overlay logic to replace. Line 68 is `--ro-bind / /`. Lines 81-97 are tmpfs + network + pid isolation (keep as-is).
  - `src/wrapper.ts:31-37` — `overlayArgs()` helper. Still used for HOME overlay, but no longer for project/cwd.

  **API/Type References**:
  - `src/wrapper.ts:12-23` — `WrapperOptions` interface. No changes needed.
  - `src/wrapper.ts:3-10` — `ObserveOptions` interface. No changes needed.

  **Test References**:
  - `test/wrapper.test.ts:1-233` — All 26 existing wrapper tests. Update assertions where they check for project overlay.

  **External References**:
  - bwrap man page: mounts are processed left-to-right, later mounts on child paths override parent mounts

  **WHY Each Reference Matters**:
  - `wrapper.ts:73-79`: This is the EXACT code that changes — HOME overlay stays, CWD overlay becomes `--bind`
  - `wrapper.ts:31-37`: `overlayArgs()` helper is reused for HOME but no longer for project path
  - `wrapper.ts:12-23`: Interface stays stable — callers (index.ts) won't need changes for wrapper

  **Acceptance Criteria**:

  - [ ] `bun test test/wrapper.test.ts` → all tests pass (26 existing + 5 new)
  - [ ] Output of `command()` contains `--bind $PROJECT $PROJECT`
  - [ ] Output of `command()` does NOT contain `--overlay-src $PROJECT`
  - [ ] Mount ordering: `--overlay` appears before `--bind` in output

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Hybrid wrapper — project inside HOME
    Tool: Bash (bun -e)
    Preconditions: None
    Steps:
      1. Run: bun -e "import {command} from './src/wrapper'; console.log(command({cmd:'echo hi',cwd:'/home/user/proj',upper:'/tmp/u',project:'/home/user/proj',callId:'t',allow:['/home/user/proj'],home:'/home/user',epilogue:'/bin/true',overlay:true}))"
      2. Assert output contains '--bind /home/user/proj /home/user/proj'
      3. Assert output contains '--overlay-src /home/user'
      4. Assert output does NOT contain '--overlay-src /home/user/proj'
      5. Assert '--overlay' appears before '--bind /home/user/proj' in output
    Expected Result: All 5 assertions pass
    Failure Indicators: '--bind' missing, '--overlay-src' includes project path, wrong ordering
    Evidence: .sisyphus/evidence/task-1-hybrid-project-inside-home.txt

  Scenario: Edge case — project equals HOME
    Tool: Bash (bun -e)
    Preconditions: None
    Steps:
      1. Run: bun -e "import {command} from './src/wrapper'; console.log(command({cmd:'echo hi',cwd:'/home/user',upper:'/tmp/u',project:'/home/user',callId:'t',allow:['/home/user'],home:'/home/user',epilogue:'/bin/true',overlay:true}))"
      2. Assert output does NOT contain '--bind /home/user /home/user'
      3. Assert output contains '--overlay-src /home/user'
    Expected Result: No bind-mount when project === home, only overlay
    Failure Indicators: '--bind /home/user' present in output
    Evidence: .sisyphus/evidence/task-1-project-equals-home.txt

  Scenario: Project outside HOME
    Tool: Bash (bun -e)
    Preconditions: None
    Steps:
      1. Run: bun -e "import {command} from './src/wrapper'; console.log(command({cmd:'echo hi',cwd:'/opt/work',upper:'/tmp/u',project:'/opt/work',callId:'t',allow:['/opt/work'],home:'/home/user',epilogue:'/bin/true',overlay:true}))"
      2. Assert output contains '--bind /opt/work /opt/work'
      3. Assert output contains '--overlay-src /home/user'
    Expected Result: Both bind-mount for project AND overlay for HOME
    Failure Indicators: Missing either --bind or --overlay
    Evidence: .sisyphus/evidence/task-1-project-outside-home.txt
  ```

  **Evidence to Capture:**
  - [ ] task-1-hybrid-project-inside-home.txt
  - [ ] task-1-project-equals-home.txt
  - [ ] task-1-project-outside-home.txt

  **Commit**: YES (groups with Task 5)
  - Message: `feat(sandbox): hybrid bind-mount + overlay architecture`
  - Files: `src/wrapper.ts`, `test/wrapper.test.ts`
  - Pre-commit: `bun test test/wrapper.test.ts`

- [ ] 2. Update epilogue.ts — HOME-only overlay walk + intermediate dir filtering + CLI binary

  **What to do**:
  - Modify `run()` in `src/epilogue.ts`:
    - Add `home` as required field in `RunOptions` interface
    - Change walk root from `opts.upper` (entire overlay) to `path.join(opts.upper, opts.home)` (only HOME subtree in overlay)
    - Pass the walk root to `walk()` so relative path calculation is correct: `walk(path.join(opts.upper, opts.home), opts.upper)` — targets are still absolute paths calculated relative to the overlay root
    - Filter out pure intermediate `type: "dir"` ops from committed/discarded counts — a dir op is "pure intermediate" if it's a container directory that was created only to hold files (e.g., creating `/home/user/.config/file` creates dir ops for `/home`, `/home/user`, `/home/user/.config`). Filter: exclude `type: "dir"` ops from the `discarded` list when building fsViolations (line 138-145). Keep dir ops in committed list for mkdir on host.
  - Create `bin/epilogue.ts` CLI entry point:
    - Parse argv: `--upper`, `--project`, `--call-id`, `--allow` (colon-separated), `--home`, `--observe-log` (optional)
    - Call `run()` with parsed options
    - Exit 0 always (epilogue failures should not affect command exit code)
    - Wrap everything in try/catch, stderr any errors
  - Update `test/epilogue.test.ts` FIRST (TDD):
    - Fix all 8 failing tests by adjusting committed/discarded count assertions to not count intermediate dir ops
    - Add `home` field to all `run()` calls (e.g., `home: os.homedir()`)
    - Adjust the walk to only process files within the HOME subtree of the overlay
    - Add test: epilogue with project-only writes in overlay returns empty (nothing to walk in HOME)
  - NOTE: The existing epilogue.test.ts creates overlay files at absolute paths like `/tmp/oc-epilogue-test-project/...` and `/etc/...` and `/opt/...`. These paths are placed in the overlay upper at `upper + target`. For the HOME-only walk, the test setup needs to create overlay files under `upper + HOME + relative_path` for files that should be found, and verify that files outside HOME in the overlay are ignored.

  **Must NOT do**:
  - Do NOT modify `writable()` or `evaluate()` in policy.ts
  - Do NOT change whiteout detection logic
  - Do NOT change observe log parsing
  - Do NOT make epilogue binary exit with non-zero codes on errors

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Module update + new CLI entry point, multiple test fixes required
  - **Skills**: `[]`
    - No specialized skills needed
  - **Skills Evaluated but Omitted**:
    - `git-master`: No git operations

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Tasks 4, 5, 6
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `src/epilogue.ts:28-56` — `walk()` function. Currently walks from `dir` recursively. The `root` parameter determines how relative paths are calculated. Change: pass `path.join(upper, home)` as `dir` but keep `upper` as `root` so target paths remain absolute.
  - `src/epilogue.ts:115-161` — `run()` function. Line 117 is the walk call to modify. Lines 138-145 are the discarded→fsViolations filter where dir ops should be excluded.
  - `src/epilogue.ts:100-112` — `commit()` function. No changes needed.

  **API/Type References**:
  - `src/epilogue.ts:18-24` — `RunOptions` interface. Add `home: string` field.
  - `src/epilogue.ts:11-16` — `Manifest` interface. No changes needed.
  - `src/epilogue.ts:6-9` — `Op` type. No changes needed.

  **Test References**:
  - `test/epilogue.test.ts:1-431` — All 19 tests. The 8 failing tests all have count assertions (`committed.length`, `discarded.length`) that don't account for intermediate directory ops.
  - `test/epilogue.test.ts:23-27` — `overlayFile()` helper creates files at `upper + target`. For HOME-scoped walk, test files need to be at `upper + HOME + relative_path`.

  **External References**:
  - overlayfs documentation: upper directory structure mirrors the lower directory hierarchy

  **WHY Each Reference Matters**:
  - `epilogue.ts:28-56`: walk() is the core function being scoped — understanding dir/root params is essential
  - `epilogue.ts:117`: This single line is the primary change point — scoping the walk to HOME
  - `epilogue.ts:138-145`: This filter needs updating to exclude dir ops from violation counts
  - `test/epilogue.test.ts:23-27`: Test setup helper needs to create files in the right overlay subdirectory

  **Acceptance Criteria**:

  - [ ] `bun test test/epilogue.test.ts` → all tests pass (19 previously failing now pass)
  - [ ] `RunOptions` has `home: string` field
  - [ ] `bin/epilogue.ts` exists and parses --upper, --project, --call-id, --allow, --home, --observe-log
  - [ ] Intermediate dir ops filtered from fsViolations count

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Epilogue walks only HOME subtree
    Tool: Bash (bun test)
    Preconditions: test/epilogue.test.ts updated with home field
    Steps:
      1. Run: bun test test/epilogue.test.ts
      2. Assert: all 19+ tests pass, 0 failures
      3. Verify: committed/discarded counts match expected (no intermediate dir inflation)
    Expected Result: 0 failures, all assertions pass
    Failure Indicators: count mismatch errors, "expected 1 received 3" type failures
    Evidence: .sisyphus/evidence/task-2-epilogue-tests.txt

  Scenario: CLI entry point parses arguments
    Tool: Bash (bun run)
    Preconditions: bin/epilogue.ts exists
    Steps:
      1. Create temp dirs: upper=/tmp/epi-qa-upper, project=/tmp/epi-qa-proj
      2. Run: bun run bin/epilogue.ts --upper /tmp/epi-qa-upper --project /tmp/epi-qa-proj --call-id qa_test --allow /tmp/epi-qa-proj --home /home/staly
      3. Assert exit code 0
      4. Assert no manifest written (empty overlay)
    Expected Result: Exits 0, no errors on stderr
    Failure Indicators: Non-zero exit code, parse errors, unhandled exceptions
    Evidence: .sisyphus/evidence/task-2-epilogue-cli.txt

  Scenario: Intermediate dirs not counted as violations
    Tool: Bash (bun test)
    Preconditions: Updated epilogue.test.ts
    Steps:
      1. Run the "mixed: commits allowed, discards violations" test
      2. Assert: committed.length === 1 (file only, not intermediate dirs)
      3. Assert: discarded.length === 1 (file only, not intermediate dirs)
    Expected Result: Exact counts without dir inflation
    Failure Indicators: Counts higher than expected
    Evidence: .sisyphus/evidence/task-2-no-dir-inflation.txt
  ```

  **Evidence to Capture:**
  - [ ] task-2-epilogue-tests.txt
  - [ ] task-2-epilogue-cli.txt
  - [ ] task-2-no-dir-inflation.txt

  **Commit**: YES (groups with Task 5)
  - Message: `feat(sandbox): hybrid bind-mount + overlay architecture`
  - Files: `src/epilogue.ts`, `bin/epilogue.ts`, `test/epilogue.test.ts`
  - Pre-commit: `bun test test/epilogue.test.ts`

- [ ] 3. Verify observe.c --log flag and recompile binary

  **What to do**:
  - Check background task output from `ses_34f311846ffepPn72B0JMJJgLp` (task `bg_f79a5fda`) which added `--log` flag to observe.c
  - Verify the `--log` flag implementation in `src/observe.c`: when `--log <path>` is passed, oc-observe should write JSON events to that file instead of stdout, keeping stdout clean for the supervised process
  - Recompile: `cc -o bin/oc-observe src/observe.c src/tls.c -lpthread` (or `make build` which runs postinstall.ts)
  - Test: `bin/oc-observe --log /tmp/test.log bwrap --ro-bind / / --unshare-net true` should exit 0 and write to /tmp/test.log
  - If --log implementation is broken or incomplete, fix it

  **Must NOT do**:
  - Do NOT modify TLS proxy functionality
  - Do NOT change the JSON output format of oc-observe events
  - Do NOT modify protocol detection logic

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Verification + recompile, small scope
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Task 4
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/observe.c` — Full source (~861 lines). The --log flag was added by a background agent. Look for `--log` argument parsing and file descriptor redirection.
  - `script/postinstall.ts` — Build script that compiles observe.c + tls.c into bin/oc-observe.

  **WHY Each Reference Matters**:
  - `observe.c`: Need to verify the --log flag was implemented correctly — JSON events go to log file, stdout stays clean
  - `postinstall.ts`: Build command may need updating if new source files or flags were added

  **Acceptance Criteria**:

  - [ ] `bin/oc-observe` binary exists and is freshly compiled
  - [ ] `bin/oc-observe --log /tmp/test.log` accepted as valid argument (no error)
  - [ ] When --log is used, JSON output goes to the log file, not stdout

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: oc-observe --log flag works
    Tool: Bash
    Preconditions: bin/oc-observe compiled
    Steps:
      1. Run: bin/oc-observe --log /tmp/oc-observe-qa.log bwrap --ro-bind / / --unshare-net -- true
      2. Check exit code (should be 0 or match inner process)
      3. Check /tmp/oc-observe-qa.log exists (may be empty if no network events)
    Expected Result: Binary runs without error, log file created
    Failure Indicators: "unknown option --log", segfault, binary missing
    Evidence: .sisyphus/evidence/task-3-observe-log.txt
  ```

  **Evidence to Capture:**
  - [ ] task-3-observe-log.txt

  **Commit**: YES (groups with Task 5)
  - Message: `feat(sandbox): hybrid bind-mount + overlay architecture`
  - Files: `src/observe.c`, `bin/oc-observe`
  - Pre-commit: Binary compiles cleanly

- [ ] 4. Rewrite index.ts — new hook flow for transparent wrapper architecture

  **What to do**:
  - Full rewrite of `src/index.ts` to use the transparent wrapper architecture.
  - Register FOUR hooks:

  **(a) `tool.execute.before`**:
  - Only for `info.tool === "bash"`
  - Create overlay directories: `upper = /tmp/oc-sandbox-${callID}`, `work = upper + "-work"`
  - Call `wrapper.command()` to generate the hybrid bwrap wrapper string
  - Mutate `output.args.command` to the wrapper string (this is the key transparent mechanism)
  - If overlay/bwrap not available, skip (no-op, command runs normally)
  - Pass epilogue binary path: `path.join(import.meta.dir, '..', 'bin', 'oc-epilogue')`
  - Pass observe options when `cfg.network.mode === "observe"`
  - **CRITICAL**: When observe mode configured but oc-observe binary missing, throw error (not fallback)

  **(b) `permission.ask`**:
  - For `info.type === "bash"`: set `output.status = "allow"` (auto-approve — the wrapper handles sandboxing)
  - For `info.type === "edit"`: keep existing edit() logic (path-based policy check)
  - For `info.type === "sandbox_review"`: handle post-execution review
    - Read manifest from `info.metadata` (contains committed, discarded, violations, upper)
    - If user approves (output.status remains default), commit the discarded ops from the overlay to real filesystem using epilogue's commit function
    - Clean up overlay dirs
  - For other types: no-op (pass through)

  **(c) `tool.execute.after`**:
  - For bash tool: append sandbox metadata to output (optional, for debugging)
  - Clean up stale overlay dirs if any

  **(d) `shell.env`**:
  - Set `output.env.OC_SANDBOX = "1"`
  - Set `output.env.OC_SANDBOX_PROJECT = project`
  - Set `output.env.OC_SANDBOX_WRITABLE = cfg.filesystem.allow_write.join(":")`

  - Mark `src/sandbox.ts` and `src/commit.ts` with `@deprecated` comment at top of file
  - Remove imports of sandbox and commit modules from index.ts
  - Import wrapper module instead
  - **Silence ALL console output across ALL src/ files**:
    - `src/index.ts` (being rewritten): do NOT include any console.log/warn/error calls. No verbose logging.
    - `src/deps.ts`: remove the two `console.warn()` calls on lines 89 and 93 (bwrap/strace missing warnings). Instead, just return `available: false` silently.
    - `src/sandbox.ts`: the @deprecated file still has `console.warn()` on line 90. Remove it or guard it behind @deprecated.
    - `src/config.ts`: remove `console.warn()` calls on lines 39 and 54 (JSON parse and validation errors). Instead, silently use defaults.
    - The plugin must produce ZERO console output at runtime — no warnings, no errors, no logs.

  **Must NOT do**:
  - Do NOT delete sandbox.ts or commit.ts
  - Do NOT modify policy.ts or store.ts (except console removal in deps.ts and config.ts is allowed)
  - Do NOT run the command inside the plugin (the wrapper runs inside bash.ts)
  - Do NOT capture or replay stdout/stderr (transparent architecture — bash tool handles I/O)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Full module rewrite with complex hook interaction logic, mount ordering, and error handling
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after Wave 1)
  - **Blocks**: Task 5
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References**:
  - `src/index.ts:138-162` — Current plugin function and hook registration. This is the code being replaced. Study the structure: `plugin()` returns `Hooks` object.
  - `src/index.ts:14-98` — Current `bash()` handler. Being completely replaced. Study how it uses stash, sandbox, policy, commit.
  - `src/index.ts:100-136` — Current `edit()` handler. Keep this logic UNCHANGED for edit/write tool types.
  - `src/wrapper.ts:42-121` — `command()` function. This is what index.ts will call in tool.execute.before to generate the bwrap wrapper.

  **API/Type References**:
  - `src/wrapper.ts:12-23` — `WrapperOptions` interface. Index.ts must construct this object.
  - `src/epilogue.ts:18-24` — `RunOptions` interface (after Task 2 adds `home`). Used for sandbox_review commit.
  - `src/epilogue.ts:100-112` — `commit()` function. Called during sandbox_review approval.
  - `src/deps.ts:83-105` — `check()` returns `Deps`. Index.ts uses this to determine capabilities.
  - `src/config.ts` — `load()` and `SandboxConfig` type.
  - `src/policy.ts:writable()` — Used by edit handler.

  **Test References**:
  - `test/transparent-wrapper.test.ts:1-521` — All 17 hook integration tests. These define the expected behavior.
  - `test/transparent-wrapper.test.ts:69-102` — `invokeHooks()` helper showing the exact hook call sequence.
  - `test/transparent-wrapper.test.ts:114-137` — Hook registration test: expects all 4 hooks.

  **External References**:
  - `packages/opencode/src/session/prompt.ts:790-822` (in opencode repo) — Shows how tool.execute.before/after fire and how args mutation works. `{args}` is passed by reference.
  - `packages/opencode/src/tool/bash.ts:263-283` (in opencode repo) — Post-exit sandbox review: reads manifest, calls ctx.ask({permission: "sandbox_review", ...})

  **WHY Each Reference Matters**:
  - `index.ts:138-162`: Plugin structure to follow — same export shape, same input types
  - `wrapper.ts:42-121`: index.ts calls this — must know the interface
  - `transparent-wrapper.test.ts:69-102`: This is the TEST that drives the implementation — the hook call sequence IS the spec
  - `prompt.ts:790-822`: Confirms args mutation mechanism — mutating output.args.command in tool.execute.before changes what bash.ts executes
  - `bash.ts:263-283`: Confirms manifest path format: `/tmp/oc-sandbox-review-${ctx.callID}` — index.ts must match this

  **Acceptance Criteria**:

  - [ ] Plugin returns all 4 hooks: tool.execute.before, permission.ask, tool.execute.after, shell.env
  - [ ] tool.execute.before mutates args.command to bwrap wrapper for bash tools
  - [ ] permission.ask auto-approves bash type (status = "allow")
  - [ ] permission.ask handles sandbox_review type (commit discarded ops)
  - [ ] shell.env sets OC_SANDBOX, OC_SANDBOX_PROJECT
  - [ ] Observe mode: error thrown when oc-observe binary missing
  - [ ] sandbox.ts has @deprecated comment
  - [ ] commit.ts has @deprecated comment
  - [ ] Zero console.log/warn/error in src/index.ts, src/deps.ts, src/config.ts, src/sandbox.ts (removed or silenced)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Hook registration returns all 4 hooks
    Tool: Bash (bun test)
    Preconditions: index.ts rewritten
    Steps:
      1. Run: bun test test/transparent-wrapper.test.ts -t 'plugin returns required hooks'
      2. Assert: test passes
    Expected Result: hooks["tool.execute.before"], hooks["permission.ask"], hooks["tool.execute.after"], hooks["shell.env"] all defined
    Failure Indicators: "is not a function" errors, undefined hooks
    Evidence: .sisyphus/evidence/task-4-hook-registration.txt

  Scenario: Args mutation replaces command with bwrap wrapper
    Tool: Bash (bun test)
    Preconditions: index.ts rewritten, wrapper.ts updated (Task 1)
    Steps:
      1. Run: bun test test/transparent-wrapper.test.ts -t 'args.command is replaced'
      2. Assert: args.command contains 'bwrap' and '--bind' and original command
    Expected Result: Command replaced with wrapper, original command embedded inside
    Failure Indicators: args.command unchanged, missing bwrap
    Evidence: .sisyphus/evidence/task-4-args-mutation.txt

  Scenario: Observe mode error when binary missing
    Tool: Bash (bun -e)
    Preconditions: index.ts rewritten
    Steps:
      1. Create temp project dir with sandbox.json having network.mode: "observe"
      2. Temporarily rename bin/oc-observe to bin/oc-observe.bak
      3. Call plugin(), then try invokeHooks()
      4. Assert: error thrown or status not "allow"
      5. Restore bin/oc-observe
    Expected Result: Hard error when observe binary missing, not silent fallback
    Failure Indicators: Silent fallback to block mode, no error
    Evidence: .sisyphus/evidence/task-4-observe-error.txt
  ```

  **Evidence to Capture:**
  - [ ] task-4-hook-registration.txt
  - [ ] task-4-args-mutation.txt
  - [ ] task-4-observe-error.txt

  **Commit**: YES (groups with Task 5)
  - Message: `feat(sandbox): hybrid bind-mount + overlay architecture`
  - Files: `src/index.ts`, `src/sandbox.ts` (@deprecated), `src/commit.ts` (@deprecated)
  - Pre-commit: `bun test test/transparent-wrapper.test.ts`


- [ ] 5. Fix and update all test files — full suite green

  **What to do**:
  - Run `bun test` and verify ALL tests pass (target: 0 failures)
  - The 172 previously-passing tests MUST still pass — any regressions are bugs to fix
  - The 16 previously-failing tests should now pass with Tasks 1-4 complete:
    - 8 epilogue tests — fixed by Task 2 (HOME-only walk + dir filtering)
    - 8 transparent-wrapper tests — fixed by Task 4 (new index.ts hooks)
  - If any tests still fail, debug and fix:
    - Check if transparent-wrapper.test.ts expectations match the new index.ts hook behavior
    - Check if epilogue.test.ts assertions match the updated walk/filter logic
    - Check if wrapper.test.ts assertions match the hybrid command generation
  - Do NOT modify stable test files: overlay.test.ts, observe.test.ts, proxy.test.ts, protocol.test.ts, degradation.test.ts, integration.test.ts, e2e-permission.test.ts
  - If execute-once.test.ts fails (old capture+replay tests), that's expected since index.ts no longer uses that architecture. Either skip or remove that test file.

  **Must NOT do**:
  - Do NOT modify stable test files (overlay, observe, proxy, protocol, degradation, integration, e2e-permission)
  - Do NOT weaken test assertions to make them pass (fix the implementation instead)
  - Do NOT delete tests without explanation

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Debugging test failures across multiple files, understanding interconnections
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (after Task 4)
  - **Blocks**: Tasks 6, 7
  - **Blocked By**: Tasks 1, 2, 4

  **References**:

  **Pattern References**:
  - `test/wrapper.test.ts` — 26+ tests for wrapper.ts
  - `test/epilogue.test.ts` — 19+ tests for epilogue.ts
  - `test/transparent-wrapper.test.ts` — 17 tests for index.ts hook integration
  - `test/execute-once.test.ts` — 15 old tests (may need removal or skip)

  **WHY Each Reference Matters**:
  - These are the test files being fixed — agent needs to understand each test's intent to fix correctly

  **Acceptance Criteria**:

  - [ ] `bun test` → 0 failures
  - [ ] All 172+ previously-passing tests still pass
  - [ ] All 16 previously-failing tests now pass
  - [ ] No stable test files modified

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Full test suite passes
    Tool: Bash
    Preconditions: Tasks 1-4 complete
    Steps:
      1. Run: bun test 2>&1 | tee /tmp/test-output.txt
      2. Assert: exit code 0
      3. Assert: output contains '0 fail'
      4. Count pass: grep 'pass' output, verify >= 188
    Expected Result: 0 failures, 188+ passes
    Failure Indicators: Any 'fail' in output, non-zero exit code
    Evidence: .sisyphus/evidence/task-5-full-suite.txt

  Scenario: Stable tests unchanged and passing
    Tool: Bash
    Preconditions: Tasks 1-4 complete
    Steps:
      1. Run: bun test test/overlay.test.ts test/observe.test.ts test/proxy.test.ts test/protocol.test.ts test/degradation.test.ts test/integration.test.ts
      2. Assert: all pass, 0 failures
    Expected Result: All stable tests pass without modification
    Failure Indicators: Any failure in stable test files
    Evidence: .sisyphus/evidence/task-5-stable-tests.txt
  ```

  **Evidence to Capture:**
  - [ ] task-5-full-suite.txt
  - [ ] task-5-stable-tests.txt

  **Commit**: YES
  - Message: `feat(sandbox): hybrid bind-mount + overlay architecture`
  - Files: All modified src/ and test/ files
  - Pre-commit: `bun test`
  - Post-commit: `~/.local/bin/strip-llm-coauthor`

- [ ] 6. Compile epilogue binary + update Makefile

  **What to do**:
  - Compile epilogue: `bun build bin/epilogue.ts --compile --outfile bin/oc-epilogue`
  - Update Makefile `build` target to also compile the epilogue binary
  - Update Makefile `clean` target to remove bin/oc-epilogue
  - Verify: `bin/oc-epilogue --upper /tmp/nonexistent --project /tmp --call-id test --allow /tmp --home /home/staly` exits 0 (empty walk, no crash)
  - Verify binary size is reasonable (under 100MB — Bun compiled binaries include runtime)

  **Must NOT do**:
  - Do NOT modify the epilogue source logic (that's Task 2)
  - Do NOT change the postinstall.ts C compilation logic

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple build step + Makefile update
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 7)
  - **Blocks**: None
  - **Blocked By**: Tasks 2, 5

  **References**:

  **Pattern References**:
  - `Makefile:1-29` — Current build targets. Add epilogue compilation to `build:` and cleanup to `clean:`.
  - `bin/epilogue.ts` — CLI entry point created in Task 2.

  **WHY Each Reference Matters**:
  - `Makefile`: Exact lines to modify for build integration
  - `bin/epilogue.ts`: Source file being compiled

  **Acceptance Criteria**:

  - [ ] `bin/oc-epilogue` file exists and is executable
  - [ ] `bin/oc-epilogue --upper /tmp/x --project /tmp --call-id t --allow /tmp --home /home/staly` exits 0
  - [ ] `make build` includes epilogue compilation
  - [ ] `make clean` removes bin/oc-epilogue

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Epilogue binary compiles and runs
    Tool: Bash
    Preconditions: bin/epilogue.ts exists (Task 2)
    Steps:
      1. Run: bun build bin/epilogue.ts --compile --outfile bin/oc-epilogue
      2. Assert: exit code 0, bin/oc-epilogue exists
      3. Run: bin/oc-epilogue --upper /tmp/oc-epi-qa --project /tmp --call-id qa --allow /tmp --home /home/staly
      4. Assert: exit code 0
      5. Run: ls -la bin/oc-epilogue | awk '{print $5}'
      6. Assert: size < 100000000 (100MB)
    Expected Result: Binary compiles, runs, reasonable size
    Failure Indicators: Compilation error, non-zero exit, oversized binary
    Evidence: .sisyphus/evidence/task-6-epilogue-binary.txt

  Scenario: Makefile targets work
    Tool: Bash
    Preconditions: Makefile updated
    Steps:
      1. Run: make clean
      2. Assert: bin/oc-epilogue removed
      3. Run: make build
      4. Assert: bin/oc-epilogue exists again
    Expected Result: Clean removes binary, build recreates it
    Failure Indicators: File not removed, compilation error during make build
    Evidence: .sisyphus/evidence/task-6-makefile.txt
  ```

  **Evidence to Capture:**
  - [ ] task-6-epilogue-binary.txt
  - [ ] task-6-makefile.txt

  **Commit**: YES
  - Message: `build: add epilogue binary compilation`
  - Files: `bin/oc-epilogue`, `Makefile`
  - Pre-commit: `make build`
  - Post-commit: `~/.local/bin/strip-llm-coauthor`

- [ ] 7. Commit bash.ts patch into opencode patched branch + rebuild

  **What to do**:
  - In `/home/staly/opencode/` on `patched` branch:
    - Verify the bash.ts review patch is in the working tree (uncommitted changes to `packages/opencode/src/tool/bash.ts`)
    - Amend the existing patched commit (`86c74185d`) to include the bash.ts changes: `git add packages/opencode/src/tool/bash.ts && git commit --amend --no-edit`
    - This keeps both patches (permission.ask + bash.ts review) as a single commit, which is required because `oc-build` rebases `HEAD~1`
  - Rebuild opencode: `~/.local/bin/oc-build`
  - Verify the deployed binary includes both patches
  - Do NOT push to sst/opencode remote

  **Must NOT do**:
  - Do NOT push to remote
  - Do NOT create a separate commit (must be single commit for oc-build)
  - Do NOT modify the permission.ask patch
  - Do NOT change the bash.ts review logic

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple git amend + rebuild, no code changes
  - **Skills**: `["git-master"]`
    - `git-master`: Git amend operation requires care

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 6)
  - **Blocks**: None (final task)
  - **Blocked By**: Task 5

  **References**:

  **Pattern References**:
  - `/home/staly/opencode/packages/opencode/src/tool/bash.ts:263-283` — The uncommitted review patch. Lines 263-283 add post-exit sandbox review (check manifest, ctx.ask with try/catch, cleanup in finally).
  - `/home/staly/opencode/packages/opencode/src/permission/next.ts` — The existing committed patch for permission.ask trigger.
  - `/home/staly/.local/bin/oc-build` — Build script. Line 16: `git rebase --onto "$latest" HEAD~1 patched` — rebases exactly 1 commit.

  **WHY Each Reference Matters**:
  - `bash.ts:263-283`: This is the patch being committed — agent must verify it's unchanged
  - `oc-build:16`: Explains why both patches must be in one commit — rebase moves HEAD~1

  **Acceptance Criteria**:

  - [ ] `cd /home/staly/opencode && git log --oneline -1` shows single patched commit
  - [ ] `cd /home/staly/opencode && git diff HEAD` shows no uncommitted changes
  - [ ] `cd /home/staly/opencode && git diff HEAD~1..HEAD --stat` shows both next.ts AND bash.ts
  - [ ] `~/.local/bin/oc-build` exits 0
  - [ ] Deployed binary exists at expected path

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Single patched commit with both patches
    Tool: Bash
    Preconditions: On patched branch in /home/staly/opencode
    Steps:
      1. Run: cd /home/staly/opencode && git log --oneline -2
      2. Assert: first commit is the patched commit, second is v1.2.15 release
      3. Run: git diff HEAD~1..HEAD --stat
      4. Assert: output includes both next.ts and bash.ts
      5. Run: git diff HEAD
      6. Assert: no output (working tree clean)
    Expected Result: Single commit with both patches, clean working tree
    Failure Indicators: Multiple patch commits, uncommitted changes remaining
    Evidence: .sisyphus/evidence/task-7-patched-commit.txt

  Scenario: Opencode rebuild succeeds
    Tool: Bash
    Preconditions: Patched commit is complete
    Steps:
      1. Run: ~/.local/bin/oc-build
      2. Assert: exit code 0
      3. Assert: output contains 'deployed:'
      4. Run: ls -la ~/.bun/install/global/node_modules/opencode-ai/bin/.opencode
      5. Assert: file exists and is recent
    Expected Result: Build succeeds, binary deployed
    Failure Indicators: Build error, missing binary
    Evidence: .sisyphus/evidence/task-7-oc-build.txt
  ```

  **Evidence to Capture:**
  - [ ] task-7-patched-commit.txt
  - [ ] task-7-oc-build.txt

  **Commit**: Amend (in opencode repo, not sandbox repo)
  - Message: (amend existing, no message change)
  - Files: `packages/opencode/src/tool/bash.ts`
  - Pre-commit: `~/.local/bin/oc-build`

---
## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp). Verify code style: single word variable names, no `else`, `const` over `let`, no destructuring, Bun APIs.
  Output: `Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (wrapper + epilogue + index.ts working together). Test edge cases: project inside HOME, project === HOME, empty overlay. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes. Verify stable modules untouched: policy.ts, strace.ts, protocol.ts, dns.ts, config.ts, store.ts.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| After Task | Message | Files |
|-----------|---------|-------|
| 5 (all tests pass) | `feat(sandbox): hybrid bind-mount + overlay architecture` | src/wrapper.ts, src/epilogue.ts, src/index.ts, src/sandbox.ts, src/commit.ts, bin/epilogue.ts, test/wrapper.test.ts, test/epilogue.test.ts, test/transparent-wrapper.test.ts |
| 6 (binary built) | `build: add epilogue binary compilation` | bin/oc-epilogue, Makefile |
| 7 (opencode rebuild) | Amend existing patched commit in opencode repo | packages/opencode/src/tool/bash.ts |

Pre-commit for all: `bun test` must pass.
Run `~/.local/bin/strip-llm-coauthor` on all commits before pushing.

---

## Success Criteria

### Verification Commands
```bash
bun test                    # Expected: 0 failures
bun test test/wrapper.test.ts    # Expected: all pass
bun test test/epilogue.test.ts   # Expected: all pass  
bun test test/transparent-wrapper.test.ts  # Expected: all pass
ls -la bin/oc-epilogue      # Expected: executable file exists
bin/oc-epilogue --upper /tmp/nonexistent --project /tmp --call-id test --allow /tmp --home /home/staly  # Expected: exits cleanly (empty walk)
~/.local/bin/oc-build       # Expected: exits 0
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass (0 failures)
- [ ] Epilogue binary compiles and runs
- [ ] Opencode rebuilt with both patches
- [ ] No modifications to stable modules
