/**
 * Parse DNS wire format query packets.
 * Extracts QNAME (domain name) and QTYPE (record type) from DNS queries.
 */

const QTYPES: Record<number, string> = {
  1: "A",
  2: "NS",
  5: "CNAME",
  15: "MX",
  16: "TXT",
  28: "AAAA",
  33: "SRV",
  255: "ANY",
}

export function parseDNS(buf: Uint8Array): { qname: string; qtype: string } | undefined {
  // Minimum DNS packet: 12-byte header
  if (buf.length < 12) return undefined

  // Header flags: QR bit (MSB of byte[2]) must be 0 for query
  const flags = (buf[2]! << 8) | buf[3]!
  if (flags & 0x8000) return undefined // QR=1 means response, not query

  // QDCOUNT must be >= 1 (2 bytes at offset 4)
  const qdcount = (buf[4]! << 8) | buf[5]!
  if (qdcount < 1) return undefined

  // Parse QNAME starting at offset 12
  let pos = 12
  const labels: string[] = []

  while (pos < buf.length) {
    const len = buf[pos]!
    pos++

    // Null terminator = end of QNAME
    if (len === 0) break

    // Compression pointer (top 2 bits = 11) — stop parsing (queries rarely use compression)
    if ((len & 0xc0) === 0xc0) return undefined

    // Label length validation (RFC 1035: max 63 bytes)
    if (len > 63) return undefined

    // Guard: ensure we have enough bytes for this label
    if (pos + len > buf.length) return undefined

    // Extract label as ASCII string
    labels.push(new TextDecoder("ascii", { fatal: false }).decode(buf.slice(pos, pos + len)))
    pos += len

    // Guard: total QNAME length (dots + labels) must be <= 253
    const totalLen = labels.join(".").length
    if (totalLen > 253) return undefined
  }

  if (labels.length === 0) return undefined

  // QTYPE: 2 bytes after QNAME
  if (pos + 2 > buf.length) return undefined
  const qtype = (buf[pos]! << 8) | buf[pos + 1]!

  return {
    qname: labels.join("."),
    qtype: QTYPES[qtype] ?? String(qtype),
  }
}
