import Dockerode from 'dockerode'
import fs from 'fs'
import { PassThrough } from 'stream'

export type ContainerCreateOpts = {
  sessionId: string
  image: string
  cmd: string[]
  binds?: string[]
  networkMode?: string
  env?: string[]
  workingDir?: string
  name?: string
  gpu?: boolean
}

export type ExecOpts = {
  WorkingDir?: string
  Env?: string[]
  trace?: boolean // if true, wrap command with strace and return log
}

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
  straceLog?: string // populated when tracing is enabled
}

export type ContainerChange = {
  Kind: 0 | 1 | 2
  Path: string
}

export function connect(): Dockerode {
  return new Dockerode()
}

export async function createContainer(docker: Dockerode, opts: ContainerCreateOpts): Promise<Dockerode.Container> {
  // Mount Docker socket if available (allows container to use host Docker daemon)
  const dockerSocket = process.env.DOCKER_HOST?.replace('unix://', '') ?? '/var/run/docker.sock'
  const socketBinds: string[] = fs.existsSync(dockerSocket) ? [`${dockerSocket}:/var/run/docker.sock`] : []
  
  // selective CapDrop — NOT ALL (breaks native addon installs)
  const container = await docker.createContainer({
    Image: opts.image,
    Cmd: opts.cmd,
    WorkingDir: opts.workingDir,
    Env: opts.env,
    Labels: {
      'opencode-sandbox': 'true',
      'opencode-sandbox.session': opts.sessionId,
    },
    HostConfig: {
      Binds: [...(opts.binds ?? []), ...socketBinds],
      NetworkMode: opts.networkMode,
      CapDrop: ['NET_RAW', 'SYS_ADMIN', 'SYS_MODULE', 'SYS_BOOT', 'MAC_ADMIN', 'AUDIT_WRITE'],
      CapAdd: ['SYS_PTRACE'], // needed for strace-based SSH/network observation
      SecurityOpt: ['seccomp=unconfined'], // unconfined allows all ptrace ops strace needs
      ...(opts.gpu ? { DeviceRequests: [{ Driver: '', Count: -1, DeviceIDs: [], Capabilities: [['gpu']], Options: {} }] } : {}),
    },
    ...(opts.name ? { name: opts.name } : {}),
  })
  return container
}

export async function execCommand(
  container: Dockerode.Container,
  cmd: string[],
  opts?: ExecOpts,
): Promise<ExecResult> {
  const straceLog = opts?.trace ? `/tmp/oc-strace-${Date.now()}.log` : undefined
  const actualCmd = straceLog
    ? ['strace', '-e', 'trace=execve,connect', '-f', '-q', '-s', '512', '-o', straceLog, ...cmd]
    : cmd

  const exec = await container.exec({
    Cmd: actualCmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false, // CRITICAL: false for demuxed streams
    ...(opts?.WorkingDir ? { WorkingDir: opts.WorkingDir } : {}),
    ...(opts?.Env ? { Env: opts.Env } : {}),
  })

  const stream = await exec.start({ Detach: false })

  const result = await new Promise<ExecResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    const stdoutPassthrough = new PassThrough()
    const stderrPassthrough = new PassThrough()

    stdoutPassthrough.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    stderrPassthrough.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    container.modem.demuxStream(stream, stdoutPassthrough, stderrPassthrough)

    let resolved = false
    const finish = async () => {
      if (resolved) return
      resolved = true
      try {
        const info = await exec.inspect()
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: info.ExitCode ?? -1,
        })
      } catch (e) {
        reject(e)
      }
    }

    // Primary: stream end event
    stream.on('end', finish)
    stream.on('error', reject)

    // Fallback: poll exec.inspect() every 100ms until Running === false
    // (known dockerode issue: end event may not always fire)
    const poll = setInterval(async () => {
      try {
        const info = await exec.inspect()
        if (!info.Running) {
          clearInterval(poll)
          await finish()
        }
      } catch {
        clearInterval(poll)
      }
    }, 100)

    // Clean up interval if stream ends first
    stream.on('end', () => clearInterval(poll))
    stream.on('error', () => clearInterval(poll))
  })

  // Read strace log back from container (second exec, fast cat)
  if (straceLog) {
    try {
      const logResult = await execCommand(container, ['cat', straceLog])
      result.straceLog = logResult.stdout
      // Best-effort cleanup — don't block on it
      execCommand(container, ['rm', '-f', straceLog]).catch(() => {})
    } catch {
      // strace log unreadable — carry on without it
    }
  }

  return result
}

export async function getChanges(container: Dockerode.Container): Promise<ContainerChange[]> {
  const changes = await container.changes()
  return (changes ?? []) as ContainerChange[]
}

export async function commitContainer(container: Dockerode.Container, tag: string): Promise<string> {
  const [repo, tagPart] = tag.includes(':') ? tag.split(':') as [string, string] : [tag, 'latest']
  const result = await container.commit({ repo, tag: tagPart })
  return (result as { Id: string }).Id
}

export async function removeImage(docker: Dockerode, tag: string): Promise<void> {
  const image = docker.getImage(tag)
  await image.remove({ force: false })
}

export async function createNetwork(docker: Dockerode, name: string, sessionId: string): Promise<Dockerode.Network> {
  const network = await docker.createNetwork({
    Name: name,
    Driver: 'bridge',
    Labels: {
      'opencode-sandbox': 'true',
      'opencode-sandbox.session': sessionId,
    },
  })
  return network
}

export async function cleanup(docker: Dockerode, sessionId: string): Promise<void> {
  const label = `opencode-sandbox.session=${sessionId}`
  const containers = await docker.listContainers({ all: true, filters: { label: [label] } })
  await Promise.all(
    containers.map(async (info) => {
      const c = docker.getContainer(info.Id)
      try { await c.stop({ t: 1 }) } catch { /* already stopped */ }
      await c.remove({ force: true })
    }),
  )
  const networks = await docker.listNetworks({ filters: { label: [label] } })
  await Promise.all(networks.map((n) => docker.getNetwork(n.Id).remove()))

  // Remove all committed images for this session
  const tagPrefix = `opencode-sandbox:${sessionId}-`
  const images = await docker.listImages({ filters: { reference: ['opencode-sandbox'] } })
  await Promise.all(
    images.flatMap((img) =>
      (img.RepoTags ?? []).filter((t: string) => t.startsWith(tagPrefix)).map(async (t: string) => {
        try { await docker.getImage(t).remove({ force: false }) } catch { /* in use or already removed */ }
      }),
    ),
  )
}
