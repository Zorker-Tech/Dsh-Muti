/**
 * Git command construction, result classification, and porcelain parsing.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tests/git.spec
 */

import { describe, expect, it } from 'vitest'
import type { HostProcess } from '@deepseek-ai/dsh-agent-mesh'
import { GitRunner, parseStatus, statusKind } from '../src/git.ts'
import { FakeHost } from './support/fake-host.ts'
import type { FakeAnswer } from './support/fake-host.ts'

describe('GitRunner', () => {
  it('runs commands with explicit options and classifies process and output failures', async () => {
    const host = new FakeHost()
    let answer: FakeAnswer | undefined
    host.respond = () => answer
    const runner = new GitRunner(host, { command: 'git-test', timeoutMs: 321 })

    expect(await runner.available()).toBe(true)
    answer = { lines: ['first', 'second  '], stderr: ' warning \n', code: 2 }
    const failed = await runner.exec('/repo', ['custom', 'arg'])
    expect(failed).toEqual({ ok: false, stdout: 'first\nsecond', stderr: 'warning', code: 2 })
    expect(host.spawns.at(-1)).toMatchObject({
      command: 'git-test', cwd: '/repo', args: ['custom', 'arg'], timeoutMs: 321,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })

    answer = { lines: ['ok'], code: 0, timedOut: true }
    expect((await runner.exec('/repo', ['timed-out'])).ok).toBe(false)
    answer = { lines: ['ok'], code: 0, cancelled: true }
    expect((await runner.exec('/repo', ['cancelled'])).ok).toBe(false)
    answer = { linesError: 'stdout failed', stderr: 'notice', code: 0 }
    expect((await runner.exec('/repo', ['broken-stream'])).stdout).toBe('')
    expect(host.logs.at(-1)?.message).toContain('stdout failed')

    host.spawn = () => {
      const lines: AsyncIterable<string> = {
        async *[Symbol.asyncIterator]() { throw 'non-error stream failure' },
      }
      const process: HostProcess = {
        lines,
        async stderr() { return '' },
        exit: Promise.resolve({ code: 0, signal: null, timedOut: false, cancelled: false }),
        cancel() {},
      }
      return process
    }
    await runner.exec('/repo', ['primitive-stream-failure'])
    expect(host.logs.at(-1)?.message).toContain('non-error stream failure')
    await runner.exec('/repo', [])
    expect(host.logs.at(-1)?.message).toContain('git  output stream ended abnormally')
  })

  it('projects repository, branch, status, and commit queries', async () => {
    const host = new FakeHost()
    let answer: FakeAnswer | undefined
    host.respond = () => answer
    const runner = new GitRunner(host, { command: 'git', timeoutMs: 10_000 })

    answer = { lines: ['/repo'], code: 0 }
    expect(await runner.repoRoot('/repo/subdir')).toBe('/repo')
    expect(await runner.head('/repo')).toBe('/repo')
    expect(await runner.gitDir('/repo')).toBe('/repo')
    answer = { lines: [], code: 0 }
    expect(await runner.repoRoot('/outside')).toBeUndefined()
    expect(await runner.head('/repo')).toBeUndefined()
    expect(await runner.gitDir('/repo')).toBeUndefined()
    answer = { code: 128, stderr: 'not a repository' }
    expect(await runner.repoRoot('/outside')).toBeUndefined()
    expect(await runner.head('/outside')).toBeUndefined()
    expect(await runner.gitDir('/outside')).toBeUndefined()

    answer = { lines: ['feature/parser'], code: 0 }
    expect(await runner.currentBranch('/repo')).toBe('feature/parser')
    answer = { lines: ['HEAD'], code: 0 }
    expect(await runner.currentBranch('/repo')).toBeUndefined()
    answer = { lines: [], code: 0 }
    expect(await runner.currentBranch('/repo')).toBeUndefined()
    answer = { code: 128 }
    expect(await runner.currentBranch('/repo')).toBeUndefined()

    answer = { lines: ['a'.repeat(40)], code: 0 }
    expect(await runner.hasBranch('/repo', 'feature')).toBe(true)
    answer = { lines: [], code: 0 }
    expect(await runner.hasBranch('/repo', 'feature')).toBe(false)
    answer = { code: 1 }
    expect(await runner.hasBranch('/repo', 'feature')).toBe(false)

    answer = { lines: ['?? new.txt', 'R  old.txt -> new.txt', ' M edited.ts'], code: 0 }
    expect(await runner.status('/repo')).toMatchObject([
      { path: 'new.txt', status: 'untracked' },
      { from: 'old.txt', path: 'new.txt', status: 'renamed' },
      { path: 'edited.ts', status: 'modified' },
    ])
    answer = { code: 1 }
    expect(await runner.status('/repo')).toEqual([])

    answer = { lines: ['1\t4'], code: 0 }
    expect(await runner.aheadBehind('/repo', 'base')).toEqual({ behind: 1, ahead: 4 })
    answer = { code: 1 }
    expect(await runner.aheadBehind('/repo', 'base')).toBeUndefined()
    answer = { lines: ['1'], code: 0 }
    expect(await runner.aheadBehind('/repo', 'base')).toBeUndefined()
    answer = { lines: ['bad\tbad'], code: 0 }
    expect(await runner.aheadBehind('/repo', 'base')).toBeUndefined()

    answer = { lines: ['true'], code: 0 }
    expect(await runner.isRepository('/repo')).toBe(true)
    answer = { lines: ['false'], code: 0 }
    expect(await runner.isRepository('/repo')).toBe(false)
    answer = { code: 128 }
    expect(await runner.isRepository('/outside')).toBe(false)
  })

  it('parses base-side line ranges and keeps deleted and binary paths distinguishable', async () => {
    const host = new FakeHost()
    let answer: FakeAnswer = { lines: [
      '--- a/edited.ts',
      '+++ b/edited.ts',
      'index 1111111..2222222 100644',
      '@@ -4,2 +4,3 @@ section',
      '--- a/edited.ts',
      '+++ b/edited.ts',
      '@@ -8 +8 @@',
      '--- /dev/null',
      '+++ b/added.ts',
      '@@ -0,0 +1,2 @@',
      '--- a/deleted.ts',
      '+++ /dev/null',
      '@@ -10,2 +0,0 @@',
      '--- a/deleted.ts',
      '+++ /dev/null',
      '@@ -12 +0,0 @@',
      '--- /dev/null',
      '+++ /dev/null',
      '--- a/image.bin',
      '+++ b/image.bin',
    ] }
    host.respond = spec => spec.args[0] === 'diff' ? answer : undefined
    const runner = new GitRunner(host, { command: 'git', timeoutMs: 10_000 })

    expect(await runner.hunks('/repo/wt', 'base')).toEqual(new Map([
      ['edited.ts', [{ start: 4, lines: 2 }, { start: 8, lines: 1 }]],
      ['added.ts', [{ start: 0, lines: 0 }]],
      ['deleted.ts', [{ start: 10, lines: 2 }, { start: 12, lines: 1 }]],
      ['image.bin', []],
    ]))
    expect(host.spawns.at(-1)?.args).toEqual(['diff', '--no-color', '--unified=0', 'base', '--'])

    answer = { code: 1, stderr: 'bad base' }
    expect(await runner.hunks('/repo/wt', 'missing')).toBeUndefined()
  })

  it('builds worktree commands and parses porcelain worktree lists', async () => {
    const host = new FakeHost()
    let answer: FakeAnswer | undefined
    host.respond = () => answer
    const runner = new GitRunner(host, { command: 'git', timeoutMs: 10_000 })

    await runner.addWorktree('/repo', '/repo/wt-a', 'feature/a')
    expect(host.spawns.at(-1)?.args).toEqual(['worktree', 'add', '-b', 'feature/a', '/repo/wt-a'])
    await runner.addWorktree('/repo', '/repo/wt-b', 'feature/b', 'main')
    expect(host.spawns.at(-1)?.args).toEqual(['worktree', 'add', '-b', 'feature/b', '/repo/wt-b', 'main'])
    await runner.removeWorktree('/repo', '/repo/wt-a', false)
    expect(host.spawns.at(-1)?.args).toEqual(['worktree', 'remove', '/repo/wt-a'])
    await runner.removeWorktree('/repo', '/repo/wt-b', true)
    expect(host.spawns.at(-1)?.args).toEqual(['worktree', 'remove', '--force', '/repo/wt-b'])
    await runner.pruneWorktrees('/repo')
    expect(host.spawns.at(-1)?.args).toEqual(['worktree', 'prune'])

    answer = { lines: [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main',
      'worktree /repo/wt-a', 'HEAD def456',
      'worktree /repo/wt-detached',
    ], code: 0 }
    expect(await runner.listWorktrees('/repo')).toEqual([
      { path: '/repo', head: 'abc123', branch: 'main' },
      { path: '/repo/wt-a', head: 'def456' },
      { path: '/repo/wt-detached' },
    ])
    answer = { lines: ['unexpected line'], code: 0 }
    expect(await runner.listWorktrees('/repo')).toEqual([])
    answer = { code: 1 }
    expect(await runner.listWorktrees('/repo')).toEqual([])
  })
})

describe('porcelain status parsing', () => {
  it('ignores short lines and classifies every declared status family', () => {
    expect(parseStatus('M\n?? new\nR  old -> new')).toEqual([
      { code: '??', path: 'new', status: 'untracked' },
      { code: 'R ', from: 'old', path: 'new', status: 'renamed' },
    ])
    expect(statusKind('U ')).toBe('conflicted')
    expect(statusKind('AA')).toBe('conflicted')
    expect(statusKind('DD')).toBe('conflicted')
    expect(statusKind('A ')).toBe('added')
    expect(statusKind('D ')).toBe('deleted')
    expect(statusKind('M ')).toBe('modified')
  })
})
