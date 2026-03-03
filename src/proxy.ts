import Dockerode from 'dockerode'
import path from 'path'
import { fileURLToPath } from 'url'
import type { HttpRequest, TlsInfo, DnsQuery } from './store.js'

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ADDON_PATH = path.join(PROJECT_ROOT, 'mitmproxy', 'addon.py')
const MITMPROXY_IMAGE = 'mitmproxy/mitmproxy:latest'

export type ProxyFlow = {
  method: string
  path: string
  host: string
  port: number
  status: number | null
  tls: boolean
  sni: string | null
}

export type ProxyState = {
  container: Dockerode.Container
  logDir: string
  networkName: string
  sessionId: string
}

export async function startProxy(
  docker: Dockerode,
  networkName: string,
  sessionId: string,
  allowMethods?: string[],
): Promise<ProxyState> {
  const logDir = `/tmp/oc-proxy-${sessionId}`

  // Pull mitmproxy image if needed (suppress output)
  try {
    await new Promise<void>((resolve, reject) => {
      docker.pull(MITMPROXY_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) { resolve(); return } // ignore pull errors, image may already exist
        docker.modem.followProgress(stream, (err2: Error | null) => {
          if (err2) resolve() // ignore errors
          else resolve()
        })
      })
    })
  } catch { /* image may already be local */ }

  const container = await docker.createContainer({
    Image: MITMPROXY_IMAGE,
    Cmd: [
      'mitmdump',
      '--set', 'flow_detail=0',
      '-s', '/addon/addon.py',
      '--listen-host', '0.0.0.0',
      '--listen-port', '8080',
    ],
    Env: [
      `MITMPROXY_LOG=/var/log/mitmproxy/flows.jsonl`,
      `ALLOW_METHODS=${allowMethods?.join(',') ?? ''}`,
    ],
    Labels: {
      'opencode-sandbox': 'true',
      'opencode-sandbox.session': sessionId,
    },
    HostConfig: {
      Binds: [
        `${ADDON_PATH}:/addon/addon.py:ro`,
        `${logDir}:/var/log/mitmproxy`,
      ],
      NetworkMode: networkName,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: {
          Aliases: ['mitmproxy'],
        },
      },
    },
  })

  // Ensure log dir exists on host
  await Bun.spawn(['mkdir', '-p', logDir]).exited

  await container.start()

  // Wait for proxy to be ready
  await Bun.sleep(2000)

  return { container, logDir, networkName, sessionId }
}

export async function readLogs(state: ProxyState): Promise<ProxyFlow[]> {
  const logFile = `${state.logDir}/flows.jsonl`
  const file = Bun.file(logFile)
  if (!(await file.exists())) return []
  const text = await file.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as ProxyFlow }
      catch { return null }
    })
    .filter((f): f is ProxyFlow => f !== null)
}

export function mapFlows(flows: ProxyFlow[]): { http: HttpRequest[]; tls: TlsInfo[]; dns: DnsQuery[] } {
  const http: HttpRequest[] = flows.map((f) => ({
    method: f.method,
    path: f.path,
    host: f.host,
    addr: f.host,
    port: f.port,
    forwarded: false,
  }))

  const tls: TlsInfo[] = flows
    .filter((f) => f.tls && f.sni)
    .map((f) => ({
      sni: f.sni ?? f.host,
      addr: f.host,
      port: f.port,
    }))

  // DNS not directly observable via explicit proxy
  return { http, tls, dns: [] }
}

export async function stopProxy(state: ProxyState): Promise<void> {
  try { await state.container.stop({ t: 1 }) } catch { /* already stopped */ }
  try { await state.container.remove({ force: true }) } catch { /* already removed */ }
  // Clean up log dir
  await Bun.spawn(['rm', '-rf', state.logDir]).exited
}

export async function getProxyCACert(state: ProxyState): Promise<string> {
  // mitmproxy stores CA cert at /home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem inside container
  const exec = await state.container.exec({
    Cmd: ['cat', '/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem'],
    AttachStdout: true,
    AttachStderr: false,
    Tty: false,
  })
  const stream = await exec.start({ Detach: false })
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/[\x00-\x07\x0e-\x1f]/g, '').trim()))
  })
}
