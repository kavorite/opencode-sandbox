# Docker-Based Sandbox Rewrite

## TL;DR

> **Quick Summary**: Replace bwrap+strace+seccomp with Docker containers managed via dockerode. Warm container per session, mitmproxy sidecar for network observation, `container.changes()` for filesystem diff. All C code deleted, everything in TypeScript. Run once → inspect → commit or rollback.
> 
> **Deliverables**:
> - `src/docker.ts` — dockerode client wrapper (connect, exec, changes, commit)
> - `src/container.ts` — warm container lifecycle (create, exec, commit/recreate, cleanup)
> - `src/proxy.ts` — mitmproxy sidecar management (start, stop, log parsing)
> - `src/diff.ts` — `container.changes()` → SandboxResult field mapping
> - `src/image.ts` — Dockerfile management, image build/pull
> - `src/index.ts` — complete rewrite using Docker modules
> - `src/config.ts` — schema overhaul (remove bwrap options, add Docker options)
> - `src/deps.ts` — check Docker daemon instead of bwrap/strace
> - `Dockerfile` — Alpine sandbox image
> - `mitmproxy/addon.py` — HTTP method filtering + JSON flow logging
> - Full test suite rewritten for Docker (testcontainers)
> - All C code and bwrap-related files deleted
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 5 waves
> **Critical Path**: Task 1 → Task 3 → Task 7 → Task 8 → Task 11 → Task 13 → Task 14 → F1-F4

---

## Context

### Original Request
User requested a complete rewrite of the opencode-sandbox plugin to replace bwrap+strace+seccomp with Docker-based sandboxing. The bwrap approach is fundamentally fragile — depends on Linux-specific kernel features (user namespaces, ptrace, seccomp USER_NOTIF, overlayfs nesting) that fail across platforms and in nested environments. Docker solves all of this by design.

### Interview Summary
**Key Discussions**:
- Run-once semantics: no timeout+rerun. Command runs to completion in container, inspect results, commit or rollback. "copy-on-write semantics mean we don't have to consider how long a program runs"
- Docker required: error and block if unavailable (no fallback to default permission flow)
- All C code deleted: observe.c, tls.c, ca_gen.c — everything TypeScript
- Nesting: OC_SANDBOX=1 detected → skip container creation, commands already sandboxed
- Interoperate with Docker Sandboxes where useful (credential injection pattern) but go beyond it

**Architecture Decisions**:
- **SDK**: dockerode v4.x — programmatic API, `container.changes()`, TypeScript types
- **Lifecycle**: Warm container — create at plugin init, `docker exec` each command, lives for session
- **Network**: mitmproxy sidecar — battle-tested TLS MITM, explicit `HTTP_PROXY`/`HTTPS_PROXY` env vars (NOT transparent iptables)
- **Base image**: Alpine minimal (~5MB) with git, ssh, curl, bash
- **Project mount**: Bind-mount project dir RW (direct writes to disk). `container.changes()` catches only out-of-project writes.
- **State**: `docker commit` after approved commands saves clean state. On rejection, recreate container from last committed image.
- **Tests**: testcontainers pattern for integration tests, mocked dockerode for unit tests

**Research Findings**:
- `container.changes()`: returns overlay diff. Bind-mounted paths are NOT tracked (by design — project writes invisible, which is what we want)
- `docker exec` stream `end` event may not fire (known dockerode issue) — must use dual strategy: listen for stream end AND poll `exec.inspect()` until `Running === false`
- `docker commit` does NOT capture volumes/bind-mounts — project-dir changes already on host, rollback only affects container overlay (out-of-project writes)
- `Tty: false` REQUIRED for demuxed stdout/stderr — `Tty: true` merges streams
- CapDrop ALL breaks native addon installs — use selective drop, keep CHOWN, DAC_OVERRIDE, SETGID, SETUID, FOWNER
- Explicit proxy (HTTP_PROXY env vars) preferred over transparent iptables (transparent requires NET_ADMIN, conflicts with security hardening)
- Programs ignoring HTTP_PROXY (hardcoded connections) bypass mitmproxy — known limitation, acceptable tradeoff for cross-platform
- macOS bind-mount ~3x slower with VirtioFS — acceptable for source code, not ideal for node_modules

### Metis Review
**Identified Gaps** (addressed):
- `docker exec` stream reliability: Added dual-strategy requirement (stream end + exec.inspect polling)
- CapDrop ALL too aggressive: Changed to selective cap drop preserving build-essential capabilities
- Transparent proxy requires NET_ADMIN: Changed to explicit proxy mode via env vars
- Docker resource cleanup on crash: Added label-based cleanup + process exit handlers
- Project-dir writes irrevocable: Accepted as design property — project writes are expected, out-of-project writes are what we sandbox
- `docker commit` image accumulation: Added label-based cleanup for committed images

---

## Work Objectives

### Core Objective
Replace the bwrap+strace+seccomp sandbox with Docker containers, eliminating all Linux kernel dependencies and enabling cross-platform sandboxing on any system with Docker.

### Concrete Deliverables
- 7 new TypeScript modules (docker.ts, container.ts, proxy.ts, diff.ts, image.ts, rewritten index.ts, rewritten config.ts, rewritten deps.ts)
- 1 Dockerfile (Alpine sandbox image)
- 1 Python mitmproxy addon (method filtering + flow logging)
- Full test suite (unit + integration)
- All C code and bwrap-dependent files deleted

### Definition of Done
- [ ] `bun test` → 0 failures
- [ ] Plugin starts with Docker daemon running → warm container created
- [ ] Plugin errors with Docker daemon not running → clear error message
- [ ] Command runs in container, stdout/stderr captured correctly
- [ ] Out-of-project writes detected via `container.changes()`
- [ ] mitmproxy captures HTTP/HTTPS traffic, populates SandboxResult
- [ ] Nesting detected (OC_SANDBOX=1) → plugin passes through, no new container
- [ ] No C code, no bwrap references, no strace references in src/

### Must Have
- dockerode v4.x for Docker API interaction
- Warm container created at plugin init, reused for all commands
- `docker exec` with Tty=false, demuxed stdout/stderr, dual-strategy stream handling
- `container.changes()` for filesystem diff → SandboxResult.mutations
- mitmproxy sidecar container for HTTP/HTTPS observation
- Explicit proxy mode via HTTP_PROXY/HTTPS_PROXY env vars
- `docker commit` after approved commands, recreate from image on rejection
- Selective CapDrop (keep CHOWN, DAC_OVERRIDE, SETGID, SETUID, FOWNER)
- Label ALL Docker resources with `opencode-sandbox.session=<id>` for cleanup
- Process exit handlers (SIGTERM, SIGINT, uncaughtException) for cleanup
- OC_SANDBOX=1 detection for nesting → skip container creation
- SandboxResult type preserved exactly (same fields, same shape)
- Plugin hooks preserved: tool.execute.before, permission.ask, tool.execute.after, shell.env
- All C files deleted (observe.c, tls.c, tls.h, ca_gen.c)
- All bwrap-dependent files deleted (wrapper.ts, epilogue.ts, strace.ts, decode.ts, sandbox.ts, commit.ts)
- Zero console output from plugin at runtime

### Must NOT Have (Guardrails)
- Do NOT use transparent iptables proxy (requires NET_ADMIN, breaks security hardening)
- Do NOT use Tty=true for exec (breaks stdout/stderr demux)
- Do NOT use CapDrop ALL (breaks native addon installs)
- Do NOT fall through to default permission flow if Docker unavailable (error and block)
- Do NOT create new containers for nested/sub-agent execution
- Do NOT modify store.ts SandboxResult type shape
- Do NOT use docker CLI shelling out (use dockerode API)
- Do NOT add Docker-in-Docker support (nested agents reuse existing container)
- Do NOT assume DNS is fully observable (explicit proxy only catches HTTP/HTTPS, not raw DNS)
- Do NOT include bwrap, strace, or seccomp in any new code
- Avoid `any` type, `else` statements, `let` over `const`

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (bun:test)
- **Automated tests**: YES (tests alongside implementation)
- **Framework**: bun test + testcontainers
- **Unit tests**: Mock dockerode for fast isolated testing of each module
- **Integration tests**: testcontainers manages real Docker lifecycle

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Docker modules**: Use Bash (bun -e / bun test) — import module, call functions, verify behavior
- **Container lifecycle**: Use Bash (docker commands) — verify containers created, exec works, changes detected
- **Network proxy**: Use Bash (curl through proxy) — verify HTTP interception, method filtering
- **Integration**: Use testcontainers + bun test — full pipeline tests

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation, all parallel):
├── Task 1: Package setup — add deps, remove postinstall [quick]
├── Task 2: Dockerfile + image module (src/image.ts) [unspecified-high]
├── Task 3: Docker client module (src/docker.ts) [deep]
├── Task 4: Config schema rewrite (src/config.ts) [quick]
├── Task 5: Dependency checker rewrite (src/deps.ts) [quick]
└── Task 6: Filesystem diff mapper (src/diff.ts) [unspecified-high]

Wave 2 (After Wave 1 — core modules, parallel):
├── Task 7: Container lifecycle (src/container.ts) [deep] (depends: 2, 3, 6)
├── Task 8: mitmproxy sidecar (src/proxy.ts + addon.py) [deep] (depends: 3)
└── Task 9: Store type migration (src/store.ts) [quick] (depends: 6)

Wave 3 (After Wave 2 — integration):
├── Task 10: Policy adapter (src/policy.ts) [unspecified-high] (depends: 6, 9)
└── Task 11: Plugin rewrite (src/index.ts) [deep] (depends: 4, 5, 7, 8, 10)

Wave 4 (After Wave 3 — tests):
├── Task 12: Unit tests [unspecified-high] (depends: 3, 6, 7, 8)
└── Task 13: Integration tests with testcontainers [deep] (depends: 11)

Wave 5 (After Wave 4 — cleanup):
└── Task 14: Delete old files + update package.json + README [quick] (depends: 13)

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 3 → Task 7 → Task 11 → Task 13 → Task 14 → F1-F4
Parallel Speedup: ~60% (Waves 1 & 2 maximize concurrency)
Max Concurrent: 6 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 (package.json) | — | 2, 3, 8 | 1 |
| 2 (Dockerfile/image) | — | 7 | 1 |
| 3 (docker.ts) | — | 7, 8 | 1 |
| 4 (config.ts) | — | 11 | 1 |
| 5 (deps.ts) | — | 11 | 1 |
| 6 (diff.ts) | — | 7, 9, 10 | 1 |
| 7 (container.ts) | 2, 3, 6 | 11, 12 | 2 |
| 8 (proxy.ts) | 3 | 11, 12 | 2 |
| 9 (store.ts) | 6 | 10 | 2 |
| 10 (policy.ts) | 6, 9 | 11 | 3 |
| 11 (index.ts) | 4, 5, 7, 8, 10 | 13 | 3 |
| 12 (unit tests) | 3, 6, 7, 8 | 14 | 4 |
| 13 (integration tests) | 11 | 14 | 4 |
| 14 (cleanup) | 12, 13 | F1-F4 | 5 |

### Agent Dispatch Summary

- **Wave 1**: 6 tasks — T1 → `quick`, T2 → `unspecified-high`, T3 → `deep`, T4 → `quick`, T5 → `quick`, T6 → `unspecified-high`
- **Wave 2**: 3 tasks — T7 → `deep`, T8 → `deep`, T9 → `quick`
- **Wave 3**: 2 tasks — T10 → `unspecified-high`, T11 → `deep`
- **Wave 4**: 2 tasks — T12 → `unspecified-high`, T13 → `deep`
- **Wave 5**: 1 task — T14 → `quick`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs


- [ ] 1. Package setup — add Docker dependencies, remove C compilation

  **What to do**:
  - Add `dockerode` and `@types/dockerode` to dependencies
  - Add `testcontainers` to devDependencies
  - Remove `postinstall` script from package.json (no more C compilation)
  - Run `bun install` to verify dependency resolution
  - Verify `import Dockerode from 'dockerode'` works from a bun -e one-liner

  **Must NOT do**:
  - Do NOT remove existing dependencies (@opencode-ai/plugin, zod)
  - Do NOT modify any source files yet

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2-6)
  - **Blocks**: Tasks 2, 3, 8
  - **Blocked By**: None

  **References**:
  - `package.json:1-28` — Current deps. Lines 9 (`postinstall`) to remove. Lines 17-19 (dependencies) to add dockerode. Lines 21-27 (devDependencies) to add testcontainers.
  - npm: `dockerode` v4.x, `@types/dockerode` for TypeScript types
  - npm: `testcontainers` for Docker lifecycle in tests

  **Acceptance Criteria**:
  - [ ] `bun install` exits 0
  - [ ] `bun -e "import Dockerode from 'dockerode'; console.log('ok')"` prints 'ok'
  - [ ] `bun -e "import { GenericContainer } from 'testcontainers'; console.log('ok')"` prints 'ok'
  - [ ] No `postinstall` script in package.json

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Dependencies install and import correctly
    Tool: Bash
    Steps:
      1. Run: bun install
      2. Assert: exit code 0
      3. Run: bun -e "import Dockerode from 'dockerode'; console.log(typeof Dockerode)"
      4. Assert: output is 'function'
      5. Run: grep postinstall package.json
      6. Assert: no output (postinstall removed)
    Expected Result: All deps resolve, imports work, no postinstall
    Evidence: .sisyphus/evidence/task-1-deps.txt
  ```

  **Commit**: YES
  - Message: `chore: add dockerode and testcontainers deps`
  - Files: `package.json`, `bun.lock`

- [ ] 2. Dockerfile + image module (src/image.ts)

  **What to do**:
  - Create `Dockerfile` at project root:
    ```dockerfile
    FROM alpine:3.19
    RUN apk add --no-cache bash git openssh-client curl coreutils ca-certificates
    RUN adduser -D -h /home/sandbox sandbox
    USER sandbox
    WORKDIR /workspace
    ```
  - Create `src/image.ts` module:
    - `ensureImage(docker: Dockerode): Promise<string>` — check if image `opencode-sandbox:local` exists, build from Dockerfile if not, return image name
    - `buildImage(docker: Dockerode, dockerfilePath: string): Promise<string>` — build image from Dockerfile, tag as `opencode-sandbox:local`, return image ID
    - Use dockerode `docker.buildImage()` API with tar stream of Dockerfile
    - Label image with `opencode-sandbox=true` for cleanup
  - Write unit test `test/image.test.ts`:
    - Test that `ensureImage` returns image name
    - Test that `buildImage` creates tagged image

  **Must NOT do**:
  - Do NOT push image to any registry
  - Do NOT include node_modules or heavy runtimes in the image
  - Do NOT use USER root in the Dockerfile

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3-6)
  - **Blocks**: Task 7
  - **Blocked By**: None

  **References**:
  - dockerode `buildImage()` API: accepts tar stream, returns build output stream
  - Alpine 3.19 package list: `apk add --no-cache` for minimal installs
  - Metis finding: label all Docker resources with `opencode-sandbox.session=<id>`

  **Acceptance Criteria**:
  - [ ] `Dockerfile` exists at project root
  - [ ] `src/image.ts` exports `ensureImage` and `buildImage`
  - [ ] `docker build -t opencode-sandbox:local .` succeeds from project root
  - [ ] Built image is ~15MB or less
  - [ ] Image runs: `docker run --rm opencode-sandbox:local whoami` outputs `sandbox`

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Dockerfile builds and runs
    Tool: Bash
    Steps:
      1. Run: docker build -t opencode-sandbox:local .
      2. Assert: exit code 0
      3. Run: docker run --rm opencode-sandbox:local whoami
      4. Assert: output is 'sandbox'
      5. Run: docker run --rm opencode-sandbox:local which git
      6. Assert: output contains '/usr/bin/git'
      7. Run: docker images opencode-sandbox:local --format '{{.Size}}'
      8. Assert: size < 50MB
    Expected Result: Image builds, non-root user, git available, small
    Evidence: .sisyphus/evidence/task-2-dockerfile.txt

  Scenario: image.ts ensureImage works
    Tool: Bash (bun -e)
    Steps:
      1. Run: bun -e "import {ensureImage} from './src/image'; import Dockerode from 'dockerode'; const d = new Dockerode(); console.log(await ensureImage(d))"
      2. Assert: output contains 'opencode-sandbox'
    Expected Result: Image name returned
    Evidence: .sisyphus/evidence/task-2-image-module.txt
  ```

  **Commit**: YES (groups with Wave 1 commit)
  - Message: `feat(docker): foundation modules — client, image, config, deps, diff`
  - Files: `Dockerfile`, `src/image.ts`, `test/image.test.ts`

- [ ] 3. Docker client module (src/docker.ts)

  **What to do**:
  - Create `src/docker.ts` — thin wrapper around dockerode with sandbox-specific defaults:
    - `connect(): Dockerode` — connect to Docker socket (default `/var/run/docker.sock`), return client instance
    - `createContainer(docker: Dockerode, opts: ContainerCreateOpts): Promise<Dockerode.Container>` — create container with:
      - Selective CapDrop: `['NET_RAW', 'SYS_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'SYS_BOOT', 'MAC_ADMIN', 'AUDIT_WRITE']`
      - SecurityOpt: `['no-new-privileges']`
      - Labels: `{ 'opencode-sandbox': 'true', 'opencode-sandbox.session': sessionId }`
      - NetworkMode: passed in (sandbox network name)
    - `execCommand(container: Dockerode.Container, cmd: string[], opts?: ExecOpts): Promise<ExecResult>` where `ExecResult = { stdout: string, stderr: string, exitCode: number }`
      - **CRITICAL**: Set `Tty: false` for demuxed stdout/stderr
      - **CRITICAL**: Use `container.modem.demuxStream(stream, stdout, stderr)` for stream splitting
      - **CRITICAL**: Dual-strategy stream handling — listen for stream `end` event AND poll `exec.inspect()` until `Running === false` as fallback (known dockerode issue where `end` may not fire)
    - `getChanges(container: Dockerode.Container): Promise<ContainerChange[]>` — wrapper around `container.changes()` returning `{ Kind: 0|1|2, Path: string }[]`
    - `commitContainer(container: Dockerode.Container, tag: string): Promise<string>` — commit current state, return image ID
    - `createNetwork(docker: Dockerode, name: string): Promise<Dockerode.Network>` — create bridge network with labels
    - `cleanup(docker: Dockerode, sessionId: string): Promise<void>` — remove all resources with matching session label
  - Export types: `ContainerCreateOpts`, `ExecResult`, `ExecOpts`, `ContainerChange`
  - Write unit test `test/docker.test.ts` with mocked dockerode

  **Must NOT do**:
  - Do NOT use `Tty: true` (breaks demux)
  - Do NOT use CapDrop ALL (breaks native addon installs)
  - Do NOT shell out to `docker` CLI
  - Do NOT handle container lifecycle (that's Task 7)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Core module with critical edge cases (stream handling, demux, dual-strategy polling)
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4-6)
  - **Blocks**: Tasks 7, 8
  - **Blocked By**: None

  **References**:
  - dockerode npm docs: `container.exec()`, `exec.start()`, `container.modem.demuxStream()`, `exec.inspect()`, `container.changes()`, `container.commit()`
  - Metis finding: `stream.on('end')` may not fire — use dual strategy
  - Metis finding: selective CapDrop, keep CHOWN/DAC_OVERRIDE/SETGID/SETUID/FOWNER
  - Canonical exec pattern from research: `Tty: false`, `hijack: true`, `stdin: false`, demuxStream
  - `src/store.ts:38-55` — SandboxResult type. The ExecResult from docker.ts feeds into this.

  **Acceptance Criteria**:
  - [ ] `src/docker.ts` exports connect, createContainer, execCommand, getChanges, commitContainer, createNetwork, cleanup
  - [ ] execCommand returns { stdout, stderr, exitCode } with correct demuxing
  - [ ] Tty is false in all exec calls
  - [ ] CapDrop is selective (NOT ALL)
  - [ ] Labels include opencode-sandbox and session ID
  - [ ] `test/docker.test.ts` passes

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: execCommand captures stdout/stderr separately
    Tool: Bash (bun -e)
    Preconditions: Docker daemon running
    Steps:
      1. Create container: docker run -d --name oc-test-exec alpine:3.19 sleep 300
      2. Run: bun -e "import {connect,execCommand} from './src/docker'; import Dockerode from 'dockerode'; const d = connect(); const c = d.getContainer('oc-test-exec'); const r = await execCommand(c, ['sh','-c','echo OUT && echo ERR >&2']); console.log(JSON.stringify(r))"
      3. Assert: stdout contains 'OUT', stderr contains 'ERR', exitCode === 0
      4. Cleanup: docker rm -f oc-test-exec
    Expected Result: Demuxed stdout/stderr, correct exit code
    Failure Indicators: stdout contains stderr content (Tty=true bug), exitCode undefined
    Evidence: .sisyphus/evidence/task-3-exec-demux.txt

  Scenario: getChanges detects filesystem modifications
    Tool: Bash (bun -e)
    Preconditions: Docker daemon running
    Steps:
      1. Create container: docker run -d --name oc-test-changes alpine:3.19 sleep 300
      2. Exec: docker exec oc-test-changes touch /tmp/newfile
      3. Run: bun -e "import {connect,getChanges} from './src/docker'; const d = connect(); const c = d.getContainer('oc-test-changes'); const ch = await getChanges(c); console.log(JSON.stringify(ch))"
      4. Assert: output contains '/tmp/newfile' with Kind=1 (added)
      5. Cleanup: docker rm -f oc-test-changes
    Expected Result: Changes array includes the new file
    Evidence: .sisyphus/evidence/task-3-changes.txt

  Scenario: execCommand handles non-zero exit codes
    Tool: Bash (bun -e)
    Preconditions: Docker daemon running
    Steps:
      1. Create container: docker run -d --name oc-test-exit alpine:3.19 sleep 300
      2. Run: bun -e "import {connect,execCommand} from './src/docker'; const d = connect(); const c = d.getContainer('oc-test-exit'); const r = await execCommand(c, ['sh','-c','exit 42']); console.log(r.exitCode)"
      3. Assert: output is '42'
      4. Cleanup: docker rm -f oc-test-exit
    Expected Result: Non-zero exit code captured correctly
    Evidence: .sisyphus/evidence/task-3-exit-code.txt
  ```

  **Commit**: YES (groups with Wave 1 commit)
  - Message: `feat(docker): foundation modules — client, image, config, deps, diff`
  - Files: `src/docker.ts`, `test/docker.test.ts`

- [ ] 4. Config schema rewrite (src/config.ts)

  **What to do**:
  - Rewrite `src/config.ts` schema to remove bwrap-specific options and add Docker options:
    - REMOVE: `timeout`, `strace_bufsize`, `home_readable`
    - KEEP: `network.mode` ("block" | "observe"), `network.allow`, `network.allow_methods`, `network.allow_graphql_queries`, `filesystem.allow_write`, `filesystem.deny_read`, `filesystem.inherit_permissions`, `auto_allow_clean`, `verbose`
    - ADD: `docker.image` (optional string, custom image name, default `opencode-sandbox:local`)
  - Remove `TIMEOUT` const export
  - Keep `load()` function (reads .opencode/sandbox.json + global config, deep merge)
  - Keep `deepMerge()` helper unchanged
  - Update `defaults` const to match new schema
  - Update `SandboxConfig` type export
  - Keep `schema` export for test access
  - Zero console output (already an issue from before)

  **Must NOT do**:
  - Do NOT change config file locations (.opencode/sandbox.json, ~/.config/opencode/sandbox.json)
  - Do NOT change the deep merge behavior
  - Do NOT remove network.allow_methods or allow_graphql_queries (mitmproxy will use these)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1-3, 5, 6)
  - **Blocks**: Task 11
  - **Blocked By**: None

  **References**:
  - `src/config.ts:1-75` — Current config module. Lines 7-28 are the schema. Lines 5, 8, 27 are fields to remove (TIMEOUT, timeout, strace_bufsize, home_readable).
  - `src/config.ts:32` — `defaults` const needs updating
  - `src/config.ts:59-73` — `load()` function. Keep as-is except update defaults.

  **Acceptance Criteria**:
  - [ ] Schema has no `timeout`, `strace_bufsize`, or `home_readable` fields
  - [ ] Schema has `docker.image` optional string field
  - [ ] `network.mode`, `network.allow`, `network.allow_methods`, `network.allow_graphql_queries` preserved
  - [ ] `load()` still reads from .opencode/sandbox.json and global config
  - [ ] `bun -e "import {schema} from './src/config'; console.log(JSON.stringify(schema.parse({})))"` outputs valid config without timeout

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Config schema parses defaults correctly
    Tool: Bash (bun -e)
    Steps:
      1. Run: bun -e "import {schema} from './src/config'; const c = schema.parse({}); console.log(JSON.stringify({mode:c.network.mode, hasTimeout:'timeout' in c, hasDocker:'docker' in c}))"
      2. Assert: mode is 'block', hasTimeout is false, hasDocker is true
    Expected Result: No timeout field, docker section present
    Evidence: .sisyphus/evidence/task-4-config.txt
  ```

  **Commit**: YES (groups with Wave 1 commit)
  - Message: `feat(docker): foundation modules — client, image, config, deps, diff`
  - Files: `src/config.ts`

- [ ] 5. Dependency checker rewrite (src/deps.ts)

  **What to do**:
  - Rewrite `src/deps.ts` to check for Docker instead of bwrap/strace:
    - `check(): Promise<{ available: boolean, docker: boolean, error?: string }>` — attempt to connect to Docker socket and ping daemon
    - Use dockerode `docker.ping()` to verify daemon is running
    - If Docker not available: return `{ available: false, docker: false, error: 'Docker daemon not running or not installed' }`
    - Remove all bwrap/strace/overlay checks
    - Zero console output (no console.warn for missing deps)

  **Must NOT do**:
  - Do NOT shell out to `docker info` or `docker version` (use dockerode API)
  - Do NOT fall back gracefully — this is used by index.ts to hard-error

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 11
  - **Blocked By**: None

  **References**:
  - `src/deps.ts:1-105` — Current module. All bwrap/strace/overlay checking logic to be replaced.
  - dockerode `docker.ping()` — returns 'OK' if daemon is running

  **Acceptance Criteria**:
  - [ ] `check()` returns `{ available: true, docker: true }` when Docker is running
  - [ ] `check()` returns `{ available: false, ... }` when Docker is not running
  - [ ] No references to bwrap, strace, or overlay in deps.ts
  - [ ] Zero console output

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Docker availability check succeeds
    Tool: Bash (bun -e)
    Preconditions: Docker daemon running
    Steps:
      1. Run: bun -e "import * as deps from './src/deps'; const r = await deps.check(); console.log(JSON.stringify(r))"
      2. Assert: available is true, docker is true
    Expected Result: Docker detected as available
    Evidence: .sisyphus/evidence/task-5-deps.txt
  ```

  **Commit**: YES (groups with Wave 1 commit)
  - Files: `src/deps.ts`

- [ ] 6. Filesystem diff mapper (src/diff.ts)

  **What to do**:
  - Create `src/diff.ts` — maps Docker `container.changes()` output to SandboxResult fields:
    - `type ContainerChange = { Kind: 0 | 1 | 2, Path: string }` (0=modified, 1=added, 2=deleted)
    - `mapChanges(changes: ContainerChange[], project: string, home: string): DiffResult`
    - `DiffResult = { mutations: FsMutation[], files: FileOpen[], writes: FileWrite[] }`
    - Mapping logic:
      - Kind 1 (added) → `FsMutation { kind: 'fs_mutation', syscall: 'mkdir' (if dir) | 'creat' (if file), path, result: 0 }`
      - Kind 0 (modified) → `FsMutation { kind: 'fs_mutation', syscall: 'rename', path, result: 0 }` + `FileWrite { kind: 'file_write', syscall: 'write', fd: -1, bytes: 0, result: 0 }`
      - Kind 2 (deleted) → `FsMutation { kind: 'fs_mutation', syscall: 'unlink' (if file) | 'rmdir' (if dir), path, result: 0 }`
    - Filter OUT changes under project path (bind-mounted, already on host)
    - Filter OUT changes under `/tmp`, `/proc`, `/sys`, `/dev`, `/run` (ephemeral)
    - Translate container paths to host paths: if container mounts project at same host path, paths already match
  - Define the types locally (don't import from strace.ts which will be deleted):
    - `FileOpen`, `FileWrite`, `FsMutation`, `NetConnect`, `NetSocket` — redefine in diff.ts or a new shared types file
  - Write unit test `test/diff.test.ts`:
    - Test: added file outside project → FsMutation with syscall 'creat'
    - Test: modified file outside project → FsMutation + FileWrite
    - Test: deleted file outside project → FsMutation with syscall 'unlink'
    - Test: changes under project path filtered out
    - Test: changes under /tmp filtered out

  **Must NOT do**:
  - Do NOT import from strace.ts (will be deleted)
  - Do NOT import from epilogue.ts (will be deleted)
  - Do NOT assume specific container mount paths — use project param

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Data mapping with type definitions, multiple edge cases
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1-5)
  - **Blocks**: Tasks 7, 9, 10
  - **Blocked By**: None

  **References**:
  - Docker Engine API: `container.changes()` returns `[{ Kind: 0|1|2, Path: string }]`
  - `src/strace.ts:9-30` — Current `FileOpen`, `FileWrite`, `FsMutation` types. Redefine these in diff.ts (don't import from strace.ts).
  - `src/store.ts:38-55` — `SandboxResult` type. The DiffResult fields feed into this.
  - `src/policy.ts:55-64` — How `mutations` are consumed by policy evaluation. The FsMutation shape must match.

  **Acceptance Criteria**:
  - [ ] `src/diff.ts` exports `mapChanges`, `DiffResult`, `ContainerChange`, `FsMutation`, `FileOpen`, `FileWrite`
  - [ ] Project-path changes filtered out
  - [ ] Ephemeral path changes (/tmp, /proc, /sys, /dev, /run) filtered out
  - [ ] Kind 0/1/2 mapped to correct syscalls
  - [ ] `test/diff.test.ts` passes

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: mapChanges filters and maps correctly
    Tool: Bash (bun test)
    Steps:
      1. Run: bun test test/diff.test.ts
      2. Assert: all tests pass
    Expected Result: All mapping and filtering tests pass
    Evidence: .sisyphus/evidence/task-6-diff.txt

  Scenario: Changes under project path are excluded
    Tool: Bash (bun -e)
    Steps:
      1. Run: bun -e "import {mapChanges} from './src/diff'; const r = mapChanges([{Kind:1,Path:'/home/user/project/foo.ts'},{Kind:1,Path:'/home/user/.cache/bar'}], '/home/user/project', '/home/user'); console.log(r.mutations.length)"
      2. Assert: output is '1' (only .cache change, project change filtered)
    Expected Result: Project changes excluded, non-project changes included
    Evidence: .sisyphus/evidence/task-6-diff-filter.txt
  ```

  **Commit**: YES (groups with Wave 1 commit)
  - Message: `feat(docker): foundation modules — client, image, config, deps, diff`
  - Files: `src/diff.ts`, `test/diff.test.ts`

- [ ] 7. Container lifecycle manager (src/container.ts)

  **What to do**:
  - Create `src/container.ts` — orchestrates the warm container pattern:
    - `type SessionState = { container: Dockerode.Container, network: Dockerode.Network, imageTag: string, sessionId: string }`
    - `init(docker: Dockerode, project: string, home: string, sessionId: string, config: SandboxConfig): Promise<SessionState>` —
      1. Create bridge network `oc-sandbox-${sessionId}`
      2. Ensure sandbox image exists (call image.ensureImage)
      3. Create container with:
         - `HostConfig.Binds: ['${project}:${project}']` (bind-mount project at same path, RW)
         - `HostConfig.NetworkMode: networkName` (or 'none' if network.mode === 'block')
         - `Env: ['HOME=${home}', 'OC_SANDBOX=1', 'OC_SANDBOX_PROJECT=${project}']`
         - If observe mode: `Env += ['HTTP_PROXY=http://mitmproxy:8080', 'HTTPS_PROXY=http://mitmproxy:8080']`
         - `WorkingDir: project`
         - Labels, CapDrop, SecurityOpt (from docker.ts createContainer)
         - `Cmd: ['sleep', 'infinity']` (keep container alive for exec)
      4. Start container
      5. Commit initial state as `opencode-sandbox:${sessionId}-base`
      6. Return SessionState
    - `exec(state: SessionState, cmd: string, cwd: string): Promise<ExecResult>` —
      1. Call `docker.execCommand(container, ['sh', '-c', cmd], { WorkingDir: cwd })`
      2. Return ExecResult (stdout, stderr, exitCode)
    - `inspect(state: SessionState, project: string, home: string): Promise<DiffResult>` —
      1. Call `docker.getChanges(container)`
      2. Call `diff.mapChanges(changes, project, home)`
      3. Return DiffResult
    - `approve(state: SessionState): Promise<void>` —
      1. Commit current container state: `docker.commitContainer(container, imageTag + '-approved-' + Date.now())`
      2. Update `state.imageTag` to new committed image
    - `reject(state: SessionState): Promise<void>` —
      1. Stop and remove current container
      2. Recreate container from last committed image (`state.imageTag`)
      3. Start new container
      4. Update `state.container` reference
    - `teardown(state: SessionState): Promise<void>` —
      1. Stop and remove container
      2. Remove network
      3. Clean up committed images (remove all with session label)
    - Register process exit handlers: `process.on('exit')`, `process.on('SIGTERM')`, `process.on('SIGINT')` → call teardown

  **Must NOT do**:
  - Do NOT create new containers per command (warm container pattern)
  - Do NOT use Tty: true (delegate to docker.ts which enforces this)
  - Do NOT handle mitmproxy (that's Task 8)
  - Do NOT modify files on the host filesystem (project dir writes go through bind-mount automatically)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Core lifecycle orchestration with state management, commit/recreate logic, cleanup
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 8, 9)
  - **Blocks**: Tasks 11, 12
  - **Blocked By**: Tasks 2, 3, 6

  **References**:
  - `src/docker.ts` (Task 3) — All Docker API calls go through this module
  - `src/image.ts` (Task 2) — `ensureImage()` called during init
  - `src/diff.ts` (Task 6) — `mapChanges()` called during inspect
  - Metis: label ALL resources with `opencode-sandbox.session=<id>`, register cleanup on process exit
  - Metis: `docker commit` excludes bind-mounted paths (project-dir changes already on host)

  **Acceptance Criteria**:
  - [ ] `src/container.ts` exports init, exec, inspect, approve, reject, teardown
  - [ ] init creates network + container, starts it, commits base image
  - [ ] exec runs command via docker exec, returns stdout/stderr/exitCode
  - [ ] inspect calls container.changes() and maps via diff.ts
  - [ ] approve commits container state
  - [ ] reject recreates container from last committed image
  - [ ] teardown removes container + network + committed images
  - [ ] Process exit handlers registered

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Full lifecycle — init, exec, inspect, teardown
    Tool: Bash (bun -e)
    Preconditions: Docker daemon running, image built (Task 2)
    Steps:
      1. Run: bun -e "
         import {connect} from './src/docker';
         import {init, exec, inspect, teardown} from './src/container';
         const d = connect();
         const s = await init(d, '/tmp/oc-test-proj', '/home/sandbox', 'test-' + Date.now(), {network:{mode:'block'},auto_allow_clean:true,filesystem:{allow_write:[],deny_read:[],inherit_permissions:true},verbose:false,docker:{image:'opencode-sandbox:local'}});
         const r = await exec(s, 'touch /home/sandbox/.cache/testfile && echo done', '/tmp/oc-test-proj');
         console.log('stdout:', r.stdout.trim());
         const diff = await inspect(s, '/tmp/oc-test-proj', '/home/sandbox');
         console.log('mutations:', diff.mutations.length);
         await teardown(s);
         console.log('done');"
      2. Assert: stdout contains 'done', mutations.length > 0, final 'done' printed (teardown succeeded)
    Expected Result: Container created, command executed, changes detected, cleanup completed
    Failure Indicators: Docker API errors, no mutations detected, teardown fails
    Evidence: .sisyphus/evidence/task-7-lifecycle.txt

  Scenario: Reject recreates container from committed image
    Tool: Bash (bun -e)
    Preconditions: Docker daemon running
    Steps:
      1. Init session, exec 'touch /home/sandbox/dirty', call reject(state)
      2. Exec 'ls /home/sandbox/dirty' in recreated container
      3. Assert: file does not exist (container recreated from clean image)
      4. Teardown
    Expected Result: After reject, container is clean (dirty file gone)
    Evidence: .sisyphus/evidence/task-7-reject.txt
  ```

  **Commit**: YES
  - Message: `feat(docker): container lifecycle, mitmproxy sidecar, store migration`
  - Files: `src/container.ts`

- [ ] 8. mitmproxy sidecar module (src/proxy.ts + mitmproxy/addon.py)

  **What to do**:
  - Create `mitmproxy/addon.py` — mitmproxy addon script:
    ```python
    import json, os
    from mitmproxy import http, ctx
    
    LOG = os.environ.get('MITMPROXY_LOG', '/var/log/mitmproxy/flows.jsonl')
    ALLOW_METHODS = os.environ.get('ALLOW_METHODS', '').split(',') if os.environ.get('ALLOW_METHODS') else None
    
    def response(flow: http.HTTPFlow):
        entry = {
            'method': flow.request.method,
            'path': flow.request.path,
            'host': flow.request.host,
            'port': flow.request.port,
            'status': flow.response.status_code if flow.response else None,
            'tls': flow.request.scheme == 'https',
            'sni': flow.client_conn.sni if hasattr(flow.client_conn, 'sni') else None,
        }
        with open(LOG, 'a') as f:
            f.write(json.dumps(entry) + '\n')
    
    def request(flow: http.HTTPFlow):
        if ALLOW_METHODS and flow.request.method not in ALLOW_METHODS:
            flow.response = http.Response.make(403, b'Method not allowed by sandbox policy')
    ```
  - Create `src/proxy.ts` — manages mitmproxy sidecar container:
    - `type ProxyState = { container: Dockerode.Container, logPath: string, network: string }`
    - `startProxy(docker: Dockerode, networkName: string, sessionId: string, allowMethods?: string[]): Promise<ProxyState>` —
      1. Create shared volume or bind-mount for logs: `/tmp/oc-proxy-${sessionId}/`
      2. Pull/use `mitmproxy/mitmproxy:latest` image
      3. Create container on same network as sandbox:
         - `Cmd: ['mitmdump', '--set', 'flow_detail=0', '-s', '/addon/addon.py', '--listen-host', '0.0.0.0', '--listen-port', '8080']`
         - `Name: 'oc-mitmproxy-' + sessionId`
         - `Binds: ['mitmproxy/addon.py:/addon/addon.py:ro', logDir + ':/var/log/mitmproxy']`
         - `Env: ['ALLOW_METHODS=' + (allowMethods?.join(',') || '')]`
         - `NetworkAliases: ['mitmproxy']` (so sandbox container can reach it as http://mitmproxy:8080)
      4. Start container
      5. Wait for proxy to be ready (poll health endpoint or sleep 1s)
    - `readLogs(state: ProxyState): Promise<ProxyFlow[]>` — read and parse `/var/log/mitmproxy/flows.jsonl`
    - `mapFlows(flows: ProxyFlow[]): { http: HttpRequest[], tls: TlsInfo[], dns: DnsQuery[] }` —
      - Each flow → `HttpRequest { method, path, host, addr: host, port, forwarded: false }`
      - TLS flows (tls: true) → `TlsInfo { sni, addr: host, port }`
      - DNS: not directly observable via explicit proxy. Return empty array.
    - `stopProxy(state: ProxyState): Promise<void>` — stop and remove proxy container + clean up log dir
    - `getProxyCACert(state: ProxyState): Promise<string>` — copy mitmproxy's CA cert from container for trust injection

  **Must NOT do**:
  - Do NOT use transparent iptables proxy (requires NET_ADMIN)
  - Do NOT assume DNS is observable (explicit proxy doesn't intercept raw DNS)
  - Do NOT modify the sandbox container from this module (proxy.ts only manages the mitmproxy sidecar)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Cross-container orchestration, Python addon, log parsing, CA cert extraction
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7, 9)
  - **Blocks**: Tasks 11, 12
  - **Blocked By**: Task 3

  **References**:
  - `src/docker.ts` (Task 3) — Docker API calls for creating/managing the mitmproxy container
  - `src/store.ts:16-36` — `HttpRequest`, `TlsInfo`, `DnsQuery` types that mapFlows must produce
  - mitmproxy docs: mitmdump, addon API (request/response hooks), CA cert at ~/.mitmproxy/mitmproxy-ca-cert.pem
  - Docker Hub: `mitmproxy/mitmproxy` official image
  - Metis: explicit proxy mode only (HTTP_PROXY env vars, NOT transparent iptables)

  **Acceptance Criteria**:
  - [ ] `mitmproxy/addon.py` exists, has `request` and `response` handlers
  - [ ] `src/proxy.ts` exports startProxy, readLogs, mapFlows, stopProxy, getProxyCACert
  - [ ] Proxy container starts on the sandbox network with alias 'mitmproxy'
  - [ ] Method filtering works: blocked methods return 403
  - [ ] Flow logs written as JSONL, parseable by readLogs
  - [ ] mapFlows produces correct HttpRequest[] and TlsInfo[]

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: mitmproxy intercepts HTTP request
    Tool: Bash
    Preconditions: Docker daemon running
    Steps:
      1. Create Docker network: docker network create oc-proxy-test
      2. Start mitmproxy: docker run -d --name oc-proxy-test-mitm --network oc-proxy-test -v $(pwd)/mitmproxy/addon.py:/addon/addon.py:ro -v /tmp/oc-proxy-test:/var/log/mitmproxy -e ALLOW_METHODS=GET mitmproxy/mitmproxy mitmdump --set flow_detail=0 -s /addon/addon.py --listen-host 0.0.0.0 --listen-port 8080
      3. Wait: sleep 3
      4. Run curl through proxy: docker run --rm --network oc-proxy-test -e http_proxy=http://oc-proxy-test-mitm:8080 alpine:3.19 wget -q -O- http://httpbin.org/get
      5. Assert: request succeeded (exit 0)
      6. Check logs: cat /tmp/oc-proxy-test/flows.jsonl
      7. Assert: log contains entry with method 'GET' and host 'httpbin.org'
      8. Test blocked method: docker run --rm --network oc-proxy-test -e http_proxy=http://oc-proxy-test-mitm:8080 alpine:3.19 wget -q -O- --post-data='' http://httpbin.org/post
      9. Assert: request returns 403 or fails (POST not in ALLOW_METHODS)
      10. Cleanup: docker rm -f oc-proxy-test-mitm && docker network rm oc-proxy-test
    Expected Result: GET proxied successfully, POST blocked, logs written
    Evidence: .sisyphus/evidence/task-8-proxy.txt
  ```

  **Commit**: YES
  - Message: `feat(docker): container lifecycle, mitmproxy sidecar, store migration`
  - Files: `src/proxy.ts`, `mitmproxy/addon.py`

- [ ] 9. Store type migration (src/store.ts)

  **What to do**:
  - Modify `src/store.ts` to remove import from `./strace` (which will be deleted):
    - Move `FileOpen`, `FileWrite`, `FsMutation`, `NetConnect`, `NetSocket` type definitions into store.ts directly (or import from `./diff`)
    - These types are currently defined in strace.ts and imported by store.ts
    - The SandboxResult type shape MUST NOT change
    - The type field values must remain compatible (same `kind`, `syscall` fields)
  - Option: import shared types from diff.ts instead (since diff.ts redefines them for Docker)
  - Keep the `results` Map, `set()`, `get()`, `clear()` functions unchanged

  **Must NOT do**:
  - Do NOT change SandboxResult field names or types
  - Do NOT change the Map-based storage mechanism
  - Do NOT remove any fields from SandboxResult

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7, 8)
  - **Blocks**: Task 10
  - **Blocked By**: Task 6

  **References**:
  - `src/store.ts:1-71` — Current module. Line 1 imports from `./strace`. The rest is standalone.
  - `src/strace.ts:9-30` — `FileOpen`, `FileWrite`, `FsMutation` type definitions to move into store.ts
  - `src/strace.ts:32-55` — `NetConnect`, `NetSocket` type definitions to move into store.ts
  - `src/diff.ts` (Task 6) — May already define some of these types; coordinate to avoid duplication

  **Acceptance Criteria**:
  - [ ] `src/store.ts` has NO imports from `./strace`
  - [ ] `FileOpen`, `FileWrite`, `FsMutation`, `NetConnect`, `NetSocket` types defined in store.ts (or imported from diff.ts)
  - [ ] SandboxResult type is IDENTICAL in shape to current version
  - [ ] `bun -e "import type {SandboxResult} from './src/store'; console.log('ok')"` works

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Store module imports resolve without strace.ts
    Tool: Bash (bun -e)
    Steps:
      1. Run: bun -e "import {set,get,clear} from './src/store'; set('test', {files:[],writes:[],mutations:[],network:[],sockets:[],dns:[],http:[],tls:[],ssh:[],duration:0,timedOut:false,violations:[],stdout:'',stderr:'',exitCode:0}); const r = get('test'); console.log(r?.exitCode)"
      2. Assert: output is '0'
      3. Run: grep 'strace' src/store.ts
      4. Assert: no output (no strace imports)
    Expected Result: Store works without strace dependency
    Evidence: .sisyphus/evidence/task-9-store.txt
  ```

  **Commit**: YES
  - Message: `feat(docker): container lifecycle, mitmproxy sidecar, store migration`
  - Files: `src/store.ts`

- [ ] 10. Policy adapter (src/policy.ts)

  **What to do**:
  - Minimal changes to `src/policy.ts` to work with Docker-produced SandboxResult:
    - Update import: change `import type { ... } from './strace'` to import from `./store` or `./diff`
    - The core `writable()` and `evaluate()` functions should work as-is if SandboxResult shape is unchanged
    - Verify that `evaluate()` correctly processes mutations from `container.changes()` (which uses absolute host paths)
    - The `EPHEMERAL` and `SANDBOX_INFRA` path lists may need adjustment:
      - KEEP: `/tmp`, `/dev`, `/sys`, `/proc`, `/run`, `~/.cache`, `~/.local`, `~/.config`, `~/.npm`, `~/.bun`, `~/.pnpm-store`
      - REMOVE or UPDATE: `/newroot`, `/etc/ssl`, `/etc/pki` (these were bwrap-specific CA injection paths, Docker uses different mechanism)
    - Verify the `proxy` detection logic (`allow_methods` check) still works for mitmproxy mode
  - Write a focused test to verify policy evaluates Docker-produced mutations correctly

  **Must NOT do**:
  - Do NOT rewrite the core writable() or evaluate() logic
  - Do NOT change violation types or severity levels
  - Do NOT change the function signatures

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 11)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 6, 9

  **References**:
  - `src/policy.ts:1-132` — Current module. Line 2 imports from `./store`. Lines 10-16 are EPHEMERAL/SANDBOX_INFRA lists.
  - `src/store.ts` (Task 9) — Updated types
  - `src/diff.ts` (Task 6) — FsMutation shape that policy.evaluate() consumes

  **Acceptance Criteria**:
  - [ ] `src/policy.ts` has NO imports from `./strace`
  - [ ] `writable()` and `evaluate()` work with Docker-produced SandboxResult
  - [ ] SANDBOX_INFRA updated (no bwrap-specific paths)
  - [ ] `bun -e "import {evaluate} from './src/policy'"` succeeds

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Policy evaluates Docker-style mutations
    Tool: Bash (bun -e)
    Steps:
      1. Run: bun -e "
         import {evaluate} from './src/policy';
         const result = {files:[],writes:[],mutations:[{kind:'fs_mutation',syscall:'creat',path:'/home/user/.ssh/evil',result:0}],network:[],sockets:[],dns:[],http:[],tls:[],ssh:[],duration:0,timedOut:false,violations:[],stdout:'',stderr:'',exitCode:0};
         const v = evaluate(result, {network:{mode:'block',allow:[],allow_methods:['GET','HEAD','OPTIONS'],allow_graphql_queries:true},filesystem:{inherit_permissions:true,allow_write:[],deny_read:[]},auto_allow_clean:true,verbose:false,docker:{image:'opencode-sandbox:local'}}, '/home/user/project');
         console.log(v.length, v[0]?.type)"
      2. Assert: output shows 1 violation of type 'filesystem'
    Expected Result: Write to ~/.ssh detected as violation
    Evidence: .sisyphus/evidence/task-10-policy.txt
  ```

  **Commit**: YES
  - Message: `feat(docker): plugin rewrite with Docker-based sandboxing`
  - Files: `src/policy.ts`

- [ ] 11. Plugin rewrite (src/index.ts)

  **What to do**:
  - **Complete rewrite** of `src/index.ts` using Docker modules:
    - Import: docker, container, proxy, diff, config, deps, policy, store
    - Remove ALL bwrap/strace/seccomp/overlay imports and logic
    - Remove: stash Map, uppers Map, VIRTUAL set, probeOverlay(), systemOverlayDirs(), resolveGitWorktreeAllowPaths(), all CA/proxy setup code

  **Plugin initialization** (`plugin()`):
    1. `deps.check()` → if not available, throw Error('Docker required for opencode-sandbox')
    2. If `OC_SANDBOX === '1'`: return empty hooks `{}` (nested — already sandboxed)
    3. `config.load(input.directory)`
    4. `docker.connect()`
    5. Generate sessionId: `'oc-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)`
    6. If `cfg.network.mode === 'observe'`: `proxy.startProxy(docker, networkName, sessionId, cfg.network.allow_methods)`
    7. `container.init(docker, project, home, sessionId, cfg)` → SessionState
    8. Return hooks object

  **Hook: `tool.execute.before`**:
    - If `info.tool !== 'bash'`: return (no-op for non-bash tools)
    - Store reference to `output.args` keyed by `info.callID`
    - (Do NOT replace command — the command runs via `docker exec` in permission.ask)

  **Hook: `permission.ask`**:
    - If `info.type === 'sandbox_review'`: handle post-review commit (same as current)
    - If `info.type === 'edit' | 'write' | 'apply_patch'`: path-based policy check (keep current logic)
    - If `info.type === 'bash'`:
      1. Get stashed args reference
      2. Run command in container: `container.exec(state, args.command, project)`
      3. Get filesystem changes: `container.inspect(state, project, home)`
      4. If observe mode: `proxy.readLogs()` + `proxy.mapFlows()` for network data
      5. Build `SandboxResult` from exec result + diff result + network data
      6. Run `policy.evaluate(result, cfg, project)`
      7. `store.set(callID, result)`
      8. If no violations OR auto_allow_clean:
         - `container.approve(state)` (commit clean state)
         - `output.status = 'allow'`
      9. If violations:
         - Write manifest to `/tmp/oc-sandbox-review-${callID}`
         - Leave `output.status = 'ask'` (permission prompt shows violations)
    - **IMPORTANT**: Replace `output.args.command` with a no-op (`true`) after running in container. The real command already ran inside Docker; we don't want bash.ts to run it again on the host.

  **Hook: `tool.execute.after`**:
    - Clean up stashed args for callID
    - If observe mode: clear proxy logs for next command

  **Hook: `shell.env`**:
    - Set `OC_SANDBOX=1`
    - Set `OC_SANDBOX_PROJECT=project`
    - Set `OC_SANDBOX_WRITABLE=cfg.filesystem.allow_write.join(':')`
    - If observe mode: set `OC_ALLOW_METHODS=cfg.network.allow_methods.join(',')`

  **Must NOT do**:
  - Do NOT import wrapper.ts, epilogue.ts, strace.ts, sandbox.ts, commit.ts, observe.c
  - Do NOT reference bwrap, strace, seccomp, overlayfs anywhere
  - Do NOT use console.log/warn/error (zero console output)
  - Do NOT fall through to default permission flow if Docker unavailable (throw error)
  - Do NOT create new containers for nested execution

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Full module rewrite orchestrating all Docker modules, complex hook interaction
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 4, 5, 7, 8, 10

  **References**:
  - `src/index.ts:1-316` — Current module (complete rewrite target). Study hook shapes at lines 203-313.
  - `src/container.ts` (Task 7) — init, exec, inspect, approve, reject, teardown
  - `src/proxy.ts` (Task 8) — startProxy, readLogs, mapFlows, stopProxy
  - `src/docker.ts` (Task 3) — connect, cleanup
  - `src/config.ts` (Task 4) — load, SandboxConfig
  - `src/deps.ts` (Task 5) — check
  - `src/policy.ts` (Task 10) — evaluate, writable
  - `src/store.ts` (Task 9) — set, get, SandboxResult
  - `test/transparent-wrapper.test.ts:69-102` — invokeHooks helper showing expected hook call sequence (adapt for Docker flow)
  - `test/e2e-permission.test.ts` — Expected permission.ask behavior (adapt for Docker)

  **Acceptance Criteria**:
  - [ ] Plugin returns all 4 hooks: tool.execute.before, permission.ask, tool.execute.after, shell.env
  - [ ] Docker unavailable → throws Error
  - [ ] OC_SANDBOX=1 → returns empty hooks (nesting)
  - [ ] Bash commands run in container via docker exec
  - [ ] Filesystem changes detected via container.changes()
  - [ ] Network traffic observed via mitmproxy (when observe mode)
  - [ ] Clean commands auto-approved, violations trigger permission prompt
  - [ ] No imports from wrapper.ts, epilogue.ts, strace.ts, sandbox.ts, commit.ts
  - [ ] Zero console output
  - [ ] After running command in container, args.command replaced with no-op ('true')

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Plugin initializes with Docker
    Tool: Bash (bun -e)
    Preconditions: Docker daemon running, image built
    Steps:
      1. Create temp dir: mkdir -p /tmp/oc-plugin-test
      2. Run: bun -e "import plugin from './src'; const h = await plugin({directory:'/tmp/oc-plugin-test',worktree:'/tmp/oc-plugin-test',serverUrl:new URL('http://localhost:0')}); console.log(Object.keys(h).sort().join(','))"
      3. Assert: output is 'permission.ask,shell.env,tool.execute.after,tool.execute.before'
    Expected Result: All 4 hooks registered
    Evidence: .sisyphus/evidence/task-11-hooks.txt

  Scenario: Nesting detection skips sandboxing
    Tool: Bash
    Preconditions: None
    Steps:
      1. Run: OC_SANDBOX=1 bun -e "import plugin from './src'; const h = await plugin({directory:'/tmp/test',worktree:'/tmp/test',serverUrl:new URL('http://localhost:0')}); console.log(Object.keys(h).length)"
      2. Assert: output is '0' (empty hooks)
    Expected Result: Nested sandbox detected, no hooks registered
    Evidence: .sisyphus/evidence/task-11-nesting.txt

  Scenario: Docker unavailable throws error
    Tool: Bash
    Preconditions: Docker daemon stopped OR mock docker.ts to fail
    Steps:
      1. Run: DOCKER_HOST=tcp://localhost:99999 bun -e "import plugin from './src'; try { await plugin({directory:'/tmp/test',worktree:'/tmp/test',serverUrl:new URL('http://localhost:0')}); console.log('NO ERROR') } catch(e) { console.log('ERROR:', e.message) }"
      2. Assert: output starts with 'ERROR:' (not 'NO ERROR')
    Expected Result: Clear error when Docker unavailable
    Evidence: .sisyphus/evidence/task-11-no-docker.txt
  ```

  **Commit**: YES
  - Message: `feat(docker): plugin rewrite with Docker-based sandboxing`
  - Files: `src/index.ts`

- [ ] 12. Unit tests with mocked dockerode

  **What to do**:
  - Create/update unit test files that mock dockerode for fast isolated testing:
    - `test/docker.test.ts` — test docker.ts functions with mocked Docker socket
    - `test/diff.test.ts` — test mapChanges with synthetic ContainerChange arrays (already from Task 6)
    - `test/container.test.ts` — test lifecycle with mocked docker.ts module
    - `test/proxy.test.ts` — test log parsing and flow mapping with mock data (NOTE: replaces old proxy.test.ts which tested bwrap proxy config)
    - `test/config.test.ts` — test new schema (replaces relevant parts of old tests)
  - Each test file should:
    - Mock dockerode using `mock.module()` from bun:test or manual mocks
    - Test happy paths and error paths
    - Not require Docker daemon running
  - Remove or replace old bwrap-dependent test files:
    - `test/wrapper.test.ts` → DELETE (bwrap wrapper tests)
    - `test/epilogue.test.ts` → DELETE (overlay epilogue tests)
    - `test/overlay.test.ts` → DELETE (bwrap overlay tests)
    - `test/observe.test.ts` → DELETE (oc-observe tests)
    - `test/degradation.test.ts` → DELETE (bwrap degradation tests)
    - `test/transparent-wrapper.test.ts` → REWRITE for Docker hook flow
    - `test/e2e-permission.test.ts` → REWRITE for Docker permission flow
    - `test/integration.test.ts` → REWRITE for Docker integration
    - `test/worktree-e2e.test.ts` → REWRITE for Docker (worktree detection still needed)
    - `test/timeout-sweep.ts` → DELETE (no more timeouts)
    - `test/protocol.test.ts` → KEEP if protocol.ts is kept, DELETE if not
    - `test/proxy.test.ts` → REWRITE (was bwrap proxy config, now mitmproxy)

  **Must NOT do**:
  - Do NOT require Docker daemon for unit tests (mocked)
  - Do NOT weaken assertions to make tests pass
  - Do NOT leave old bwrap test files that will fail

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Multiple test files, mock setup, adapting existing test patterns
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 13)
  - **Blocks**: Task 14
  - **Blocked By**: Tasks 3, 6, 7, 8

  **References**:
  - All new src/ modules from Tasks 3-11
  - Existing test files in test/ — study patterns for mock setup, assertion style
  - bun:test docs: `mock.module()`, `describe`, `test`, `expect`

  **Acceptance Criteria**:
  - [ ] All unit tests pass: `bun test` with Docker NOT running still passes unit tests
  - [ ] Old bwrap test files deleted or rewritten
  - [ ] Each new module has corresponding test coverage
  - [ ] Mocked tests don't depend on Docker daemon

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Unit tests pass without Docker daemon
    Tool: Bash
    Steps:
      1. Run: DOCKER_HOST=tcp://localhost:99999 bun test test/diff.test.ts test/config.test.ts
      2. Assert: tests pass (these don't need Docker)
    Expected Result: Pure unit tests work offline
    Evidence: .sisyphus/evidence/task-12-unit-tests.txt
  ```

  **Commit**: YES
  - Message: `test: rewrite test suite for Docker sandbox`
  - Files: test/*.test.ts (new and rewritten)

- [ ] 13. Integration tests with testcontainers

  **What to do**:
  - Create `test/integration-docker.test.ts` using `testcontainers` npm package:
    - Full pipeline test: plugin init → tool.execute.before → permission.ask → verify result
    - Test: clean echo command → auto-approved, exit code 0
    - Test: write outside project → violation detected, stays 'ask'
    - Test: network request (if observe mode) → HTTP captured in SandboxResult
    - Test: nesting (OC_SANDBOX=1) → empty hooks returned
    - Test: edit permission → path-based policy still works
  - Use testcontainers' `GenericContainer` for managing the Docker-in-Docker test environment
  - Each test should clean up after itself (testcontainers handles this via Ryuk)

  **Must NOT do**:
  - Do NOT skip cleanup (testcontainers handles this)
  - Do NOT hardcode Docker socket paths (testcontainers detects this)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Full integration tests with real Docker, complex setup/teardown, multiple scenarios
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 12)
  - **Blocks**: Task 14
  - **Blocked By**: Task 11

  **References**:
  - `src/index.ts` (Task 11) — Plugin being tested end-to-end
  - testcontainers npm docs: GenericContainer, StartedTestContainer, Network
  - `test/e2e-permission.test.ts` — Pattern for permission.ask testing (adapt for Docker)

  **Acceptance Criteria**:
  - [ ] `bun test test/integration-docker.test.ts` passes with Docker running
  - [ ] Clean command auto-approved
  - [ ] Violation command stays 'ask'
  - [ ] Nesting detected correctly
  - [ ] All containers cleaned up after tests

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Full integration test suite passes
    Tool: Bash (bun test)
    Preconditions: Docker daemon running, image built
    Steps:
      1. Run: bun test test/integration-docker.test.ts
      2. Assert: all tests pass
      3. Run: docker ps -f label=opencode-sandbox --format '{{.Names}}'
      4. Assert: no leftover containers (all cleaned up)
    Expected Result: All integration tests pass, no Docker resource leaks
    Evidence: .sisyphus/evidence/task-13-integration.txt
  ```

  **Commit**: YES
  - Message: `test: rewrite test suite for Docker sandbox`
  - Files: `test/integration-docker.test.ts`

- [ ] 14. Delete old files + update package.json + README

  **What to do**:
  - Delete C source files: `src/observe.c`, `src/tls.c`, `src/tls.h`, `src/ca_gen.c`
  - Delete bwrap-dependent TypeScript: `src/wrapper.ts`, `src/epilogue.ts`, `src/strace.ts`, `src/decode.ts`, `src/sandbox.ts`, `src/commit.ts`
  - Delete compiled binaries: `bin/oc-observe`, `bin/oc-epilogue`, `bin/ca-gen`, `bin/ca.pem`, `bin/ca.key`
  - Delete build script: `script/postinstall.ts`
  - Delete old test files that were replaced: `test/wrapper.test.ts`, `test/epilogue.test.ts`, `test/overlay.test.ts`, `test/observe.test.ts`, `test/degradation.test.ts`, `test/timeout-sweep.ts`
  - Delete protocol.ts and dns.ts if no longer used (check imports first)
  - Update `package.json`:
    - Confirm no `postinstall` script
    - Update `files` array if needed for distribution
  - Update `README.md`:
    - Remove all bwrap/strace/seccomp references
    - Update system requirements: Docker (or Docker Desktop) required
    - Update configuration docs (no timeout, new docker section)
    - Update "How It Works" section for Docker architecture
    - Update limitations section
  - Run `bun test` to verify nothing broke from deletions

  **Must NOT do**:
  - Do NOT delete files that are still imported by active modules (check imports first!)
  - Do NOT delete store.ts, policy.ts, config.ts, deps.ts (these were updated, not replaced)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: File deletion + doc updates, straightforward
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 5 (sequential, after all tests pass)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 12, 13

  **References**:
  - `src/` directory — Files to delete listed above
  - `bin/` directory — Binaries to delete
  - `script/` directory — postinstall.ts to delete
  - `test/` directory — Old test files to delete
  - `README.md` — Current docs to rewrite for Docker

  **Acceptance Criteria**:
  - [ ] `ls src/*.c src/*.h 2>/dev/null` returns nothing
  - [ ] `grep -rn 'bwrap\|strace\|seccomp' src/` returns nothing
  - [ ] `ls src/wrapper.ts src/epilogue.ts src/strace.ts src/decode.ts src/sandbox.ts src/commit.ts 2>/dev/null` returns nothing
  - [ ] `ls bin/oc-observe bin/oc-epilogue bin/ca-gen 2>/dev/null` returns nothing
  - [ ] `bun test` still passes (0 failures)
  - [ ] README mentions Docker, not bwrap

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Old files deleted, tests still pass
    Tool: Bash
    Steps:
      1. Run: ls src/*.c 2>&1
      2. Assert: 'No such file' or empty
      3. Run: grep -rn 'bwrap' src/ 2>&1
      4. Assert: no output
      5. Run: bun test
      6. Assert: 0 failures
    Expected Result: No C code, no bwrap refs, all tests pass
    Evidence: .sisyphus/evidence/task-14-cleanup.txt
  ```

  **Commit**: YES
  - Message: `chore: delete bwrap/strace/seccomp code and C files`
  - Files: deleted files, README.md, package.json
## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, docker commands, bun test). For each "Must NOT Have": search codebase for forbidden patterns (bwrap, strace, seccomp, CapDrop ALL, Tty: true) — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun test`. Review all new/changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify: `const` over `let`, no `else`, no unnecessary destructuring. Verify zero references to bwrap/strace/seccomp in src/.
  Output: `Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state (no pre-existing containers). Execute EVERY QA scenario from EVERY task. Test cross-task integration: container lifecycle + mitmproxy + filesystem diff working together. Test edge cases: Docker not running, empty project, large file operations. Test nesting: set OC_SANDBOX=1 and verify plugin passes through. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual implementation. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Verify ALL C files deleted. Verify ALL bwrap references removed. Verify SandboxResult type shape unchanged. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Old Files [DELETED/N remaining] | SandboxResult [UNCHANGED/CHANGED] | VERDICT`

---

## Commit Strategy

| After Task | Message | Files |
|-----------|---------|-------|
| 1 | `chore: add dockerode and testcontainers deps` | package.json |
| 6 | `feat(docker): foundation modules — client, image, config, deps, diff` | src/docker.ts, src/image.ts, src/config.ts, src/deps.ts, src/diff.ts, Dockerfile |
| 9 | `feat(docker): container lifecycle, mitmproxy sidecar, store migration` | src/container.ts, src/proxy.ts, src/store.ts, mitmproxy/addon.py |
| 11 | `feat(docker): plugin rewrite with Docker-based sandboxing` | src/index.ts, src/policy.ts |
| 13 | `test: rewrite test suite for Docker sandbox` | test/*.test.ts |
| 14 | `chore: delete bwrap/strace/seccomp code and C files` | deleted files, package.json, README.md |

Pre-commit for all: `bun test` must pass.

---

## Success Criteria

### Verification Commands
```bash
bun test                              # Expected: 0 failures
docker ps -f label=opencode-sandbox   # Expected: shows sandbox + mitmproxy containers when running
bun -e "import p from './src'; const h = await p({directory:'/tmp/test',worktree:'/tmp/test',serverUrl:new URL('http://localhost:0')}); console.log(Object.keys(h))"  # Expected: tool.execute.before, permission.ask, tool.execute.after, shell.env
grep -rn 'bwrap\|strace\|seccomp\|observe\.c\|tls\.c' src/  # Expected: no output
ls src/*.c src/*.h 2>/dev/null        # Expected: no such file
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass (0 failures)
- [ ] Docker containers created and cleaned up correctly
- [ ] mitmproxy sidecar intercepts HTTP/HTTPS
- [ ] No C code remains in src/
- [ ] No bwrap/strace/seccomp references in src/
- [ ] SandboxResult type unchanged
- [ ] Cross-platform: works on Linux + macOS (Docker Desktop)
