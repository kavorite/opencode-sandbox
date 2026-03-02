import { decode } from "./decode"
import { parseDNS } from "./dns"
import { infer } from "./protocol"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  syscall: "unlink" | "rename" | "mkdir" | "rmdir"
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

export type StraceEvent = FileOpen | FileWrite | FsMutation | NetConnect | NetSocket

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Strip PID prefix: `1234  syscall(...)` or `[pid 1234] syscall(...)` */
function strip(raw: string): string {
  const trimmed = raw.trim()
  const sans =
    trimmed.startsWith("[pid ") && trimmed.indexOf("] ") !== -1 ? trimmed.substring(trimmed.indexOf("] ") + 2) : trimmed
  const m = sans.match(/^\d+\s+/)
  return m ? sans.substring(m[0].length) : sans
}

function num(s: string): number {
  const n = parseInt(s, 10)
  return isNaN(n) ? -1 : n
}

/** Extract first quoted string starting search at `from`. */
function quoted(s: string, from: number): string {
  const open = s.indexOf('"', from)
  if (open === -1) return ""
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++
      continue
    }
    if (s[i] === '"') return s.substring(open + 1, i)
  }
  return ""
}

/** Return index of closing `"` matching the one at `pos`. */
function endquote(s: string, pos: number): number {
  if (pos === -1 || s[pos] !== '"') return -1
  for (let i = pos + 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++
      continue
    }
    if (s[i] === '"') return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// per-syscall parsers
// ---------------------------------------------------------------------------

const OPEN_NAMES = new Set(["openat", "open", "creat"])
const WRITE_NAMES = new Set(["write", "writev", "pwrite64"])
const FS_NAMES = new Set(["unlink", "rename", "mkdir", "rmdir"])
const SOCK_NAMES = new Set(["socket", "bind", "sendto"])

function parseOpen(name: "openat" | "open" | "creat", args: string, res: number): FileOpen | undefined {
  // openat(AT_FDCWD, "/path", FLAGS[, mode])
  // open("/path", FLAGS[, mode])
  // creat("/path", mode)
  const from = name === "openat" ? args.indexOf(", ") + 2 : 0
  if (from < 2 && name === "openat") return undefined

  const path = quoted(args, from)
  if (!path) return undefined

  const qopen = args.indexOf('"', from)
  const qclose = endquote(args, qopen)
  if (qclose === -1) return { kind: "file_open", syscall: name, path, flags: "", result: res }

  const tail = args.substring(qclose + 1)
  const sep = tail.indexOf(", ")
  if (sep === -1) return { kind: "file_open", syscall: name, path, flags: "", result: res }

  const rest = tail.substring(sep + 2)
  const next = rest.indexOf(", ")
  const flags = next !== -1 ? rest.substring(0, next) : rest

  return { kind: "file_open", syscall: name, path, flags, result: res }
}

function parseWrite(name: "write" | "writev" | "pwrite64", args: string, res: number): FileWrite | undefined {
  const comma = args.indexOf(",")
  if (comma === -1) return undefined
  const fd = num(args.substring(0, comma))
  if (fd === -1) return undefined

  // writev has complex iovec args — use result as byte count
  if (name === "writev") return { kind: "file_write", syscall: name, fd, bytes: res, result: res }

  // write(fd, "buf", count)  /  pwrite64(fd, "buf", count, offset)
  const qopen = args.indexOf('"', comma)
  const qclose = endquote(args, qopen)
  if (qclose === -1) return { kind: "file_write", syscall: name, fd, bytes: res, result: res }

  const tail = args.substring(qclose + 1)
  // skip optional "..." truncation marker then find ", count"
  const sep = tail.indexOf(", ")
  if (sep === -1) return { kind: "file_write", syscall: name, fd, bytes: res, result: res }

  const after = tail.substring(sep + 2)
  // pwrite64 has "count, offset" — take first token
  const next = after.indexOf(", ")
  const bytes = num(next !== -1 ? after.substring(0, next) : after)

  return {
    kind: "file_write",
    syscall: name,
    fd,
    bytes: bytes === -1 ? res : bytes,
    result: res,
  }
}

function parseMutation(
  name: "unlink" | "rename" | "mkdir" | "rmdir",
  args: string,
  res: number,
): FsMutation | undefined {
  const path = quoted(args, 0)
  if (!path) return undefined
  return { kind: "fs_mutation", syscall: name, path, result: res }
}

function parseConnect(args: string, res: number): NetConnect | undefined {
  const fi = args.indexOf("sa_family=")
  if (fi === -1) return undefined
  const fe = args.indexOf(",", fi + 10)
  if (fe === -1) return undefined
  const family = args.substring(fi + 10, fe).trim()

  if (family !== "AF_INET" && family !== "AF_INET6" && family !== "AF_UNIX") return undefined

  if (family === "AF_UNIX")
    return {
      kind: "net_connect",
      syscall: "connect",
      family,
      addr: quoted(args, fe) || "",
      port: 0,
      result: res,
    }

  const pi = args.indexOf("htons(", fe)
  const port = pi !== -1 ? num(args.substring(pi + 6, args.indexOf(")", pi + 6))) : 0

  const marker = family === "AF_INET" ? "inet_addr(" : "inet_pton("
  const ai = args.indexOf(marker, fe)
  const addr = ai !== -1 ? quoted(args, ai + marker.length) : ""

  return {
    kind: "net_connect",
    syscall: "connect",
    family,
    addr,
    port,
    result: res,
  }
}

function parseSocket(name: "socket" | "bind" | "sendto", args: string): NetSocket | undefined {
  if (name === "sendto") {
    const fi = args.indexOf("sa_family=")
    const family = fi !== -1 ? (() => {
      const fe = args.indexOf(",", fi + 10)
      return fe !== -1 ? args.substring(fi + 10, fe).trim() : ""
    })() : ""

    const pi = args.indexOf("htons(")
    const port = pi !== -1 ? num(args.substring(pi + 6, args.indexOf(")", pi + 6))) : undefined

    const marker = family === "AF_INET6" ? "inet_pton(" : "inet_addr("
    const ai = args.indexOf(marker)
    const addr = ai !== -1 ? quoted(args, ai + marker.length) : undefined

    const buf = quoted(args, 0)

    return {
      kind: "net_socket",
      syscall: "sendto",
      family: family || "AF_INET",
      type: "SOCK_DGRAM",
      buffer: buf || undefined,
      addr: addr || undefined,
      port,
    }
  }

  const comma = args.indexOf(",")
  if (comma === -1) return undefined
  const family = args.substring(0, comma).trim()
  const rest = args.substring(comma + 1)
  const comma2 = rest.indexOf(",")
  const type = (comma2 !== -1 ? rest.substring(0, comma2) : rest).trim()
  return { kind: "net_socket", syscall: name, family, type }
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

export function parseLine(line: string): StraceEvent | undefined {
  const s = strip(line)
  if (!s) return undefined

  // signals and process lifecycle
  if (s.startsWith("---") || s.startsWith("+++")) return undefined

  // unfinished / resumed — Task 8 handles pair matching
  if (s.includes("<unfinished ...>")) return undefined
  if (s.includes("<... ") && s.includes(" resumed>")) return undefined

  // extract syscall name (everything before first open-paren)
  const paren = s.indexOf("(")
  if (paren === -1) return undefined
  const name = s.substring(0, paren)

  // result separator " = "
  const eq = s.lastIndexOf(" = ")
  if (eq === -1) return undefined // truncated line

  // closing paren of args sits before optional whitespace padding then " = "
  let close = eq - 1
  while (close >= 0 && s[close] === " ") close--
  if (close < 0 || s[close] !== ")") return undefined

  const args = s.substring(paren + 1, close)
  const res = num(s.substring(eq + 3))

  if (OPEN_NAMES.has(name)) return parseOpen(name as "openat" | "open" | "creat", args, res)
  if (WRITE_NAMES.has(name)) return parseWrite(name as "write" | "writev" | "pwrite64", args, res)
  if (FS_NAMES.has(name)) return parseMutation(name as "unlink" | "rename" | "mkdir" | "rmdir", args, res)
  if (name === "connect") return parseConnect(args, res)
  if (SOCK_NAMES.has(name)) return parseSocket(name as "socket" | "bind" | "sendto", args)

  return undefined
}

// ---------------------------------------------------------------------------
// log-level parsing
// ---------------------------------------------------------------------------

export type ParsedLog = {
  files: FileOpen[]
  writes: FileWrite[]
  mutations: FsMutation[]
  network: NetConnect[]
  sockets: NetSocket[]
  dns: Array<{ qname: string; qtype: string; resolver: string }>
}

const NOISE = ["/proc/self/", "/dev/null", "/dev/zero"]

// bwrap pivot_root creates these relative dirs during namespace setup
const BWRAP_NOISE = new Set(["newroot", "oldroot"])

function pid(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith("[pid ")) {
    const end = trimmed.indexOf("]")
    return end !== -1 ? trimmed.substring(5, end) : "0"
  }
  const m = trimmed.match(/^(\d+)\s/)
  return m ? m[1]! : "0"
}

export function parseLog(content: string): ParsedLog {
  const lines = content.split("\n")
  const cap = Math.min(lines.length, 50000)
  const pending = new Map<string, string>()
  const files: FileOpen[] = []
  const writes: FileWrite[] = []
  const mutations: FsMutation[] = []
  const network: NetConnect[] = []
  const sockets: NetSocket[] = []
  const dns: Array<{ qname: string; qtype: string; resolver: string }> = []

  for (let i = 0; i < cap; i++) {
    const raw = lines[i]
    if (!raw) continue

    let line = raw

    if (raw.includes("<unfinished ...>")) {
      pending.set(pid(raw), raw.substring(0, raw.indexOf("<unfinished ...>")))
      continue
    }

    if (raw.includes("<... ") && raw.includes(" resumed>")) {
      const p = pid(raw)
      const head = pending.get(p)
      if (head) {
        pending.delete(p)
        line = head + raw.substring(raw.indexOf("resumed>") + 8)
      } else {
        continue
      }
    }

    const event = parseLine(line)
    if (!event) continue

    switch (event.kind) {
      case "file_open":
        files.push(event)
        break
      case "file_write":
        writes.push(event)
        break
      case "fs_mutation":
        mutations.push(event)
        break
      case "net_connect":
        network.push({ ...event, protocol: infer(event.port) })
        break
      case "net_socket":
        sockets.push(event)
        if (event.syscall === "sendto" && event.buffer && event.port === 53) {
          const bytes = decode(event.buffer)
          const parsed = parseDNS(bytes)
          if (parsed) dns.push({ qname: parsed.qname, qtype: parsed.qtype, resolver: event.addr ?? "" })
        }
        break
    }
  }

  const seen = new Set<string>()
  const deduped = files.filter((f) => {
    if (NOISE.some((n) => f.path.startsWith(n))) return false
    if (f.path === "/dev/null" || f.path === "/dev/zero") return false
    if (seen.has(f.path)) return false
    seen.add(f.path)
    return true
  })

  const filtered = mutations.filter((m) => !BWRAP_NOISE.has(m.path))

  return {
    files: deduped,
    writes,
    mutations: filtered,
    network,
    sockets,
    dns,
  }
}
