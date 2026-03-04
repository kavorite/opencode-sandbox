# Docker Sandbox — Decisions

## Architecture (All confirmed by user)
- SDK: dockerode v4.x (not docker CLI)
- Lifecycle: warm container per session, `docker exec` each command
- Network: mitmproxy sidecar, explicit HTTP_PROXY/HTTPS_PROXY env vars (NOT transparent iptables)
- Base image: Alpine minimal (~5MB) with git, ssh, curl, bash
- Project mount: Bind-mount project dir RW at same host path
- State: docker commit after approved commands, recreate on rejection
- Tests: testcontainers + mocked dockerode

## Critical Implementation Constraints
- Tty: false REQUIRED for demuxed stdout/stderr (Tty: true merges streams)
- Dual-strategy stream handling: listen for stream end AND poll exec.inspect() until Running === false
- CapDrop selective (NOT ALL): drop NET_RAW, SYS_ADMIN, SYS_PTRACE, SYS_MODULE, SYS_BOOT, MAC_ADMIN, AUDIT_WRITE — keep CHOWN, DAC_OVERRIDE, SETGID, SETUID, FOWNER
- Label ALL Docker resources: { 'opencode-sandbox': 'true', 'opencode-sandbox.session': sessionId }
- Process exit handlers: process.on('exit'), process.on('SIGTERM'), process.on('SIGINT') → teardown
- OC_SANDBOX=1 detection: skip container creation (already inside sandbox)

## Type Preservation
SandboxResult type in store.ts MUST NOT CHANGE shape.
FileOpen, FileWrite, FsMutation, NetConnect, NetSocket must keep exact same fields.
diff.ts CAN EXTEND FsMutation.syscall to include 'creat' — the union type will be widened but not broken.
