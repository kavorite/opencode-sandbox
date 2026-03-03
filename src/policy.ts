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
  // In proxy mode (allow_methods configured), raw network connects are handled by
  // the TLS MITM proxy — don't flag them as violations
  const proxy = config.network.allow_methods && config.network.allow_methods.length > 0
  const inet = proxy ? [] : result.network
    .filter((n) => n.family === "AF_INET" || n.family === "AF_INET6")
    .filter((n) => !config.network.allow.includes(n.addr))
    .map(
      (n): Violation => ({
        type: "network",
        syscall: "connect",
        detail: `Connection to ${n.addr}:${n.port}`,
        severity: "high",
      }),
    )

  const unix = proxy ? [] : result.network
    .filter((n) => n.family === "AF_UNIX")
    .map(
      (n): Violation => ({
        type: "unix_socket",
        syscall: "connect",
        detail: `Unix socket: ${n.addr}`,
        severity: "low",
      }),
    )

  const methods = !config.network.allow_methods || config.network.allow_methods.length === 0
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
        ...result.tls
          .map(
            (t): Violation => ({
              type: "network",
              syscall: "connect",
              detail: `Non-HTTP TLS to ${t.sni} blocked`,
              severity: "high",
            }),
          ),
      ]

  const ssh = !proxy
    ? []
    : result.ssh
        .filter((s) => s.cmd !== "git-upload-pack")
        .map(
          (s): Violation => ({
            type: "network",
            syscall: "connect",
            detail: s.cmd
              ? `SSH ${s.cmd} to ${s.repo || s.addr}`
              : `SSH connection to ${s.addr}:${s.port}`,
            severity: "high",
          }),
        )

  return [...reads, ...mutations, ...inet, ...unix, ...methods, ...ssh]
}
