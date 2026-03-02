import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as config from "../src/config"
import path from "path"
import fs from "fs/promises"

const root = path.resolve(import.meta.dir, "..")
const bun = process.argv[0]

async function spawn(script: string, restricted: string): Promise<string> {
  const proc = Bun.spawn([bun, "-e", script], {
    cwd: root,
    env: { ...process.env, PATH: restricted },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

describe("graceful degradation", () => {
  const restricted = `/nonexistent:${path.dirname(bun)}`

  describe("dependency checks", () => {
    test("no bwrap returns bwrap=false", async () => {
      const result = JSON.parse(
        await spawn(
          `import * as deps from "./src/deps"; const r = await deps.check(); console.log(JSON.stringify(r));`,
          restricted,
        ),
      )
      expect(result.bwrap).toBe(false)
      expect(result.available).toBe(false)
    })

    test("no strace returns strace=false", async () => {
      const result = JSON.parse(
        await spawn(
          `import * as deps from "./src/deps"; const r = await deps.check(); console.log(JSON.stringify(r));`,
          restricted,
        ),
      )
      expect(result.strace).toBe(false)
      expect(result.available).toBe(false)
    })

    test("neither available still resolves", async () => {
      const result = JSON.parse(
        await spawn(
          `import * as deps from "./src/deps"; const r = await deps.check(); console.log(JSON.stringify(r));`,
          restricted,
        ),
      )
      expect(result.bwrap).toBe(false)
      expect(result.strace).toBe(false)
      expect(result.available).toBe(false)
    })
  })

  describe("plugin degradation", () => {
    test("returns empty hooks when deps unavailable", async () => {
      const script = `
        import plugin from "./src/index";
        const hooks = await plugin({
          directory: "/tmp/opencode-sandbox-test",
          worktree: "/tmp/opencode-sandbox-test",
          serverUrl: new URL("http://localhost"),
        });
        console.log(JSON.stringify(Object.keys(hooks)));
      `
      const keys = JSON.parse(await spawn(script, restricted))
      expect(keys).toEqual([])
    })

    test("returns empty hooks when bwrap namespace restricted", async () => {
      const script = `
        import plugin from "./src/index";
        const hooks = await plugin({
          directory: "/tmp/opencode-sandbox-test",
          worktree: "/tmp/opencode-sandbox-test",
          serverUrl: new URL("http://localhost"),
        });
        console.log(JSON.stringify({ keys: Object.keys(hooks), len: Object.keys(hooks).length }));
      `
      const result = JSON.parse(await spawn(script, restricted))
      expect(result.keys).toEqual([])
      expect(result.len).toBe(0)
    })
  })

  describe("config loading", () => {
    const tmp = path.join("/tmp", `sandbox-test-${process.pid}`)

    beforeEach(async () => {
      await fs.mkdir(path.join(tmp, ".opencode"), { recursive: true })
    })

    afterEach(async () => {
      await fs.rm(tmp, { recursive: true, force: true })
    })

    test("missing sandbox.json uses global then hardcoded defaults", async () => {
      const dir = path.join("/tmp", `sandbox-test-missing-${process.pid}`)
      await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
      await fs.rm(path.join(dir, ".opencode", "sandbox.json"), { force: true })
      const cfg = await config.load(dir, "/nonexistent/global.json")
      expect(cfg.timeout).toBe(250)
      expect(cfg.auto_allow_clean).toBe(true)
      expect(cfg.verbose).toBe(false)
      expect(cfg.network.mode).toBe("observe")
      expect(cfg.network.allow).toEqual([])
      expect(cfg.network.allow_methods).toEqual(["GET", "HEAD", "OPTIONS"])
      expect(cfg.filesystem.inherit_permissions).toBe(true)
      expect(cfg.filesystem.allow_write).toEqual([])
      expect(cfg.filesystem.deny_read).toEqual([])
      await fs.rm(dir, { recursive: true, force: true })
    })

    test("malformed sandbox.json warns and applies schema defaults", async () => {
      await Bun.write(path.join(tmp, ".opencode", "sandbox.json"), "not json {{{")
      const cfg = await config.load(tmp, "/nonexistent/global.json")
      expect(cfg.timeout).toBe(250)
      expect(cfg.auto_allow_clean).toBe(true)
      expect(cfg.verbose).toBe(false)
      expect(cfg.network.mode).toBe("observe")
      expect(cfg.filesystem.inherit_permissions).toBe(true)
    })

    test("empty object sandbox.json merges with hardcoded defaults", async () => {
      await Bun.write(path.join(tmp, ".opencode", "sandbox.json"), "{}")
      const cfg = await config.load(tmp, "/nonexistent/global.json")
      expect(cfg.timeout).toBe(250)
      expect(cfg.auto_allow_clean).toBe(true)
      expect(cfg.verbose).toBe(false)
      expect(cfg.network.mode).toBe("observe")
      expect(cfg.network.allow).toEqual([])
      expect(cfg.network.allow_methods).toEqual(["GET", "HEAD", "OPTIONS"])
      expect(cfg.filesystem.inherit_permissions).toBe(true)
      expect(cfg.filesystem.allow_write).toEqual([])
      expect(cfg.filesystem.deny_read).toEqual([])
    })
  })
})
