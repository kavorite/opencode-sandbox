/**
 * Decode strace's escaped buffer format back to raw bytes.
 *
 * Strace escapes binary data in strings using:
 * - \xNN for hex bytes
 * - \NNN for octal bytes (1-3 digits)
 * - \n, \r, \t, \0 for special chars
 * - \\ for backslash
 * - \" for quote
 * - Literal printable ASCII
 */

export function decode(raw: string): Uint8Array {
  const bytes: number[] = []

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!

    // Check for truncation marker at end
    if (c === "." && raw.slice(i) === "...") {
      break
    }

    if (c !== "\\") {
      bytes.push(c.charCodeAt(0))
      continue
    }

    // Handle escape sequences
    i++
    if (i >= raw.length) break

    const next = raw[i]!

    // Hex escape: \xNN
    if (next === "x") {
      i++
      const hex = raw.slice(i, i + 2)
      if (hex.length === 2) {
        bytes.push(parseInt(hex, 16))
        i += 1
        continue
      }
    }

    // Special single-char escapes
    if (next === "n") {
      bytes.push(0x0a)
      continue
    }
    if (next === "r") {
      bytes.push(0x0d)
      continue
    }
    if (next === "t") {
      bytes.push(0x09)
      continue
    }
    if (next === "0") {
      bytes.push(0x00)
      continue
    }
    if (next === "\\") {
      bytes.push(0x5c)
      continue
    }
    if (next === '"') {
      bytes.push(0x22)
      continue
    }

    // Octal escape: \NNN (1-3 digits)
    if (next >= "0" && next <= "7") {
      let octal = next
      let j = i + 1
      while (j < i + 3 && j < raw.length && raw[j]! >= "0" && raw[j]! <= "7") {
        octal += raw[j]!
        j++
      }
      bytes.push(parseInt(octal, 8))
      i = j - 1
      continue
    }

    // Unknown escape, treat as literal
    bytes.push(next!.charCodeAt(0))
  }

  return new Uint8Array(bytes)
}

export function isTruncated(raw: string): boolean {
  return raw.endsWith("...")
}
