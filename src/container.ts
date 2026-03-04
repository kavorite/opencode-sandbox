import fs from 'fs'
import { execSync } from 'child_process'
import path from 'path'
import Dockerode from 'dockerode'
import * as docker from './docker.js'
import { ensureImage } from './image.js'
import { mapChanges, snapshotKey } from './diff.js'
import type { SandboxConfig } from './config.js'
import type { ExecResult } from './docker.js'
import type { DiffResult } from './diff.js'

// Re-export so callers don't need to import from diff/docker directly
export type { DiffResult, ExecResult }

export type SessionState = {
  container: Dockerode.Container
  network: Dockerode.Network
  imageTag: string
  sessionId: string
  project: string
  home: string
  /** The home directory of the user inside the container (e.g. /home/sandbox) */
  containerHome: string
  dockerClient: Dockerode
  binds: string[]
  env: string[]
  gpu: boolean
  /** Docker network mode (network name) used when creating containers */
  networkMode: string
  /** Whether this session owns the Docker network (false for sub-agents sharing parent's network) */
  ownsNetwork: boolean
  /** Baseline container.changes() snapshot — changes present before any command runs.
   *  Used to compute deltas so runtime-injected artifacts (GPU drivers etc.) are excluded. */
  baseline: Set<string>
}

export async function init(
  dockerClient: Dockerode,
  project: string,
  home: string,
  sessionId: string,
  config: SandboxConfig,
  existingNetworkName?: string,
): Promise<SessionState> {
  let networkName: string
  let network: Dockerode.Network
  let ownsNetwork: boolean

  if (existingNetworkName) {
    // Sub-agent: join parent's existing network (verify it still exists)
    try {
      network = dockerClient.getNetwork(existingNetworkName)
      await network.inspect()
      networkName = existingNetworkName
      ownsNetwork = false
    } catch {
      // Parent's network gone — create our own
      networkName = `oc-sandbox-${sessionId}`
      network = await docker.createNetwork(dockerClient, networkName, sessionId)
      ownsNetwork = true
    }
  } else {
    // Primary session: create new network
    networkName = `oc-sandbox-${sessionId}`
    network = await docker.createNetwork(dockerClient, networkName, sessionId)
    ownsNetwork = true
  }

  // Ensure image exists
  const imageName = await ensureImage(dockerClient)

  // Build env vars — forward host environment for transparent execution
  // Merge host PATH with container-essential paths: modern distros merge /bin → /usr/bin
  // (symlink) so host PATH may omit /bin, but Alpine has /bin as a real separate directory.
  const CONTAINER_PATHS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']
  const hostPathParts = (process.env.PATH ?? '').split(':').filter(Boolean)
  const mergedPath = [...hostPathParts, ...CONTAINER_PATHS.filter(p => !hostPathParts.includes(p))].join(':')
  const env = [
    `HOME=${home}`,
    `PATH=${mergedPath}`,
    'OC_SANDBOX=1',
    `OC_SANDBOX_PROJECT=${project}`,
  ]
  // Forward host env vars that tools/runtimes depend on
  const FORWARD_ENV = [
    'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND',
    'LANG', 'LC_ALL', 'TERM',
    'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME',
    'NVM_DIR', 'PYENV_ROOT', 'VIRTUAL_ENV', 'CONDA_DEFAULT_ENV',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'NODE_OPTIONS', 'EDITOR', 'VISUAL', 'DOCKER_HOST',
  ] as const
  for (const key of FORWARD_ENV) {
    if (process.env[key]) env.push(`${key}=${process.env[key]}`)
  }
  if (config.network.observe && config.network.allow_methods?.length) {
    env.push('HTTP_PROXY=http://mitmproxy:8080')
    env.push('HTTPS_PROXY=http://mitmproxy:8080')
  }

  // Bind mounts: $HOME read-only (gives access to ~/.local/bin, ~/.cargo, ~/.nvm, etc.)
  // + project dir read-write (Docker overlapping mount: more-specific path wins)
  const binds = [
    `${home}:${home}:ro`,
    `${project}:${project}`,
  ]

  // Forward SSH agent socket if available (needs rw access to the socket)
  if (process.env.SSH_AUTH_SOCK) {
    binds.push(`${process.env.SSH_AUTH_SOCK}:${process.env.SSH_AUTH_SOCK}`)
  }

  // Git worktree support: if .git is a file (linked worktree), bind-mount the
  // main repository's .git directory so git commands can update objects/refs/config.
  // Must be read-write: git fetch writes to refs/remotes/ and packed-refs,
  // git push -u writes tracking config — all stored in the common git dir.
  const dotGitPath = path.join(project, '.git')
  if (fs.existsSync(dotGitPath) && fs.statSync(dotGitPath).isFile()) {
    const content = fs.readFileSync(dotGitPath, 'utf8').trim()
    const match = content.match(/^gitdir:\s*(.+)$/m)
    if (match) {
      // gitdir is like /main-repo/.git/worktrees/<name>
      // The common git dir (objects, refs, config) is two levels up
      const gitdir = path.resolve(project, match[1]!)
      const commonGitDir = path.resolve(gitdir, '..', '..')
      if (fs.existsSync(commonGitDir) && !binds.some(b => b.split(':')[0] === commonGitDir)) {
        binds.push(`${commonGitDir}:${commonGitDir}`)
      }
    }
  }

  // Create container (with GPU passthrough if enabled)
  const containerOpts = {
    sessionId,
    image: config.docker.image ?? imageName,
    cmd: ['sleep', 'infinity'] as string[],
    binds,
    networkMode: networkName,
    env,
    workingDir: project,
    name: `oc-sandbox-${sessionId}`,
    gpu: config.docker.gpu ?? true,
  }
  let container = await docker.createContainer(dockerClient, containerOpts)

  // Start with GPU fallback — if GPU requested but runtime missing, retry without
  try {
    await container.start()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (containerOpts.gpu && (msg.includes('could not select device driver') || msg.includes('nvidia') || msg.includes('GPU') || msg.includes('OCI runtime'))) {
      // GPU runtime not available — remove failed container, retry without GPU
      try { await container.remove({ force: true }) } catch { /* ignore */ }
      containerOpts.gpu = false
      containerOpts.name = `oc-sandbox-${sessionId}-nogpu`
      container = await docker.createContainer(dockerClient, containerOpts)
      await container.start()
    } else {
      throw err
    }
  }

  // Detect the container image user's actual home directory (not the env-overridden $HOME)
  // We use getent passwd to read from /etc/passwd, bypassing the HOME env var we set.
  const containerHomeResult = await docker.execCommand(
    container,
    ['sh', '-c', 'getent passwd $(id -u) | cut -d: -f6'],
    {},
  )
  const containerHome = containerHomeResult.stdout.trim() || '/home/sandbox'

  // Warm up: trigger lazy runtime init (ldconfig etc.) before capturing baseline.
  // Without this, the first real command's diff would include ldconfig artifacts.
  await docker.execCommand(container, ['true'], {})

  // Capture baseline: changes present after container start + warm-up (runtime injections
  // like GPU drivers, ldconfig cache). Subtracted from post-command diffs so only
  // command-caused changes are reported.
  const baselineChanges = await docker.getChanges(container)
  const baseline = new Set(baselineChanges.map(snapshotKey))

  // Commit base state
  const baseTag = `opencode-sandbox:${sessionId}-base`
  await docker.commitContainer(container, baseTag)

  const state: SessionState = {
    container,
    network,
    imageTag: baseTag,
    sessionId,
    project,
    home,
    containerHome,
    dockerClient,
    binds,
    env,
    gpu: containerOpts.gpu,
    networkMode: networkName,
    ownsNetwork,
    baseline,
  }

  // Register cleanup on process exit.
  // Use synchronous Docker CLI for 'exit' event (async ops don't complete on 'exit').
  // SIGTERM/SIGINT use async teardown since handlers can await before the process exits.
  const syncCleanup = () => {
    try { execSync(`docker rm -f ${state.container.id}`, { stdio: 'ignore', timeout: 5000 }) } catch { /* best-effort */ }
    try { execSync(`docker network rm ${networkName}`, { stdio: 'ignore', timeout: 5000 }) } catch { /* best-effort */ }
  }
  const asyncCleanup = () => { teardown(state).catch(() => {}) }
  process.once('exit', syncCleanup)
  process.once('SIGTERM', asyncCleanup)
  process.once('SIGINT', asyncCleanup)
  process.once('uncaughtException', asyncCleanup)

  return state
}

export async function exec(
  state: SessionState,
  cmd: string,
  cwd: string,
): Promise<ExecResult> {
  try {
    return await docker.execCommand(state.container, ['sh', '-c', cmd], { WorkingDir: cwd, trace: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('paused')) {
      // Container stuck paused (e.g. after commit race) — unpause and retry
      try { await state.container.unpause() } catch { /* already unpaused */ }
      return docker.execCommand(state.container, ['sh', '-c', cmd], { WorkingDir: cwd, trace: true })
    }
    throw err
  }
}

export async function inspect(
  state: SessionState,
): Promise<DiffResult> {
  const changes = await docker.getChanges(state.container)
  const result = mapChanges(changes, state.project, state.home, state.binds, state.containerHome, state.baseline)
  // Update baseline so the next command's diff is also a clean delta
  for (const c of changes) state.baseline.add(snapshotKey(c))
  return result
}

export async function approve(state: SessionState): Promise<void> {
  const newTag = `opencode-sandbox:${state.sessionId}-approved-${Date.now()}`
  const oldTag = state.imageTag
  try {
    await docker.commitContainer(state.container, newTag)
    state.imageTag = newTag
  } finally {
    // Docker pauses the container during commit — ensure we always unpause,
    // even if commit fails, to prevent 'container is paused' errors on next exec.
    try { await state.container.unpause() } catch { /* already running */ }
  }
  // Remove previous snapshot — only the latest matters for rollback
  if (oldTag !== newTag) {
    try { await docker.removeImage(state.dockerClient, oldTag) } catch { /* best effort */ }
  }
}

export async function reject(state: SessionState): Promise<void> {
  // Stop and remove current (dirty) container
  try { await state.container.stop({ t: 1 }) } catch { /* already stopped */ }
  await state.container.remove({ force: true })

  // Recreate from last committed image (preserving SSH binds and env)
  const newContainer = await docker.createContainer(state.dockerClient, {
    sessionId: state.sessionId,
    image: state.imageTag,
    cmd: ['sleep', 'infinity'],
    binds: state.binds,
    networkMode: state.networkMode,
    env: state.env,
    workingDir: state.project,
    gpu: state.gpu,
    name: `oc-sandbox-${state.sessionId}-${Date.now()}`,
  })
  await newContainer.start()
  state.container = newContainer
}

export async function teardown(state: SessionState): Promise<void> {
  // Stop + remove container
  try { await state.container.stop({ t: 1 }) } catch { /* already stopped */ }
  try { await state.container.remove({ force: true }) } catch { /* already removed */ }

  // Remove network only if this session owns it (sub-agents share parent's network)
  if (state.ownsNetwork) {
    try { await state.network.remove() } catch { /* already removed */ }
  }

  // Clean up all committed images for this session (label-based)
  await docker.cleanup(state.dockerClient, state.sessionId)
}
