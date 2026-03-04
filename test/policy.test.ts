import { describe, test, expect } from 'bun:test'
import { evaluate } from '../src/policy'
import type { SandboxResult } from '../src/store'
import type { SandboxConfig } from '../src/config'

const defaultConfig: SandboxConfig = {
  network: {
    observe: true,
    allow: [],
    allow_methods: ['GET', 'HEAD', 'OPTIONS'],
    allow_graphql_queries: true,
  },
  filesystem: {
    inherit_permissions: true,
    allow_write: [],
    deny_read: [],
  },
  auto_allow_clean: true,
  docker: { image: 'opencode-sandbox:local', gpu: true },
  verbose: false,
}

const emptyResult: SandboxResult = {
  files: [],
  writes: [],
  mutations: [],
  network: [],
  sockets: [],
  dns: [],
  http: [],
  tls: [],
  ssh: [],
  duration: 0,
  timedOut: false,
  violations: [],
  stdout: '',
  stderr: '',
  exitCode: 0,
}

describe('evaluate — GraphQL policy', () => {
  test('allows GraphQL query when allow_graphql_queries is true', () => {
    const result: SandboxResult = {
      ...emptyResult,
      http: [{
        method: 'POST',
        path: '/graphql',
        host: 'api.example.com',
        addr: 'api.example.com',
        port: 443,
        graphql: { type: 'query', name: 'GetUser' },
      }],
    }
    const violations = evaluate(result, defaultConfig, '/project')
    expect(violations).toHaveLength(0)
  })

  test('flags GraphQL mutation when allow_graphql_queries is true', () => {
    const result: SandboxResult = {
      ...emptyResult,
      http: [{
        method: 'POST',
        path: '/graphql',
        host: 'api.example.com',
        addr: 'api.example.com',
        port: 443,
        graphql: { type: 'mutation', name: 'DeleteUser' },
      }],
    }
    const violations = evaluate(result, defaultConfig, '/project')
    expect(violations).toHaveLength(1)
    expect(violations[0]!.type).toBe('network')
    expect(violations[0]!.severity).toBe('high')
    expect(violations[0]!.detail).toContain('POST')
  })

  test('flags GraphQL subscription when allow_graphql_queries is true', () => {
    const result: SandboxResult = {
      ...emptyResult,
      http: [{
        method: 'POST',
        path: '/graphql',
        host: 'api.example.com',
        addr: 'api.example.com',
        port: 443,
        graphql: { type: 'subscription', name: 'OnMessage' },
      }],
    }
    const violations = evaluate(result, defaultConfig, '/project')
    expect(violations).toHaveLength(1)
  })

  test('flags POST without graphql info (non-GraphQL endpoint)', () => {
    const result: SandboxResult = {
      ...emptyResult,
      http: [{
        method: 'POST',
        path: '/api/data',
        host: 'api.example.com',
        addr: 'api.example.com',
        port: 443,
      }],
    }
    const violations = evaluate(result, defaultConfig, '/project')
    expect(violations).toHaveLength(1)
    expect(violations[0]!.detail).toContain('POST')
  })

  test('allows everything when POST is in allow_methods', () => {
    const config: SandboxConfig = {
      ...defaultConfig,
      network: {
        ...defaultConfig.network,
        allow_methods: ['GET', 'HEAD', 'OPTIONS', 'POST'],
      },
    }
    const result: SandboxResult = {
      ...emptyResult,
      http: [{
        method: 'POST',
        path: '/graphql',
        host: 'api.example.com',
        addr: 'api.example.com',
        port: 443,
        graphql: { type: 'mutation', name: 'DeleteUser' },
      }],
    }
    const violations = evaluate(result, config, '/project')
    expect(violations).toHaveLength(0)
  })

  test('flags mutation even when allow_graphql_queries is false', () => {
    const config: SandboxConfig = {
      ...defaultConfig,
      network: {
        ...defaultConfig.network,
        allow_graphql_queries: false,
      },
    }
    const result: SandboxResult = {
      ...emptyResult,
      http: [{
        method: 'POST',
        path: '/graphql',
        host: 'api.example.com',
        addr: 'api.example.com',
        port: 443,
        graphql: { type: 'mutation', name: 'DeleteUser' },
      }],
    }
    const violations = evaluate(result, config, '/project')
    expect(violations).toHaveLength(1)
  })

  test('flags query when allow_graphql_queries is false', () => {
    const config: SandboxConfig = {
      ...defaultConfig,
      network: {
        ...defaultConfig.network,
        allow_graphql_queries: false,
      },
    }
    const result: SandboxResult = {
      ...emptyResult,
      http: [{
        method: 'POST',
        path: '/graphql',
        host: 'api.example.com',
        addr: 'api.example.com',
        port: 443,
        graphql: { type: 'query', name: 'GetUser' },
      }],
    }
    const violations = evaluate(result, config, '/project')
    expect(violations).toHaveLength(1)
  })

  test('no violations when observe mode is off', () => {
    const config: SandboxConfig = {
      ...defaultConfig,
      network: {
        ...defaultConfig.network,
        observe: false,
      },
    }
    const result: SandboxResult = {
      ...emptyResult,
      http: [{
        method: 'POST',
        path: '/graphql',
        host: 'api.example.com',
        addr: 'api.example.com',
        port: 443,
        graphql: { type: 'mutation', name: 'DeleteUser' },
      }],
    }
    const violations = evaluate(result, config, '/project')
    expect(violations).toHaveLength(0)
  })

  test('mixed requests — query allowed, mutation flagged', () => {
    const result: SandboxResult = {
      ...emptyResult,
      http: [
        {
          method: 'POST',
          path: '/graphql',
          host: 'api.example.com',
          addr: 'api.example.com',
          port: 443,
          graphql: { type: 'query', name: 'GetUser' },
        },
        {
          method: 'POST',
          path: '/graphql',
          host: 'api.example.com',
          addr: 'api.example.com',
          port: 443,
          graphql: { type: 'mutation', name: 'DeleteUser' },
        },
        {
          method: 'GET',
          path: '/api/health',
          addr: 'api.example.com',
          port: 443,
        },
      ],
    }
    const violations = evaluate(result, defaultConfig, '/project')
    // Only the mutation should be flagged (GET is allowed, query is allowed)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.detail).toContain('POST')
  })
})
