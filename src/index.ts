import os from 'os'
import path from 'path'
import { rm } from 'fs/promises'
import type { PluginInput, Hooks, Plugin } from '@opencode-ai/plugin'
import * as config from './config.js'
import * as deps from './deps.js'
import * as container from './container.js'
import * as proxy from './proxy.js'
import * as policy from './policy.js'
import * as store from './store.js'
import { parseStrace } from './strace.js'
import { connect } from './docker.js'
import type { SessionState } from './container.js'
import type { ProxyState } from './proxy.js'
import type { SandboxResult } from './store.js'
import { getParser, stripSentinels } from './parse.js'

// Stashed original commands keyed by callID — used to relay real command in shell.env / logging
const originalCommands = new Map<string, string>()

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  // Nesting detection — if running inside a sandbox container, return empty hooks.
  // We use a container-specific env var (OC_SANDBOX_CONTAINER) set only in the Docker
  // container's env at creation time. This avoids false positives from:
  //   - /.dockerenv: breaks when the HOST runs in Docker (CI, dev containers, cloud)
  //   - OC_SANDBOX: sub-agents on the host inherit this via shell.env but need their own sandbox
  if (process.env.OC_SANDBOX_CONTAINER) return {}

  // Check Docker availability — error and block if unavailable
  const depsResult = await deps.check()
  if (!depsResult.available) {
    throw new Error(`opencode-sandbox requires Docker: ${depsResult.error ?? 'Docker daemon not available'}`)
  }

  const cfg = await config.load(input.directory)
  // worktree = git working tree root (bind mount + policy boundary)
  // cwd = session working directory (where commands execute, may be a subdir of worktree)
  const project = input.worktree || input.directory
  const cwd = input.directory
  const home = os.homedir()
  const docker = connect()
  const sessionId = `oc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // Sub-agent detection: if a parent sandbox is running, reuse its Docker network
  // so the sub-agent's container shares the mitmproxy sidecar.
  const parentNetworkName = process.env.OC_SANDBOX_NETWORK
  const parentProxyLog = process.env.OC_SANDBOX_PROXY_LOG

  // Initialize warm container (joins parent's network if sub-agent, or creates new one)
  const state: SessionState = await container.init(docker, project, home, sessionId, cfg, parentNetworkName)
  const networkName = state.networkMode

  // Start mitmproxy sidecar AFTER init (network must exist first).
  // Sub-agents skip proxy creation — they share the parent's proxy sidecar on the shared network.
  let proxyState: ProxyState | undefined
  if (cfg.network.observe && !parentNetworkName) {
    // Primary session: start our own proxy sidecar
    proxyState = await proxy.startProxy(docker, networkName, sessionId, cfg.network.allow_methods, cfg.network.allow_graphql_queries)
  } else if (cfg.network.observe && parentProxyLog) {
    // Sub-agent: read proxy logs from parent's shared directory
    proxyState = {
      logDir: parentProxyLog,
      networkName,
      sessionId,
    }
  }

  return {
    'tool.execute.before': async (info, output) => {
      if (info.tool !== 'bash') return
      const args = output.args as { command: string; workdir?: string }
      let originalCommand = args.command

      // Strip sentinel comments using tree-sitter (handles double-prefixes, nested sentinels)
      const parser = await getParser()
      originalCommand = stripSentinels(originalCommand, parser)

      // Run the command inside Docker NOW — before bash.ts spawns it on the host
      // Recover from stale/missing/corrupted container by reinitializing the session
      let execResult: Awaited<ReturnType<typeof container.exec>>
      const execCwd = (args.workdir && path.isAbsolute(args.workdir)) ? args.workdir : cwd
      try {
        execResult = await container.exec(state, originalCommand, execCwd)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('no such container') || msg.includes('No such container') ||
            msg.includes('is not running') || msg.includes('RWLayer') ||
            (err instanceof Error && 'statusCode' in err && (err as any).statusCode >= 500)) {
          // Container missing, stopped, or storage corrupted — reinitialize and retry once.
          // Pass the current network name so init() reuses the existing network
          // instead of trying to create a duplicate (which would 409).
          const newState = await container.init(docker, project, home, sessionId, cfg, networkName)
          Object.assign(state, newState)
          execResult = await container.exec(state, originalCommand, execCwd)
        } else {
          throw err
        }
      }

      // Get filesystem diff
      const diffResult = await container.inspect(state)

      // Parse strace output for SSH commands and network connections
      const traced = execResult.straceLog ? parseStrace(execResult.straceLog) : { ssh: [], network: [] }

      // Get network data from proxy logs if observe mode
      const networkData = proxyState
        ? proxy.mapFlows(await proxy.readLogs(proxyState))
        : { http: [], tls: [], dns: [] }

      // Build SandboxResult
      const result: SandboxResult = {
        files: diffResult.files,
        writes: diffResult.writes,
        mutations: diffResult.mutations,
        network: traced.network,
        sockets: [],
        dns: networkData.dns,
        http: networkData.http,
        tls: networkData.tls,
        ssh: traced.ssh,
        duration: 0,
        timedOut: false,
        violations: [],
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        exitCode: execResult.exitCode,
      }

      // Evaluate policy
      const violations = policy.evaluate(result, cfg, project)
      result.violations = violations

      // Store result for tool.execute.after to relay to agent
      store.set(info.callID, result)
      originalCommands.set(info.callID, originalCommand)

      if (violations.length > 0) {
        // Violations — rollback container to pre-command state
        await container.reject(state)
        // Write manifest for potential review prompt
        const manifestPath = `/tmp/oc-sandbox-review-${info.callID}`
        await Bun.write(manifestPath, JSON.stringify({ violations, stdout: result.stdout, stderr: result.stderr }))
      } else {
        // Clean — commit container state
        await container.approve(state)
      }

      // Sentinel strategy:
      //   Clean:     shell comment → bash skips tree-sitter command detection (no nodes)
      //   Violation: original command → bash detects ops → PermissionNext prompts user
      //              If user denies, the command is blocked on host (Docker already rolled back).
      //
      //   The event hook below auto-replies to PermissionNext for clean commands so
      //   sub-agent sessions (which start with an empty permission ruleset) don't prompt.
      args.command = violations.length > 0
        ? originalCommand                          // violation: prompt user; if approved, runs on host
        : `# [sandboxed] ${originalCommand}`       // clean: no-op comment, no prompt
    },

    'permission.ask': async (info, output) => {
      // Handle post-review commit approval (from sandbox_review)
      if (info.type === 'sandbox_review') {
        output.status = 'allow'
        return
      }

      // Path-based policy for file edits/writes (these hooks DO fire for non-bash tools)
      if (info.type === 'edit' || info.type === 'write' || info.type === 'apply_patch') {
        const filepath = (info.metadata as Record<string, unknown> | undefined)?.filepath as string | undefined
        if (!filepath) return
        const targets = filepath.includes(', ') ? filepath.split(', ') : [filepath]
        const blocked = targets
          .map((t) => (path.isAbsolute(t) ? t : path.resolve(cwd, t)))
          .filter((t) => !policy.writable(t, path.resolve(project), cfg.filesystem.allow_write))
        if (blocked.length === 0 && cfg.auto_allow_clean) {
          output.status = 'allow'
        }
        return
      }

      // NOTE: 'bash' permission.ask is NOT triggered by PermissionNext (current opencode).
      // Bash auto-approval for sub-agents is handled via the 'event' hook below instead.
    },

    'tool.execute.after': async (info, output) => {
      if (info.tool !== 'bash') return
      // Show the real command in the TUI, not the sentinel
      const orig = originalCommands.get(info.callID)
      if (orig) output.title = orig
      // Relay Docker stdout/stderr back to agent — host ran a no-op, Docker ran the real command
      const result = store.get(info.callID)
      if (result) {
        if (result.violations.length > 0) {
          // The original command was shown to the user. If approved, it ran on host — output is already correct.
          // If denied, bash tool output will be the denial message — also correct.
          // Prepend violation context so agent knows what was flagged.
          const summary = result.violations.map((v) => `[sandbox flagged: ${v.type} - ${v.detail}]`).join('\n')
          output.output = `${summary}\n${output.output ?? ''}`.trim()
        } else {
          const text = [result.stdout, result.stderr].filter(Boolean).join('\n')
          if (text) output.output = text
        }
      }
      originalCommands.delete(info.callID)
      await rm(`/tmp/oc-sandbox-review-${info.callID}`, { force: true }).catch(() => {})
    },

    'shell.env': async (_info, output) => {
      output.env.OC_SANDBOX = '1'
      output.env.OC_SANDBOX_PROJECT = project
      output.env.OC_SANDBOX_NETWORK = networkName
      output.env.OC_SANDBOX_WRITABLE = cfg.filesystem.allow_write.join(':')
      if (proxyState?.logDir) {
        output.env.OC_SANDBOX_PROXY_LOG = proxyState.logDir
      }
      if (cfg.network.observe && cfg.network.allow_methods?.length) {
        output.env.OC_ALLOW_METHODS = cfg.network.allow_methods.join(',')
      }
    },

    'experimental.chat.system.transform': async (_input, output) => {
      output.system.push([
        'SANDBOX ENVIRONMENT ACTIVE: All bash commands are transparently intercepted by the opencode-sandbox plugin.',
        'Commands execute inside a Docker container — the plugin handles interception, diffing, and output relay automatically.',
        'DO NOT add any prefix like "# [sandboxed]" to your commands. Just write normal commands (e.g. `bun test`, `git status`).',
        'The sandbox auto-approves clean commands and prompts the user only for genuine violations (git push, writes outside project dir).',
        'Command output is relayed back to you transparently — you will see stdout/stderr as if the command ran on the host.',
      ].join(' '))
    },

    // PermissionNext (the new permission system) does NOT call
    // Plugin.trigger('permission.ask').  Instead it publishes 'permission.asked' bus
    // events.  We intercept these events to:
    //   1. Auto-reply for bash commands the sandbox already evaluated as clean
    //   2. Enforce path-based policy for file edits/writes outside the project directory
    'event': async ({ event }) => {
      if ((event as any).type !== 'permission.asked') return
      const req = (event as any).properties as {
        id: string
        sessionID: string
        permission: string
        patterns: string[]
        metadata: Record<string, unknown>
        always: string[]
        tool?: { messageID: string; callID: string }
      } | undefined
      if (!req) return

      // --- Bash commands: auto-approve if sandbox evaluated as clean ---
      if (req.permission === 'bash') {
        const callID = req.tool?.callID
        if (!callID) return

        const result = store.peek(callID)
        if (!result || result.violations.length > 0) return // violations → let user decide

        if (!cfg.auto_allow_clean) return

        // Clean command already executed in Docker — auto-approve so sub-agents aren't blocked.
        // 'always' adds a session-scoped rule, preventing repeat prompts in the same session.
        try {
          await (input.client as any).permission.reply({
            requestID: req.id,
            reply: 'always',
          })
        } catch {
          // Already replied or request expired — no-op
        }
        return
      }

      // --- File edits/writes: path-based policy (mirrors permission.ask handler) ---
      if (req.permission === 'edit' || req.permission === 'write' || req.permission === 'apply_patch') {
        const filepath = req.metadata?.filepath as string | undefined
        if (!filepath) return
        const targets = filepath.includes(', ') ? filepath.split(', ') : [filepath]
        const blocked = targets
          .map((t) => (path.isAbsolute(t) ? t : path.resolve(cwd, t)))
          .filter((t) => !policy.writable(t, path.resolve(project), cfg.filesystem.allow_write))
        if (blocked.length === 0 && cfg.auto_allow_clean) {
          try {
            await (input.client as any).permission.reply({
              requestID: req.id,
              reply: 'always',
            })
          } catch {
            // Already replied or request expired — no-op
          }
        }
        // blocked.length > 0 → don't reply → user gets prompted
        return
      }
    },
  }
}

export default plugin
