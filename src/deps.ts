import path from "path"


interface Deps {
  bwrap: boolean
  strace: boolean
  observe: boolean
  overlay: boolean
  available: boolean
}

let cached: Deps | null = null

async function testBwrap(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bwrap", "--ro-bind", "/", "/", "--unshare-user", "true"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    })

    const timeout = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill()
        resolve(false)
      }, 5000)

      proc.exited.then(() => {
        clearTimeout(timer)
        resolve(proc.exitCode === 0)
      })
    })

    return await timeout
  } catch (_e) {
    return false
  }
}

async function testOverlay(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bwrap", "--ro-bind", "/", "/", "--overlay-src", "/tmp", "--tmp-overlay", "/tmp", "true"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    })

    const timeout = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill()
        resolve(false)
      }, 5000)

      proc.exited.then(() => {
        clearTimeout(timer)
        resolve(proc.exitCode === 0)
      })
    })

    return await timeout
  } catch (_e) {
    return false
  }
}

async function testStrace(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["strace", "-V"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    })

    const result = await proc.exited
    return result === 0
  } catch (_e) {
    return false
  }
}

async function testObserve(): Promise<boolean> {
  const bin = path.join(import.meta.dir, "..", "bin", "oc-observe")
  return await Bun.file(bin).exists()
}

export async function check(): Promise<Deps> {
  if (cached) return cached

  const [bwrap, strace, observe, overlay] = await Promise.all([testBwrap(), testStrace(), testObserve(), testOverlay()])

  if (!bwrap) {
    console.warn("opencode-sandbox: bwrap not available. Install: apt install bubblewrap / pacman -S bubblewrap")
  }

  if (!strace) {
    console.warn("opencode-sandbox: strace not available. Install: apt install strace / pacman -S strace")
  }

  cached = {
    bwrap,
    strace,
    observe,
    overlay,
    available: bwrap && strace,
  }

  return cached
}

export function reset(): void {
  cached = null
}
