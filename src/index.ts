import type { PluginInput, Hooks, Plugin } from "@opencode-ai/plugin"
import * as config from "./config"
import * as deps from "./deps"
import * as store from "./store"
import * as sandbox from "./sandbox"
import * as policy from "./policy"

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const available = await deps.check()
  if (!available.available) return {}

  const cfg = await config.load(input.directory)
  const project = input.directory

  return {
    "permission.ask": async (info, output) => {
      try {
        if (info.type !== "bash") return

        const command = Array.isArray(info.pattern) ? info.pattern.join(" ") : info.pattern ?? ""
        const cwd = input.directory

        const result = await sandbox.run(command, cwd, cfg, available)
        const violations = policy.evaluate(result, cfg, project)
        store.set(info.callID ?? info.id, { ...result, violations })

        if (cfg.verbose) {
          console.log(
            `[sandbox] id=${info.id} violations=${violations.length} timedOut=${result.timedOut} duration=${result.duration}ms dns=${result.dns.length} tls=${result.tls.length} http=${result.http.length} net=${result.network.length}`,
          )
        }

        // Timed out — incomplete observations, don't auto-approve
        if (result.timedOut) return

        // Observe+proxy mode: network activity without HTTP entries means the proxy
        // didn't complete the TLS handshake — we can't verify the HTTP method
        const proxy = cfg.network.allow_methods && cfg.network.allow_methods.length > 0
        const network = result.dns.length > 0 || result.tls.length > 0 || result.network.length > 0
        if (proxy && network && result.http.length === 0 && result.ssh.length === 0) return

        if (violations.length === 0 && cfg.auto_allow_clean) {
          output.status = "allow"
          return
        }

        if (cfg.verbose && violations.length > 0) {
          const report = violations.map((v) => `[${v.severity}] ${v.type}: ${v.detail}`).join("\n")
          console.log(`[sandbox] violations for ${info.id}:\n${report}`)
        }
      } catch (err) {
        console.error("[sandbox] ERROR in permission.ask:", err)
      }
    },
  }
}

export default plugin
