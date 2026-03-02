#!/usr/bin/env bun
/**
 * Full test matrix for observe+proxy mode.
 *
 * Matrix:
 *   Commands: echo (clean), curl GET, curl POST
 *   Timeouts: 100ms (under budget for curl), 500..5000ms (sweep for clean threshold)
 *
 * Expected confusion matrix at correct timeout:
 *   echo  → ALLOW         (no network, no violations)
 *   GET   → ALLOW         (HTTP GET observed, in allow_methods → 0 violations)
 *   POST  → ASK(violation) (HTTP POST observed, NOT in allow_methods → violation)
 *
 * Under budget (timeout too short for curl):
 *   GET   → ASK(timeout)
 *   POST  → ASK(timeout)
 */
import { run } from "../src/sandbox"
import { evaluate } from "../src/policy"
import { check } from "../src/deps"

const available = await check()
if (!available.available) {
  console.error("deps not available:", available)
  process.exit(1)
}

const timeouts = [100, 250, 500, 1000, 1500, 2000, 3000, 5000]
const commands = [
  { label: "echo", cmd: "echo CLEAN" },
  { label: "GET", cmd: "curl -s https://httpbin.org/get" },
  { label: "POST", cmd: "curl -s -X POST https://httpbin.org/post" },
]

const cfg = {
  timeout: 0,
  network: { mode: "observe" as const, allow: [] as string[], allow_methods: ["GET", "HEAD", "OPTIONS"] },
  filesystem: { inherit_permissions: true, allow_write: [] as string[], deny_read: [] as string[] },
  auto_allow_clean: true,
  verbose: false,
}

console.log("timeout | command | duration | timedOut | dns | tls | http | net | http_methods | violations | decision")
console.log("--------|---------|----------|---------|-----|-----|------|-----|-------------|------------|--------")

for (const ms of timeouts) {
  for (const { label, cmd } of commands) {
    cfg.timeout = ms
    const result = await run(cmd, "/tmp", cfg, available)
    const violations = evaluate(result, cfg, "/tmp")

    const methods = result.http.map((h) => h.method).join(",") || "-"
    const proxy = cfg.network.allow_methods.length > 0
    const network = result.dns.length > 0 || result.tls.length > 0 || result.network.length > 0
    const incomplete = proxy && network && result.http.length === 0

    const decision = result.timedOut
      ? "ASK(timeout)"
      : incomplete
        ? "ASK(incomplete)"
        : violations.length > 0
          ? `ASK(${violations.length} violations)`
          : "ALLOW"

    console.log(
      `${String(ms).padStart(7)} | ${label.padEnd(7)} | ${String(Math.round(result.duration)).padStart(8)}ms | ${String(result.timedOut).padEnd(7)} | ${String(result.dns.length).padStart(3)} | ${String(result.tls.length).padStart(3)} | ${String(result.http.length).padStart(4)} | ${String(result.network.length).padStart(3)} | ${methods.padEnd(11)} | ${String(violations.length).padStart(10)} | ${decision}`,
    )
  }
}
