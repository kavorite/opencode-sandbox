# Docker Sandbox — Issues

## Known dockerode Issues
1. `exec.start()` stream `end` event may not fire — use DUAL STRATEGY: listen for end AND poll exec.inspect() until Running === false
2. `container.changes()` does NOT track bind-mounted paths (project dir) — this is DESIRED behavior
3. `docker commit` does NOT capture volumes/bind-mounts — project writes already on host, rollback only affects overlay (out-of-project writes)

## Environment Notes
- Docker v28.5.1 running on host
- bwrap sandbox is active (opencode runs inside bwrap with NoNewPrivs=1)
- Dispatched subagents via mcp_task run outside the bwrap sandbox restrictions

## Potential Conflicts
- diff.ts defines FsMutation with syscall: 'creat' (new value for added files)
- strace.ts defines FsMutation with syscall: "unlink"|"rename"|"mkdir"|"rmdir" (no 'creat')
- Resolution: diff.ts should define its own FsMutation type with extended syscall union
- store.ts should import FsMutation from diff.ts (not strace.ts) as part of Task 9
