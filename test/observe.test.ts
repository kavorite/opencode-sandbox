import { describe, test, expect, afterEach } from "bun:test"
import os from "os"
import fs from "fs/promises"
import path from "path"
import { run } from "../src/sandbox"
import * as store from "../src/store"
import type { SandboxConfig } from "../src/config"

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

const observeBin = path.join(import.meta.dir, "..", "bin", "oc-observe")
const hasObserve = await Bun.file(observeBin).exists()
const available = linux && (await hasBwrap()) && (await hasStrace())

async function cleanup() {
  const entries = await fs.readdir("/tmp")
  const stale = entries.filter((e) => e.startsWith("oc-sandbox-"))
  await Promise.all(stale.map((e) => fs.unlink(path.join("/tmp", e)).catch(() => {})))
  store.clear()
}

const cfg: SandboxConfig = {
  timeout: 5000,
  network: { mode: "observe", allow: [] },
  filesystem: { inherit_permissions: true, allow_write: [], deny_read: [] },
  auto_allow_clean: true,
  verbose: false,
}

describe.skipIf(!available || !hasObserve)("observe mode", () => {
  afterEach(cleanup)

  test("HTTP request captured — direct IP connect → result.http has GET entry", async () => {
    // Use direct IP to bypass DNS (DNS resolution fails in sandbox network namespace).
    // The supervisor intercepts connect() and injects a socketpair; bash sends the HTTP
    // request into the socketpair which the supervisor reads and emits as JSON.
    const result = await run(
      "exec 3<>/dev/tcp/93.184.216.34/80; printf 'GET / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n' >&3 || true",
      "/tmp",
      cfg,
      { observe: true },
    )

    expect(result.http).toBeArray()
    expect(result.http.length).toBeGreaterThanOrEqual(1)

    const get = result.http.find((h) => h.method === "GET")
    expect(get).toBeDefined()
    expect(get!.method).toBe("GET")
  })

  test("DNS activity captured — curl triggers DNS → result.dns has entry", async () => {
    // curl http://example.com triggers DNS resolution; the supervisor captures
    // the DNS connect as a dns_connect JSON event (resolver IP).
    const result = await run("curl -s http://example.com || true", "/tmp", cfg, { observe: true })

    expect(result.dns).toBeArray()
    expect(result.dns.length).toBeGreaterThanOrEqual(1)

    // dns_connect events have resolver but no qname; dns events have both
    const entry = result.dns[0]
    expect(entry).toBeDefined()
    expect(entry.resolver).toBeTruthy()
  })
})

describe.skipIf(!available)("observe mode fallback", () => {
  afterEach(cleanup)

  test("observe mode with binary missing → falls back to block, no crash, http/tls empty", async () => {
    const result = await run("curl -s http://example.com || true", "/tmp", cfg, { observe: false })

    // Should not crash — result must be a valid SandboxResult
    expect(result).toBeDefined()
    expect(result.timedOut).toBe(false)

    // http and tls must be empty arrays (no supervisor output)
    expect(result.http).toBeArray()
    expect(result.http).toHaveLength(0)
    expect(result.tls).toBeArray()
    expect(result.tls).toHaveLength(0)
  })
})

describe.skipIf(!available || !hasObserve)("observe mode timeout", () => {
  afterEach(cleanup)

  test("timeout cleans up supervisor — no zombie processes, no stale /tmp files", async () => {
    const shortCfg: SandboxConfig = {
      ...cfg,
      timeout: 500,
    }

    const result = await run("sleep 10", "/tmp", shortCfg, { observe: true })

    expect(result.timedOut).toBe(true)
    expect(result.duration).toBeLessThan(3000)

    // No stale /tmp/oc-sandbox-* files should remain after cleanup
    const entries = await fs.readdir("/tmp")
    const stale = entries.filter((e) => e.startsWith("oc-sandbox-"))
    expect(stale).toHaveLength(0)
  })
})

describe.skipIf(!available || !hasObserve)("observe mode concurrent", () => {
  afterEach(cleanup)

  test("concurrent observe runs — results don't cross-contaminate", async () => {
    const [a, b] = await Promise.all([
      run("exec 3<>/dev/tcp/93.184.216.34/80; printf 'GET /a HTTP/1.0\r\n\r\n' >&3 || true", "/tmp", cfg, { observe: true }),
      run("exec 3<>/dev/tcp/93.184.216.34/80; printf 'GET /b HTTP/1.0\r\n\r\n' >&3 || true", "/tmp", cfg, { observe: true }),
    ])

    // Each result should only contain its own HTTP request
    const aHasA = a.http.some((h) => h.path === "/a")
    const aHasB = a.http.some((h) => h.path === "/b")
    const bHasB = b.http.some((h) => h.path === "/b")
    const bHasA = b.http.some((h) => h.path === "/a")

    expect(aHasA).toBe(true)
    expect(aHasB).toBe(false)
    expect(bHasB).toBe(true)
    expect(bHasA).toBe(false)
  })
})
