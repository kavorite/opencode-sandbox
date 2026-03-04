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

// Stashed original commands keyed by callID — used to relay real command in shell.env / logging
const originalCommands = new Map<string, string>()

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  // Nesting detection — if already inside a sandbox, return empty hooks
  if (process.env.OC_SANDBOX === '1') return {}

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
  const networkName = `oc-sandbox-${sessionId}`

  // Initialize warm container (creates Docker network internally)
  const state: SessionState = await container.init(docker, project, home, sessionId, cfg)

  // Start mitmproxy sidecar AFTER init (network must exist first)
  let proxyState: ProxyState | undefined
  if (cfg.network.observe) {
    proxyState = await proxy.startProxy(docker, networkName, sessionId, cfg.network.allow_methods, cfg.network.allow_graphql_queries)
  }

  return {
    'tool.execute.before': async (info, output) => {
      if (info.tool !== 'bash') return
      const args = output.args as { command: string }
      const originalCommand = args.command

      // Run the command inside Docker NOW — before bash.ts spawns it on the host
      // Run the command inside Docker NOW — before bash.ts spawns it on the host
      // Recover from stale/missing container by reinitializing the session
      let execResult: Awaited<ReturnType<typeof container.exec>>
      try {
        execResult = await container.exec(state, originalCommand, cwd)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('no such container') || msg.includes('No such container')) {
          // Container was removed externally — reinitialize and retry once
          const newState = await container.init(docker, project, home, sessionId, cfg)
          Object.assign(state, newState)
          execResult = await container.exec(state, originalCommand, cwd)
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
      //   Clean: shell comment → bash skips permission prompt (auto-approved)
      //   Violation: 'true # [sandboxed] ...' → bash fires permission prompt
      //   In both cases the host runs a no-op; Docker already executed the real command.
      args.command = violations.length > 0
        ? `true # [sandboxed] ${originalCommand}`   // prompt — user must approve
        : `# [sandboxed] ${originalCommand}`         // silent — clean, no prompt
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
      // Bash interception happens in tool.execute.before instead.
    },

    'tool.execute.after': async (info, output) => {
      if (info.tool !== 'bash') return
      // Relay Docker stdout/stderr back to agent — host ran 'true', Docker ran the real command
      const result = store.get(info.callID)
      if (result) {
        if (result.violations.length > 0) {
          // Command was blocked — relay violation summary so agent knows
          const summary = result.violations.map((v) => `[SANDBOX VIOLATION] ${v.type}: ${v.detail}`).join('\n')
          output.output = `Command blocked by sandbox:\n${summary}`
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
      output.env.OC_SANDBOX_WRITABLE = cfg.filesystem.allow_write.join(':')
      if (cfg.network.observe && cfg.network.allow_methods?.length) {
        output.env.OC_ALLOW_METHODS = cfg.network.allow_methods.join(',')
      }
    },
  }
}


export default plugin
