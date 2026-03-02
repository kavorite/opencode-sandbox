import { z } from "zod"
import path from "path"
import os from "os"

export const TIMEOUT = 1000

const schema = z.object({
  timeout: z.number().default(TIMEOUT),
  network: z
    .object({
      mode: z.enum(["block", "log", "observe"]).default("block"),
      allow: z.array(z.string()).default([]),
      allow_methods: z.array(z.string()).optional(),
    })
    .default({ mode: "block", allow: [] }),
  filesystem: z
    .object({
      inherit_permissions: z.boolean().default(true),
      allow_write: z.array(z.string()).default([]),
      deny_read: z.array(z.string()).default([]),
    })
    .default({ inherit_permissions: true, allow_write: [], deny_read: [] }),
  auto_allow_clean: z.boolean().default(true),
  home_readable: z.boolean().default(true),
  verbose: z.boolean().default(false),
  strace_bufsize: z.number().optional(),
})

export type SandboxConfig = z.infer<typeof schema>

export const defaults = { timeout: TIMEOUT, network: { mode: "observe" as const, allow_methods: ["GET", "HEAD", "OPTIONS"] }, auto_allow_clean: true }

async function read(file: string): Promise<Record<string, unknown> | undefined> {
  if (!await Bun.file(file).exists()) return undefined
  const text = await Bun.file(file).text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    console.warn(`Failed to parse ${file}: invalid JSON`)
    return undefined
  }
}

export async function load(directory: string, globalPath?: string): Promise<SandboxConfig> {
  const g = globalPath ?? path.join(os.homedir(), ".config", "opencode", "sandbox.json")
  const local = path.join(directory, ".opencode", "sandbox.json")

  const base = await read(g) ?? defaults
  const override = await read(local)
  const merged = override ? { ...base, ...override } : base

  const result = schema.safeParse(merged)
  if (!result.success) {
    console.warn(`Invalid sandbox config:`, result.error.message)
    return schema.parse(defaults)
  }

  return result.data
}

export { schema }
