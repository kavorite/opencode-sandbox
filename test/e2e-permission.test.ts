import { describe, test, expect } from "bun:test"
import os from "os"
import fs from "fs/promises"
import path from "path"
import plugin from "../src/index"
import * as store from "../src/store"

const linux = os.platform() === "linux"

async function hasBwrap(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bwrap", "--ro-bind", "/", "/", "--unshare-user", "true"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

async function hasStrace(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["strace", "-V"], { stdio: ["ignore", "ignore", "ignore"] })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

const available = linux && (await hasBwrap()) && (await hasStrace())

/**
 * E2E tests that exercise the exact same data shape that PermissionNext.ask()
 * would pass to Plugin.trigger("permission.ask", ...). This verifies:
 * 1. The plugin correctly receives and processes the permission info
 * 2. Clean commands get auto-approved (output.status = "allow")
 * 3. Network-violating commands leave status as "ask"
 * 4. Timed-out commands leave status as "ask"
 */
describe.skipIf(!available)("E2E permission.ask hook", () => {
  test("clean echo command — auto-approved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({ network: { mode: "block" }, auto_allow_clean: true, verbose: true }),
    )

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      // Simulate the exact shape PermissionNext.ask() passes after our patch
      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_test_echo",
          type: "bash",
          pattern: ["echo hello world"],
          sessionID: "ses_test",
          messageID: "msg_test",
          callID: "call_test",
          message: "echo hello world",
          metadata: {},
          time: { created: Date.now() },
        } as any,
        output,
      )

      expect(output.status).toBe("allow")

      const stored = store.get("call_test")
      expect(stored).toBeDefined()
      expect(stored!.timedOut).toBe(false)
      expect(stored!.violations.length).toBe(0)
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("curl POST command — network violation, stays ask", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({ network: { mode: "block" }, auto_allow_clean: true, verbose: true }),
    )

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_test_curl",
          type: "bash",
          pattern: ["curl -X POST https://httpbin.org/post"],
          sessionID: "ses_test",
          messageID: "msg_test",
          callID: "call_curl",
          message: "curl -X POST https://httpbin.org/post",
          metadata: {},
          time: { created: Date.now() },
        } as any,
        output,
      )

      // Curl tries to connect — network blocked — violation detected — stays "ask"
      expect(output.status).toBe("ask")

      const stored = store.get("call_curl")
      expect(stored).toBeDefined()
      expect(stored!.violations.length).toBeGreaterThan(0)
      expect(stored!.violations.some((v: any) => v.type === "network")).toBe(true)
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("git log command — clean, auto-approved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({ network: { mode: "block" }, auto_allow_clean: true, verbose: true }),
    )

    // Init a git repo so git log works
    const proc = Bun.spawn(["git", "init"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] })
    await proc.exited
    const commit = Bun.spawn(
      ["git", "-c", "user.email=t@t.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "init"],
      {
        cwd: dir,
        stdio: ["ignore", "ignore", "ignore"],
      },
    )
    await commit.exited

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_test_git",
          type: "bash",
          pattern: ["git log --oneline -5"],
          sessionID: "ses_test",
          messageID: "msg_test",
          callID: "call_git",
          message: "git log --oneline -5",
          metadata: {},
          time: { created: Date.now() },
        } as any,
        output,
      )

      expect(output.status).toBe("allow")
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("edit with no filepath metadata — stays ask", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({ network: { mode: "block" }, auto_allow_clean: true }),
    )

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_test_edit",
          type: "edit",
          pattern: ["*"],
          sessionID: "ses_test",
          messageID: "msg_test",
          message: "*",
          metadata: {},
          time: { created: Date.now() },
        } as any,
        output,
      )

      // No filepath in metadata — edit handler early-returns, status unchanged
      expect(output.status).toBe("ask")
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("sleep command — times out, stays ask", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({ timeout: 100, network: { mode: "block" }, auto_allow_clean: true, verbose: true }),
    )

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_test_sleep",
          type: "bash",
          pattern: ["sleep 10"],
          sessionID: "ses_test",
          messageID: "msg_test",
          callID: "call_sleep",
          message: "sleep 10",
          metadata: {},
          time: { created: Date.now() },
        } as any,
        output,
      )

      // Timed out — shouldn't auto-approve
      expect(output.status).toBe("ask")

      const stored = store.get("call_sleep")
      expect(stored).toBeDefined()
      expect(stored!.timedOut).toBe(true)
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!available)("E2E edit permission handler", () => {
  test("edit inside project — auto-approved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({ network: { mode: "block" }, auto_allow_clean: true }),
    )

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_edit_inside",
          type: "edit",
          pattern: ["*"],
          sessionID: "ses_test",
          messageID: "msg_test",
          message: "edit file",
          metadata: { filepath: "src/index.ts", diff: "+// hello" },
          time: { created: Date.now() },
        } as any,
        output,
      )

      // Relative path inside project — no violations — auto-approved
      expect(output.status).toBe("allow")
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("edit outside project — stays ask", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({ network: { mode: "block" }, auto_allow_clean: true, verbose: true }),
    )

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_edit_outside",
          type: "edit",
          pattern: ["*"],
          sessionID: "ses_test",
          messageID: "msg_test",
          message: "edit file",
          metadata: { filepath: "/etc/passwd", diff: "+evil" },
          time: { created: Date.now() },
        } as any,
        output,
      )

      // Absolute path outside project — violation — stays ask
      expect(output.status).toBe("ask")
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("edit with absolute path inside project — auto-approved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({ network: { mode: "block" }, auto_allow_clean: true }),
    )

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_edit_abs_inside",
          type: "edit",
          pattern: ["*"],
          sessionID: "ses_test",
          messageID: "msg_test",
          message: "edit file",
          metadata: { filepath: path.join(dir, "src/main.ts"), diff: "+code" },
          time: { created: Date.now() },
        } as any,
        output,
      )

      // Absolute path inside project — auto-approved
      expect(output.status).toBe("allow")
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("apply_patch with comma-separated paths — mixed inside/outside", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({ network: { mode: "block" }, auto_allow_clean: true, verbose: true }),
    )

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_patch_mixed",
          type: "edit",
          pattern: ["*"],
          sessionID: "ses_test",
          messageID: "msg_test",
          message: "apply patch",
          metadata: { filepath: "src/foo.ts, /etc/hosts", diff: "patch content" },
          time: { created: Date.now() },
        } as any,
        output,
      )

      // One path outside project — violation — stays ask
      expect(output.status).toBe("ask")
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("edit with allowed external path — auto-approved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-e2e-"))
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(dir, ".opencode", "sandbox.json"),
      JSON.stringify({
        network: { mode: "block" },
        auto_allow_clean: true,
        filesystem: { allow_write: ["/tmp"] },
      }),
    )

    try {
      const hooks = await plugin({
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:0"),
      } as Parameters<typeof plugin>[0])

      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]!(
        {
          id: "perm_edit_allowed",
          type: "edit",
          pattern: ["*"],
          sessionID: "ses_test",
          messageID: "msg_test",
          message: "edit file",
          metadata: { filepath: "/tmp/scratch.txt", diff: "+data" },
          time: { created: Date.now() },
        } as any,
        output,
      )

      // /tmp is in allow_write — auto-approved
      expect(output.status).toBe("allow")
    } finally {
      store.clear()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
