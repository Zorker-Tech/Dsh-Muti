/**
 * Worktree creation, reuse, sampling, conflict reports, and removal recovery.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tests/worktrees.spec
 */

import { describe, expect, it } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { CollaborationError } from '../src/errors.ts'
import { GitRunner } from '../src/git.ts'
import type { WorktreeId, WorktreeRecord } from '../src/domain.ts'
import { WorktreeManager } from '../src/worktrees.ts'
import type { WorktreeManagerOptions } from '../src/worktrees.ts'
import { FakeHost } from './support/fake-host.ts'

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  private readonly values = new Map<K, V>()

  get(key: K): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[K, V]> { return this.values.entries() }
  keys(): IterableIterator<K> { return this.values.keys() }
  get size(): number { return this.values.size }
  async put(key: K, value: V): Promise<void> { this.values.set(key, value) }
  async delete(key: K): Promise<boolean> { return this.values.delete(key) }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.values.get(key)
    if (current === undefined) throw new Error(`missing test record ${key}`)
    const next = fn(current)
    this.values.set(key, next)
    return next
  }
}

const options: WorktreeManagerOptions = {
  worktreeDir: '.dsh-agent-mesh', branchPrefix: 'agent-mesh/', conflictPolicy: 'report', featureBoundaries: [],
}

function managerFor(
  host: FakeHost,
  table = new MemoryTable<WorktreeId, WorktreeRecord>(),
  managerOptions: WorktreeManagerOptions = options,
): {
  manager: WorktreeManager
  table: KvTable<WorktreeId, WorktreeRecord>
} {
  return {
    manager: new WorktreeManager(host, new GitRunner(host, { command: 'git', timeoutMs: 5000 }), table, managerOptions),
    table,
  }
}

describe('worktree lifecycle', () => {
  it('creates, filters, reuses, and binds records with optional owners', async () => {
    const host = new FakeHost()
    const { manager } = managerFor(host)
    const created = await manager.create({ agentId: 'codex', repoRoot: '/repo', label: 'parser' })
    const reused = await manager.create({
      agentId: 'codex', repoRoot: '/repo', reuse: true,
      collaborationId: 'collab-1', taskId: 'task-1',
    })
    expect(reused.id).toBe(created.id)
    expect(reused.collaborationId).toBe('collab-1')
    expect(reused.taskId).toBe('task-1')
    expect(await manager.list('/repo')).toHaveLength(1)
    expect(await manager.list()).toHaveLength(1)
    expect(manager.records()).toHaveLength(1)
    expect(manager.get(created.id)?.branch).toBe('agent-mesh/parser')
    expect(() => manager.require('missing')).toThrow(CollaborationError)

    await manager.bindRun('missing', 'run-1')
    const standalone = await manager.create({ agentId: 'solo', repoRoot: '/repo' })
    await manager.bindRun(standalone.id, 'run-0')
    expect(manager.get(standalone.id)).toMatchObject({ state: 'active', runId: 'run-0' })
    expect((await manager.create({ agentId: 'solo', repoRoot: '/repo', reuse: true })).id).not.toBe(standalone.id)
    await manager.bindRun(standalone.id, undefined)
    await manager.bindRun(created.id, 'run-1')
    expect(manager.get(created.id)).toMatchObject({ state: 'active', runId: 'run-1' })
    await manager.bindRun(created.id, undefined)
    expect(manager.get(created.id)).toMatchObject({ state: 'idle' })

    host.status.set(created.path, [' M dirty.ts'])
    expect((await manager.create({ agentId: 'codex', repoRoot: '/repo', reuse: true })).id).not.toBe(created.id)
    expect((await manager.create({ agentId: 'other', repoRoot: '/repo', reuse: true })).agentId).toBe('other')
  })

  it('refuses unavailable or non-repository paths and classifies create failures', async () => {
    const unavailableHost = new FakeHost()
    unavailableHost.gitAvailable = false
    const unavailable = managerFor(unavailableHost).manager
    await expect(unavailable.create({ agentId: 'codex', repoRoot: '/repo' }))
      .rejects.toMatchObject({ code: 'worktree/git-unavailable' })
    await expect(unavailable.conflicts('/repo')).rejects.toMatchObject({ code: 'worktree/git-unavailable' })

    const host = new FakeHost()
    const manager = managerFor(host).manager
    await expect(manager.create({ agentId: 'codex', repoRoot: '/elsewhere' }))
      .rejects.toMatchObject({ code: 'worktree/not-a-repository' })
    await expect(manager.conflicts('/elsewhere')).rejects.toMatchObject({ code: 'worktree/not-a-repository' })

    host.respond = spec => spec.args[0] === 'worktree' && spec.args[1] === 'add'
      ? { code: 1, stderr: 'branch rejected' }
      : undefined
    await expect(manager.create({ agentId: 'codex', repoRoot: '/repo' }))
      .rejects.toMatchObject({ code: 'worktree/create-failed', cause: 'branch rejected' })

    host.respond = spec => spec.args[0] === 'rev-parse' && spec.args[1] === 'HEAD'
      && spec.cwd.includes('/worktrees/')
      ? { code: 1 }
      : undefined
    await expect(manager.create({ agentId: 'codex', repoRoot: '/repo' }))
      .rejects.toMatchObject({ code: 'worktree/create-failed' })
  })

  it('samples unreadable worktrees and reports shared paths and skipped records', async () => {
    const host = new FakeHost()
    const { manager } = managerFor(host)
    const left = await manager.create({ agentId: 'codex', repoRoot: '/repo', label: 'left' })
    const right = await manager.create({ agentId: 'grok', repoRoot: '/repo', label: 'right' })
    host.respond = (spec) => {
      if (spec.args[0] === 'rev-parse' && spec.args[1] === '--show-toplevel' && spec.cwd === '/elsewhere') {
        return { code: 128 }
      }
      if (spec.args[0] === 'rev-parse' && spec.args[1] === 'HEAD') return { code: 1 }
      if (spec.args[0] === 'rev-parse' && spec.args[1] === '--abbrev-ref') return { lines: ['HEAD'] }
      if (spec.args[0] === 'status') return spec.cwd === left.path ? { lines: [' M shared.ts'] } : { lines: [] }
      if (spec.args[0] === 'rev-list') return { code: 1 }
      return undefined
    }

    expect(await manager.list('/elsewhere')).toEqual([])
    const samples = await manager.list('/repo')
    expect(samples.find(view => view.id === left.id)?.progress).toMatchObject({
      head: left.baseCommit,
      branch: left.branch,
      dirty: true,
      notes: [
        'HEAD could not be resolved; the recorded base commit is reported instead',
        'the commit count ahead of the base commit could not be computed',
      ],
    })
    expect(samples.find(view => view.id === right.id)?.progress?.notes).toContain(
      'the worktree could not be read as a git work tree',
    )
    expect((await manager.conflicts('/repo')).notes.some(note => note.includes('HEAD could not be resolved'))).toBe(true)

    host.respond = spec => spec.args[0] === 'status' ? { lines: [' M shared.ts'] } : undefined
    const conflicts = await manager.conflicts('/repo')
    expect(conflicts.findings[0]?.paths).toEqual(['shared.ts'])
    expect(conflicts.notes[0]).toContain('same-file')
    expect(conflicts.suggestedOrder).toHaveLength(2)

    await manager.markIntegrated(left.id, true)
    const skipped = await manager.conflicts('/repo')
    expect(skipped.worktrees).toEqual([right.id])
    expect(skipped.notes.some(note => note.includes('integrated or removed worktrees are not compared'))).toBe(true)
  })

  it('reports overlapping hunks, configured feature areas, and differing bases', async () => {
    const host = new FakeHost()
    const table = new MemoryTable<WorktreeId, WorktreeRecord>()
    const featureBoundaries = ['packages', 'packages/api/']
    const blockingManager = managerFor(host, table, {
      ...options, conflictPolicy: 'block', featureBoundaries,
    }).manager
    const left = await blockingManager.create({ agentId: 'codex', repoRoot: '/repo', label: 'left' })
    const right = await blockingManager.create({ agentId: 'grok', repoRoot: '/repo', label: 'right' })
    host.status.set(left.path, [' M shared.ts', ' M far.ts', ' M packages/api/left.ts', ' M packages/client/left.ts'])
    host.status.set(right.path, [' M shared.ts', ' M far.ts', ' M packages/api/right.ts'])
    host.diffs.set(left.path, [
      '--- a/shared.ts', '+++ b/shared.ts', '@@ -10,2 +10,2 @@',
      '--- a/far.ts', '+++ b/far.ts', '@@ -30,1 +30,1 @@',
      '--- a/packages/api/left.ts', '+++ b/packages/api/left.ts', '@@ -1,1 +1,1 @@',
      '--- a/packages/client/left.ts', '+++ b/packages/client/left.ts', '@@ -1,1 +1,1 @@',
    ])
    host.diffs.set(right.path, [
      '--- a/shared.ts', '+++ b/shared.ts', '@@ -11,1 +11,1 @@',
      '--- a/far.ts', '+++ b/far.ts', '@@ -40,1 +40,1 @@',
      '--- a/packages/api/right.ts', '+++ b/packages/api/right.ts', '@@ -1,1 +1,1 @@',
    ])

    const report = await blockingManager.conflicts('/repo')
    const sameFile = report.findings.find(finding => finding.kind === 'same-file')
    const sameHunk = report.findings.find(finding => finding.kind === 'same-hunk')
    const featureArea = report.findings.find(finding => finding.kind === 'feature-boundary')
    expect(sameFile?.paths).toEqual(['far.ts', 'shared.ts'])
    expect(sameHunk).toMatchObject({ severity: 'blocking', paths: ['shared.ts'] })
    expect(featureArea).toMatchObject({ severity: 'info', paths: ['packages/api'] })
    expect(report.notes.some(note => note.includes('different files'))).toBe(true)

    const reportManager = managerFor(host, table, { ...options, featureBoundaries }).manager
    const reportPolicy = await reportManager.conflicts('/repo')
    expect(reportPolicy.findings.find(finding => finding.kind === 'same-hunk')?.severity).toBe('warning')

    const changedBase = blockingManager.get(right.id)
    if (changedBase === undefined) throw new Error('expected the right worktree record')
    await table.put(right.id, { ...changedBase, baseCommit: 'b'.repeat(40) })
    const drifted = await blockingManager.conflicts('/repo')
    expect(drifted.findings.find(finding => finding.kind === 'same-hunk')).toBeUndefined()
    expect(drifted.findings.find(finding => finding.kind === 'base-drift')).toMatchObject({
      severity: 'info', paths: [],
    })
    expect(drifted.notes.some(note => note.includes('same-hunk comparison was skipped'))).toBe(true)
  })

  it('reports when git cannot provide changed line ranges', async () => {
    const host = new FakeHost()
    const { manager } = managerFor(host)
    const worktree = await manager.create({ agentId: 'codex', repoRoot: '/repo' })
    host.status.set(worktree.path, [' M file.ts'])
    host.respond = spec => spec.args[0] === 'diff' ? { code: 1, stderr: 'base unavailable' } : undefined

    const report = await manager.conflicts('/repo')
    expect(report.notes).toContain(
      `${worktree.id}: git could not read the diff; line-range conflicts are unavailable`,
    )
  })

  it('uses unique branch suffixes and a random fallback for occupied names', async () => {
    const host = new FakeHost()
    let verifyCalls = 0
    host.respond = (spec) => {
      if (spec.args[0] !== 'rev-parse' || spec.args[1] !== '--verify') return undefined
      verifyCalls += 1
      return verifyCalls < 3 ? { lines: ['exists'] } : { code: 1 }
    }
    const manager = managerFor(host).manager
    const suffixed = await manager.create({ agentId: 'codex', repoRoot: '/repo', label: 'parser' })
    expect(suffixed.branch).toBe('agent-mesh/parser-3')

    const fallbackHost = new FakeHost()
    fallbackHost.respond = spec => spec.args[0] === 'rev-parse' && spec.args[1] === '--verify'
      ? { lines: ['exists'] }
      : undefined
    const fallback = await managerFor(fallbackHost).manager.create({
      agentId: 'codex', repoRoot: '/repo', label: '###',
    })
    expect(fallback.branch).toMatch(/^agent-mesh\/work-[a-z0-9]+$/)
  })

  it('prunes once after a refused removal and reports a second refusal', async () => {
    const retryHost = new FakeHost()
    let removeCalls = 0
    retryHost.respond = (spec) => {
      if (spec.args[0] === 'worktree' && spec.args[1] === 'remove') {
        removeCalls += 1
        if (removeCalls === 1) return { code: 1, stderr: 'stale admin entry' }
      }
      return undefined
    }
    const retryManager = managerFor(retryHost).manager
    const retryTarget = await retryManager.create({ agentId: 'codex', repoRoot: '/repo' })
    expect((await retryManager.remove(retryTarget.id, { force: true })).state).toBe('removed')
    expect(retryHost.spawns.some(spawn => spawn.args[0] === 'worktree' && spawn.args[1] === 'prune')).toBe(true)

    const failedHost = new FakeHost()
    const failedManager = managerFor(failedHost).manager
    const failedTarget = await failedManager.create({ agentId: 'grok', repoRoot: '/repo' })
    failedHost.refusedRemovals.add(failedTarget.path)
    await expect(failedManager.remove(failedTarget.id, { force: true }))
      .rejects.toMatchObject({ code: 'worktree/remove-failed' })

    const unknownAheadHost = new FakeHost()
    unknownAheadHost.respond = spec => spec.args[0] === 'rev-list' ? { code: 1 } : undefined
    const unknownAheadManager = managerFor(unknownAheadHost).manager
    const unknownAheadTarget = await unknownAheadManager.create({ agentId: 'pi', repoRoot: '/repo' })
    expect((await unknownAheadManager.remove(unknownAheadTarget.id)).state).toBe('removed')
  })
})
