import { describe, test, expect } from 'bun:test'
import { schema } from '../src/config'

describe('config schema', () => {
  test('parses empty input with defaults', () => {
    const result = schema.parse({})
    expect(result.network.observe).toBe(false)
    expect(result.docker.image).toBe('opencode-sandbox:local')
    expect(result).not.toHaveProperty('timeout')
    expect(result).not.toHaveProperty('home_readable')
    expect(result).not.toHaveProperty('strace_bufsize')
  })

  test('docker.image can be overridden', () => {
    const result = schema.parse({ docker: { image: 'my-custom:latest' } })
    expect(result.docker.image).toBe('my-custom:latest')
  })

  test('network.allow_methods defaults to GET,HEAD,OPTIONS', () => {
    const result = schema.parse({})
    expect(result.network.allow_methods).toContain('GET')
    expect(result.network.allow_methods).toContain('HEAD')
    expect(result.network.allow_methods).toContain('OPTIONS')
  })

  test('filesystem fields present', () => {
    const result = schema.parse({})
    expect(result.filesystem.allow_write).toEqual([])
    expect(result.filesystem.deny_read).toEqual([])
    expect(result.filesystem.inherit_permissions).toBe(true)
  })
})
