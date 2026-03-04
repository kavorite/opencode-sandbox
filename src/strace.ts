import type { NetConnect } from './diff.js'
import type { SshInfo } from './store.js'

export type StraceResult = {
  ssh: SshInfo[]
  network: NetConnect[]
}

// Match: 1234  execve("/path/to/bin", ["arg0", "arg1", ...], ...) = 0
// Also handles unfinished/resumed strace lines (we skip those)
const EXECVE_RE = /^\d+\s+execve\("([^"]+)",\s*\[([^\]]*)\]/

// Match: 1234  connect(3, {sa_family=AF_INET, sin_port=htons(22), sin_addr=inet_addr("1.2.3.4")}, 16) = 0
const CONNECT_INET4_RE =
  /^\d+\s+connect\(\d+,\s*\{sa_family=(AF_INET),\s*sin_port=htons\((\d+)\),\s*sin_addr=inet_addr\("([^"]+)"\)[^}]*\}[^)]*\)\s*=\s*0/

// Match: 1234  connect(3, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "::1", &sin6_addr)}, 28) = 0
const CONNECT_INET6_RE =
  /^\d+\s+connect\(\d+,\s*\{sa_family=(AF_INET6),\s*sin6_port=htons\((\d+)\),\s*inet_pton\(AF_INET6,\s*"([^"]+)"/

// Match: 1234  connect(3, {sa_family=AF_UNIX, sun_path="/tmp/sock"}, ...) = 0
const CONNECT_UNIX_RE =
  /^\d+\s+connect\(\d+,\s*\{sa_family=AF_UNIX,\s*sun_path="([^"]+)"\}/

// Parse the strace args array string: ["ssh", "git@github.com", "git-receive-pack", "'/repo'"]
// into a plain string array, handling embedded quotes and escapes minimally.
function parseArgs(raw: string): string[] {
  const args: string[] = []
  // Each element is a quoted string; extract content between double quotes
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    args.push((m[1] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  }
  return args
}

// Determine if the binary path looks like an SSH binary
function isSshBin(binPath: string): boolean {
  const base = binPath.split('/').pop() ?? ''
  return base === 'ssh' || base === 'ssh2' || base.startsWith('ssh_')
}

// Known git-over-SSH remote commands
const GIT_SSH_CMDS = new Set(['git-receive-pack', 'git-upload-pack', 'git-upload-archive'])

export function parseStrace(log: string): StraceResult {
  const ssh: SshInfo[] = []
  const network: NetConnect[] = []
  const seen = new Set<string>() // deduplicate connects

  for (const line of log.split('\n')) {
    // --- execve: look for SSH invocations ---
    const execM = EXECVE_RE.exec(line)
    if (execM) {
      const binPath = execM[1] ?? ''
      const argsRaw = execM[2] ?? ''
      if (isSshBin(binPath)) {
        const args = parseArgs(argsRaw)
        // ssh args: ["ssh", [opts...], "user@host", "remote-cmd", "/repo"]
        // Git may pass the remote command + path as ONE combined arg:
        //   e.g. ["ssh", "host", "git-upload-pack 'repo'"]
        // or as separate args:
        //   e.g. ["ssh", "host", "git-upload-pack", "'/repo'"]
        let host = ''
        let cmd = ''
        let repo = ''
        // SSH options that consume the next argument (value flags)
        const OPTS_WITH_VALUE = new Set(['-i', '-l', '-p', '-o', '-c', '-D', '-E', '-e', '-F', '-I', '-J', '-L', '-m', '-O', '-P', '-Q', '-R', '-S', '-W', '-w', '-b', '-B'])
        let skipNext = false
        for (let i = 1; i < args.length; i++) {
          const a = args[i]
          if (!a) continue
          if (skipNext) { skipNext = false; continue } // value of previous flag
          if (a.startsWith('-')) { if (OPTS_WITH_VALUE.has(a)) skipNext = true; continue }
          if (!host) { host = a; continue }
          // Check for git SSH command — both standalone and combined-with-path forms
          const matchedGitCmd = GIT_SSH_CMDS.has(a)
            ? a
            : [...GIT_SSH_CMDS].find(c => a.startsWith(c + ' ') || a.startsWith(c + "'"))
          if (matchedGitCmd) {
            cmd = matchedGitCmd
            if (a !== matchedGitCmd) {
              // Path appended: e.g. "git-upload-pack 'repo'" or "git-upload-pack'repo'"
              repo = a.slice(matchedGitCmd.length).trim().replace(/^'+|'+$/g, '')
            }
            continue
          }
          if (cmd && !repo) { repo = a.replace(/^'+|'+$/g, '') }
        }
        if (cmd) {
          ssh.push({ cmd, repo, addr: host, port: 22 })
        }
      }
      continue
    }

    // --- connect: AF_INET ---
    const inet4M = CONNECT_INET4_RE.exec(line)
    if (inet4M) {
      const family = 'AF_INET' as const
      const port = parseInt(inet4M[2] ?? '0', 10)
      const addr = inet4M[3] ?? ''
      const key = `${family}:${addr}:${port}`
      if (!seen.has(key)) {
        seen.add(key)
        network.push({ kind: 'net_connect', syscall: 'connect', family, addr, port, result: 0 })
      }
      continue
    }

    // --- connect: AF_INET6 ---
    const inet6M = CONNECT_INET6_RE.exec(line)
    if (inet6M) {
      const family = 'AF_INET6' as const
      const port = parseInt(inet6M[2] ?? '0', 10)
      const addr = inet6M[3] ?? ''
      const key = `${family}:${addr}:${port}`
      if (!seen.has(key)) {
        seen.add(key)
        network.push({ kind: 'net_connect', syscall: 'connect', family, addr, port, result: 0 })
      }
      continue
    }

    // --- connect: AF_UNIX ---
    const unixM = CONNECT_UNIX_RE.exec(line)
    if (unixM) {
      const addr = unixM[1] ?? ''
      const key = `AF_UNIX:${addr}`
      if (!seen.has(key)) {
        seen.add(key)
        network.push({ kind: 'net_connect', syscall: 'connect', family: 'AF_UNIX', addr, port: 0, result: 0 })
      }
    }
  }

  return { ssh, network }
}
