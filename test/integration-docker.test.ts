import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import path from 'path'
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

  test('clean echo command runs in Docker and stores result', async () => {
    const callID = 'test-clean-' + Date.now()

    const hooks = await plugin({
      directory: TEST_PROJECT,
      worktree: TEST_PROJECT,
      serverUrl: new URL('http://localhost:0'),
    })

    // Simulate tool.execute.before — runs command in Docker, stores result, replaces command
    const argsRef = { command: 'echo hello' }
    await hooks['tool.execute.before']?.({
      tool: 'bash', callID, id: callID
    } as any, { args: argsRef } as any)

    // Result should be stored after tool.execute.before
    const result = getResult(callID)
    expect(result).toBeDefined()
    expect(result?.exitCode).toBe(0)
    expect(result?.stdout.trim()).toBe('hello')
    expect(result?.violations).toHaveLength(0)

    // Clean command: silent comment sentinel (no permission prompt)
    expect(argsRef.command).toBe('# [sandboxed] echo hello')
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
    await hooks['tool.execute.before']?.({
      tool: 'bash', callID, id: callID
    } as any, { args: argsRef } as any)

    // Result should be stored with mutations + violations detected after tool.execute.before
    const result = getResult(callID)
    expect(result).toBeDefined()
    expect(result!.mutations.length).toBeGreaterThan(0)
    expect(result!.violations.length).toBeGreaterThan(0)

    // At least one violation should be a filesystem mutation for our path
    const mutationViolation = result!.violations.find(
      (v) => v.type === 'filesystem' && v.detail.includes('/home/sandbox/evil-test'),
    )
    expect(mutationViolation).toBeDefined()

    // Command should be replaced with sentinel even on violation
    expect(argsRef.command).toBe('true # [sandboxed] mkdir /home/sandbox/evil-test')
  }, 60000) // 60s for container exec

  test('SSH auth: ~/.ssh is mounted and plainsight key can reach github', async () => {
    const callID = 'test-ssh-' + Date.now()

    const hooks = await plugin({
      directory: TEST_PROJECT,
      worktree: TEST_PROJECT,
      serverUrl: new URL('http://localhost:0'),
    })

    // Verify ~/.ssh is mounted by checking the plainsight key exists inside the container
    const argsRef = { command: 'test -f ~/.ssh/plainsight && echo SSH_KEY_PRESENT || echo SSH_KEY_MISSING' }
    await hooks['tool.execute.before']?.({
      tool: 'bash', callID, id: callID
    } as any, { args: argsRef } as any)

    const result = getResult(callID)
    expect(result).toBeDefined()
    expect(result!.violations).toHaveLength(0)
    expect(result!.stdout.trim()).toBe('SSH_KEY_PRESENT')
  }, 60000)

  test('SSH auth: git ls-remote works with plainsight key inside container', async () => {
    const callID = 'test-ssh-git-' + Date.now()

    const hooks = await plugin({
      directory: TEST_PROJECT,
      worktree: TEST_PROJECT,
      serverUrl: new URL('http://localhost:0'),
    })

    // Use GIT_SSH_COMMAND to explicitly use the plainsight key, with StrictHostKeyChecking disabled
    // to avoid known_hosts prompts in CI-like environments
    const sshCmd = 'ssh -i ~/.ssh/plainsight -o StrictHostKeyChecking=accept-new -o BatchMode=yes'
    const argsRef = {
      // Don't redirect stderr — we want stdout to contain only the ls-remote output (commit hash + HEAD)
      command: `GIT_SSH_COMMAND='${sshCmd}' git ls-remote git@github.com:PlainsightAI/plainsight-api.git HEAD`,
    }
    await hooks['tool.execute.before']?.({
      tool: 'bash', callID, id: callID
    } as any, { args: argsRef } as any)

    const result = getResult(callID)
    expect(result).toBeDefined()
    expect(result!.violations).toHaveLength(0)
    // stdout should contain a commit hash + 'HEAD' line
    expect(result!.stdout).toMatch(/[0-9a-f]{40}\s+HEAD/)
  }, 120000) // 2 min for network + git handshake
})

describe('opencode-sandbox strace integration', () => {
  test('strace: git ls-remote populates result.ssh with git-upload-pack (no violation)', async () => {
    const callID = 'test-strace-fetch-' + Date.now()
    const hooks = await plugin({
      directory: TEST_PROJECT,
      worktree: TEST_PROJECT,
      serverUrl: new URL('http://localhost:0'),
    })

    const sshCmd = 'ssh -i ~/.ssh/plainsight -o StrictHostKeyChecking=accept-new -o BatchMode=yes'
    const cmd = `GIT_SSH_COMMAND='${sshCmd}' git ls-remote git@github.com:PlainsightAI/plainsight-api.git HEAD`
    const argsRef = { command: cmd }
    await hooks['tool.execute.before']?.({ tool: 'bash', callID, id: callID } as any, { args: argsRef } as any)

    const result = getResult(callID)
    expect(result).toBeDefined()
    // ls-remote uses git-upload-pack -- not a push, not a violation
    expect(result!.violations).toHaveLength(0)
    // strace should have captured the ssh execve with git-upload-pack
    const uploadPack = result!.ssh.find((s) => s.cmd === 'git-upload-pack')
    expect(uploadPack).toBeDefined()
    expect(uploadPack!.addr).toContain('github.com')
  }, 120000)
})

// ---------------------------------------------------------------------------
// Git worktree integration tests
// Verifies that git commands inside the sandbox can write refs to the shared
// common git dir when running from a worktree.
// ---------------------------------------------------------------------------

describe('opencode-sandbox git worktree integration', () => {
  // All dirs under $HOME so the bare repo is readable via the $HOME:ro mount
  const HOME = process.env.HOME!
  const WT_TEST_DIR = path.join(HOME, '.oc-worktree-test-' + Date.now())
  const BARE_REPO = path.join(WT_TEST_DIR, 'bare.git')
  const MAIN_CLONE = path.join(WT_TEST_DIR, 'main-clone')
  const WORKTREE_DIR = path.join(WT_TEST_DIR, 'my-worktree')

  beforeAll(() => {
    mkdirSync(WT_TEST_DIR, { recursive: true })
    // Create a bare repo
    execSync('git init --bare ' + BARE_REPO, { stdio: 'pipe' })
    // Clone it to get a real repo with an origin remote
    execSync(`git clone ${BARE_REPO} ${MAIN_CLONE}`, { stdio: 'pipe' })
    // Configure git user and create an initial commit so there's a HEAD
    execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: MAIN_CLONE, stdio: 'pipe' })
    writeFileSync(path.join(MAIN_CLONE, 'README.md'), 'test')
    execSync('git add . && git commit -m "init"', { cwd: MAIN_CLONE, stdio: 'pipe' })
    execSync('git push origin main || git push origin master', { cwd: MAIN_CLONE, stdio: 'pipe' })
    // Create a worktree
    execSync(`git worktree add ${WORKTREE_DIR} -b test-branch`, { cwd: MAIN_CLONE, stdio: 'pipe' })
  })

  afterAll(() => {
    // Clean up worktree first, then the rest
    try { execSync(`git worktree remove ${WORKTREE_DIR} --force`, { cwd: MAIN_CLONE, stdio: 'pipe' }) } catch { /* ok */ }
    rmSync(WT_TEST_DIR, { recursive: true, force: true })
  })

  test('sandbox can write refs to shared git dir from worktree', async () => {
    const callID = 'test-wt-ref-' + Date.now()

    const hooks = await plugin({
      directory: WORKTREE_DIR,
      worktree: WORKTREE_DIR,
      serverUrl: new URL('http://localhost:0'),
    })

    // Write a ref via git update-ref inside the sandbox
    const argsRef = { command: 'git update-ref refs/remotes/sandbox-test/main HEAD' }
    await hooks['tool.execute.before']?.({
      tool: 'bash', callID, id: callID
    } as any, { args: argsRef } as any)

    const result = getResult(callID)
    expect(result).toBeDefined()
    expect(result!.exitCode).toBe(0)

    // Verify the ref was actually written to the common git dir
    // (read it from the host — the common git dir is the main clone's .git)
    const refValue = execSync('git rev-parse refs/remotes/sandbox-test/main', {
      cwd: MAIN_CLONE,
      encoding: 'utf8',
    }).trim()
    const headValue = execSync('git rev-parse HEAD', {
      cwd: MAIN_CLONE,
      encoding: 'utf8',
    }).trim()
    expect(refValue).toBe(headValue)
  }, 60000)

  test('git fetch updates tracking refs inside sandbox worktree', async () => {
    const callID = 'test-wt-fetch-' + Date.now()

    const hooks = await plugin({
      directory: WORKTREE_DIR,
      worktree: WORKTREE_DIR,
      serverUrl: new URL('http://localhost:0'),
    })

    // Run git fetch origin inside the sandbox (the bare repo is readable via $HOME:ro)
    const argsRef = { command: 'git fetch origin' }
    await hooks['tool.execute.before']?.({
      tool: 'bash', callID, id: callID
    } as any, { args: argsRef } as any)

    const result = getResult(callID)
    expect(result).toBeDefined()
    expect(result!.exitCode).toBe(0)

    // Verify origin/main (or origin/master) resolves from the worktree
    // The ref should exist in the common git dir after fetch
    let trackingRef: string | undefined
    try {
      trackingRef = execSync('git rev-parse origin/main', {
        cwd: WORKTREE_DIR,
        encoding: 'utf8',
      }).trim()
    } catch {
      trackingRef = execSync('git rev-parse origin/master', {
        cwd: WORKTREE_DIR,
        encoding: 'utf8',
      }).trim()
    }
    expect(trackingRef).toMatch(/^[0-9a-f]{40}$/)
  }, 60000)
})
