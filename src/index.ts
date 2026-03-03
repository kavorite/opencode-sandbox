import path from "path"
import os from "os"
import { mkdtemp, mkdir, rm, readdir, stat, lstat } from "fs/promises"
import type { PluginInput, Hooks, Plugin } from "@opencode-ai/plugin"
import * as config from "./config"
import * as deps from "./deps"
import * as wrapper from "./wrapper"
import * as policy from "./policy"
import { commit as commitOp } from "./epilogue"
import type { Manifest } from "./epilogue"
import * as store from "./store"

function isManifest(v: unknown): v is Manifest {
  return v !== null && typeof v === "object" && "discarded" in v
}

// Stashed args references keyed by callID. tool.execute.before stores these;
// permission.ask reads and mutates them to replace the command with a wrapper.
const stash = new Map<string, { command: string }>()

// Overlay upper dir paths keyed by callID. tool.execute.before creates these;
// tool.execute.after cleans them up as a safety net.
const uppers = new Map<string, string>()

// Top-level directories that are virtual/tmpfs — never overlay these.
const VIRTUAL = new Set(["dev", "proc", "sys", "run", "tmp"])

// Discover top-level directories suitable for overlay violation capture.
// Excludes virtual/tmpfs dirs and HOME (overlayed separately by wrapper.ts).
// Probe whether bwrap can overlay a directory (some dirs fail due to
// nested overlayfs mounts, e.g., /var with Docker overlay2).
async function probeOverlay(dir: string): Promise<boolean> {
  const tag = dir.replace(/\//g, "_")
  const upper = `/tmp/oc-probe-${process.pid}-${tag}`
  const work = upper + "-work"
  try {
    await mkdir(path.join(upper, dir), { recursive: true })
    await mkdir(path.join(work, dir), { recursive: true })
    const proc = Bun.spawn(["bwrap", "--ro-bind", "/", "/",
      "--overlay-src", dir, "--overlay", path.join(upper, dir), path.join(work, dir), dir,
      "--die-with-parent", "true"], { stdio: ["ignore", "ignore", "ignore"] })
    return (await proc.exited) === 0
  } catch { /* ignore — bwrap overlay probe failure is non-fatal */
    return false
  } finally {
    await rm(upper, { recursive: true, force: true }).catch(() => {})
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

// Discover top-level directories suitable for overlay violation capture.
// Excludes virtual/tmpfs dirs, HOME, symlinks, non-root filesystems,
// and dirs that fail the bwrap overlay probe (e.g., /var with Docker).
async function systemOverlayDirs(home: string): Promise<string[]> {
  const rootSt = await stat("/").catch(() => null)
  if (!rootSt) return []
  const rootDev = rootSt.dev
  const entries = await readdir("/").catch(() => [] as string[])
  const candidates: string[] = []
  for (const entry of entries) {
    if (VIRTUAL.has(entry)) continue
    const full = "/" + entry
    if (full === home || home.startsWith(full + "/") || full.startsWith(home + "/")) continue
    const st = await lstat(full).catch(() => null)
    if (!st || !st.isDirectory()) continue
    if (st.dev !== rootDev) continue
    candidates.push(full)
  }
  const results = await Promise.all(candidates.map(probeOverlay))
  return candidates.filter((_, i) => results[i])
}

// Detect if the project directory is a git worktree and return paths that
// the epilogue should treat as writable. In a worktree, .git is a file
// pointing to git metadata under the main repo's .git/worktrees/. Without
// adding these to the allow list, the epilogue discards git metadata writes
// (objects, refs, HEAD) because they fall outside the project subtree.
async function resolveGitWorktreeAllowPaths(project: string): Promise<string[]> {
  const gitPath = path.join(project, ".git")
  const st = await lstat(gitPath).catch(() => null)
  if (!st || !st.isFile()) return []

  let content: string
  try {
    content = await Bun.file(gitPath).text()
  } catch {
    return []
  }

  const match = content.trim().match(/^gitdir:\s*(.+)/)
  if (!match?.[1]) return []

  let gitdir = match[1].trim()
  if (!path.isAbsolute(gitdir)) {
    gitdir = path.resolve(project, gitdir)
  }

  // Resolve the shared git directory via the commondir file that git
  // writes in every worktree gitdir (typically contains "../..").
  let commonDir: string
  try {
    const rel = (await Bun.file(path.join(gitdir, "commondir")).text()).trim()
    commonDir = path.isAbsolute(rel) ? rel : path.resolve(gitdir, rel)
  } catch {
    // Fallback: standard layout is .git/worktrees/<name> — go up two levels.
    commonDir = path.resolve(gitdir, "..", "..")
  }

  commonDir = path.resolve(commonDir)

  // Verify it exists and isn't already covered by the project bind-mount.
  const dirSt = await stat(commonDir).catch(() => null)
  if (!dirSt?.isDirectory()) return []
  if (commonDir === project || commonDir.startsWith(project + "/")) return []

  return [commonDir]
}

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const available = await deps.check()
  if (!available.available) return {}

  const cfg = await config.load(input.directory)
  const project = input.directory
  const epilogue = path.join(import.meta.dir, "..", "bin", "oc-epilogue")
  const observeBin = path.join(import.meta.dir, "..", "bin", "oc-observe")
  const straceBin = Bun.which("strace") ?? "strace"
  const home = os.homedir()
  const overlayDirs = await systemOverlayDirs(home)
  const gitWorktreeAllowPaths = await resolveGitWorktreeAllowPaths(project)
  if (gitWorktreeAllowPaths.length > 0) {
    console.error(`opencode-sandbox: git worktree detected — adding to allow list: ${gitWorktreeAllowPaths.join(", ")}`)
  }

  return {
    "tool.execute.before": async (info, output) => {
      if (info.tool !== "bash") return
      stash.set(info.callID, output.args)
      const upper = await mkdtemp("/tmp/oc-upper-")
      const promises: Promise<string | undefined>[] = [
        mkdir(path.join(upper, home), { recursive: true }),
        mkdir(path.join(upper + "-work", home), { recursive: true }),
      ]
      for (const dir of overlayDirs) {
        promises.push(mkdir(path.join(upper, dir), { recursive: true }))
        promises.push(mkdir(path.join(upper + "-work", dir), { recursive: true }))
      }
      await Promise.all(promises)
      uppers.set(info.callID, upper)
    },

    "permission.ask": async (info, output) => {
      if (info.type === "sandbox_review") {
        if (!isManifest(info.metadata)) return
        const manifest = info.metadata
        for (const op of manifest.discarded) {
          try { await commitOp(op) } catch { /* ignore — commit failure during review is non-fatal */ }
        }
        if (manifest.upper) {
          await rm(manifest.upper, { recursive: true, force: true }).catch(() => {})
          await rm(manifest.upper + "-work", { recursive: true, force: true }).catch(() => {})
        }
        output.status = "allow"
        return
      }

      if (info.type === "edit" || info.type === "write" || info.type === "apply_patch") {
        const filepath = info.metadata?.filepath as string | undefined
        if (!filepath) return
        const targets = filepath.includes(", ") ? filepath.split(", ") : [filepath]
        const blocked = targets
          .map((t) => (path.isAbsolute(t) ? t : path.resolve(project, t)))
          .filter((t) => !policy.writable(t, path.resolve(project), cfg.filesystem.allow_write))
        if (blocked.length === 0 && cfg.auto_allow_clean) {
          output.status = "allow"
        }
        return
      }

      if (info.type !== "bash") return

      const callID = info.callID ?? info.id
      const ref = stash.get(callID)
      if (!ref) {
        output.status = "allow"
        store.set(callID, { timedOut: false, violations: [], files: [], writes: [], mutations: [], network: [], sockets: [], dns: [], http: [], tls: [], ssh: [], duration: 0, stdout: "", stderr: "", exitCode: 0 })
        return
      }
      const upper = uppers.get(callID)
      if (!upper) return

      if (cfg.network.mode === "observe" && !available.observe) {
        throw new Error("opencode-sandbox: oc-observe binary required for observe mode but not found")
      }

      const observe = cfg.network.mode !== "observe" ? undefined : {
        bin: observeBin,
        log: `/tmp/oc-observe-${callID}.log`,
        strace: straceBin,
        straceLog: `/tmp/oc-strace-${callID}.log`,
        bufsize: cfg.strace_bufsize ?? 16384,
        graphqlQueries: cfg.network.allow_graphql_queries,
      }

      const cmd = wrapper.command({
        cmd: ref.command,
        cwd: project,
        upper,
        project,
        callId: callID,
        allow: [...cfg.filesystem.allow_write, ...gitWorktreeAllowPaths],
        home,
        epilogue,
        overlay: true,
        observe,
        overlayDirs,
      })

      ref.command = cmd
      stash.delete(callID)
      output.status = "allow"
    },

    "tool.execute.after": async (info) => {
      if (info.tool !== "bash") return
      const upper = uppers.get(info.callID)
      if (!upper) return
      uppers.delete(info.callID)
      stash.delete(info.callID)
      await rm(upper, { recursive: true, force: true }).catch(() => {})
      await rm(upper + "-work", { recursive: true, force: true }).catch(() => {})
    },

    "shell.env": async (info, output) => {
      output.env.OC_SANDBOX = "1"
      output.env.OC_SANDBOX_PROJECT = project
      output.env.OC_SANDBOX_WRITABLE = cfg.filesystem.allow_write.join(":")
    },
  }
}

export default plugin
