const PORTS: Record<number, string> = {
  80: "http",
  443: "https",
  8080: "http",
  8443: "https",
  53: "dns",
  22: "ssh",
  21: "ftp",
}

export function infer(port: number): string {
  return PORTS[port] ?? "unknown"
}

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS", "CONNECT", "TRACE"]
const HTTP2_PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"

export function parseHTTP(buf: Uint8Array): { method: string; path: string; host?: string } | undefined {
  if (buf.length > 16384) return undefined
  
  // Check HTTP/2 preface
  const preface = new TextDecoder().decode(buf.slice(0, HTTP2_PREFACE.length))
  if (preface === HTTP2_PREFACE) return { method: "PRI", path: "*" }
  
  // Try to decode as ASCII text and find request line
  const text = new TextDecoder("ascii", { fatal: false }).decode(buf)
  const crlf = text.indexOf("\r\n")
  const line = crlf !== -1 ? text.slice(0, crlf) : text.slice(0, 200)
  
  const parts = line.split(" ")
  if (parts.length < 3) return undefined
  
  const method = parts[0]!
  if (!HTTP_METHODS.includes(method)) return undefined
  
  const path = parts[1] ?? "/"
  
  // Extract Host header if present within first 4096 bytes
  const header = text.slice(0, 4096)
  const hostMatch = header.match(/\r\nHost: ([^\r\n]+)/i)
  const host = hostMatch ? hostMatch[1]! : undefined
  
  return { method, path, host }
}

export function parseTLS(buf: Uint8Array): { sni: string } | undefined {
  if (buf.length > 16384) return undefined
  // TLS record header: content_type=0x16 (handshake), version major=0x03
  if (buf.length < 5) return undefined
  if (buf[0] !== 0x16 || buf[1] !== 0x03) return undefined
  
  // Handshake header starts at offset 5
  if (buf.length < 6) return undefined
  if (buf[5] !== 0x01) return undefined  // handshake_type = ClientHello
  
  // Skip: record header (5) + handshake type (1) + length (3) + client_version (2) + random (32)
  let pos = 5 + 1 + 3 + 2 + 32
  if (pos >= buf.length) return undefined
  
  // session_id (1 byte length prefix)
  if (pos + 1 > buf.length) return undefined
  pos += 1 + buf[pos]!
  
  // cipher_suites (2 byte length prefix)
  if (pos + 2 > buf.length) return undefined
  pos += 2 + (buf[pos]! << 8 | buf[pos + 1]!)
  
  // compression_methods (1 byte length prefix)
  if (pos + 1 > buf.length) return undefined
  pos += 1 + buf[pos]!
  
  // extensions (2 byte length prefix)
  if (pos + 2 > buf.length) return undefined
  const extEnd = pos + 2 + (buf[pos]! << 8 | buf[pos + 1]!)
  pos += 2
  
  // Walk extensions to find SNI (type 0x0000)
  while (pos + 4 <= extEnd && pos + 4 <= buf.length) {
    const type = buf[pos]! << 8 | buf[pos + 1]!
    const len = buf[pos + 2]! << 8 | buf[pos + 3]!
    pos += 4
    
    if (type === 0x0000) {
      // SNI extension: list_length (2) + name_type (1, must be 0) + name_length (2) + name
      if (pos + 5 > buf.length) return undefined
      const nameLen = buf[pos + 3]! << 8 | buf[pos + 4]!
      if (pos + 5 + nameLen > buf.length) return undefined
      const sni = new TextDecoder("ascii").decode(buf.slice(pos + 5, pos + 5 + nameLen))
      return { sni }
    }
    
    pos += len
  }
  
  return undefined
}
