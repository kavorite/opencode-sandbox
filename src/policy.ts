import path from "path"
import type { Violation, SandboxResult } from "./store"
import type { SandboxConfig } from "./config"

const home = process.env.HOME || "/root"

// Paths safe to mutate inside the COW sandbox — writes are discarded on exit.
// Virtual filesystems are kernel interfaces; user-state dirs are caches/stores
// that build tools (pnpm, npm, bun) routinely touch.
const EPHEMERAL = [
  "/tmp", "/dev", "/sys", "/proc", "/run",
  `${home}/.cache`, `${home}/.local`, `${home}/.config`,
  `${home}/.npm`, `${home}/.bun`, `${home}/.pnpm-store`,
]
// Paths used by the sandbox's own CA injection — not user-initiated writes
const SANDBOX_INFRA = ["/etc/ssl", "/etc/pki"]

export function writable(target: string, root: string, allow: string[]): boolean {
  if (target === root || target.startsWith(root + "/")) return true
  if (EPHEMERAL.some((p) => target === p || target.startsWith(p + "/"))) return true
  if (SANDBOX_INFRA.some((p) => target === p || target.startsWith(p + "/"))) return true
  if (
    allow.some((p) => {
      const resolved = path.resolve(p)
      return target === resolved || target.startsWith(resolved + "/")
    })
  )
    return true
  return false
}

function denied(target: string, deny: string[]): boolean {
  return deny.some((p) => {
    const resolved = path.resolve(p)
    return target === resolved || target.startsWith(resolved + "/")
  })
}

export function evaluate(result: SandboxResult, config: SandboxConfig, project: string): Violation[] {
  const root = path.resolve(project)

  const reads = result.files
    .filter((f) => denied(path.resolve(f.path), config.filesystem.deny_read))
    .map(
      (f): Violation => ({
        type: "filesystem",
        syscall: "open",
        detail: `Read of denied path ${f.path}`,
        severity: "medium",
      }),
    )

  // FileWrite only has fd (no path) — skip write checks (need fd-to-path mapping)

  const mutations = result.mutations
    .filter((m) => !writable(path.resolve(m.path), root, config.filesystem.allow_write))
    .map(
      (m): Violation => ({
        type: "filesystem",
        syscall: m.syscall,
        detail: `Write to ${m.path} (outside project)`,
        severity: "medium",
      }),
    )

  // In observe mode, flag HTTP methods not in the allow list
  const methods = !config.network.observe || !config.network.allow_methods || config.network.allow_methods.length === 0
    ? []
    : [
        ...result.http
          .filter((h) => !config.network.allow_methods!.includes(h.method))
          .filter((h) => !(config.network.allow_graphql_queries && h.method === "POST" && h.path.toLowerCase().includes("graphql")))
          .map(
            (h): Violation => ({
              type: "network",
              syscall: "connect",
              detail: `HTTP ${h.method} to ${h.host}${h.path} not in allow list`,
              severity: "high",
            }),
          ),
      ]

  // SSH push detection — git-receive-pack means the command is pushing to a remote.
  // git-upload-pack is fetch/clone (safe, read-only from remote's perspective).
  const sshPushes = result.ssh
    .filter((s) => s.cmd === 'git-receive-pack')
    .map(
      (s): Violation => ({
        type: 'network',
        syscall: 'connect',
        detail: `git push to ${s.repo ? `${s.addr}:${s.repo}` : s.addr}`,
        severity: 'high',
      }),
    )

  return [...reads, ...mutations, ...methods, ...sshPushes]
}
