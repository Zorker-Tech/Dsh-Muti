/**
 * Service ownership, plugin composition, and background run settlement behavior.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tests/index.spec
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MeshCollaboration, apply } from '../src/index.ts'
import { MeshCollaborationController } from '../src/controller.ts'
import { mount, required, unmountAll } from './support/harness.ts'

afterEach(unmountAll)

class ExposedCollaboration extends MeshCollaboration {
  /** Make the protected host factory observable to this test. */
  host() { return this.createHost() }
}

describe('collaboration service', () => {
  it('creates the context host and refuses reads before initialization', () => {
    const service = new ExposedCollaboration(new Context())
    expect(service.host().home.length).toBeGreaterThan(0)
    expect(() => service.list()).toThrow('the collaboration service is not open yet')
  })

  it('applies the service and Remote controller with omitted and explicit config', async () => {
    const ctx = new Context()
    const placeholder = ctx.plugin({ apply() {} })
    const plugin = vi.spyOn(ctx, 'plugin').mockReturnValue(placeholder)

    apply(ctx)
    apply(ctx, { baseRef: 'main' })

    expect(plugin).toHaveBeenCalledTimes(4)
    expect(plugin.mock.calls[0]?.[0]).toBe(MeshCollaboration)
    expect(plugin.mock.calls[1]?.[0]).toBe(MeshCollaborationController)
    expect(plugin.mock.calls[2]?.[0]).toBe(MeshCollaboration)
    expect(plugin.mock.calls[3]?.[0]).toBe(MeshCollaborationController)
    expect(MeshCollaborationController.inject).toEqual(['meshCollaboration'])
    plugin.mockRestore()
    await placeholder.dispose()
  })

  it('resolves explicit worktree defaults and lists tasks', async () => {
    const harness = await mount({
      worktreeDir: '.mesh-work', branchPrefix: 'review/', gitCommand: 'git-test',
      gitTimeoutMs: 1234, baseRef: 'main', defaultIsolation: 'shared-cwd',
    })
    const view = await harness.service.start({
      title: 'Configured', objective: 'Use the configured defaults', repoRoot: '/repo',
      tasks: [{ title: 'inspect', instruction: 'Inspect files', assignee: 'codex' }],
    })
    const task = required(view.tasks[0], 'configured task')
    expect(task.isolation).toBe('shared-cwd')
    expect(harness.service.tasks(view.id)).toEqual([task])
    expect(harness.service.plan(view.id).objective).toBe('Use the configured defaults')
    await expect(harness.service.observeTodos(view.id, 'codex')).rejects.toMatchObject({
      code: 'mesh/session-not-found', message: 'agent "codex" has no session to observe',
    })

    const worktree = await harness.service.createWorktree({ agentId: 'codex', repoRoot: '/repo' })
    expect(worktree.path).toContain('/repo/.mesh-work/worktrees/')
    expect(worktree.branch).toContain('review/')
    const add = harness.host.spawns.find(spawn => spawn.args[0] === 'worktree' && spawn.args[1] === 'add')
    expect(add?.args).toContain('main')
    expect(add?.command).toBe('git-test')
    expect(add?.timeoutMs).toBe(1234)
  })

  it('applies configured feature prefixes and conflict severity to service reports', async () => {
    const harness = await mount({ conflictPolicy: 'block', featureBoundaries: ['packages/api/'] })
    const left = await harness.service.createWorktree({ agentId: 'codex', repoRoot: '/repo' })
    const right = await harness.service.createWorktree({ agentId: 'grok', repoRoot: '/repo' })
    harness.host.status.set(left.path, [' M shared.ts', ' M packages/api/left.ts'])
    harness.host.status.set(right.path, [' M shared.ts', ' M packages/api/right.ts'])
    harness.host.diffs.set(left.path, ['--- a/shared.ts', '+++ b/shared.ts', '@@ -4,1 +4,1 @@'])
    harness.host.diffs.set(right.path, ['--- a/shared.ts', '+++ b/shared.ts', '@@ -4,1 +4,1 @@'])

    const report = await harness.service.worktreeConflicts('/repo')
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'same-hunk', severity: 'blocking', paths: ['shared.ts'] }),
      expect.objectContaining({ kind: 'feature-boundary', severity: 'info', paths: ['packages/api'] }),
    ]))
  })

  it('drops evicted and post-disposal settlements and contains rejected waits', async () => {
    const harness = await mount()
    const view = await harness.service.start({
      title: 'Settle', objective: 'Observe a background run', repoRoot: '/repo',
      tasks: [
        { title: 'evicted', instruction: 'Run one', assignee: 'codex', isolation: 'shared-cwd' },
        { title: 'rejected', instruction: 'Run two', assignee: 'grok', isolation: 'shared-cwd' },
        { title: 'late', instruction: 'Run three', assignee: 'pi', isolation: 'shared-cwd' },
        { title: 'primitive rejection', instruction: 'Run four', assignee: 'grok', isolation: 'shared-cwd' },
        { title: 'settled', instruction: 'Run five', assignee: 'pi', isolation: 'shared-cwd' },
      ],
    })
    const evictedTask = required(view.tasks[0], 'evicted task')
    const evictedRun = await harness.service.dispatchTask(view.id, evictedTask.id)
    harness.mesh.evict(evictedRun.runId)
    harness.mesh.settle(evictedRun.runId, 'succeeded')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(harness.service.task(view.id, evictedTask.id).status).toBe('running')

    const warning = vi.spyOn(harness.ctx.logger, 'warn')
    const waitForRun = vi.spyOn(harness.mesh, 'waitForRun').mockRejectedValueOnce(new Error('adapter wait error'))
    const rejectedTask = required(view.tasks[1], 'rejected task')
    await harness.service.dispatchTask(view.id, rejectedTask.id)
    await vi.waitFor(() =>{  expect(warning).toHaveBeenCalledWith(
      'agent-mesh-collaboration: run %s did not settle: %s', 'run-2', 'adapter wait error',
    ) })

    const lateTask = required(view.tasks[2], 'late task')
    const lateRun = await harness.service.dispatchTask(view.id, lateTask.id)
    waitForRun.mockRejectedValueOnce('adapter wait failure')
    const primitiveTask = required(view.tasks[3], 'primitive rejection task')
    await harness.service.dispatchTask(view.id, primitiveTask.id)
    await vi.waitFor(() =>{  expect(warning).toHaveBeenCalledWith(
      'agent-mesh-collaboration: run %s did not settle: %s', 'run-4', 'adapter wait failure',
    ) })

    const settledTask = required(view.tasks[4], 'settled task')
    const settledRun = await harness.service.dispatchTask(view.id, settledTask.id)
    harness.mesh.settle(settledRun.runId, 'succeeded')
    await vi.waitFor(() =>{  expect(harness.service.task(view.id, settledTask.id).status).toBe('succeeded') })

    const warningCount = warning.mock.calls.length
    await unmountAll()
    harness.mesh.settle(lateRun.runId, 'succeeded')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(warning).toHaveBeenCalledTimes(warningCount)
  })
})
