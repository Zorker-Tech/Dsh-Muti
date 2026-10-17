import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentSession, AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh'
import { MeshCollaborationController } from '../src/index.ts'
import { mount, required, unmountAll } from './support/harness.ts'

afterEach(unmountAll)

describe('collaboration Remote controller', () => {
  it('projects collaboration, plan, preview and todo operations', async () => {
    const harness = await mount()
    const controller = new MeshCollaborationController(harness.ctx)
    const signal = new AbortController().signal
    const created = await controller.remoteExportCollaborationStart({
      title: 'Ship the mesh',
      objective: 'Ship the collaboration controller',
      repoRoot: '/repo',
    }, signal)
    expect(created).toMatchObject({ title: 'Ship the mesh', objective: 'Ship the collaboration controller', todoRevision: 1 })
    expect(await controller.remoteExportCollaborations(null, signal)).toHaveLength(1)
    expect(await controller.remoteExportCollaborations(created.id, signal)).toEqual([created])

    const seeded = await controller.remoteExportCollaborationStart({
      title: 'Seeded work',
      objective: 'Exercise seed projections',
      repoRoot: '/repo',
      tasks: [
        { title: 'shared', instruction: 'share cwd', assignee: 'codex', isolation: 'shared-cwd', dependsOn: [] },
        { title: 'isolated', instruction: 'use worktree', assignee: 'grok', isolation: 'worktree', dependsOn: ['task-1'] },
        { title: 'default isolation', instruction: 'use the default', assignee: 'pi' },
      ],
    }, signal)
    expect(seeded.tasks.map(task => task.isolation)).toEqual(['shared-cwd', 'worktree', 'worktree'])
    expect(seeded.tasks[1]?.dependsOn).toEqual([seeded.tasks[0]?.id])

    const phases = await controller.remoteExportPlanSet({
      collaborationId: created.id,
      objective: 'Observe first',
      phases: [
        { id: 'phase-a', title: 'prepare', status: 'done', exitCriteria: '' },
        { id: 'phase-b', title: 'execute', status: 'active', exitCriteria: 'tests pass' },
        { id: 'phase-c', title: 'integrate', status: 'future', exitCriteria: '' },
      ],
      activePhaseId: 'phase-b',
      decisions: ['keep the remote API thin'],
      mode: 'observe',
    }, signal)
    expect(phases).toEqual([
      { id: 'phase-a', title: 'prepare', status: 'done', exitCriteria: '' },
      { id: 'phase-b', title: 'execute', status: 'active', exitCriteria: 'tests pass' },
      { id: 'phase-c', title: 'integrate', status: 'todo', exitCriteria: '' },
    ])
    expect(await controller.remoteExportPlanContextPreview({ collaborationId: created.id, agentId: 'codex' }, signal))
      .toEqual({ available: false, text: '', hash: '' })

    await controller.remoteExportPlanSet({ collaborationId: created.id, objective: 'Inject again', mode: 'other' }, signal)
    const preview = await controller.remoteExportPlanContextPreview({ collaborationId: created.id, agentId: 'codex' }, signal)
    expect(preview.available).toBe(true)
    expect(preview.text).toContain('Inject again')
    expect((await controller.remoteExportPlanAdvance({ collaborationId: created.id, phaseId: 'phase-c' }, signal))
      .map(phase => phase.status)).toEqual(['done', 'done', 'active'])

    const board = await controller.remoteExportTodosSet({
      collaborationId: created.id,
      todos: [
        { id: 't1', content: 'pending', status: 'pending' },
        { id: 't2', content: 'running', status: 'in_progress', owner: 'codex', blockedBy: ['t1'] },
        { id: 't3', content: 'done', status: 'completed' },
        { id: 't4', content: 'blocked', status: 'blocked' },
        { id: 't5', content: 'cancelled', status: 'cancelled' },
        { id: 't6', content: 'unknown', status: 'future' },
      ],
    }, signal)
    expect(board.todos.map(todo => todo.status)).toEqual([
      'pending', 'in_progress', 'completed', 'blocked', 'cancelled', 'pending',
    ])
    expect((await controller.remoteExportTodosGet({ collaborationId: created.id }, signal)).todos).toEqual(board.todos)
    await controller.remoteExportTodosSet({
      collaborationId: created.id,
      todos: [],
      expectedRevision: board.revision,
    }, signal)

    const session: AgentSession = {
      key: brandString<AgentSessionKey>('codex:abc'),
      agentId: brandString<AgentId>('codex'),
      nativeId: 'abc',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T01:00:00.000Z',
      status: 'idle',
      notes: [],
    }
    harness.mesh.sessions.set('codex', [session])
    harness.mesh.nativeTasks.set('codex:abc', {
      available: true,
      todos: [{
        id: 'native-1', content: 'observed', status: 'completed', owner: 'codex', blockedBy: [],
        updatedAt: '2026-10-16T01:00:00.000Z', nativeKey: 'item-1',
      }],
      plan: { active: true, items: ['finish the parser'] },
      notes: ['native note'],
    })
    const observed = await controller.remoteExportTodosObserve({ collaborationId: created.id, agentId: 'codex' }, signal)
    expect(observed.observed).toBe(1)
    expect(observed.board.todos[0]).toMatchObject({ nativeKey: 'item-1', observedIn: 'codex:abc' })
    expect(observed.notes).toEqual(['native note'])
    expect((await controller.remoteExportTodosObserve({
      collaborationId: created.id,
      agentId: 'codex',
      sessionId: 'abc',
    }, signal)).observed).toBe(0)
  })

  it('projects task dispatch, worktree progress, conflict reports and lifecycle changes', async () => {
    const harness = await mount()
    const controller = new MeshCollaborationController(harness.ctx)
    const signal = new AbortController().signal
    const seeded = await controller.remoteExportCollaborationStart({
      title: 'Dispatch work',
      objective: 'Exercise task dispatch mapping',
      repoRoot: '/repo',
      tasks: [
        { title: 'first', instruction: 'First task.', assignee: 'codex', isolation: 'shared-cwd' },
        { title: 'second', instruction: 'Second task.', assignee: 'grok', isolation: 'shared-cwd' },
        { title: 'third', instruction: 'Third task.', assignee: 'pi' },
      ],
    }, signal)
    const first = required(seeded.tasks[0], 'the first task')
    const second = required(seeded.tasks[1], 'the second task')
    const third = required(seeded.tasks[2], 'the default-isolation task')
    const firstDispatch = await controller.remoteExportTaskDispatch({ collaborationId: seeded.id, taskId: first.id }, signal)
    expect(firstDispatch).toMatchObject({ taskId: first.id, status: 'running' })
    expect(firstDispatch.contextHash).toMatch(/^[a-f\d]{16}$/)
    await controller.remoteExportPlanSet({ collaborationId: seeded.id, objective: 'Observe only', mode: 'observe' }, signal)
    const secondDispatch = await controller.remoteExportTaskDispatch({
      collaborationId: seeded.id,
      taskId: second.id,
      baseRef: 'main',
      timeoutMs: 30_000,
    }, signal)
    expect(secondDispatch).toMatchObject({ status: 'running', contextHash: '' })
    await controller.remoteExportPlanSet({ collaborationId: seeded.id, objective: 'Inject again', mode: 'inject' }, signal)
    const thirdDispatch = await controller.remoteExportTaskDispatch({
      collaborationId: seeded.id,
      taskId: third.id,
      baseRef: 'main',
      timeoutMs: 10_000,
    }, signal)
    expect(thirdDispatch.status).toBe('running')
    expect((await controller.remoteExportCollaborations(seeded.id, signal))[0]?.tasks[2]?.worktreeId).not.toBe('')
    await expect(controller.remoteExportTaskDispatch({ collaborationId: seeded.id, taskId: 'missing' }, signal))
      .rejects.toMatchObject({ code: 'agent-mesh-collaboration/unknown-task' })
    await expect(controller.remoteExportPlanSet({ collaborationId: 'missing', objective: 'x' }, signal))
      .rejects.toMatchObject({ code: 'agent-mesh-collaboration/unknown-collaboration' })
    await expect(controller.remoteExportPlanSet({
      collaborationId: seeded.id,
      objective: 'invalid active phase',
      activePhaseId: 'missing',
    }, signal)).rejects.toMatchObject({ code: 'mesh/invalid-transition' })
    const unrelated = new Error('storage unavailable')
    vi.spyOn(harness.service, 'setPlan').mockRejectedValueOnce(unrelated)
    await expect(controller.remoteExportPlanSet({ collaborationId: seeded.id, objective: 'unavailable' }, signal))
      .rejects.toBe(unrelated)

    const clean = await controller.remoteExportWorktreeCreate({
      agentId: 'codex',
      repoRoot: '/repo',
      collaborationId: seeded.id,
    }, signal)
    const dirty = await controller.remoteExportWorktreeCreate({
      agentId: 'grok',
      repoRoot: '/repo',
      baseRef: 'main',
      label: 'second task',
      reuse: false,
    }, signal)
    harness.host.status.set(clean.path, [])
    harness.host.status.set(dirty.path, [' M src/shared.ts'])

    expect(await controller.remoteExportWorktrees({}, signal)).toHaveLength(3)
    expect(await controller.remoteExportWorktrees({ repoRoot: '/repo' }, signal)).toHaveLength(3)
    expect((await controller.remoteExportWorktreeConflicts({ repoRoot: '/repo' }, signal)).suggestedOrder).toEqual([])
    harness.host.status.set(clean.path, [' M src/shared.ts'])
    const conflicts = await controller.remoteExportWorktreeConflicts({ repoRoot: '/repo' }, signal)
    expect(conflicts.findings[0]?.paths).toEqual(['src/shared.ts'])
    expect(conflicts.suggestedOrder).toHaveLength(3)

    const view = harness.service.get(seeded.id)
    const noActivePhase = { ...view, plan: { ...view.plan, activePhaseId: undefined } }
    vi.spyOn(harness.service, 'list').mockReturnValueOnce([noActivePhase])
    const mapped = await controller.remoteExportCollaborations(null, signal)
    expect(mapped[0]?.activePhaseId).toBe('')
    expect(mapped[0]?.worktrees).toHaveLength(2)

    harness.mesh.settle(thirdDispatch.runId, 'failed', { code: 'run/agent-crashed', message: 'the worktree task failed' })
    await vi.waitFor(() =>{  expect(harness.service.task(seeded.id, third.id).status).toBe('failed') })
    expect((await controller.remoteExportCollaborations(seeded.id, signal))[0]?.tasks[2]?.note)
      .toBe('the worktree task failed')

    const merged = await controller.remoteExportWorktreeIntegrated({ worktreeId: clean.id }, signal)
    expect(merged.state).toBe('merged')
    const outstanding = await controller.remoteExportWorktreeIntegrated({ worktreeId: clean.id, merged: false }, signal)
    expect(outstanding.state).toBe('idle')
    expect((await controller.remoteExportWorktrees({}, signal)).find(worktree => worktree.id === clean.id)?.changedFiles).toBe(1)

    harness.host.status.set(clean.path, [])
    expect(await controller.remoteExportWorktreeRemove({ worktreeId: clean.id }, signal)).toEqual({
      worktreeId: clean.id, state: 'removed', forced: false,
    })
    expect(await controller.remoteExportWorktreeRemove({ worktreeId: dirty.id, force: true }, signal)).toEqual({
      worktreeId: dirty.id, state: 'removed', forced: true,
    })
    expect((await controller.remoteExportWorktrees({}, signal)).map(worktree => worktree.changedFiles)).toEqual([0, 0, 0])
  })

  it('honors a cancelled Remote request before reading the service', async () => {
    const harness = await mount()
    const controller = new MeshCollaborationController(harness.ctx)
    await expect(controller.remoteExportCollaborations(null, AbortSignal.abort())).rejects.toThrow()
    expect(harness.service.list()).toEqual([])
  })
})
