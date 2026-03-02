import path from "path";
import type { PluginInput, Hooks, Plugin } from "@opencode-ai/plugin";
import * as config from "./config";
import * as deps from "./deps";
import * as store from "./store";
import * as sandbox from "./sandbox";
import * as policy from "./policy";

function bash(
  info: {
    id: string;
    pattern?: string | string[];
    metadata?: Record<string, unknown>;
    callID?: string;
  },
  output: { status: string },
  cfg: config.SandboxConfig,
  project: string,
  directory: string,
  available: Awaited<ReturnType<typeof deps.check>>,
) {
  const command =
    (info.metadata?.command as string) ||
    (Array.isArray(info.pattern)
      ? info.pattern.join(" ; ")
      : (info.pattern ?? ""));
  const cwd = (info.metadata?.cwd as string) || directory;

  return sandbox.run(command, cwd, cfg, available).then((result) => {
    const allow = cwd !== project ? [...cfg.filesystem.allow_write, cwd] : cfg.filesystem.allow_write;
    const violations = policy.evaluate(result, { ...cfg, filesystem: { ...cfg.filesystem, allow_write: allow } }, project);
    store.set(info.callID ?? info.id, { ...result, violations });

    if (cfg.verbose) {
      console.log(
        `[sandbox] id=${info.id} violations=${violations.length} timedOut=${result.timedOut} duration=${result.duration}ms dns=${result.dns.length} tls=${result.tls.length} http=${result.http.length} net=${result.network.length}`,
      );
    }

    if (result.timedOut) return;

    // Proxy fallback: only when observe mode is actually running (not just configured).
    // AF_UNIX (docker, dbus, etc.) is local IPC — exclude from internet traffic check.
    const observe = cfg.network.mode === "observe" && available.observe;
    const proxy = observe && cfg.network.allow_methods && cfg.network.allow_methods.length > 0;
    const inet =
      result.dns.length > 0 ||
      result.tls.length > 0 ||
      result.network.some((n) => n.family === "AF_INET" || n.family === "AF_INET6");
    if (proxy && inet && result.http.length === 0 && result.ssh.length === 0)
      return;

    if (violations.length === 0 && cfg.auto_allow_clean) {
      output.status = "allow";
      return;
    }

    if (cfg.verbose && violations.length > 0) {
      const report = violations
        .map((v) => `[${v.severity}] ${v.type}: ${v.detail}`)
        .join("\n");
      console.log(`[sandbox] violations for ${info.id}:\n${report}`);
    }
  });
}

function edit(
  info: { id: string; metadata?: Record<string, unknown> },
  output: { status: string },
  cfg: config.SandboxConfig,
  project: string,
) {
  const filepath = info.metadata?.filepath as string | undefined;
  if (!filepath) return;

  const targets = filepath.includes(", ") ? filepath.split(", ") : [filepath];
  const violations: store.Violation[] = targets
    .map((t) => (path.isAbsolute(t) ? t : path.resolve(project, t)))
    .filter(
      (t) =>
        !policy.writable(t, path.resolve(project), cfg.filesystem.allow_write),
    )
    .map(
      (t): store.Violation => ({
        type: "filesystem",
        syscall: "write",
        detail: `Edit to ${t} (outside project)`,
        severity: "medium",
      }),
    );

  if (cfg.verbose && violations.length > 0) {
    const report = violations
      .map((v) => `[${v.severity}] ${v.type}: ${v.detail}`)
      .join("\n");
    console.log(`[sandbox] edit violations for ${info.id}:\n${report}`);
  }

  if (violations.length === 0 && cfg.auto_allow_clean) {
    output.status = "allow";
    return;
  }
}

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const available = await deps.check();
  if (!available.available) return {};

  const cfg = await config.load(input.directory);
  const project = input.directory;
  return {
    "permission.ask": async (info, output) => {
      try {
        if (info.type === "bash")
          return bash(info, output, cfg, project, input.directory, available);
        if (info.type === "edit") return edit(info, output, cfg, project);
      } catch (err) {
        console.error("[sandbox] ERROR in permission.ask:", err);
      }
    },
  };
};

export default plugin;
