# Docker Sandbox — Learnings

## 2026-03-03 Session: Codebase Baseline

### Current Source Files
- src/config.ts (75 lines) — Zod schema. Exports: TIMEOUT, schema, SandboxConfig, defaults, load, deepMerge
- src/deps.ts (103 lines) — Checks bwrap/strace/overlay, has `check()` and `reset()`
- src/store.ts (71 lines) — IMPORTS types from strace.ts (line 1). Exports: DnsQuery, Violation, HttpRequest, TlsInfo, SshInfo, SandboxResult, set/get/clear
- src/policy.ts (132 lines) — Imports from store and config. Contains EPHEMERAL list, SANDBOX_INFRA list, writable(), evaluate()
- src/strace.ts (397 lines) — All the types: FileOpen, FileWrite, FsMutation, NetConnect, NetSocket. Also heavy parsing logic.
- src/index.ts — Plugin entry point (REWRITE target)
- Also: wrapper.ts, epilogue.ts, decode.ts, sandbox.ts, commit.ts, protocol.ts, dns.ts — all to be deleted

### package.json Current State
- Has `postinstall` script → remove
- Missing: dockerode, @types/dockerode (deps) and testcontainers (devDeps)
- Keep: @opencode-ai/plugin, zod

### Critical Type Facts
Types defined in strace.ts that store.ts imports (and must be preserved with EXACT same shape):
- FileOpen: { kind: "file_open", syscall: "openat"|"open"|"creat", path: string, flags: string, result: number }
- FileWrite: { kind: "file_write", syscall: "write"|"writev"|"pwrite64", fd: number, bytes: number, result: number }
- FsMutation: { kind: "fs_mutation", syscall: "unlink"|"rename"|"mkdir"|"rmdir", path: string, result: number }
- NetConnect: { kind: "net_connect", syscall: "connect", family: "AF_INET"|"AF_INET6"|"AF_UNIX", addr: string, port: number, protocol?: string, result: number }
- NetSocket: { kind: "net_socket", syscall: "socket"|"bind"|"sendto", family: string, type: string, buffer?: string, addr?: string, port?: number }

NOTE: diff.ts will also need `FsMutation` with syscall extended to include "creat" (for added files).
The plan says Kind 1 (added) → FsMutation with syscall: 'mkdir' (dir) or 'creat' (file).
"creat" is NOT in the original FsMutation type! This is a new value that diff.ts must add.

### Policy.ts SANDBOX_INFRA to Clean Up
Current: `/newroot`, `/etc/ssl`, `/etc/pki` — these were bwrap CA injection paths
Remove: `/newroot` (bwrap-specific)
Keep or adjust: `/etc/ssl`, `/etc/pki` — Docker doesn't need these, safe to remove

### config.ts Changes Needed
- REMOVE: TIMEOUT const (line 5), timeout field (line 8), home_readable field (line 25), strace_bufsize field (line 27)
- ADD: docker object: { image: z.string().optional() } with default `opencode-sandbox:local`
- UPDATE: defaults const (line 32) to remove timeout, add docker
- KEEP: load(), deepMerge(), all network and filesystem fields, schema export

### deps.ts Complete Rewrite
Old interface had: bwrap, strace, observe, overlay, available
New interface should have: available, docker, error?
Use dockerode `docker.ping()` — returns 'OK' when daemon running
Remove all bwrap/strace/overlay checks, remove `reset()` function (or keep if needed)
