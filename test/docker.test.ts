import { describe, test, expect, mock } from 'bun:test'
import type Dockerode from 'dockerode'
import {
  createContainer,
  getChanges,
  commitContainer,
  createNetwork,
  cleanup,
  type ContainerCreateOpts,
  type ContainerChange,
} from '../src/docker'

describe('createContainer', () => {
  test('applies selective CapDrop (not ALL)', async () => {
    let capturedConfig: unknown
    const mockDocker = {
      createContainer: mock((config: unknown) => {
        capturedConfig = config
        return Promise.resolve({ id: 'mock-container' })
      }),
    } as unknown as Dockerode

    await createContainer(mockDocker, {
      sessionId: 'test-session',
      image: 'alpine:3.19',
      cmd: ['sleep', '1'],
    })

    const cfg = capturedConfig as Record<string, unknown>
    const hostConfig = cfg.HostConfig as Record<string, unknown>
    const capDrop = hostConfig.CapDrop as string[]

    expect(capDrop).toContain('NET_RAW')
    expect(capDrop).toContain('SYS_ADMIN')
    expect(capDrop).not.toContain('SYS_PTRACE')
    const capAdd = hostConfig.CapAdd as string[]
    expect(capAdd).toContain('SYS_PTRACE')
    expect(capDrop).toContain('SYS_MODULE')
    expect(capDrop).toContain('SYS_BOOT')
    expect(capDrop).toContain('MAC_ADMIN')
    expect(capDrop).toContain('AUDIT_WRITE')
    expect(capDrop).not.toContain('ALL')
    expect(hostConfig.SecurityOpt).toContain('seccomp=unconfined')
    expect(hostConfig.SecurityOpt).not.toContain('no-new-privileges')
  })

  test('includes DeviceRequests for GPU when gpu: true', async () => {
    let capturedConfig: unknown
    const mockDocker = {
      createContainer: mock((config: unknown) => {
        capturedConfig = config
        return Promise.resolve({ id: 'mock-container' })
      }),
    } as unknown as Dockerode

    await createContainer(mockDocker, {
      sessionId: 'test-gpu',
      image: 'alpine:3.19',
      cmd: ['sleep', '1'],
      gpu: true,
    })

    const cfg = capturedConfig as Record<string, unknown>
    const hostConfig = cfg.HostConfig as Record<string, unknown>
    const deviceRequests = hostConfig.DeviceRequests as Array<Record<string, unknown>>
    expect(deviceRequests).toHaveLength(1)
    expect(deviceRequests[0].Count).toBe(-1)
    expect(deviceRequests[0].Capabilities).toEqual([['gpu']])
  })

  test('omits DeviceRequests when gpu: false', async () => {
    let capturedConfig: unknown
    const mockDocker = {
      createContainer: mock((config: unknown) => {
        capturedConfig = config
        return Promise.resolve({ id: 'mock-container' })
      }),
    } as unknown as Dockerode

    await createContainer(mockDocker, {
      sessionId: 'test-no-gpu',
      image: 'alpine:3.19',
      cmd: ['sleep', '1'],
      gpu: false,
    })

    const cfg = capturedConfig as Record<string, unknown>
    const hostConfig = cfg.HostConfig as Record<string, unknown>
    expect(hostConfig.DeviceRequests).toBeUndefined()
  })

  test('omits DeviceRequests when gpu not specified', async () => {
    let capturedConfig: unknown
    const mockDocker = {
      createContainer: mock((config: unknown) => {
        capturedConfig = config
        return Promise.resolve({ id: 'mock-container' })
      }),
    } as unknown as Dockerode

    await createContainer(mockDocker, {
      sessionId: 'test-default',
      image: 'alpine:3.19',
      cmd: ['sleep', '1'],
    })

    const cfg = capturedConfig as Record<string, unknown>
    const hostConfig = cfg.HostConfig as Record<string, unknown>
    expect(hostConfig.DeviceRequests).toBeUndefined()
  })

  test('sets sandbox labels with sessionId', async () => {
    let capturedConfig: unknown
    const mockDocker = {
      createContainer: mock((config: unknown) => {
        capturedConfig = config
        return Promise.resolve({ id: 'mock-container' })
      }),
    } as unknown as Dockerode

    await createContainer(mockDocker, {
      sessionId: 'sess-abc-123',
      image: 'node:20',
      cmd: ['node'],
    })

    const cfg = capturedConfig as Record<string, unknown>
    const labels = cfg.Labels as Record<string, string>
    expect(labels['opencode-sandbox']).toBe('true')
    expect(labels['opencode-sandbox.session']).toBe('sess-abc-123')
  })

  test('passes optional binds, networkMode, env, workingDir, name', async () => {
    let capturedConfig: unknown
    const mockDocker = {
      createContainer: mock((config: unknown) => {
        capturedConfig = config
        return Promise.resolve({ id: 'mock-container' })
      }),
    } as unknown as Dockerode

    await createContainer(mockDocker, {
      sessionId: 'test',
      image: 'alpine',
      cmd: ['sh'],
      binds: ['/host:/container:ro'],
      networkMode: 'none',
      env: ['FOO=bar'],
      workingDir: '/app',
      name: 'my-container',
    })

    const cfg = capturedConfig as Record<string, unknown>
    const hostConfig = cfg.HostConfig as Record<string, unknown>
    expect(cfg.WorkingDir).toBe('/app')
    expect(cfg.Env).toEqual(['FOO=bar'])
    expect(cfg.name).toBe('my-container')
    expect(hostConfig.Binds).toEqual(['/host:/container:ro'])
    expect(hostConfig.NetworkMode).toBe('none')
  })
})

describe('getChanges', () => {
  test('returns ContainerChange array from container.changes()', async () => {
    const mockChanges: ContainerChange[] = [
      { Kind: 1, Path: '/tmp/newfile' },
      { Kind: 0, Path: '/etc/hosts' },
      { Kind: 2, Path: '/var/log/old' },
    ]
    const mockContainer = {
      changes: mock(() => Promise.resolve(mockChanges)),
    } as unknown as Dockerode.Container

    const result = await getChanges(mockContainer)
    expect(result).toEqual(mockChanges)
    expect(result).toHaveLength(3)
    expect(result[0].Kind).toBe(1)
    expect(result[0].Path).toBe('/tmp/newfile')
  })

  test('returns empty array when changes() returns null', async () => {
    const mockContainer = {
      changes: mock(() => Promise.resolve(null)),
    } as unknown as Dockerode.Container

    const result = await getChanges(mockContainer)
    expect(result).toEqual([])
  })
})

describe('commitContainer', () => {
  test('commits with repo:tag split', async () => {
    let capturedArgs: unknown
    const mockContainer = {
      commit: mock((args: unknown) => {
        capturedArgs = args
        return Promise.resolve({ Id: 'sha256:abc123' })
      }),
    } as unknown as Dockerode.Container

    const id = await commitContainer(mockContainer, 'myrepo:v1')
    expect(id).toBe('sha256:abc123')
    expect(capturedArgs).toEqual({ repo: 'myrepo', tag: 'v1' })
  })

  test('defaults tag to latest when no colon', async () => {
    let capturedArgs: unknown
    const mockContainer = {
      commit: mock((args: unknown) => {
        capturedArgs = args
        return Promise.resolve({ Id: 'sha256:def456' })
      }),
    } as unknown as Dockerode.Container

    const id = await commitContainer(mockContainer, 'myrepo')
    expect(id).toBe('sha256:def456')
    expect(capturedArgs).toEqual({ repo: 'myrepo', tag: 'latest' })
  })
})

describe('createNetwork', () => {
  test('creates bridge network with sandbox labels', async () => {
    let capturedConfig: unknown
    const mockDocker = {
      createNetwork: mock((config: unknown) => {
        capturedConfig = config
        return Promise.resolve({ id: 'net-123' })
      }),
    } as unknown as Dockerode

    await createNetwork(mockDocker, 'test-net', 'sess-xyz')
    const cfg = capturedConfig as Record<string, unknown>
    expect(cfg.Name).toBe('test-net')
    expect(cfg.Driver).toBe('bridge')
    const labels = cfg.Labels as Record<string, string>
    expect(labels['opencode-sandbox']).toBe('true')
    expect(labels['opencode-sandbox.session']).toBe('sess-xyz')
  })
})

describe('cleanup', () => {
  test('stops and removes containers, then removes networks', async () => {
    const stopMock = mock(() => Promise.resolve())
    const removeMock = mock(() => Promise.resolve())
    const netRemoveMock = mock(() => Promise.resolve())

    const mockDocker = {
      listContainers: mock(() =>
        Promise.resolve([
          { Id: 'c1' },
          { Id: 'c2' },
        ]),
      ),
      getContainer: mock((id: string) => ({
        stop: stopMock,
        remove: removeMock,
      })),
      listNetworks: mock(() =>
        Promise.resolve([{ Id: 'n1' }]),
      ),
      getNetwork: mock(() => ({
        remove: netRemoveMock,
      })),
    } as unknown as Dockerode

    await cleanup(mockDocker, 'sess-cleanup')

    // Verify listContainers called with correct label filter
    expect(mockDocker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['opencode-sandbox.session=sess-cleanup'] },
    })

    // Verify stop + remove called for each container
    expect(stopMock).toHaveBeenCalledTimes(2)
    expect(removeMock).toHaveBeenCalledTimes(2)

    // Verify network removal
    expect(netRemoveMock).toHaveBeenCalledTimes(1)
  })

  test('handles already-stopped containers gracefully', async () => {
    const stopMock = mock(() => Promise.reject(new Error('container already stopped')))
    const removeMock = mock(() => Promise.resolve())

    const mockDocker = {
      listContainers: mock(() =>
        Promise.resolve([{ Id: 'c-stopped' }]),
      ),
      getContainer: mock(() => ({
        stop: stopMock,
        remove: removeMock,
      })),
      listNetworks: mock(() => Promise.resolve([])),
      getNetwork: mock(() => ({ remove: mock(() => Promise.resolve()) })),
    } as unknown as Dockerode

    // Should not throw even if stop fails
    await cleanup(mockDocker, 'sess-stopped')
    expect(removeMock).toHaveBeenCalledTimes(1)
  })
})
