import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import type Dockerode from 'dockerode'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import path from 'path'
import type { SessionState, ExecResult, DiffResult } from '../src/container'
import type { SandboxConfig } from '../src/config'

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
    networkMode: 'oc-sandbox-test-session',
    ownsNetwork: true,
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

mock.module('../src/image', () => ({
  ensureImage: mock(() => Promise.resolve('opencode-sandbox:local')),
}))

// Dynamic import AFTER mocking
const { exec, inspect, approve, reject, teardown, init } = await import('../src/container')

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

    const state = makeState({ container, network, dockerClient, ownsNetwork: true })

    await teardown(state)

    expect(container.stop).toHaveBeenCalled()
    expect(container.remove).toHaveBeenCalled()
    expect(network.remove).toHaveBeenCalled()
    expect(cleanupMock).toHaveBeenCalled()
  })

  test('does NOT remove network when ownsNetwork is false (sub-agent)', async () => {
    const container = mockContainer()
    const network = mockNetwork()
    const dockerClient = {
      listContainers: mock(() => Promise.resolve([])),
      listNetworks: mock(() => Promise.resolve([])),
    } as unknown as Dockerode

    const state = makeState({ container, network, dockerClient, ownsNetwork: false })

    await teardown(state)

    expect(container.stop).toHaveBeenCalled()
    expect(container.remove).toHaveBeenCalled()
    expect(network.remove).not.toHaveBeenCalled()
    expect(cleanupMock).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// init() — git worktree bind-mount tests
// ---------------------------------------------------------------------------

const TEST_TMPDIR = '/tmp/oc-container-unit-' + Date.now()

function makeSandboxConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    network: { observe: false, allow: [], allow_methods: [], allow_graphql_queries: true },
    filesystem: { inherit_permissions: true, allow_write: [], deny_read: [] },
    auto_allow_clean: true,
    docker: { image: 'opencode-sandbox:local', gpu: false },
    verbose: false,
    ...overrides,
  }
}

afterAll(() => {
  rmSync(TEST_TMPDIR, { recursive: true, force: true })
})

describe('init — git worktree bind mounts', () => {
  beforeEach(() => {
    execCommandMock.mockClear()
    getChangesMock.mockClear()
    commitContainerMock.mockClear()
    createContainerMock.mockClear()
    cleanupMock.mockClear()
    createNetworkMock.mockClear()
  })

  test('worktree common git dir is mounted read-write', async () => {
    // Set up a fake worktree: .git is a file pointing to the main repo's worktree dir
    const mainRepo = path.join(TEST_TMPDIR, 'main-repo')
    const worktreeGitDir = path.join(mainRepo, '.git', 'worktrees', 'my-wt')
    const worktreeProject = path.join(TEST_TMPDIR, 'my-wt')

    mkdirSync(worktreeGitDir, { recursive: true })
    mkdirSync(worktreeProject, { recursive: true })
    // The .git file in the worktree points to the worktree-specific gitdir
    writeFileSync(path.join(worktreeProject, '.git'), `gitdir: ${worktreeGitDir}\n`)

    const state = await init(
      {} as Dockerode,
      worktreeProject,
      '/home/user',
      'wt-test-' + Date.now(),
      makeSandboxConfig(),
    )

    // The common git dir (main-repo/.git) should be in the binds
    const commonGitDir = path.join(mainRepo, '.git')
    const gitBind = state.binds.find(b => b.startsWith(commonGitDir + ':'))
    expect(gitBind).toBeDefined()
    // Must NOT have :ro suffix — git needs write access for refs/remotes, packed-refs
    expect(gitBind).toBe(`${commonGitDir}:${commonGitDir}`)
    expect(gitBind).not.toContain(':ro')
  })

  test('non-worktree .git directory does not add extra git bind', async () => {
    // Set up a normal repo: .git is a directory, not a file
    const normalProject = path.join(TEST_TMPDIR, 'normal-repo')
    const dotGitDir = path.join(normalProject, '.git')

    mkdirSync(dotGitDir, { recursive: true })

    const state = await init(
      {} as Dockerode,
      normalProject,
      '/home/user',
      'normal-test-' + Date.now(),
      makeSandboxConfig(),
    )

    // Should only have the two host mounts, $HOME:ro and $project:rw — no extra binds
    const nonStandardBinds = state.binds.filter(
      b => b !== '/usr/lib:/usr/lib:ro' &&
           b !== '/usr:/host/usr:ro' &&
           !b.startsWith('/home/user:') &&
           !b.startsWith(normalProject + ':')
    )
    expect(nonStandardBinds).toHaveLength(0)
  })
})
