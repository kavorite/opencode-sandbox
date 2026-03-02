import { z } from "zod"
import path from "path"

const schema = z.object({
  timeout: z.number().default(250),
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

export async function load(directory: string): Promise<SandboxConfig> {
  const file = path.join(directory, ".opencode", "sandbox.json")
  const exists = await Bun.file(file).exists()

  if (!exists) {
    const defaults = { timeout: 6000, network: { mode: "observe", allow_methods: ["GET", "HEAD", "OPTIONS"] }, auto_allow_clean: true }
    await Bun.write(file, JSON.stringify(defaults, null, 2) + "\n")
    return schema.parse(defaults)
  }

  const text = await Bun.file(file).text()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    console.warn(`Failed to parse ${file}: invalid JSON`)
    return schema.parse({})
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    console.warn(`Invalid sandbox config in ${file}:`, result.error.message)
    return schema.parse({})
  }

  return result.data
}

export { schema }
