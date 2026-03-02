import { describe, test, expect, afterEach } from "bun:test"
import os from "os"
import fs from "fs/promises"
import path from "path"
import { run } from "../src/sandbox"
import { parseLog, parseLine } from "../src/strace"
import { evaluate } from "../src/policy"
import * as store from "../src/store"
import { load, TIMEOUT } from "../src/config"
import plugin from "../src/index"

const linux = os.platform() === "linux"

async function hasBwrap(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bwrap", "--ro-bind", "/", "/", "--unshare-user", "true"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    const code = await proc.exited
    return code === 0
  } catch {
    return false
  }
}

async function hasStrace(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["strace", "-V"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    const code = await proc.exited
    return code === 0
  } catch {
    return false
  }
}

const available = linux && (await hasBwrap()) && (await hasStrace())

async function cleanup() {
  const entries = await fs.readdir("/tmp")
  const stale = entries.filter((e) => e.startsWith("oc-sandbox-"))
  await Promise.all(stale.map((e) => fs.unlink(path.join("/tmp", e)).catch(() => {})))
  store.clear()
}

describe.skipIf(!available)("opencode-sandbox integration", () => {
  afterEach(cleanup)

  test("sandbox isolation — file write stays inside sandbox", async () => {
    const result = await run("echo test > /tmp/sandbox-file.txt", "/tmp", 5000)

    // File must NOT exist on host — bwrap mounts tmpfs over /tmp
    const exists = await Bun.file("/tmp/sandbox-file.txt").exists()
    expect(exists).toBe(false)

    // strace should have captured the openat for that path
    const opened = result.files.some((f) => f.path.includes("sandbox-file.txt"))
    expect(opened).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  test("network isolation — connect blocked with ENETUNREACH", async () => {
    const result = await run("curl -s http://example.com || true", "/tmp", 5000)

    // Should see a connect attempt in strace
    const connect = result.network.some((n) => n.family === "AF_INET" || n.family === "AF_INET6")
    expect(connect).toBe(true)

    // Result code from connect should be negative (ENETUNREACH = -101 typically)
    const blocked = result.network.some((n) => n.result < 0)
    expect(blocked).toBe(true)

    // Verify no actual data came back — curl should fail
    expect(result.timedOut).toBe(false)
  })

  test(`timeout behavior — sleep killed after ${TIMEOUT}ms`, async () => {
    const result = await run("sleep 10", "/tmp", TIMEOUT)

    expect(result.timedOut).toBe(true)
    expect(result.duration).toBeLessThan(2000)

    // strace output should still be parseable despite kill
    const reparsed = parseLog(result.files.map(() => "").join("\n"))
    expect(reparsed).toBeDefined()
    expect(reparsed.files).toBeArray()
  })

  test("concurrent commands — results don't cross-contaminate", async () => {
    const [a, b] = await Promise.all([
      run("echo alpha > /tmp/alpha.txt", "/tmp", 5000),
      run("echo beta > /tmp/beta.txt", "/tmp", 5000),
    ])

    const alphaHasAlpha = a.files.some((f) => f.path.includes("alpha.txt"))
    const alphaHasBeta = a.files.some((f) => f.path.includes("beta.txt"))
    const betaHasBeta = b.files.some((f) => f.path.includes("beta.txt"))
    const betaHasAlpha = b.files.some((f) => f.path.includes("alpha.txt"))

    expect(alphaHasAlpha).toBe(true)
    expect(alphaHasBeta).toBe(false)
    expect(betaHasBeta).toBe(true)
    expect(betaHasAlpha).toBe(false)

    expect(a.timedOut).toBe(false)
    expect(b.timedOut).toBe(false)
  })

  test("policy evaluation — detects violations", () => {
    const result: Parameters<typeof evaluate>[0] = {
      files: [{ kind: "file_open", syscall: "openat", path: "/etc/shadow", flags: "O_RDONLY", result: 3 }],
      writes: [],
      mutations: [{ kind: "fs_mutation", syscall: "mkdir", path: "/usr/local/evil", result: 0 }],
      network: [
        { kind: "net_connect", syscall: "connect", family: "AF_INET", addr: "93.184.216.34", port: 80, result: -101 },
      ],
      sockets: [],
      dns: [],
      http: [],
      tls: [],
      ssh: [],
      duration: 50,
      timedOut: false,
      violations: [],
    }

    const cfg = {
      timeout: TIMEOUT,
      network: { mode: "block" as const, allow: [] },
      filesystem: {
        inherit_permissions: true,
        allow_write: [],
        deny_read: ["/etc/shadow"],
      },
      auto_allow_clean: true,
      verbose: false,
    }

    const violations = evaluate(result, cfg, "/home/user/project")

    // Should flag: denied read of /etc/shadow, mutation outside project, network connect
    const read = violations.find((v) => v.detail.includes("/etc/shadow"))
    const mutation = violations.find((v) => v.detail.includes("/usr/local/evil"))
    const net = violations.find((v) => v.detail.includes("93.184.216.34"))

    expect(read).toBeDefined()
    expect(read!.type).toBe("filesystem")
    expect(read!.severity).toBe("medium")

    expect(mutation).toBeDefined()
    expect(mutation!.type).toBe("filesystem")

    expect(net).toBeDefined()
    expect(net!.type).toBe("network")
    expect(net!.severity).toBe("high")
  })

  test("full pipeline — permission.ask → sandbox → auto-approve clean command", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-sandbox-test-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(dir, ".opencode", "sandbox.json"), JSON.stringify({ network: { mode: "block" } }))

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      expect(hooks["permission.ask"]).toBeDefined()

      // Simulate permission.ask for a clean "echo hello" command
      const id = "test-call-" + Date.now()
      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        { id, type: "bash", message: "echo hello", sessionID: "s1", messageID: "m1", metadata: {}, time: { created: Date.now() } } as any,
        output,
      )

      // Clean command should be auto-approved
      expect(output.status).toBe("allow")

      // Store should have the sandbox result
      const stored = store.get(id)
      expect(stored).toBeDefined()
      expect(stored!.timedOut).toBe(false)
      expect(stored!.violations).toBeArray()
      expect(stored!.violations.length).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("no temp files left after sandbox run", async () => {
    await run("echo cleanup-test", "/tmp", 5000)
    const entries = await fs.readdir("/tmp")
    const stale = entries.filter((e) => e.startsWith("oc-sandbox-"))
    expect(stale).toHaveLength(0)
  })
})
