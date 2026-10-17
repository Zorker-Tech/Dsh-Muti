/**
 * Model-facing collaboration tools: argument projection, service delegation, and
 * rendered text across empty and populated records.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tests/tools.spec
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { AgentId, AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh'
import type { WorktreeView } from '../src/types.ts'
import { approvalAgent, callTool, callToolFailure, callToolText, mount, required, unmountAll } from './support/harness.ts'

afterEach(unmountAll)

describe('collaboration and plan tools', () => {
  it('starts with and without seeded tasks, lists, reads, and edits plans', async () => {
    const harness = await mount()

    await expect(callToolText(harness.ctx, 'mesh_collaborations', {}))
      .resolves.toBe('No collaborations have been started.')

    const empty = await callTool(harness.ctx, 'mesh_collaboration_start', {
      title: 'Explore the mesh', objective: 'Find the right design', repoRoot: '/repo',
    }) as { collaborationId: string; tasks: unknown[] }
    expect(empty.tasks).toEqual([])
    await expect(callToolText(harness.ctx, 'mesh_collaboration_start', {
      title: 'Explore another mesh', objective: 'Find another design', repoRoot: '/repo', tasks: [],
    })).resolves.toContain('No tasks were seeded')

    const started = await callTool(harness.ctx, 'mesh_collaboration_start', {
      title: 'Ship the mesh', objective: 'Ship the harness', repoRoot: '/repo',
      tasks: [{
        title: 'write parser', instruction: 'Write the parser', assignee: 'codex',
        dependsOn: [], isolation: 'shared-cwd',
      }, { title: 'review parser', instruction: 'Review the parser', assignee: 'grok' }],
    }) as { collaborationId: string; tasks: { id: string }[] }
    const collaborationId = started.collaborationId
    const taskId = required(started.tasks[0], 'seeded task').id

    await expect(callToolText(harness.ctx, 'mesh_collaborations', {}))
      .resolves.toContain('tasks:\n')
    await expect(callToolText(harness.ctx, 'mesh_collaborations', { collaborationId }))
      .resolves.toContain('plan mode: inject, active phase phase-1')

    const plan = await callTool(harness.ctx, 'mesh_plan_set', {
      collaborationId,
      objective: 'Ship the parser safely',
      phases: [
        { id: 'design', title: 'Design', status: 'active', exitCriteria: 'reviewed' },
        { id: 'build', title: 'Build', status: 'todo' },
      ],
      activePhaseId: 'design',
      decisions: ['keep the API small'],
      mode: 'observe',
    }) as { phases: { id: string; exitCriteria: string }[]; decisions: string[] }
    expect(plan.phases[0]?.exitCriteria).toBe('reviewed')
    expect(plan.phases[1]?.exitCriteria).toBe('')
    expect(plan.decisions).toEqual(['keep the API small'])
    await expect(callToolText(harness.ctx, 'mesh_plan_set', { collaborationId, objective: 'Still shipping' }))
      .resolves.toContain('Plan of ')
    await expect(callToolText(harness.ctx, 'mesh_plan_advance', { collaborationId, phaseId: 'build' }))
      .resolves.toContain('Active phase of ')

    const planWithoutActive = { ...harness.service.plan(collaborationId) }
    delete planWithoutActive.activePhaseId
    const setPlan = vi.spyOn(harness.service, 'setPlan').mockResolvedValue(planWithoutActive)
    const setWithoutActive = await callTool(harness.ctx, 'mesh_plan_set', {
      collaborationId, objective: 'No active phase',
    }) as { activePhaseId: string }
    expect(setWithoutActive.activePhaseId).toBe('')
    setPlan.mockRestore()

    const advancePhase = vi.spyOn(harness.service, 'advancePhase').mockResolvedValue(planWithoutActive)
    const advanceWithoutActive = await callTool(harness.ctx, 'mesh_plan_advance', {
      collaborationId, phaseId: 'build',
    }) as { activePhaseId: string }
    expect(advanceWithoutActive.activePhaseId).toBe('')
    advancePhase.mockRestore()

    const originalView = harness.service.get(collaborationId)
    const planWithoutPhases = { ...originalView.plan, phases: [], decisions: [] }
    delete planWithoutPhases.activePhaseId
    const emptyView = { ...originalView, plan: planWithoutPhases, tasks: [], worktrees: [] }
    const get = vi.spyOn(harness.service, 'get').mockReturnValue(emptyView)
    await expect(callToolText(harness.ctx, 'mesh_collaborations', { collaborationId }))
      .resolves.toContain('tasks: none')
    get.mockRestore()

    await callTool(harness.ctx, 'mesh_worktree_create', {
      agentId: 'codex', repoRoot: '/repo', collaborationId,
    })
    const populatedSummary = await callToolText(harness.ctx, 'mesh_collaborations', { collaborationId })
    expect(populatedSummary).toContain('decisions:\n  - keep the API small')
    expect(populatedSummary).toContain('worktrees:\n')
    expect(harness.service.task(collaborationId, taskId).status).toBe('queued')
  })
})

describe('todo tools', () => {
  it('reads empty and populated boards and folds native session todos', async () => {
    const harness = await mount()
    const started = await harness.service.start({
      title: 'Ship the mesh', objective: 'Ship the harness', repoRoot: '/repo',
    })

    await expect(callToolText(harness.ctx, 'mesh_todos_get', { collaborationId: started.id }))
      .resolves.toContain('is empty')
    await expect(callToolText(harness.ctx, 'mesh_todos_set', { collaborationId: started.id, todos: [] }))
      .resolves.toContain('(empty)')

    const board = await callTool(harness.ctx, 'mesh_todos_set', {
      collaborationId: started.id,
      todos: [
        { id: 'todo-open', content: 'write tests', status: 'pending' },
        { id: 'todo-blocked', content: 'review tests', status: 'blocked', owner: 'grok', blockedBy: ['todo-open'] },
      ],
      expectedRevision: 2,
    }) as { todos: { id: string; owner: string; nativeKey: string; observedIn: string }[] }
    expect(board.todos[0]).toMatchObject({ owner: 'shared', nativeKey: '', observedIn: '' })
    expect(board.todos[1]?.owner).toBe('grok')
    await expect(callToolText(harness.ctx, 'mesh_todos_get', { collaborationId: started.id }))
      .resolves.toContain('[blocked by todo-open]')

    harness.mesh.sessions.set('codex', [{
      key: brandString<AgentSessionKey>('codex:session-1'),
      agentId: brandString<AgentId>('codex'),
      nativeId: 'session-1',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T01:00:00.000Z',
      status: 'idle',
      notes: [],
    }])
    harness.mesh.nativeTasks.set('codex:session-1', {
      available: false, todos: [], notes: ['native todo storage is unavailable'],
    })
    await expect(callToolText(harness.ctx, 'mesh_todos_observe', {
      collaborationId: started.id, agentId: 'codex',
    })).resolves.toContain('native todo storage is unavailable')

    await callTool(harness.ctx, 'mesh_todos_set', { collaborationId: started.id, todos: [] })
    harness.mesh.nativeTasks.set('codex:session-1', { available: true, todos: [], notes: [] })
    await expect(callToolText(harness.ctx, 'mesh_todos_observe', {
      collaborationId: started.id, agentId: 'codex', sessionId: 'session-1',
    })).resolves.toContain('Folded 0 item(s) into the board')

    harness.mesh.nativeTasks.set('codex:session-1', {
      available: true,
      todos: [{
        id: 'native-1', content: 'implement parser', status: 'in_progress', owner: 'codex',
        blockedBy: [], updatedAt: '2026-10-16T01:00:00.000Z', nativeKey: 'parser',
      }],
      notes: [],
    })
    const observed = await callTool(harness.ctx, 'mesh_todos_observe', {
      collaborationId: started.id, agentId: 'codex', sessionId: 'session-1',
    }) as { observed: number; todos: { nativeKey: string; observedIn: string }[] }
    expect(observed.observed).toBe(1)
    expect(observed.todos.find(todo => todo.nativeKey === 'parser')?.observedIn).toBe('codex:session-1')
    await expect(callToolText(harness.ctx, 'mesh_todos_observe', {
      collaborationId: started.id, agentId: 'codex',
    })).resolves.toContain('Folded 0 item(s)')
  })
})

describe('worktree tools', () => {
  it('creates, lists, compares, marks, and removes worktrees', async () => {
    const harness = await mount()
    await expect(callToolText(harness.ctx, 'mesh_worktrees', {})).resolves.toBe('No worktrees are recorded.')

    const created = await callTool(harness.ctx, 'mesh_worktree_create', {
      agentId: 'codex', repoRoot: '/repo',
    }) as { worktree: { id: string; reusable: boolean; changedFiles: number; runId: string } }
    expect(created.worktree.reusable).toBe(true)
    expect(created.worktree.changedFiles).toBe(0)
    expect(created.worktree.runId).toBe('')
    await expect(callToolText(harness.ctx, 'mesh_worktree_create', {
      agentId: 'codex', repoRoot: '/repo', baseRef: 'main', label: 'parser', reuse: true,
    })).resolves.toContain('(reusable)')

    const sampled = await harness.service.createWorktree({ agentId: 'unsampled', repoRoot: '/repo' })
    const { progress: _progress, ...unsampled } = sampled
    const worktrees = vi.spyOn(harness.service, 'worktrees').mockResolvedValue([unsampled satisfies WorktreeView])
    const unsampledValue = await callTool(harness.ctx, 'mesh_worktrees', {}) as {
      worktrees: { changedFiles: number; dirty: boolean; ahead: number; progressNotes: string[] }[]
    }
    expect(unsampledValue.worktrees[0]).toMatchObject({ changedFiles: 0, dirty: false, ahead: 0, progressNotes: [] })
    worktrees.mockRestore()

    const sampledWorktrees = await harness.service.worktrees('/repo')
    const first = required(sampledWorktrees.find(worktree => worktree.id === created.worktree.id), 'created worktree')
    expect(first.progress?.dirty).toBe(false)
    harness.host.status.set(first.path, [' M shared.ts'])
    const second = await harness.service.createWorktree({ agentId: 'grok', repoRoot: '/repo', label: 'review' })
    harness.host.status.set(second.path, [' M shared.ts', '?? review.md'])
    harness.host.ahead.set(second.path, 2)

    const listed = await callTool(harness.ctx, 'mesh_worktrees', {}) as { worktrees: { dirty: boolean; ahead: number }[] }
    expect(listed.worktrees.some(worktree => worktree.dirty)).toBe(true)
    expect(listed.worktrees.some(worktree => worktree.ahead === 2)).toBe(true)
    harness.host.respond = spec => spec.cwd === '/elsewhere'
      && spec.args[0] === 'rev-parse' && spec.args[1] === '--show-toplevel'
      ? { lines: ['/elsewhere'] }
      : undefined
    await expect(callToolText(harness.ctx, 'mesh_worktrees', { repoRoot: '/elsewhere' }))
      .resolves.toBe('No worktrees are recorded.')
    const noConflicts = await callTool(harness.ctx, 'mesh_worktree_conflicts', { repoRoot: '/elsewhere' }) as { findings: unknown[] }
    expect(noConflicts.findings).toEqual([])
    delete harness.host.respond
    const conflicts = await callToolText(harness.ctx, 'mesh_worktree_conflicts', { repoRoot: '/repo' })
    expect(conflicts).toContain('warning:')
    expect(conflicts).toContain('suggested integration order:')

    await callToolText(harness.ctx, 'mesh_worktree_integrated', { worktreeId: created.worktree.id })
    const mergedLines = (await callToolText(harness.ctx, 'mesh_worktrees', { repoRoot: '/repo' })).split('\n')
    expect(mergedLines.find(line => line.startsWith(created.worktree.id))).not.toContain('(reusable)')
    await expect(callToolText(harness.ctx, 'mesh_worktree_integrated', { worktreeId: created.worktree.id }))
      .resolves.toContain('is merged.')
    await expect(callToolText(harness.ctx, 'mesh_worktree_integrated', {
      worktreeId: created.worktree.id, merged: false,
    })).resolves.toContain('is idle.')
    harness.host.status.delete(first.path)
    const cleanRemoval = await callTool(harness.ctx, 'mesh_worktree_remove', {
      worktreeId: created.worktree.id,
    }, approvalAgent()) as { forced: boolean }
    expect(cleanRemoval.forced).toBe(false)

    const removed = await callToolText(harness.ctx, 'mesh_worktree_remove', {
      worktreeId: second.id, force: true,
    }, approvalAgent())
    expect(removed).toContain('(its work was discarded)')
  })
})

describe('dispatch tool', () => {
  it('covers injected and observe-only context along with dispatch options', async () => {
    const harness = await mount()
    const started = await callTool(harness.ctx, 'mesh_collaboration_start', {
      title: 'Ship the mesh', objective: 'Ship the harness', repoRoot: '/repo',
      tasks: [
        { title: 'inspect', instruction: 'Inspect the source', assignee: 'codex', isolation: 'shared-cwd' },
        { title: 'implement', instruction: 'Implement the change', assignee: 'grok', isolation: 'worktree' },
      ],
    }) as { collaborationId: string; tasks: { id: string }[] }
    const first = required(started.tasks[0], 'first task')
    const second = required(started.tasks[1], 'second task')

    await harness.service.setPlan(started.collaborationId, { mode: 'observe' })
    await expect(callToolText(harness.ctx, 'mesh_task_dispatch', {
      collaborationId: started.collaborationId, taskId: first.id,
    }, approvalAgent())).resolves.toContain('without an injected context block')

    await harness.service.setPlan(started.collaborationId, { mode: 'inject' })
    await expect(callToolText(harness.ctx, 'mesh_task_dispatch', {
      collaborationId: started.collaborationId, taskId: second.id, baseRef: 'main', timeoutMs: 1200,
    }, approvalAgent())).resolves.toContain('with context ')
    expect(harness.mesh.starts[1]?.request.timeoutMs).toBe(1200)
    await expect(callToolText(harness.ctx, 'mesh_worktrees', { repoRoot: '/repo' }))
      .resolves.toContain('run=run-2')
    await expect(callToolText(harness.ctx, 'mesh_collaborations', { collaborationId: started.collaborationId }))
      .resolves.toContain('worktrees:\n')
  })

  it('fails closed without an owning agent before dispatch or worktree removal', async () => {
    const harness = await mount()
    const started = await callTool(harness.ctx, 'mesh_collaboration_start', {
      title: 'Ship the mesh', objective: 'Ship worktree-isolated collaboration', repoRoot: '/repo',
      tasks: [{ title: 'write the parser', instruction: 'Write the parser.', assignee: 'codex' }],
    }) as { collaborationId: string; tasks: { id: string }[] }
    const taskId = required(started.tasks[0], 'the seeded task').id
    const worktree = await harness.service.createWorktree({ agentId: 'codex', repoRoot: '/repo' })

    await expect(callToolFailure(harness.ctx, 'mesh_task_dispatch', {
      collaborationId: started.collaborationId, taskId,
    })).resolves.toContain('the call has no agent to route it through')
    await expect(callToolFailure(harness.ctx, 'mesh_worktree_remove', {
      worktreeId: worktree.id,
    })).resolves.toContain('the call has no agent to route it through')
    expect(harness.mesh.starts).toHaveLength(0)
    await expect(harness.service.worktrees('/repo')).resolves.toHaveLength(1)
  })

  it('monotonically denies when an earlier listener bypasses collaboration approvals', async () => {
    const harness = await mount({}, (ctx) => {
      ctx.on('tools/pre-execute', (_exec, _next): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' }))
    })

    await expect(callToolFailure(harness.ctx, 'mesh_task_dispatch', {
      collaborationId: 'missing', taskId: 'missing',
    }, approvalAgent())).resolves.toContain('mesh_task_dispatch requires an approval request before it can run.')
    await expect(callToolFailure(harness.ctx, 'mesh_worktree_remove', {
      worktreeId: 'missing',
    }, approvalAgent())).resolves.toContain('mesh_worktree_remove requires an approval request before it can run.')
    expect(harness.mesh.starts).toHaveLength(0)
  })
})
