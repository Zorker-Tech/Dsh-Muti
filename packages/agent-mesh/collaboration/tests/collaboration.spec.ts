/**
 * The collaboration service's behavior: the create -> plan -> todos -> dispatch ->
 * observe flow, the guarded writes and refusals, and worktree isolation over a
 * scripted git and a scripted mesh.
 *
 * Every assertion is on a returned record or a thrown failure code; nothing here
 * reaches into the service's tables, the git runner, or the domain directly.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tests/collaboration.spec
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh'
import { approvalAgent, required, failure, callTool, callToolFailure, mount, startOne, unmountAll } from './support/harness.ts'

afterEach(unmountAll)

describe('collaboration flow', () => {
  it('creates a collaboration with a plan, a board, and its tasks', async () => {
    const harness = await mount()
    const view = await harness.service.start({
      title: 'Ship the mesh',
      objective: 'Ship worktree-isolated collaboration',
      repoRoot: '/repo',
      tasks: [
        { title: 'write the parser', instruction: 'Write the parser.', assignee: 'codex' },
        { title: 'review it', instruction: 'Review it.', assignee: 'grok', dependsOn: ['task-1'] },
      ],
    })

    expect(view.plan.mode).toBe('inject')
    expect(view.plan.activePhaseId).toBe('phase-1')
    expect(view.plan.phases.map(phase => phase.status)).toEqual(['active', 'todo', 'todo'])
    expect(view.board).toMatchObject({ revision: 1, todos: [] })
    expect(view.tasks.map(task => task.status)).toEqual(['queued', 'blocked'])
    expect(view.tasks.map(task => task.isolation)).toEqual(['worktree', 'worktree'])
    expect(required(view.tasks[1], 'the dependent task').dependsOn)
      .toEqual([required(view.tasks[0], 'the first task').id])
  })

  it('moves the plan, refuses an out-of-order phase, and guards the board revision', async () => {
    const harness = await mount()
    const { collaborationId } = await startOne(harness)

    const plan = await harness.service.setPlan(collaborationId, {
      objective: 'Ship it with worktrees',
      decisions: ['use git worktrees for isolation'],
    })
    expect(plan.objective).toBe('Ship it with worktrees')
    expect(plan.decisions).toEqual(['use git worktrees for isolation'])

    const advanced = await harness.service.advancePhase(collaborationId, 'phase-2')
    expect(advanced.phases.map(phase => phase.status)).toEqual(['done', 'active', 'todo'])

    // A phase that is neither done nor active still refuses the transition, which is
    // what stops a plan from skipping a phase.
    await harness.service.setPlan(collaborationId, {
      phases: [
        { id: 'phase-1', title: 'prepare', status: 'done' },
        { id: 'phase-2', title: 'execute', status: 'todo' },
        { id: 'phase-3', title: 'integrate', status: 'todo' },
      ],
      activePhaseId: 'phase-1',
    })
    expect((await failure(() => harness.service.advancePhase(collaborationId, 'phase-3'))).code)
      .toBe('mesh/invalid-transition')
    expect((await failure(() => harness.service.advancePhase(collaborationId, 'phase-9'))).code)
      .toBe('mesh/invalid-transition')

    const board = await harness.service.setTodos(
      collaborationId,
      [{ id: 'todo-1', content: 'write the parser', status: 'in_progress', owner: 'codex' }],
      { expectedRevision: 1 },
    )
    expect(board.revision).toBe(2)

    const stale = await failure(() => harness.service.setTodos(collaborationId, [], { expectedRevision: 1 }))
    expect(stale.code).toBe('schema/todo-conflict')
    expect(stale.remediation).toBeDefined()

    const duplicate = await failure(() => harness.service.setTodos(collaborationId, [
      { id: 'todo-1', content: 'a', status: 'pending' },
      { id: 'todo-1', content: 'b', status: 'pending' },
    ]))
    expect(duplicate.code).toBe('mesh/duplicate-todo')
  })

  it('dispatches a task into its worktree with the shared context injected', async () => {
    const harness = await mount()
    const { collaborationId, taskId } = await startOne(harness, [
      { title: 'write the parser', instruction: 'Write the parser.', assignee: 'codex' },
    ])
    await harness.service.setPlan(collaborationId, { objective: 'Ship worktree-isolated collaboration' })
    await harness.service.setTodos(collaborationId, [
      { id: 'todo-1', content: 'write the parser', status: 'in_progress', owner: 'codex' },
    ])

    const preview = required(harness.service.contextPreview(collaborationId, 'codex'), 'the context preview')
    expect(preview.text).toContain('Objective: Ship worktree-isolated collaboration')
    expect(preview.text).toContain('- * [in_progress] (codex) write the parser')
    expect(preview.hash).toHaveLength(16)

    const dispatched = await harness.service.dispatchTask(collaborationId, taskId)
    expect(dispatched.task.status).toBe('running')
    expect(dispatched.task.runId).toBe(dispatched.runId)
    expect(dispatched.cwd).toBe(`/repo/.dsh-agent-mesh/worktrees/${String(dispatched.task.worktreeId)}`)
    expect(dispatched.context).toEqual(preview)

    const start = required(harness.mesh.starts[0], 'the dispatch')
    expect(start.agentId).toBe('codex')
    expect(start.request.cwd).toBe(dispatched.cwd)
    expect(start.request.prompt).toBe(`${preview.text}\n\n---\n\nWrite the parser.`)

    const worktree = required((await harness.service.worktrees('/repo'))[0], 'the worktree')
    expect(worktree.state).toBe('active')
    expect(worktree.runId).toBe(dispatched.runId)
  })

  it('settles the task and frees the worktree when the run finishes', async () => {
    const harness = await mount()
    const { collaborationId, taskId } = await startOne(harness, [
      { title: 'write the parser', instruction: 'Write the parser.', assignee: 'codex' },
    ])
    const dispatched = await harness.service.dispatchTask(collaborationId, taskId)

    harness.mesh.settle(dispatched.runId, 'succeeded')
    await vi.waitFor(async () => {
      expect(harness.service.task(collaborationId, taskId).status).toBe('succeeded')
      expect(required((await harness.service.worktrees('/repo'))[0], 'the worktree').state).toBe('idle')
    })
  })

  it('folds an agent s own todo state into the board without touching authored items', async () => {
    const harness = await mount()
    const { collaborationId } = await startOne(harness)
    await harness.service.setTodos(collaborationId, [
      { id: 'todo-1', content: 'authored by the board', status: 'pending', owner: 'codex' },
    ])
    harness.mesh.sessions.set('codex', [{
      key: brandString<AgentSessionKey>('codex:abc'),
      agentId: brandString<AgentId>('codex'),
      nativeId: 'abc',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T01:00:00.000Z',
      status: 'idle',
      notes: [],
    }])
    harness.mesh.nativeTasks.set('codex:abc', {
      available: true,
      todos: [{
        id: 'native-1',
        content: 'native parser work',
        status: 'in_progress',
        owner: 'codex',
        blockedBy: [],
        updatedAt: '2026-10-16T01:00:00.000Z',
        nativeKey: 'parser',
      }],
      notes: [],
    })

    const first = await harness.service.observeTodos(collaborationId, 'codex')
    expect(first.observed).toBe(1)
    expect(first.board.todos.map(todo => todo.content)).toEqual(['authored by the board', 'native parser work'])
    expect(required(first.board.todos.find(todo => todo.id === 'todo-1'), 'the authored item').owner).toBe('codex')

    const second = await harness.service.observeTodos(collaborationId, 'codex')
    expect(second.observed).toBe(0)
    expect(second.board.revision).toBe(first.board.revision)

    const missing = await failure(() => harness.service.observeTodos(collaborationId, 'codex', 'nope'))
    expect(missing.code).toBe('mesh/session-not-found')
  })

  it('refuses an unfinished dependency, then dispatches it once the dependency succeeded', async () => {
    const harness = await mount()
    const view = await harness.service.start({
      title: 'Ship the mesh',
      objective: 'Ship worktree-isolated collaboration',
      repoRoot: '/repo',
      tasks: [
        { title: 'write the parser', instruction: 'Write the parser.', assignee: 'codex' },
        { title: 'review it', instruction: 'Review it.', assignee: 'grok', dependsOn: ['task-1'] },
      ],
    })
    const first = required(view.tasks[0], 'the first task')
    const second = required(view.tasks[1], 'the dependent task')

    const blocked = await failure(() => harness.service.dispatchTask(view.id, second.id))
    expect(blocked.code).toBe('mesh/invalid-transition')
    expect(blocked.message).toContain(first.id)

    const firstRun = await harness.service.dispatchTask(view.id, first.id)
    const rerun = await failure(() => harness.service.dispatchTask(view.id, first.id))
    expect(rerun.code).toBe('mesh/invalid-transition')
    expect(rerun.message).toContain('running')

    harness.mesh.settle(firstRun.runId, 'succeeded')
    await vi.waitFor(() => {
      expect(harness.service.task(view.id, first.id).status).toBe('succeeded')
    })

    const secondRun = await harness.service.dispatchTask(view.id, second.id)
    expect(secondRun.task.status).toBe('running')
    expect(secondRun.task.dependsOn).toEqual([first.id])
    expect((await failure(() => harness.service.dispatchTask(view.id, 'task-nope'))).code).toBe('mesh/task-not-found')
  })
})

describe('worktree isolation', () => {
  it('creates, samples, and removes a worktree, refusing to discard uncommitted work without force', async () => {
    const harness = await mount()
    const created = await harness.service.createWorktree({ agentId: 'codex', repoRoot: '/repo', label: 'parser' })
    expect(created.path).toBe(`/repo/.dsh-agent-mesh/worktrees/${created.id}`)
    expect(created.branch).toBe('agent-mesh/parser')
    expect(created.state).toBe('idle')
    expect(created.reusable).toBe(true)

    const clean = required((await harness.service.worktrees('/repo'))[0], 'the worktree')
    expect(clean.progress).toMatchObject({ dirty: false, ahead: 0, files: [] })

    harness.host.status.set(created.path, [' M shared.txt', '?? notes.md'])
    harness.host.ahead.set(created.path, 2)
    const dirty = required((await harness.service.worktrees('/repo'))[0], 'the worktree')
    expect(dirty.progress).toMatchObject({ dirty: true, ahead: 2 })
    expect(dirty.progress?.files).toEqual([
      { path: 'notes.md', status: 'untracked' },
      { path: 'shared.txt', status: 'modified' },
    ])

    const refused = await failure(() => harness.service.removeWorktree(created.id))
    expect(refused.code).toBe('worktree/dirty')
    expect(refused.remediation).toContain('force')

    const removed = await harness.service.removeWorktree(created.id, { force: true })
    expect(removed.state).toBe('removed')
    expect(removed.reusable).toBe(false)
    expect(harness.host.spawns.some(spawn => spawn.args.includes('--force'))).toBe(true)

    expect((await failure(() => harness.service.removeWorktree('wt-nope'))).code).toBe('worktree/not-found')
  })

  it('refuses to remove a branch whose commits are not in its base', async () => {
    const harness = await mount()
    const created = await harness.service.createWorktree({ agentId: 'codex', repoRoot: '/repo' })
    harness.host.ahead.set(created.path, 3)

    const refused = await failure(() => harness.service.removeWorktree(created.id))
    expect(refused.code).toBe('worktree/unmerged')
    expect(refused.message).toContain('3')
  })

  it('reports same-file overlap between two worktrees and ignores removed ones', async () => {
    const harness = await mount()
    const left = await harness.service.createWorktree({ agentId: 'codex', repoRoot: '/repo', label: 'left' })
    const right = await harness.service.createWorktree({ agentId: 'grok', repoRoot: '/repo', label: 'right' })
    harness.host.status.set(left.path, [' M shared.txt', '?? only-left.txt'])
    harness.host.status.set(right.path, [' M shared.txt', ' M only-right.txt'])

    const report = await harness.service.worktreeConflicts('/repo')
    expect(new Set(report.worktrees)).toEqual(new Set([left.id, right.id]))
    expect(report.findings).toHaveLength(1)
    const finding = required(report.findings[0], 'the same-file finding')
    expect(finding.kind).toBe('same-file')
    expect(finding.severity).toBe('warning')
    expect(new Set([finding.left, finding.right])).toEqual(new Set([left.id, right.id]))
    expect(finding.paths).toEqual(['shared.txt'])
    expect(finding.detail).toContain('codex')
    expect(finding.detail).toContain('grok')
    expect(report.notes.join(' ')).toContain('same-file')
    expect(report.suggestedOrder).toHaveLength(2)

    await harness.service.removeWorktree(left.id, { force: true })
    const after = await harness.service.worktreeConflicts('/repo')
    expect(after.worktrees).toEqual([right.id])
    expect(after.findings).toEqual([])
  })

  it('marks a worktree integrated and reports an unusable git rather than throwing raw', async () => {
    const harness = await mount()
    const created = await harness.service.createWorktree({ agentId: 'codex', repoRoot: '/repo' })
    const integrated = await harness.service.markWorktreeIntegrated(created.id)
    expect(integrated.state).toBe('merged')
    expect(integrated.reusable).toBe(false)
    expect((await harness.service.markWorktreeIntegrated(created.id, false)).state).toBe('idle')

    harness.host.gitAvailable = false
    expect((await failure(() => harness.service.worktreeConflicts('/repo'))).code).toBe('worktree/git-unavailable')
    const create = await failure(() => harness.service.createWorktree({ agentId: 'codex', repoRoot: '/repo' }))
    expect(create.code).toBe('worktree/git-unavailable')
    expect(create.remediation).toContain('shared-cwd')
  })

  it('refuses isolation outside a git repository', async () => {
    const harness = await mount()
    const refused = await failure(() => harness.service.createWorktree({ agentId: 'codex', repoRoot: '/elsewhere' }))
    expect(refused.code).toBe('worktree/not-a-repository')
  })
})

describe('model-facing tools', () => {
  it('registers the collaboration operations on the tool runtime', async () => {
    const harness = await mount()
    for (const name of [
      'mesh_collaboration_start',
      'mesh_collaborations',
      'mesh_plan_set',
      'mesh_plan_advance',
      'mesh_todos_set',
      'mesh_todos_get',
      'mesh_todos_observe',
      'mesh_task_dispatch',
      'mesh_worktrees',
      'mesh_worktree_create',
      'mesh_worktree_conflicts',
      'mesh_worktree_remove',
      'mesh_worktree_integrated',
    ]) {
      const definition = harness.ctx.get('tools')?.get(name)
      expect(definition, `${name} should be registered`).toBeDefined()
      expect(definition?.description.length ?? 0).toBeGreaterThan(20)
    }
  })

  it('runs start, board write, and worktree listing through the tool pipeline', async () => {
    const harness = await mount()
    const started = await callTool(harness.ctx, 'mesh_collaboration_start', {
      title: 'Ship the mesh',
      objective: 'Ship worktree-isolated collaboration',
      repoRoot: '/repo',
      tasks: [{ title: 'write the parser', instruction: 'Write the parser.', assignee: 'codex' }],
    }) as { collaborationId: string; tasks: { id: string }[] }
    const taskId = required(started.tasks[0], 'the seeded task').id

    const board = await callTool(harness.ctx, 'mesh_todos_set', {
      collaborationId: started.collaborationId,
      todos: [{ id: 'todo-1', content: 'write the parser', status: 'pending' }],
      expectedRevision: 1,
    }) as { revision: number }
    expect(board.revision).toBe(2)

    const worktrees = await callTool(harness.ctx, 'mesh_worktrees', { repoRoot: '/repo' }) as { worktrees: unknown[] }
    expect(worktrees.worktrees).toEqual([])

    const dispatched = await callTool(harness.ctx, 'mesh_task_dispatch', {
      collaborationId: started.collaborationId,
      taskId,
    }, approvalAgent()) as { runId: string; status: string }
    expect(dispatched.status).toBe('running')

    await expect(callToolFailure(harness.ctx, 'mesh_worktree_remove', { worktreeId: 'wt-nope' }, approvalAgent()))
      .resolves.toContain('no worktree with id')
  })
})
