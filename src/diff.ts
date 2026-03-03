export type ContainerChange = {
  Kind: 0 | 1 | 2
  Path: string
}

export type FileOpen = {
  kind: "file_open"
  syscall: "openat" | "open" | "creat"
  path: string
  flags: string
  result: number
}

export type FileWrite = {
  kind: "file_write"
  syscall: "write" | "writev" | "pwrite64"
  fd: number
  bytes: number
  result: number
}

export type FsMutation = {
  kind: "fs_mutation"
  syscall: "unlink" | "rename" | "mkdir" | "rmdir" | "creat"
  path: string
  result: number
}

export type NetConnect = {
  kind: "net_connect"
  syscall: "connect"
  family: "AF_INET" | "AF_INET6" | "AF_UNIX"
  addr: string
  port: number
  protocol?: string
  result: number
}

export type NetSocket = {
  kind: "net_socket"
  syscall: "socket" | "bind" | "sendto"
  family: string
  type: string
  buffer?: string
  addr?: string
  port?: number
}

export type DiffResult = {
  mutations: FsMutation[]
  files: FileOpen[]
  writes: FileWrite[]
}

const EPHEMERAL_PREFIXES = ["/tmp", "/proc", "/sys", "/dev", "/run"] as const

const isUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(prefix + "/")

const isEphemeral = (path: string): boolean =>
  EPHEMERAL_PREFIXES.some((prefix) => isUnder(path, prefix))

export const mapChanges = (
  changes: ContainerChange[],
  project: string,
  _home: string,
): DiffResult => {
  const normalizedProject = project.replace(/\/$/, "")
  const mutations: FsMutation[] = []
  const writes: FileWrite[] = []

  for (const change of changes) {
    const { Kind: kind, Path: path } = change

    if (isUnder(path, normalizedProject)) continue
    if (isEphemeral(path)) continue

    if (kind === 1) {
      const syscall = path.endsWith("/") ? "mkdir" : "creat"
      mutations.push({ kind: "fs_mutation", syscall, path, result: 0 } as const)
    }

    if (kind === 0) {
      mutations.push({ kind: "fs_mutation", syscall: "rename", path, result: 0 } as const)
      writes.push({ kind: "file_write", syscall: "write", fd: -1, bytes: 0, result: 0 } as const)
    }

    if (kind === 2) {
      const syscall = path.endsWith("/") ? "rmdir" : "unlink"
      mutations.push({ kind: "fs_mutation", syscall, path, result: 0 } as const)
    }
  }

  return { mutations, files: [], writes }
}
