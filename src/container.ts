import fs from 'fs'
import path from 'path'
import Dockerode from 'dockerode'
import * as docker from './docker.js'
import { ensureImage } from './image.js'
import { mapChanges } from './diff.js'
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
}

export async function init(
  dockerClient: Dockerode,
  project: string,
  home: string,
  sessionId: string,
  config: SandboxConfig,
): Promise<SessionState> {
  const networkName = `oc-sandbox-${sessionId}`

  // Create network for container isolation (still useful for labeling + observe mode)
  const network = await docker.createNetwork(dockerClient, networkName, sessionId)

  // Ensure image exists
  const imageName = await ensureImage(dockerClient)

  // Build env vars
  const env = [
    `HOME=${home}`,
    'OC_SANDBOX=1',
    `OC_SANDBOX_PROJECT=${project}`,
  ]
  if (config.network.observe && config.network.allow_methods?.length) {
    env.push('HTTP_PROXY=http://mitmproxy:8080')
    env.push('HTTPS_PROXY=http://mitmproxy:8080')
  }

  // Build bind mounts (project dir + SSH auth)
  const binds = [`${project}:${project}`]

  // Bind-mount ~/.ssh read-only so git can use keys and known_hosts
  const sshDir = path.join(home, '.ssh')
  if (fs.existsSync(sshDir)) {
    binds.push(`${sshDir}:${sshDir}:ro`)
  }

  // Forward SSH agent socket if available
  if (process.env.SSH_AUTH_SOCK) {
    binds.push(`${process.env.SSH_AUTH_SOCK}:${process.env.SSH_AUTH_SOCK}`)
    env.push(`SSH_AUTH_SOCK=${process.env.SSH_AUTH_SOCK}`)
  }

  // Forward GIT_SSH_COMMAND if set on host (e.g. custom key selection)
  if (process.env.GIT_SSH_COMMAND) {
    env.push(`GIT_SSH_COMMAND=${process.env.GIT_SSH_COMMAND}`)
  }

  // Create container
  const container = await docker.createContainer(dockerClient, {
    sessionId,
    image: config.docker.image ?? imageName,
    cmd: ['sleep', 'infinity'],
    binds,
    networkMode: networkName,
    env,
    workingDir: project,
    name: `oc-sandbox-${sessionId}`,
  })

  await container.start()

  // Detect the container image user's actual home directory (not the env-overridden $HOME)
  // We use getent passwd to read from /etc/passwd, bypassing the HOME env var we set.
  const containerHomeResult = await docker.execCommand(
    container,
    ['sh', '-c', 'getent passwd $(id -u) | cut -d: -f6'],
    {},
  )
  const containerHome = containerHomeResult.stdout.trim() || '/home/sandbox'

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
  }

  // Register cleanup on process exit
  const onExit = () => { teardown(state).catch(() => {}) }
  process.once('exit', onExit)
  process.once('SIGTERM', onExit)
  process.once('SIGINT', onExit)
  process.once('uncaughtException', onExit)

  return state
}

export async function exec(
  state: SessionState,
  cmd: string,
  cwd: string,
): Promise<ExecResult> {
  return docker.execCommand(state.container, ['sh', '-c', cmd], { WorkingDir: cwd })
}

export async function inspect(
  state: SessionState,
): Promise<DiffResult> {
  const changes = await docker.getChanges(state.container)
  return mapChanges(changes, state.project, state.home, state.binds, state.containerHome)
}

export async function approve(state: SessionState): Promise<void> {
  const newTag = `opencode-sandbox:${state.sessionId}-approved-${Date.now()}`
  await docker.commitContainer(state.container, newTag)
  state.imageTag = newTag
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
    env: state.env,
    workingDir: state.project,
    name: `oc-sandbox-${state.sessionId}-${Date.now()}`,
  })
  await newContainer.start()
  state.container = newContainer
}

export async function teardown(state: SessionState): Promise<void> {
  // Stop + remove container
  try { await state.container.stop({ t: 1 }) } catch { /* already stopped */ }
  try { await state.container.remove({ force: true }) } catch { /* already removed */ }

  // Remove network
  try { await state.network.remove() } catch { /* already removed */ }

  // Clean up all committed images for this session (label-based)
  await docker.cleanup(state.dockerClient, state.sessionId)
}
