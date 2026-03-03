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
import { connect } from './docker.js'
import type { SessionState } from './container.js'
import type { ProxyState } from './proxy.js'
import type { SandboxResult } from './store.js'

// Stashed args refs keyed by callID — tool.execute.before stores, permission.ask reads
const stash = new Map<string, { command: string }>()

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  // Nesting detection — if already inside a sandbox, return empty hooks
  if (process.env.OC_SANDBOX === '1') return {}

  // Check Docker availability — error and block if unavailable
  const depsResult = await deps.check()
  if (!depsResult.available) {
    throw new Error(`opencode-sandbox requires Docker: ${depsResult.error ?? 'Docker daemon not available'}`)
  }

  const cfg = await config.load(input.directory)
  const project = input.directory
  const home = os.homedir()
  const docker = connect()
  const sessionId = `oc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const networkName = `oc-sandbox-${sessionId}`

  // Initialize warm container (creates Docker network internally)
  const state: SessionState = await container.init(docker, project, home, sessionId, cfg)

  // Start mitmproxy sidecar AFTER init (network must exist first)
  let proxyState: ProxyState | undefined
  if (cfg.network.mode === 'observe') {
    proxyState = await proxy.startProxy(docker, networkName, sessionId, cfg.network.allow_methods)
  }

  return {
    'tool.execute.before': async (info, output) => {
      if (info.tool !== 'bash') return
      // Stash reference to args so permission.ask can replace the command
      stash.set(info.callID, output.args as { command: string })
    },

    'permission.ask': async (info, output) => {
      // Handle post-review commit approval (from sandbox_review)
      if (info.type === 'sandbox_review') {
        output.status = 'allow'
        return
      }

      // Path-based policy for file edits/writes
      if (info.type === 'edit' || info.type === 'write' || info.type === 'apply_patch') {
        const filepath = (info.metadata as Record<string, unknown> | undefined)?.filepath as string | undefined
        if (!filepath) return
        const targets = filepath.includes(', ') ? filepath.split(', ') : [filepath]
        const blocked = targets
          .map((t) => (path.isAbsolute(t) ? t : path.resolve(project, t)))
          .filter((t) => !policy.writable(t, path.resolve(project), cfg.filesystem.allow_write))
        if (blocked.length === 0 && cfg.auto_allow_clean) {
          output.status = 'allow'
        }
        return
      }

      if (info.type !== 'bash') return

      const callID = info.callID ?? (info as Record<string, unknown>).id as string
      const ref = stash.get(callID)
      if (!ref) {
        output.status = 'allow'
        store.set(callID, emptyResult())
        return
      }

      // Run the command inside the Docker container
      const execResult = await container.exec(state, ref.command, project)

      // Get filesystem diff
      const diffResult = await container.inspect(state)

      // Get network data from proxy logs if observe mode
      const networkData = proxyState
        ? proxy.mapFlows(await proxy.readLogs(proxyState))
        : { http: [], tls: [], dns: [] }

      // Build SandboxResult
      const result: SandboxResult = {
        files: diffResult.files,
        writes: diffResult.writes,
        mutations: diffResult.mutations,
        network: [],
        sockets: [],
        dns: networkData.dns,
        http: networkData.http,
        tls: networkData.tls,
        ssh: [],
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

      // Store result for tool.execute.after / UI display
      store.set(callID, result)

      // Replace the command with a no-op — it already ran inside Docker
      ref.command = 'true'
      stash.delete(callID)

      if (violations.length === 0 && cfg.auto_allow_clean) {
        // Clean — commit container state and auto-approve
        await container.approve(state)
        output.status = 'allow'
      } else if (violations.length > 0) {
        // Violations — write manifest for review prompt, leave as 'ask'
        const manifestPath = `/tmp/oc-sandbox-review-${callID}`
        await Bun.write(manifestPath, JSON.stringify({ violations, stdout: result.stdout, stderr: result.stderr }))
        // Rollback container to pre-command state
        await container.reject(state)
        // output.status remains 'ask' — user sees violation prompt
      } else {
        // No violations but auto_allow_clean is false — commit and ask
        await container.approve(state)
      }
    },

    'tool.execute.after': async (info) => {
      if (info.tool !== 'bash') return
      stash.delete(info.callID)
      // Clean up manifest file if it exists
      await rm(`/tmp/oc-sandbox-review-${info.callID}`, { force: true }).catch(() => {})
    },

    'shell.env': async (_info, output) => {
      output.env.OC_SANDBOX = '1'
      output.env.OC_SANDBOX_PROJECT = project
      output.env.OC_SANDBOX_WRITABLE = cfg.filesystem.allow_write.join(':')
      if (cfg.network.mode === 'observe' && cfg.network.allow_methods?.length) {
        output.env.OC_ALLOW_METHODS = cfg.network.allow_methods.join(',')
      }
    },
  }
}

function emptyResult(): SandboxResult {
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
    duration: 0,
    timedOut: false,
    violations: [],
    stdout: '',
    stderr: '',
    exitCode: 0,
  }
}

export default plugin
