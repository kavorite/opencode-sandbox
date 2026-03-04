import type { FileOpen, FileWrite, FsMutation, NetConnect, NetSocket } from './diff.js'
import type { GraphQLOperation } from './parse.js'

export type DnsQuery = {
  qname: string
  qtype: string
  resolver: string
}

export type Violation = {
  type: "network" | "filesystem" | "unix_socket"
  syscall: string
  detail: string
  severity: "high" | "medium" | "low"
}

export type HttpRequest = {
  method: string
  path: string
  host?: string
  addr: string
  port: number
  forwarded?: boolean
  graphql?: GraphQLOperation
}

export type TlsInfo = {
  sni: string
  addr: string
  port: number
}

export type SshInfo = {
  cmd: string
  repo: string
  addr: string
  port: number
}

export type SandboxResult = {
  files: FileOpen[]
  writes: FileWrite[]
  mutations: FsMutation[]
  network: NetConnect[]
  sockets: NetSocket[]
  dns: DnsQuery[]
  http: HttpRequest[]
  tls: TlsInfo[]
  ssh: SshInfo[]
  duration: number
  timedOut: boolean
  violations: Violation[]
  stdout: string
  stderr: string
  exitCode: number
  upper?: string
}

const results = new Map<string, SandboxResult>()

export function set(callID: string, result: SandboxResult) {
  results.set(callID, result)
}

export function get(callID: string): SandboxResult | undefined {
  const result = results.get(callID)
  if (result) results.delete(callID)
  return result
}

export function clear() {
  results.clear()
}
