import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import plugin from '../src/index.ts'
import { get as getResult } from '../src/store.ts'

// Temporary project directory for tests
const TEST_PROJECT = '/tmp/oc-integration-test-' + Date.now()

beforeAll(() => {
  mkdirSync(TEST_PROJECT, { recursive: true })
})

afterAll(async () => {
  rmSync(TEST_PROJECT, { recursive: true, force: true })
  // Force-cleanup any leftover Docker resources from this test run
  try {
    const proc = Bun.spawn(['docker', 'ps', '-aq', '-f', 'label=opencode-sandbox'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const ids = (await new Response(proc.stdout).text()).trim()
    if (ids) {
      await Bun.spawn(['docker', 'rm', '-f', ...ids.split('\n').filter(Boolean)], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited
    }
  } catch { /* best-effort */ }
  try {
    const proc = Bun.spawn(['docker', 'network', 'ls', '-q', '-f', 'label=opencode-sandbox'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const netIds = (await new Response(proc.stdout).text()).trim()
    if (netIds) {
      for (const id of netIds.split('\n').filter(Boolean)) {
        await Bun.spawn(['docker', 'network', 'rm', id], {
          stdout: 'ignore',
          stderr: 'ignore',
        }).exited
      }
    }
  } catch { /* best-effort */ }
})

describe('opencode-sandbox Docker integration', () => {
  test('nesting detection: OC_SANDBOX=1 returns empty hooks', async () => {
    process.env.OC_SANDBOX = '1'
    try {
      const hooks = await plugin({
        directory: TEST_PROJECT,
        worktree: TEST_PROJECT,
        serverUrl: new URL('http://localhost:0'),
      })
      expect(Object.keys(hooks)).toHaveLength(0)
    } finally {
      delete process.env.OC_SANDBOX
    }
  })

  test('Docker unavailable throws error', async () => {
    const origHost = process.env.DOCKER_HOST
    process.env.DOCKER_HOST = 'tcp://localhost:99999'
    try {
      await expect(
        plugin({
          directory: TEST_PROJECT,
          worktree: TEST_PROJECT,
          serverUrl: new URL('http://localhost:0'),
        }),
      ).rejects.toThrow(/Docker/)
    } finally {
      if (origHost !== undefined) process.env.DOCKER_HOST = origHost
      else delete process.env.DOCKER_HOST
    }
  }, 15000)

  test('plugin initializes and returns 4 hooks', async () => {
    const hooks = await plugin({
      directory: TEST_PROJECT,
      worktree: TEST_PROJECT,
      serverUrl: new URL('http://localhost:0'),
    })
    const keys = Object.keys(hooks).sort()
    expect(keys).toEqual([
      'permission.ask',
      'shell.env',
      'tool.execute.after',
      'tool.execute.before',
    ])
  }, 30000) // 30s timeout for container startup

  test('clean echo command is auto-approved with no violations', async () => {
    const callID = 'test-clean-' + Date.now()

    const hooks = await plugin({
      directory: TEST_PROJECT,
      worktree: TEST_PROJECT,
      serverUrl: new URL('http://localhost:0'),
    })

    // Simulate tool.execute.before — stashes args ref by callID
    const argsRef = { command: 'echo hello' }
    await hooks['tool.execute.before']?.(
      { tool: 'bash', callID, id: callID } as any,
      { args: argsRef } as any,
    )

    // Simulate permission.ask — runs command in Docker, evaluates policy
    const askOutput = { status: 'ask' as 'ask' | 'allow' | 'deny' }
    await hooks['permission.ask']?.(
      { type: 'bash', callID, id: callID } as any,
      askOutput as any,
    )

    // Clean command (echo) should be auto-approved
    expect(askOutput.status).toBe('allow')

    // Command should have been replaced with no-op
    expect(argsRef.command).toBe('true')

    // Result should be stored
    const result = getResult(callID)
    expect(result).toBeDefined()
    expect(result?.exitCode).toBe(0)
    expect(result?.stdout.trim()).toBe('hello')
    expect(result?.violations).toHaveLength(0)
  }, 60000) // 60s for container exec

  test('write outside project produces mutation violation', async () => {
    const callID = 'test-mutation-' + Date.now()

    const hooks = await plugin({
      directory: TEST_PROJECT,
      worktree: TEST_PROJECT,
      serverUrl: new URL('http://localhost:0'),
    })

    // Command that writes outside the project directory
    // /home/sandbox is writable by the container user but outside project + ephemeral paths
    const argsRef = { command: 'mkdir /home/sandbox/evil-test' }
    await hooks['tool.execute.before']?.(
      { tool: 'bash', callID, id: callID } as any,
      { args: argsRef } as any,
    )

    const askOutput = { status: 'ask' as 'ask' | 'allow' | 'deny' }
    await hooks['permission.ask']?.(
      { type: 'bash', callID, id: callID } as any,
      askOutput as any,
    )

    // Result should be stored with mutations detected
    const result = getResult(callID)
    expect(result).toBeDefined()
    expect(result!.mutations.length).toBeGreaterThan(0)
    expect(result!.violations.length).toBeGreaterThan(0)

    // At least one violation should be a filesystem mutation for our path
    const mutationViolation = result!.violations.find(
      (v) => v.type === 'filesystem' && v.detail.includes('/home/sandbox/evil-test'),
    )
    expect(mutationViolation).toBeDefined()
  }, 60000) // 60s for container exec
})
