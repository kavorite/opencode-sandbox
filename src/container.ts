import fs from 'fs'
import { execSync } from 'child_process'
import path from 'path'
import Dockerode from 'dockerode'
import * as docker from './docker.js'
import { ensureImage } from './image.js'
import { mapChanges, snapshotKey } from './diff.js'
import { getParser } from './parse.js'
import type { SandboxConfig } from './config.js'
import type { ExecResult } from './docker.js'
import type { DiffResult } from './diff.js'
import type { Node as TSNode } from 'web-tree-sitter'

/**
 * Resolve git worktree bind mounts for a directory.
 * If `dir` contains a `.git` file (linked worktree), returns rw bind mounts for:
 *   1. The common git dir (objects, refs, config) — so index/refs updates persist
 *   2. The base worktree's working directory — so cross-worktree git ops work
 * If `dir` is a regular git repo (`.git` is a directory), returns an rw bind for `dir` itself.
 * Returns empty array if `dir` is not a git repo or worktree.
 */
export function resolveGitBinds(dir: string, existingBinds: string[]): string[] {
  const extra: string[] = []
  const alreadyBound = (p: string) => existingBinds.some(b => {
    if (b.endsWith(':ro')) return false // ro binds don't count — we need rw
    const hostPath = b.split(':')[0]!
    return p === hostPath || p.startsWith(hostPath + '/')
  })

  const dotGitPath = path.join(dir, '.git')
  if (!fs.existsSync(dotGitPath)) return extra

  if (fs.statSync(dotGitPath).isFile()) {
    // Linked worktree: .git is a file containing `gitdir: <path>`
    const content = fs.readFileSync(dotGitPath, 'utf8').trim()
    const match = content.match(/^gitdir:\s*(.+)$/m)
    if (match) {
      // gitdir is like /main-repo/.git/worktrees/<name>
      // The common git dir (objects, refs, config) is two levels up
      const gitdir = path.resolve(dir, match[1]!)
      const commonGitDir = path.resolve(gitdir, '..', '..')
      if (fs.existsSync(commonGitDir) && !alreadyBound(commonGitDir)) {
        extra.push(`${commonGitDir}:${commonGitDir}`)
      }
      // Also mount the base worktree's working directory rw
      const baseWorktree = path.resolve(commonGitDir, '..')
      if (fs.existsSync(baseWorktree) && !alreadyBound(baseWorktree)) {
        extra.push(`${baseWorktree}:${baseWorktree}`)
      }
    }
    // The worktree dir itself needs to be writable
    if (!alreadyBound(dir)) {
      extra.push(`${dir}:${dir}`)
    }
  } else if (fs.statSync(dotGitPath).isDirectory()) {
    // Regular git repo — mount the repo dir rw
    if (!alreadyBound(dir)) {
      extra.push(`${dir}:${dir}`)
    }
  }

  return extra
}

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

  // Build env vars — forward host environment for transparent execution.
  // Host /usr is mounted read-only at /host/usr so the container inherits every host-
  // installed tool and the correct glibc version without baking anything into the image.
  // Prepend /host/usr/bin first so host tools shadow the minimal Arch base binaries.
  const HOST_USR = '/host/usr'
  const HOST_USR_PATHS = [`${HOST_USR}/bin`, `${HOST_USR}/local/bin`]
  const CONTAINER_PATHS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']
  const hostPathParts = (process.env.PATH ?? '').split(':').filter(Boolean)
  const mergedPath = [
    ...HOST_USR_PATHS,
    ...hostPathParts,
    ...CONTAINER_PATHS.filter(p => !hostPathParts.includes(p) && !HOST_USR_PATHS.includes(p)),
  ].join(':')
  const env = [
    `HOME=${home}`,
    `PATH=${mergedPath}`,
    'OC_SANDBOX=1',
    'OC_SANDBOX_CONTAINER=1',
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
    'GH_TOKEN', 'GITHUB_TOKEN',
  ] as const
  for (const key of FORWARD_ENV) {
    if (process.env[key]) env.push(`${key}=${process.env[key]}`)
  }
  if (config.network.observe && config.network.allow_methods?.length) {
    env.push('HTTP_PROXY=http://mitmproxy:8080')
    env.push('HTTPS_PROXY=http://mitmproxy:8080')
  }

  // Bind mounts:
  //   /usr/lib → /usr/lib:ro  — mount host libs at the standard path so host
  //     programs find their deps (e.g. libz-ng for git) without LD_LIBRARY_PATH.
  //     Safe because host and container are both Arch; glibc ABI is compatible.
  //   /usr → /host/usr:ro     — full host /usr tree so PATH can include
  //     /host/usr/bin and programs find their share data via their own prefix.
  //   $HOME → $HOME:ro        — ~/.local/bin, ~/.cargo/bin, ~/.config/gh, etc.
  //   $project → $project     — read-write for the agent's actual work
  const binds = [
    '/usr/lib:/usr/lib:ro',
    `/usr:${HOST_USR}:ro`,
    `${home}:${home}:ro`,
    `${project}:${project}`,
  ]

  // Forward SSH agent socket if available (needs rw access to the socket)
  if (process.env.SSH_AUTH_SOCK) {
    binds.push(`${process.env.SSH_AUTH_SOCK}:${process.env.SSH_AUTH_SOCK}`)
  }

  // Git worktree support: resolve bind mounts for the project's git worktree
  // (if it is one) so git commands can update objects/refs/config.
  const projectGitBinds = resolveGitBinds(project, binds)
  binds.push(...projectGitBinds)

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

/**
 * Extract external directory paths from a shell command that indicate where
 * filesystem writes will occur. Uses tree-sitter-bash AST parsing to accurately
 * detect:
 *   - `git -C <path>` / `git --git-dir=<path>` / `git --work-tree=<path>`
 *   - `cd <path> && ...` patterns
 * Returns resolved absolute paths that are outside the project directory.
 */
async function extractExternalPaths(cmd: string, project: string): Promise<string[]> {
  const parser = await getParser()
  const tree = parser.parse(cmd)
  if (!tree) return []

  const paths: string[] = []

  // Walk all `command` nodes in the AST
  const commands = tree.rootNode.descendantsOfType('command')
  for (const cmdNode of commands) {
    const nameNode = cmdNode.childForFieldName('name') ?? cmdNode.children.find((c: TSNode) => c.type === 'command_name')
    if (!nameNode) continue
    const cmdName = nameNode.text

    // Collect all direct word children (arguments) of this command node
    const args = cmdNode.children.filter((c: TSNode) => c.type === 'word' || c.type === 'string' || c.type === 'raw_string' || c.type === 'concatenation')

    if (cmdName === 'git') {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!.text

        // git -C <path>
        if (arg === '-C' && i + 1 < args.length) {
          paths.push(args[i + 1]!.text)
          i++ // skip the path argument
          continue
        }

        // git --work-tree=<path> or --work-tree <path>
        if (arg.startsWith('--work-tree=')) {
          paths.push(arg.slice('--work-tree='.length))
          continue
        }
        if (arg === '--work-tree' && i + 1 < args.length) {
          paths.push(args[i + 1]!.text)
          i++
          continue
        }

        // git --git-dir=<path> or --git-dir <path>
        if (arg.startsWith('--git-dir=')) {
          // For --git-dir, the writable target is the parent directory
          paths.push(path.dirname(path.resolve(arg.slice('--git-dir='.length))))
          continue
        }
        if (arg === '--git-dir' && i + 1 < args.length) {
          paths.push(path.dirname(path.resolve(args[i + 1]!.text)))
          i++
          continue
        }
      }
    } else if (cmdName === 'cd') {
      // cd <path> — the first argument is the target directory
      if (args.length > 0) {
        paths.push(args[0]!.text)
      }
    }
  }

  // Deduplicate and filter to only external (outside project) absolute paths
  const normalized = path.resolve(project)
  return [...new Set(
    paths
      .map(p => path.resolve(p))
      .filter(p => p !== normalized && !p.startsWith(normalized + '/'))
  )]
}

/**
 * Ensure `dir` is writable inside the container. If `dir` falls outside the
 * project directory (and thus under the read-only HOME mount), we resolve its
 * git repo/worktree structure, add rw bind mounts, and recreate the container.
 * This is a no-op if `dir` is already writable (inside project or previously mounted).
 */
export async function ensureWritable(state: SessionState, dir: string): Promise<void> {
  const normalized = path.resolve(dir)
  // Already inside the project dir (which is rw)
  if (normalized === state.project || normalized.startsWith(state.project + '/')) return

  // Check if already covered by an existing rw bind mount
  const isAlreadyWritable = state.binds.some(b => {
    if (b.endsWith(':ro')) return false
    // Bind format: host:container or host:container:rw
    const parts = b.split(':')
    const hostPath = parts[0]!
    return normalized === hostPath || normalized.startsWith(hostPath + '/')
  })
  if (isAlreadyWritable) return

  // Resolve git binds for this directory
  const extraBinds = resolveGitBinds(normalized, state.binds)
  if (extraBinds.length === 0) {
    // Not a git repo/worktree — mount the dir itself as rw
    extraBinds.push(`${normalized}:${normalized}`)
  }

  // Recreate container with updated binds (commit current state first to preserve it)
  const newTag = `opencode-sandbox:${state.sessionId}-remount-${Date.now()}`
  const oldTag = state.imageTag
  try {
    await docker.commitContainer(state.container, newTag)
    state.imageTag = newTag
  } finally {
    try { await state.container.unpause() } catch { /* already running */ }
  }
  if (oldTag !== newTag) {
    try { await docker.removeImage(state.dockerClient, oldTag) } catch { /* best effort */ }
  }

  // Stop and remove current container
  try { await state.container.stop({ t: 1 }) } catch { /* already stopped */ }
  await state.container.remove({ force: true })

  // Update binds with the new mounts
  state.binds.push(...extraBinds)

  // Recreate from committed image with updated binds
  const newContainer = await docker.createContainer(state.dockerClient, {
    sessionId: state.sessionId,
    image: state.imageTag,
    cmd: ['sleep', 'infinity'],
    binds: state.binds,
    networkMode: state.networkMode,
    env: state.env,
    workingDir: state.project,
    gpu: state.gpu,
    name: `oc-sandbox-${state.sessionId}-remount-${Date.now()}`,
  })
  await newContainer.start()
  state.container = newContainer
}

export async function exec(
  state: SessionState,
  cmd: string,
  cwd: string,
): Promise<ExecResult> {
  // Ensure cwd and any external paths referenced in the command are writable
  await ensureWritable(state, cwd)
  for (const extPath of await extractExternalPaths(cmd, state.project)) {
    await ensureWritable(state, extPath)
  }

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
