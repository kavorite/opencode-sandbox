import Dockerode from 'dockerode'
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
}

export type ExecOpts = {
  WorkingDir?: string
  Env?: string[]
}

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type ContainerChange = {
  Kind: 0 | 1 | 2
  Path: string
}

export function connect(): Dockerode {
  return new Dockerode()
}

export async function createContainer(docker: Dockerode, opts: ContainerCreateOpts): Promise<Dockerode.Container> {
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
      Binds: opts.binds,
      NetworkMode: opts.networkMode,
      CapDrop: ['NET_RAW', 'SYS_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'SYS_BOOT', 'MAC_ADMIN', 'AUDIT_WRITE'],
      SecurityOpt: ['no-new-privileges'],
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
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false, // CRITICAL: false for demuxed streams
    ...(opts?.WorkingDir ? { WorkingDir: opts.WorkingDir } : {}),
    ...(opts?.Env ? { Env: opts.Env } : {}),
  })

  const stream = await exec.start({ Detach: false })

  return new Promise((resolve, reject) => {
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
}
