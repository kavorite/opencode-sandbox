import { describe, test, expect } from "bun:test"
import { schema, TIMEOUT } from "../src/config"
import { evaluate } from "../src/policy"
import type { SandboxResult } from "../src/store"
import type { SandboxConfig } from "../src/config"

function empty(): SandboxResult {
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
    duration: 50,
    timedOut: false,
    violations: [],
  }
}

const project = "/home/user/project"

const cfg: SandboxConfig = {
  timeout: TIMEOUT,
  network: { mode: "observe", allow: [], allow_methods: ["GET"] },
  filesystem: { inherit_permissions: true, allow_write: [], deny_read: [] },
  auto_allow_clean: true,
  verbose: false,
}

describe("proxy config — allow_methods", () => {
  test("allow_methods is optional — backward compat", () => {
    const result = schema.parse({})
    expect(result.network.allow_methods).toBeUndefined()
  })

  test("allow_methods accepts string array", () => {
    const result = schema.parse({ network: { allow_methods: ["GET"] } })
    expect(result.network.allow_methods).toEqual(["GET"])
  })

  test("allow_methods accepts empty array", () => {
    const result = schema.parse({ network: { allow_methods: [] } })
    expect(result.network.allow_methods).toEqual([])
  })

  test("allow_methods accepts multiple methods", () => {
    const result = schema.parse({ network: { allow_methods: ["GET", "POST", "HEAD"] } })
    expect(result.network.allow_methods).toEqual(["GET", "POST", "HEAD"])
  })

  test("proxy mode — observe + allow_methods triggers proxy", () => {
    const result = schema.parse({ network: { mode: "observe", allow_methods: ["GET"] } })
    const observe = result.network.mode === "observe"
    const proxy = observe && result.network.allow_methods !== undefined
    expect(proxy).toBe(true)
  })

  test("proxy mode — observe without allow_methods is not proxy", () => {
    const result = schema.parse({ network: { mode: "observe" } })
    const observe = result.network.mode === "observe"
    const proxy = observe && result.network.allow_methods !== undefined
    expect(proxy).toBe(false)
  })

  test("proxy mode — block + allow_methods is not proxy", () => {
    const result = schema.parse({ network: { mode: "block", allow_methods: ["GET"] } })
    const observe = result.network.mode === "observe"
    const proxy = observe && result.network.allow_methods !== undefined
    expect(proxy).toBe(false)
  })
})

describe("proxy policy — method violations", () => {
  test("POST with allow_methods=[GET] → violation", () => {
    const r = empty()
    r.http = [{ method: "POST", path: "/api/data", host: "example.com", addr: "93.184.216.34", port: 80 }]

    const violations = evaluate(r, cfg, project)
    const hit = violations.find((v) => v.detail.includes("POST"))
    expect(hit).toBeDefined()
    expect(hit!.type).toBe("network")
    expect(hit!.severity).toBe("high")
    expect(hit!.detail).toContain("not in allow list")
  })

  test("GET with allow_methods=[GET] → no violation", () => {
    const r = empty()
    r.http = [{ method: "GET", path: "/", host: "example.com", addr: "93.184.216.34", port: 80 }]

    const violations = evaluate(r, cfg, project)
    const hit = violations.find((v) => v.detail.includes("not in allow list"))
    expect(hit).toBeUndefined()
  })

  test("POST with no allow_methods → no violation", () => {
    const loose: SandboxConfig = {
      ...cfg,
      network: { mode: "observe", allow: [] },
    }
    const r = empty()
    r.http = [{ method: "POST", path: "/api/data", host: "example.com", addr: "93.184.216.34", port: 80 }]

    const violations = evaluate(r, loose, project)
    const hit = violations.find((v) => v.detail.includes("not in allow list"))
    expect(hit).toBeUndefined()
  })

  test("TLS entries flagged when allow_methods is set", () => {
    const r = empty()
    r.tls = [{ sni: "api.github.com", addr: "140.82.121.5", port: 443 }]

    const violations = evaluate(r, cfg, project)
    const hit = violations.find((v) => v.detail.includes("Non-HTTP TLS"))
    expect(hit).toBeDefined()
    expect(hit!.type).toBe("network")
    expect(hit!.severity).toBe("high")
    expect(hit!.detail).toContain("api.github.com")
  })

  test("TLS entries not flagged without allow_methods", () => {
    const loose: SandboxConfig = {
      ...cfg,
      network: { mode: "observe", allow: [] },
    }
    const r = empty()
    r.tls = [{ sni: "api.github.com", addr: "140.82.121.5", port: 443 }]

    const violations = evaluate(r, loose, project)
    const hit = violations.find((v) => v.detail.includes("Non-HTTP TLS"))
    expect(hit).toBeUndefined()
  })

  test("multiple methods — HEAD allowed, DELETE blocked", () => {
    const multi: SandboxConfig = {
      ...cfg,
      network: { mode: "observe", allow: [], allow_methods: ["GET", "HEAD"] },
    }
    const r = empty()
    r.http = [
      { method: "HEAD", path: "/", host: "example.com", addr: "93.184.216.34", port: 80 },
      { method: "DELETE", path: "/api/item", host: "example.com", addr: "93.184.216.34", port: 80 },
    ]

    const violations = evaluate(r, multi, project)
    const head = violations.find((v) => v.detail.includes("HEAD"))
    expect(head).toBeUndefined()
    const del = violations.find((v) => v.detail.includes("DELETE"))
    expect(del).toBeDefined()
    expect(del!.severity).toBe("high")
  })

  test("empty allow_methods — treated as unset, no violations", () => {
    const none: SandboxConfig = {
      ...cfg,
      network: { mode: "observe", allow: [], allow_methods: [] },
    }
    const r = empty()
    r.http = [{ method: "POST", path: "/api/data", host: "example.com", addr: "93.184.216.34", port: 80 }]

    const violations = evaluate(r, none, project)
    const hit = violations.find((v) => v.detail.includes("not in allow list"))
    expect(hit).toBeUndefined()
  })

  test("forwarded HTTP request still evaluated", () => {
    const r = empty()
    r.http = [{ method: "PUT", path: "/upload", host: "cdn.example.com", addr: "10.0.0.1", port: 443, forwarded: true }]

    const violations = evaluate(r, cfg, project)
    const hit = violations.find((v) => v.detail.includes("PUT"))
    expect(hit).toBeDefined()
    expect(hit!.detail).toContain("not in allow list")
  })
})

describe("proxy JSON parsing — supervisor output contract", () => {
  test("type=http line parses to expected shape", () => {
    const line = JSON.stringify({
      type: "http",
      method: "GET",
      path: "/",
      host: "example.com",
      addr: "93.184.216.34",
      port: 80,
    })
    const msg = JSON.parse(line) as {
      type: string
      method: string
      path: string
      host: string
      addr: string
      port: number
    }
    expect(msg.type).toBe("http")
    expect(msg.method).toBe("GET")
    expect(msg.path).toBe("/")
    expect(msg.host).toBe("example.com")
    expect(msg.addr).toBe("93.184.216.34")
    expect(msg.port).toBe(80)
  })

  test("type=http with forwarded flag", () => {
    const line = JSON.stringify({
      type: "http",
      method: "POST",
      path: "/api",
      host: "example.com",
      addr: "93.184.216.34",
      port: 443,
      forwarded: true,
    })
    const msg = JSON.parse(line) as { type: string; forwarded?: boolean }
    expect(msg.type).toBe("http")
    expect(msg.forwarded).toBe(true)
  })

  test("type=http dispatches to http array — method and path present", () => {
    // Mirrors sandbox.ts line 226: if (msg.type === "http" && msg.method && msg.path)
    const msg = { type: "http", method: "GET", path: "/index.html", host: "example.com", addr: "1.2.3.4", port: 80 }
    const valid = msg.type === "http" && !!msg.method && !!msg.path
    expect(valid).toBe(true)
  })

  test("type=http without method skips http dispatch", () => {
    const msg = { type: "http", path: "/", addr: "1.2.3.4", port: 80 } as {
      type: string
      method?: string
      path?: string
    }
    const valid = msg.type === "http" && !!msg.method && !!msg.path
    expect(valid).toBe(false)
  })

  test("invalid JSON returns undefined from try-catch", () => {
    let result: unknown
    try {
      result = JSON.parse("not valid json")
    } catch {
      result = undefined
    }
    expect(result).toBeUndefined()
  })

  test("type=connect with base64 data decodes correctly", () => {
    const payload = "GET / HTTP/1.1\r\n"
    const line = JSON.stringify({
      type: "connect",
      addr: "93.184.216.34",
      port: 80,
      data: Buffer.from(payload).toString("base64"),
    })
    const msg = JSON.parse(line) as { type: string; data?: string; addr: string; port: number }
    expect(msg.type).toBe("connect")
    const buf = new Uint8Array(Buffer.from(msg.data!, "base64"))
    expect(buf.length).toBeGreaterThan(0)
    expect(new TextDecoder().decode(buf)).toContain("GET")
  })
})

describe("SSH policy — git command classification", () => {
  test("git-receive-pack → violation (write)", () => {
    const r = empty()
    r.ssh = [{ cmd: "git-receive-pack", repo: "owner/repo.git", addr: "140.82.112.4", port: 22 }]

    const violations = evaluate(r, cfg, project)
    const hit = violations.find((v) => v.detail.includes("git-receive-pack"))
    expect(hit).toBeDefined()
    expect(hit!.type).toBe("network")
    expect(hit!.severity).toBe("high")
    expect(hit!.detail).toContain("owner/repo.git")
  })

  test("git-upload-pack → no violation (read)", () => {
    const r = empty()
    r.ssh = [{ cmd: "git-upload-pack", repo: "owner/repo.git", addr: "140.82.112.4", port: 22 }]

    const violations = evaluate(r, cfg, project)
    const hit = violations.find((v) => v.detail.includes("SSH"))
    expect(hit).toBeUndefined()
  })

  test("unknown SSH command → violation", () => {
    const r = empty()
    r.ssh = [{ cmd: "", repo: "", addr: "140.82.112.4", port: 22 }]

    const violations = evaluate(r, cfg, project)
    const hit = violations.find((v) => v.detail.includes("SSH connection"))
    expect(hit).toBeDefined()
    expect(hit!.severity).toBe("high")
  })

  test("SSH not evaluated without allow_methods", () => {
    const loose: SandboxConfig = {
      ...cfg,
      network: { mode: "observe", allow: [] },
    }
    const r = empty()
    r.ssh = [{ cmd: "git-receive-pack", repo: "owner/repo.git", addr: "140.82.112.4", port: 22 }]

    const violations = evaluate(r, loose, project)
    const hit = violations.find((v) => v.detail.includes("SSH"))
    expect(hit).toBeUndefined()
  })

  test("mixed HTTP + SSH — both evaluated", () => {
    const r = empty()
    r.http = [{ method: "GET", path: "/", host: "example.com", addr: "93.184.216.34", port: 80 }]
    r.ssh = [{ cmd: "git-receive-pack", repo: "owner/repo.git", addr: "140.82.112.4", port: 22 }]

    const violations = evaluate(r, cfg, project)
    const http = violations.find((v) => v.detail.includes("GET"))
    expect(http).toBeUndefined() // GET is allowed
    const ssh = violations.find((v) => v.detail.includes("git-receive-pack"))
    expect(ssh).toBeDefined() // push is blocked
  })
})

describe("SSH JSON parsing — supervisor output contract", () => {
  test("type=ssh line parses to expected shape", () => {
    const line = JSON.stringify({
      type: "ssh",
      addr: "140.82.112.4",
      port: 22,
      cmd: "git-receive-pack",
      repo: "owner/repo.git",
    })
    const msg = JSON.parse(line) as { type: string; cmd: string; repo: string; addr: string; port: number }
    expect(msg.type).toBe("ssh")
    expect(msg.cmd).toBe("git-receive-pack")
    expect(msg.repo).toBe("owner/repo.git")
    expect(msg.addr).toBe("140.82.112.4")
    expect(msg.port).toBe(22)
  })

  test("type=ssh with empty cmd/repo", () => {
    const line = JSON.stringify({
      type: "ssh",
      addr: "140.82.112.4",
      port: 22,
      cmd: "",
      repo: "",
    })
    const msg = JSON.parse(line) as { type: string; cmd: string; repo: string }
    expect(msg.type).toBe("ssh")
    expect(msg.cmd).toBe("")
    expect(msg.repo).toBe("")
  })
})
