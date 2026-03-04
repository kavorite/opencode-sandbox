import { describe, test, expect, mock } from 'bun:test'
import type Dockerode from 'dockerode'
import type { SessionState, ExecResult, DiffResult } from '../src/container'

// ---------------------------------------------------------------------------
// Mock helpers — build mock Docker objects without requiring a daemon
// ---------------------------------------------------------------------------

function mockContainer(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'mock-container-id',
    start: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    remove: mock(() => Promise.resolve()),
    commit: mock(() => Promise.resolve({ Id: 'sha256:committed' })),
    changes: mock(() => Promise.resolve([])),
    unpause: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as Dockerode.Container
}

function mockNetwork() {
  return {
    id: 'mock-network-id',
    remove: mock(() => Promise.resolve()),
  } as unknown as Dockerode.Network
}

function makeState(overrides?: Partial<SessionState>): SessionState {
  return {
    container: mockContainer(),
    network: mockNetwork(),
    imageTag: 'opencode-sandbox:test-base',
    sessionId: 'test-session',
    project: '/home/user/project',
    home: '/home/user',
    containerHome: '/home/sandbox',
    dockerClient: {} as Dockerode,
    binds: [],
    env: [],
    gpu: false,
    baseline: new Set(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Type contract tests
// ---------------------------------------------------------------------------

describe('SessionState type contract', () => {
  test('has all required fields', () => {
    const state = makeState()
    expect(state.sessionId).toBe('test-session')
    expect(state.project).toBe('/home/user/project')
    expect(state.home).toBe('/home/user')
    expect(state.imageTag).toBe('opencode-sandbox:test-base')
    expect(state.container).toBeDefined()
    expect(state.network).toBeDefined()
    expect(state.dockerClient).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Lifecycle tests using mock.module to intercept docker.ts
// ---------------------------------------------------------------------------

const execCommandMock = mock(async (_container: unknown, cmd: string[], opts?: unknown) => ({
  stdout: 'hello world',
  stderr: '',
  exitCode: 0,
}))

const getChangesMock = mock(async () => [
  { Kind: 1 as const, Path: '/home/user/.cache/new-file' },
])

const commitContainerMock = mock(async (_container: unknown, tag: string) => `sha256:${tag}`)

const createContainerMock = mock(async (_docker: unknown, opts: unknown) => mockContainer())

const cleanupMock = mock(async () => {})

const createNetworkMock = mock(async () => mockNetwork())

mock.module('../src/docker', () => ({
  execCommand: execCommandMock,
  getChanges: getChangesMock,
  commitContainer: commitContainerMock,
  createContainer: createContainerMock,
  cleanup: cleanupMock,
  createNetwork: createNetworkMock,
}))


// Dynamic import AFTER mocking
const { exec, inspect, approve, reject, teardown } = await import('../src/container')

describe('exec', () => {
  test('delegates to docker.execCommand with sh -c wrapper', async () => {
    const state = makeState()
    const result = await exec(state, 'echo hi', '/home/user/project')

    expect(execCommandMock).toHaveBeenCalled()
    const lastCall = execCommandMock.mock.calls[execCommandMock.mock.calls.length - 1]!
    // cmd should be ['sh', '-c', 'echo hi']
    expect(lastCall[1]).toEqual(['sh', '-c', 'echo hi'])
    // opts should include WorkingDir
    expect((lastCall[2] as Record<string, unknown>)?.WorkingDir).toBe('/home/user/project')
    expect(result.stdout).toBe('hello world')
    expect(result.exitCode).toBe(0)
  })
})

describe('inspect', () => {
  test('returns DiffResult from container changes', async () => {
    const state = makeState()
    const result = await inspect(state)

    expect(getChangesMock).toHaveBeenCalled()
    // mapChanges is real (not mocked) — the added file is outside project → mutation
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]?.path).toBe('/home/user/.cache/new-file')
    expect(result.mutations[0]?.syscall).toBe('creat')
  })
})

describe('approve', () => {
  test('commits container with new tag, updates imageTag, and unpauses', async () => {
    const container = mockContainer()
    const state = makeState({ container })
    const oldTag = state.imageTag

    await approve(state)

    expect(commitContainerMock).toHaveBeenCalled()
    // imageTag should be updated to new approved tag
    expect(state.imageTag).not.toBe(oldTag)
    expect(state.imageTag).toContain('approved')
    // Container should be explicitly unpaused after commit
    expect(container.unpause).toHaveBeenCalled()
  })
})

describe('reject', () => {
  test('stops and removes dirty container, recreates from committed image', async () => {
    const originalContainer = mockContainer()
    const state = makeState({ container: originalContainer })

    await reject(state)

    // Original container should have been stopped and removed
    expect(originalContainer.stop).toHaveBeenCalled()
    expect(originalContainer.remove).toHaveBeenCalled()

    // createContainer should have been called with the last committed imageTag
    expect(createContainerMock).toHaveBeenCalled()

    // state.container should now be the new container
    expect(state.container).not.toBe(originalContainer)
  })
})

describe('teardown', () => {
  test('stops container, removes container, removes network, runs cleanup', async () => {
    const container = mockContainer()
    const network = mockNetwork()
    const dockerClient = {
      listContainers: mock(() => Promise.resolve([])),
      listNetworks: mock(() => Promise.resolve([])),
    } as unknown as Dockerode

    const state = makeState({ container, network, dockerClient })

    await teardown(state)

    expect(container.stop).toHaveBeenCalled()
    expect(container.remove).toHaveBeenCalled()
    expect(network.remove).toHaveBeenCalled()
    expect(cleanupMock).toHaveBeenCalled()
  })
})
