// Compile observe.c and ca-gen.c at install time with optional TLS support.
// Exits 0 always — never fails the install.

import path from "path"

const root = path.resolve(import.meta.dir, "..")
const src = path.join(root, "src", "observe.c")
const binDir = path.join(root, "bin")
const out = path.join(binDir, "oc-observe")
const caGen = path.join(binDir, "ca-gen")
const vendor = path.join(root, "vendor", "mbedtls")
const mbedInclude = path.join(vendor, "include")
const mbedLib = path.join(vendor, "library")

// Only compile on Linux
if (process.platform !== "linux") {
  process.stderr.write("opencode-sandbox: postinstall — skipping observe binary (non-Linux)\n")
  process.exit(0)
}

// Check kernel version >= 5.14
const uname = Bun.spawn(["uname", "-r"], { stdio: ["ignore", "pipe", "ignore"] })
await uname.exited
const version = (await new Response(uname.stdout).text()).trim()
const parts = version.split(".").map(Number)
if ((parts[0] ?? 0) < 5 || ((parts[0] ?? 0) === 5 && (parts[1] ?? 0) < 14)) {
  process.stderr.write(
    `opencode-sandbox: postinstall — kernel ${version} too old (need >= 5.14), skipping observe binary\n`,
  )
  process.exit(0)
}

// Check cc availability
const ccCheck = Bun.spawn(["cc", "--version"], { stdio: ["ignore", "ignore", "ignore"] })
await ccCheck.exited
if (ccCheck.exitCode !== 0) {
  process.stderr.write("opencode-sandbox: postinstall — cc not found, skipping observe binary (install gcc or clang)\n")
  process.exit(0)
}

// Ensure bin directory exists
await Bun.spawn(["mkdir", "-p", binDir], { stdio: ["ignore", "ignore", "ignore"] }).exited

// Check for TLS support (mbedTLS vendor)
const hasTls = await Bun.file(path.join(mbedInclude, "mbedtls", "ssl.h")).exists()

// Compile oc-observe with optional TLS support
if (hasTls) {
  const cmd = `cc -DOC_TLS_PROXY -Wall -O2 -I${mbedInclude} -I${mbedLib} -I${path.join(root, "src")} -o ${out} ${path.join(root, "src", "observe.c")} ${path.join(root, "src", "tls.c")} ${mbedLib}/*.c`
  const observe = Bun.spawn(["sh", "-c", cmd], { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 })
  await observe.exited

  if (observe.exitCode !== 0) {
    const err = await new Response(observe.stderr).text()
    process.stderr.write(`opencode-sandbox: postinstall — oc-observe compilation failed (observe mode unavailable):\n${err}\n`)
    process.exit(0)
  }

  process.stdout.write(`opencode-sandbox: postinstall — compiled ${out} with TLS support\n`)
}

if (!hasTls) {
  const observe = Bun.spawn(["cc", "-Wall", "-Wextra", "-O2", "-o", out, src], { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 })
  await observe.exited

  if (observe.exitCode !== 0) {
    const err = await new Response(observe.stderr).text()
    process.stderr.write(`opencode-sandbox: postinstall — oc-observe compilation failed (observe mode unavailable):\n${err}\n`)
    process.exit(0)
  }

  process.stdout.write(`opencode-sandbox: postinstall — compiled ${out} (TLS support unavailable)\n`)
}

// Compile ca-gen if TLS support is available
if (hasTls) {
  const cmd = `cc -DOC_TLS_PROXY -Wall -O2 -I${mbedInclude} -I${mbedLib} -o ${caGen} ${path.join(root, "src", "ca_gen.c")} ${mbedLib}/*.c`
  const ca = Bun.spawn(["sh", "-c", cmd], { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 })
  await ca.exited

  if (ca.exitCode !== 0) {
    const err = await new Response(ca.stderr).text()
    process.stderr.write(`opencode-sandbox: postinstall — ca-gen compilation failed:\n${err}\n`)
    process.exit(0)
  }

  process.stdout.write(`opencode-sandbox: postinstall — compiled ${caGen}\n`)
}

if (!hasTls) {
  process.stdout.write(`opencode-sandbox: postinstall — compiled ${out} (TLS support unavailable)\n`)
}
