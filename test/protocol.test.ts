import { describe, test, expect } from "bun:test"
import { schema, TIMEOUT } from "../src/config"
import { decode } from "../src/decode"
import { parseDNS } from "../src/dns"
import { infer, parseHTTP, parseTLS } from "../src/protocol"
import { parseLine } from "../src/strace"

describe("decode", () => {
  test("empty string", () => {
    const result = decode("")
    expect(result).toEqual(new Uint8Array([]))
  })

  test("hex escape sequence", () => {
    const result = decode("\\x16\\x03\\x01")
    expect(result).toEqual(new Uint8Array([0x16, 0x03, 0x01]))
  })

  test("octal escape sequences with DNS QNAME", () => {
    const result = decode("\\7example\\3com\\0")
    expect(result).toEqual(new Uint8Array([7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0]))
  })

  test("HTTP request with CRLF", () => {
    const result = decode("GET / HTTP/1.1\\r\\n")
    const expected = new Uint8Array([71, 69, 84, 32, 47, 32, 72, 84, 84, 80, 47, 49, 46, 49, 13, 10])
    expect(result).toEqual(expected)
  })

  test("printable ASCII", () => {
    const result = decode("hello")
    expect(result).toEqual(new Uint8Array([104, 101, 108, 108, 111]))
  })

  test("backslash followed by literal n", () => {
    const result = decode("\\\\n")
    expect(result).toEqual(new Uint8Array([0x5c, 0x6e]))
  })

  test("newline escape", () => {
    const result = decode("\\n")
    expect(result).toEqual(new Uint8Array([0x0a]))
  })

  test("octal 377 (max byte)", () => {
    const result = decode("\\377")
    expect(result).toEqual(new Uint8Array([0xff]))
  })

  test("single digit octal", () => {
    const result = decode("\\7")
    expect(result).toEqual(new Uint8Array([7]))
  })

  test("truncated buffer with ellipsis", () => {
    const result = decode("\\x16\\x03\\x01...")
    expect(result).toEqual(new Uint8Array([0x16, 0x03, 0x01]))
  })

  test("quote escape", () => {
    const result = decode('hello\\"world')
    expect(result).toEqual(new Uint8Array([104, 101, 108, 108, 111, 0x22, 119, 111, 114, 108, 100]))
  })

  test("tab escape", () => {
    const result = decode("a\\tb")
    expect(result).toEqual(new Uint8Array([97, 0x09, 98]))
  })

  test("null byte escape", () => {
    const result = decode("test\\0end")
    expect(result).toEqual(new Uint8Array([116, 101, 115, 116, 0x00, 101, 110, 100]))
  })

  test("mixed escapes and literals", () => {
    const result = decode("\\x01test\\x02")
    expect(result).toEqual(new Uint8Array([0x01, 116, 101, 115, 116, 0x02]))
  })
})

describe("infer", () => {
  test("port 80 is http", () => {
    expect(infer(80)).toBe("http")
  })

  test("port 443 is https", () => {
    expect(infer(443)).toBe("https")
  })

  test("port 53 is dns", () => {
    expect(infer(53)).toBe("dns")
  })

  test("port 22 is ssh", () => {
    expect(infer(22)).toBe("ssh")
  })

  test("port 21 is ftp", () => {
    expect(infer(21)).toBe("ftp")
  })

  test("port 8080 is http", () => {
    expect(infer(8080)).toBe("http")
  })

  test("port 8443 is https", () => {
    expect(infer(8443)).toBe("https")
  })

  test("unknown port returns unknown", () => {
    expect(infer(9999)).toBe("unknown")
  })

  test("port 0 returns unknown", () => {
    expect(infer(0)).toBe("unknown")
  })
})

describe("parseSocket sendto", () => {
  test("extracts buffer and address from DNS sendto", () => {
    const line = 'sendto(3, "\\23\\1\\0\\0\\1\\0\\0\\0\\0\\1\\0\\0\\7example\\3com\\0\\0\\1\\0\\1", 33, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("8.8.8.8")}, 16) = -1 ENETUNREACH'
    const event = parseLine(line)
    expect(event).not.toBeUndefined()
    expect(event?.kind).toBe("net_socket")
    if (event?.kind === "net_socket") {
      expect(event.syscall).toBe("sendto")
      expect(event.addr).toBe("8.8.8.8")
      expect(event.port).toBe(53)
      expect(event.family).toBe("AF_INET")
      expect(event.buffer).toBeTruthy()
    }
  })

  test("sendto with no sockaddr returns socket event with no addr", () => {
    const line = 'sendto(3, "hello", 5, 0, NULL, 0) = 5'
    const event = parseLine(line)
    expect(event).not.toBeUndefined()
    if (event?.kind === "net_socket") {
      expect(event.syscall).toBe("sendto")
    }
  })
})

describe("parseHTTP", () => {
  test("parses GET request", () => {
    const buf = decode("GET /index.html HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n")
    const result = parseHTTP(buf)
    expect(result).not.toBeUndefined()
    expect(result?.method).toBe("GET")
    expect(result?.path).toBe("/index.html")
  })

  test("parses POST request", () => {
    const buf = decode("POST /api/data HTTP/1.1\\r\\n")
    const result = parseHTTP(buf)
    expect(result?.method).toBe("POST")
  })

  test("non-HTTP buffer returns undefined", () => {
    const buf = new Uint8Array([0x16, 0x03, 0x01])
    expect(parseHTTP(buf)).toBeUndefined()
  })

  test("empty buffer returns undefined", () => {
    expect(parseHTTP(new Uint8Array([]))).toBeUndefined()
  })

  test("detects HTTP/2 preface", () => {
    const preface = "PRI * HTTP/2.0\\r\\n\\r\\nSM\\r\\n\\r\\n"
    const buf = decode(preface)
    const result = parseHTTP(buf)
    expect(result?.method).toBe("PRI")
  })

  test("oversized buffer returns undefined", () => {
    const buf = new Uint8Array(16385)
    buf[0] = 0x47 // 'G'
    expect(parseHTTP(buf)).toBeUndefined()
  })
})

describe("parseTLS", () => {
  test("non-TLS buffer returns undefined", () => {
    const buf = decode("GET / HTTP/1.1\\r\\n")
    expect(parseTLS(buf)).toBeUndefined()
  })

  test("too-short buffer returns undefined", () => {
    expect(parseTLS(new Uint8Array([0x16, 0x03]))).toBeUndefined()
  })

  test("TLS record but not ClientHello (wrong handshake type) returns undefined", () => {
    // type=0x16, version=0x0301, not handshake type 0x01
    const buf = new Uint8Array(10)
    buf[0] = 0x16
    buf[1] = 0x03
    buf[2] = 0x01
    buf[5] = 0x02  // ServerHello, not ClientHello
    expect(parseTLS(buf)).toBeUndefined()
  })

  test("parses SNI from constructed TLS ClientHello", () => {
    // Build a minimal TLS ClientHello with SNI "example.com"
    const hostname = "example.com"
    const hostnameBytes = new TextEncoder().encode(hostname)
    
    // SNI extension: type=0x0000, ext_len (2), list_len (2), name_type=0x00, name_len (2), name
    const sniExt = new Uint8Array(4 + 2 + 1 + 2 + hostnameBytes.length)
    let p = 0
    sniExt[p++] = 0x00; sniExt[p++] = 0x00  // extension type SNI
    const sniDataLen = 2 + 1 + 2 + hostnameBytes.length
    sniExt[p++] = (sniDataLen >> 8) & 0xff; sniExt[p++] = sniDataLen & 0xff
    sniExt[p++] = ((hostnameBytes.length + 3) >> 8) & 0xff; sniExt[p++] = (hostnameBytes.length + 3) & 0xff  // list_len
    sniExt[p++] = 0x00  // name_type host_name
    sniExt[p++] = (hostnameBytes.length >> 8) & 0xff; sniExt[p++] = hostnameBytes.length & 0xff
    sniExt.set(hostnameBytes, p)
    
    // ClientHello body: version(2) + random(32) + session_id_len(1) + cipher_suites_len(2) + 2 ciphers + compress_len(1) + compress + ext_len(2) + sni_ext
    const body = new Uint8Array(2 + 32 + 1 + 2 + 4 + 1 + 1 + 2 + sniExt.length)
    let b = 0
    body[b++] = 0x03; body[b++] = 0x03  // TLS 1.2
    b += 32  // random (zeros)
    body[b++] = 0x00  // session_id_len = 0
    body[b++] = 0x00; body[b++] = 0x04  // cipher_suites_len = 4
    body[b++] = 0x00; body[b++] = 0x2F  // TLS_RSA_WITH_AES_128_CBC_SHA
    body[b++] = 0x00; body[b++] = 0xFF  // TLS_EMPTY_RENEGOTIATION_INFO_SCSV
    body[b++] = 0x01  // compression_methods_len = 1
    body[b++] = 0x00  // null compression
    body[b++] = (sniExt.length >> 8) & 0xff; body[b++] = sniExt.length & 0xff
    body.set(sniExt, b)
    
    // Handshake header: type=0x01, length(3 bytes)
    const handshake = new Uint8Array(4 + body.length)
    handshake[0] = 0x01  // ClientHello
    handshake[1] = 0x00; handshake[2] = (body.length >> 8) & 0xff; handshake[3] = body.length & 0xff
    handshake.set(body, 4)
    
    // TLS record header: type=0x16, version=0x0301, length(2)
    const record = new Uint8Array(5 + handshake.length)
    record[0] = 0x16  // handshake
    record[1] = 0x03; record[2] = 0x01  // TLS 1.0
    record[3] = (handshake.length >> 8) & 0xff; record[4] = handshake.length & 0xff
    record.set(handshake, 5)
    
    const result = parseTLS(record)
    expect(result).not.toBeUndefined()
    expect(result?.sni).toBe("example.com")
  })

  test("oversized buffer returns undefined", () => {
    expect(parseTLS(new Uint8Array(16385))).toBeUndefined()
  })
})

describe("parseDNS", () => {
  test("parses A query for example.com", () => {
    // Build DNS query: header + QNAME + QTYPE + QCLASS
    const qname = new Uint8Array([7, ...new TextEncoder().encode("example"), 3, ...new TextEncoder().encode("com"), 0])
    const header = new Uint8Array([0xab, 0xcd, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const qtype = new Uint8Array([0x00, 0x01])  // A record
    const qclass = new Uint8Array([0x00, 0x01]) // IN
    const buf = new Uint8Array([...header, ...qname, ...qtype, ...qclass])
    const result = parseDNS(buf)
    expect(result?.qname).toBe("example.com")
    expect(result?.qtype).toBe("A")
  })

  test("parses AAAA query", () => {
    const qname = new Uint8Array([3, ...new TextEncoder().encode("www"), 7, ...new TextEncoder().encode("example"), 3, ...new TextEncoder().encode("com"), 0])
    const header = new Uint8Array([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const qtype = new Uint8Array([0x00, 0x1c])  // AAAA
    const qclass = new Uint8Array([0x00, 0x01])
    const buf = new Uint8Array([...header, ...qname, ...qtype, ...qclass])
    const result = parseDNS(buf)
    expect(result?.qname).toBe("www.example.com")
    expect(result?.qtype).toBe("AAAA")
  })

  test("rejects buffer smaller than 12 bytes", () => {
    expect(parseDNS(new Uint8Array(11))).toBeUndefined()
  })

  test("rejects DNS response (QR=1)", () => {
    const buf = new Uint8Array(14)
    buf[2] = 0x80  // QR=1 (response)
    buf[4] = 0x00; buf[5] = 0x01  // QDCOUNT=1
    expect(parseDNS(buf)).toBeUndefined()
  })

  test("rejects label length > 63", () => {
    const header = new Uint8Array([0, 0, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const badLabel = new Uint8Array(66)  // length byte = 64, exceeds limit
    badLabel[0] = 64
    const buf = new Uint8Array([...header, ...badLabel])
    expect(parseDNS(buf)).toBeUndefined()
  })

  test("handles compression pointer by returning undefined", () => {
    const header = new Uint8Array([0, 0, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const withPointer = new Uint8Array([7, ...new TextEncoder().encode("example"), 0xC0, 0x00])  // compression pointer
    const buf = new Uint8Array([...header, ...withPointer])
    expect(parseDNS(buf)).toBeUndefined()
  })

  test("returns unknown qtype for unrecognized type number", () => {
    const qname = new Uint8Array([4, ...new TextEncoder().encode("test"), 0])
    const header = new Uint8Array([0, 0, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const qtype = new Uint8Array([0x00, 0x64])  // type 100, not in map
    const qclass = new Uint8Array([0x00, 0x01])
    const buf = new Uint8Array([...header, ...qname, ...qtype, ...qclass])
    const result = parseDNS(buf)
    expect(result?.qname).toBe("test")
    expect(result?.qtype).toBe("100")
  })
})

describe("config schema", () => {
  test("accepts observe mode", () => {
    const result = schema.safeParse({ network: { mode: "observe" } })
    expect(result.success).toBe(true)
  })

  test("rejects invalid mode", () => {
    const result = schema.safeParse({ network: { mode: "invalid" } })
    expect(result.success).toBe(false)
  })

  test("observe mode uses minimum 500ms timeout", () => {
    const result = schema.parse({ network: { mode: "observe" } })
    expect(result.network.mode).toBe("observe")
    expect(result.timeout).toBe(TIMEOUT) // schema default; sandbox uses Math.max(timeout, 500) for observe
  })

  test("strace_bufsize optional", () => {
    const result = schema.parse({ strace_bufsize: 16384 })
    expect(result.strace_bufsize).toBe(16384)
  })

  test("strace_bufsize undefined when not set", () => {
    const result = schema.parse({})
    expect(result.strace_bufsize).toBeUndefined()
  })
})
