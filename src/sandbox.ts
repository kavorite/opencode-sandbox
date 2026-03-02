import path from "path"
import { unlink } from "fs/promises"
import { parseLog } from "./strace"
import { parseHTTP, parseTLS } from "./protocol"
import { parseDNS } from "./dns"
import type { SandboxResult, HttpRequest, TlsInfo, DnsQuery, SshInfo } from "./store"
import type { SandboxConfig } from "./config"

const home = process.env.HOME || "/root"
let warned = false

function json(text: string): { type: string; addr: string; port: number; data?: string; method?: string; path?: string; host?: string; forwarded?: boolean; cmd?: string; repo?: string } | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function run(
  command: string,
  cwd: string,
  config: SandboxConfig | number,
  deps?: { observe: boolean; overlay: boolean },
): Promise<SandboxResult> {
  // Normalize legacy call signature: run(cmd, cwd, timeout)
  if (typeof config === "number") {
    return run(command, cwd, {
      timeout: config,
      network: { mode: "block" as const, allow: [] },
      filesystem: { inherit_permissions: true, allow_write: [], deny_read: [] },
      auto_allow_clean: true,
      home_readable: true,
      verbose: false,
    }, { observe: false, overlay: false })
  }

  const logfile = `/tmp/oc-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}.log`
  const start = performance.now()

  const observe = config.network.mode === "observe" && (deps?.observe ?? false)
  const overlay = deps?.overlay ?? false
  const proxy = observe && config.network.allow_methods !== undefined

  if (config.network.mode === "observe" && !(deps?.observe ?? false) && !warned) {
    console.warn("opencode-sandbox: oc-observe binary not found, falling back to block mode")
    warned = true
  }

  const strace = observe ? (Bun.which("strace") ?? "strace") : "strace"
  const bwrap = observe ? (Bun.which("bwrap") ?? "bwrap") : "bwrap"
  const bash = observe ? (Bun.which("bash") ?? "bash") : "bash"
  const bindir = path.join(import.meta.dir, "..", "bin")

  if (proxy) {
    if (!await Bun.file(path.join(bindir, "ca.pem")).exists() || !await Bun.file(path.join(bindir, "ca.key")).exists()) {
      await Bun.spawn([path.join(bindir, "ca-gen"), bindir]).exited
    }
  }

  let bundle = ""
  const binds: string[] = []
  if (proxy) {
    const ca = await Bun.file(path.join(bindir, "ca.pem")).text()
    let system = ""
    const targets = [
      "/etc/ssl/certs/ca-certificates.crt",
      "/etc/ssl/cert.pem",
      "/etc/pki/tls/certs/ca-bundle.crt",
      "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    ]
    for (const p of targets) {
      if (!await Bun.file(p).exists()) continue
      if (!system) system = await Bun.file(p).text()
    }
    bundle = `/tmp/oc-mitm-bundle-${process.pid}.pem`
    await Bun.write(bundle, system ? system + "\n" + ca : ca)
    for (const p of targets) {
      if (!await Bun.file(p).exists()) continue
      binds.push("--ro-bind", bundle, p)
    }
  }

  const args = [
    ...(observe ? [
      path.join(bindir, "oc-observe"),
      ...(proxy ? ["--proxy", path.join(bindir, "ca.pem"), path.join(bindir, "ca.key")] : []),
    ] : []),
    strace,
    "-f",
    "-e",
    "trace=openat,open,creat,write,writev,pwrite64,unlink,rename,mkdir,rmdir,connect,socket,bind,sendto",
    "-s",
    observe ? String(config.strace_bufsize ?? 16384) : "4096",
    "-o",
    logfile,
    bwrap,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...(config.home_readable
      ? (overlay ? ["--overlay-src", home, "--tmp-overlay", home] : ["--ro-bind", home, home])
      : ["--tmpfs", home]),
    "--tmpfs",
    "/dev/shm",
    "--tmpfs",
    "/run",
    // When home is tmpfs, re-mount project dir and git worktree dirs
    ...(!config.home_readable && cwd.startsWith(home)
      ? (overlay ? ["--overlay-src", cwd, "--tmp-overlay", cwd] : ["--ro-bind", cwd, cwd])
      : []),
    ...(config.home_readable && !cwd.startsWith(home) && overlay && !cwd.startsWith("/tmp") && !cwd.startsWith("/dev") && !cwd.startsWith("/run")
      ? ["--overlay-src", cwd, "--tmp-overlay", cwd]
      : []),
    ...(proxy ? [
      ...binds,
      "--ro-bind", path.join(bindir, "ca.pem"), "/tmp/mitm-ca.pem",
      "--setenv", "SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt",
      "--setenv", "CURL_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt",
      "--setenv", "REQUESTS_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt",
      "--setenv", "NODE_EXTRA_CA_CERTS", "/tmp/mitm-ca.pem",
    ] : []),
    // SSH: when home is tmpfs, re-mount ~/.ssh so git can authenticate.
    // GIT_SSH_COMMAND bypasses system ssh_config (broken perms in user namespace).
    ...(!config.home_readable && observe ? ["--ro-bind", path.join(home, ".ssh"), path.join(home, ".ssh")] : []),
    ...(observe ? ["--setenv", "GIT_SSH_COMMAND", "ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"] : []),
    ...(observe ? [] : ["--unshare-net"]),
    "--unshare-pid",
    "--proc",
    "/proc",
    "--die-with-parent",
    "--",
    // Safe: Bun.spawn with array args passes each element as a separate
    // argv entry — no shell interpolation of `command` occurs here.
    bash,
    "-c",
    command,
  ]

  let proc: ReturnType<typeof Bun.spawn> | undefined
  try {
    proc = Bun.spawn(args, {
      cwd,
      stdio: ["ignore", observe ? "pipe" : "ignore", "ignore"],
      ...(proxy ? { env: { ...process.env, OC_ALLOW_METHODS: config.network.allow_methods!.join(",") } } : {}),
    })
  } catch {
    if (bundle) {
      try { await unlink(bundle) } catch {}
    }
    return {
      files: [],
      writes: [],
      mutations: [],
      network: [],
      sockets: [],
      dns: [],
      http: [],
      tls: [],
      ssh: [],
      duration: performance.now() - start,
      timedOut: false,
      violations: [],
    }
  }

  let timedOut = false
  // Collect supervisor stdout lines concurrently. Store reader so we can cancel
  // it on timeout (Bun ReadableStream hangs if not cancelled after process kill).
  const lines: string[] = []
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let collectDone = false
  if (!observe || !proc.stdout || typeof proc.stdout === "number") {
    collectDone = true
  } else {
    reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ""
    const collect = async () => {
      try {
        while (true) {
          const chunk = await reader!.read()
          if (chunk.done) break
          buf += dec.decode(chunk.value, { stream: true })
          const parts = buf.split("\n")
          buf = parts.pop() ?? ""
          lines.push(...parts)
        }
        if (buf) lines.push(buf)
      } catch {
        // stream cancelled or process killed
      } finally {
        collectDone = true
      }
    }
    collect()
  }
  try {
    const result = await Promise.race([
      proc.exited.then(() => ({ timedOut: false }) as const),
      new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), observe ? Math.max(config.timeout, 500) : config.timeout)),
    ])
    timedOut = result.timedOut

    if (timedOut) {
      try {
        proc.kill(9)
      } catch {}
      // Cancel the reader to unblock the collect() loop
      try {
        reader?.cancel()
      } catch {}
    }

    // Wait for process to actually exit before reading the strace log,
    // otherwise strace may not have flushed all output yet.
    await proc.exited.catch(() => {})

    // Give stdout collector a brief window to flush remaining data
    if (!collectDone) await new Promise<void>((r) => setTimeout(r, 100))

    const duration = performance.now() - start
    const content = await Bun.file(logfile)
      .text()
      .catch(() => "")

    const parsed = parseLog(content)

    // Parse supervisor stdout for observe mode
    const http: HttpRequest[] = []
    const tls: TlsInfo[] = []
    const dns: DnsQuery[] = []
    const ssh: SshInfo[] = []

    if (observe) {
      for (const line of lines) {
        if (!line.trim()) continue
        const msg = json(line)
        if (!msg) continue

        if (msg.type === "http" && msg.method && msg.path) {
          http.push({ method: msg.method, path: msg.path, host: msg.host, addr: msg.addr, port: msg.port, forwarded: msg.forwarded })
          continue
        }

        if (msg.type === "ssh") {
          ssh.push({ cmd: msg.cmd ?? "", repo: msg.repo ?? "", addr: msg.addr, port: msg.port })
          continue
        }

        if (msg.type === "dns_connect") {
          dns.push({ qname: "", qtype: "", resolver: msg.addr })
          continue
        }

        if (!msg.data) continue
        const buf = new Uint8Array(Buffer.from(msg.data, "base64"))

        if (msg.type === "connect") {
          if (msg.port === 53) {
            const d = parseDNS(buf)
            if (d) {
              dns.push({ qname: d.qname, qtype: d.qtype, resolver: msg.addr })
              continue
            }
          }
          const h = parseHTTP(buf)
          if (h) {
            http.push({ method: h.method, path: h.path, host: h.host, addr: msg.addr, port: msg.port })
            continue
          }
          const t = parseTLS(buf)
          if (t) {
            tls.push({ sni: t.sni, addr: msg.addr, port: msg.port })
            continue
          }
        }

        if (msg.type === "dns") {
          const d = parseDNS(buf)
          if (d) {
            dns.push({ qname: d.qname, qtype: d.qtype, resolver: msg.addr })
            continue
          }
        }

      }
    }

    return {
      ...parsed,
      // Filter bwrap overlayfs internal dirs (relative paths like tmp-overlay-upper-0)
      mutations: parsed.mutations.filter(m => m.path.startsWith("/")),
      dns: observe ? dns : parsed.dns,
      http,
      tls,
      ssh: observe ? ssh : [],
      duration,
      timedOut,
      violations: [],
    }
  } finally {
    try {
      await unlink(logfile)
    } catch {}
    if (bundle) {
      try {
        await unlink(bundle)
      } catch {}
    }
  }
}
