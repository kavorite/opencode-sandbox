import { z } from "zod"
import path from "path"
import os from "os"


const schema = z.object({
  network: z
    .object({
      observe: z.boolean().default(true),
      allow: z.array(z.string()).default([]),
      allow_methods: z.array(z.string()).default(["GET", "HEAD", "OPTIONS"]),
      allow_graphql_queries: z.boolean().default(true),
    })
    .default({ observe: true, allow: [] }),
  filesystem: z
    .object({
      inherit_permissions: z.boolean().default(true),
      allow_write: z.array(z.string()).default([]),
      deny_read: z.array(z.string()).default([]),
    })
    .default({ inherit_permissions: true, allow_write: [], deny_read: [] }),
  auto_allow_clean: z.boolean().default(true),
  docker: z
    .object({
      image: z.string().default("opencode-sandbox:local"),
      gpu: z.boolean().default(true),
    })
    .default({ image: "opencode-sandbox:local", gpu: true }),
  verbose: z.boolean().default(false),
})

export type SandboxConfig = z.infer<typeof schema>

export const defaults = { network: { observe: true, allow_methods: ["GET", "HEAD", "OPTIONS"], allow_graphql_queries: true }, auto_allow_clean: true, docker: { image: "opencode-sandbox:local", gpu: true } }

async function read(file: string): Promise<Record<string, unknown> | undefined> {
  if (!await Bun.file(file).exists()) return undefined
  const text = await Bun.file(file).text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...a }
  for (const k of Object.keys(b)) {
    const av = a[k]
    const bv = b[k]
    if (bv !== null && typeof bv === "object" && !Array.isArray(bv) &&
        av !== null && typeof av === "object" && !Array.isArray(av)) {
      result[k] = deepMerge(av as Record<string, unknown>, bv as Record<string, unknown>)
      continue
    }
    result[k] = bv
  }
  return result
}

export async function load(directory: string, globalPath?: string): Promise<SandboxConfig> {
  const g = globalPath ?? path.join(os.homedir(), ".config", "opencode", "sandbox.json")
  const local = path.join(directory, ".opencode", "sandbox.json")

  const base = await read(g) ?? defaults
  const override = await read(local)
  const merged = override ? deepMerge(base, override) : base

  const result = schema.safeParse(merged)
  if (!result.success) {
    return schema.parse(defaults)
  }

  return result.data
}

export { schema }
