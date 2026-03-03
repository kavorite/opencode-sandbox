import { describe, test, expect } from 'bun:test'
import { mapFlows } from '../src/proxy'
import type { ProxyFlow } from '../src/proxy'

describe('mapFlows', () => {
  test('maps HTTP flows to HttpRequest array', () => {
    const flows: ProxyFlow[] = [
      { method: 'GET', path: '/api/data', host: 'api.example.com', port: 80, status: 200, tls: false, sni: null },
    ]
    const result = mapFlows(flows)
    expect(result.http).toHaveLength(1)
    expect(result.http[0]?.method).toBe('GET')
    expect(result.http[0]?.host).toBe('api.example.com')
    expect(result.http[0]?.addr).toBe('api.example.com')
    expect(result.http[0]?.port).toBe(80)
    expect(result.http[0]?.forwarded).toBe(false)
  })

  test('maps TLS flows to TlsInfo array', () => {
    const flows: ProxyFlow[] = [
      { method: 'GET', path: '/secure', host: 'secure.example.com', port: 443, status: 200, tls: true, sni: 'secure.example.com' },
    ]
    const result = mapFlows(flows)
    expect(result.tls).toHaveLength(1)
    expect(result.tls[0]?.sni).toBe('secure.example.com')
    expect(result.tls[0]?.port).toBe(443)
  })

  test('non-TLS flows not included in tls array', () => {
    const flows: ProxyFlow[] = [
      { method: 'GET', path: '/', host: 'plain.example.com', port: 80, status: 200, tls: false, sni: null },
    ]
    const result = mapFlows(flows)
    expect(result.tls).toHaveLength(0)
  })

  test('DNS is always empty (not observable via explicit proxy)', () => {
    const flows: ProxyFlow[] = [
      { method: 'GET', path: '/', host: 'example.com', port: 80, status: 200, tls: false, sni: null },
    ]
    const result = mapFlows(flows)
    expect(result.dns).toHaveLength(0)
  })

  test('empty flows returns empty arrays', () => {
    const result = mapFlows([])
    expect(result.http).toHaveLength(0)
    expect(result.tls).toHaveLength(0)
    expect(result.dns).toHaveLength(0)
  })
})
