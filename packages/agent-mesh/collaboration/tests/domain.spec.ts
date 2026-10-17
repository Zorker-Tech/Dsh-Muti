import { describe, expect, it } from 'vitest'
import { collaborationTaskRecord, planRecord, worktreeRecord } from '../src/domain.ts'

describe('collaboration domain schemas', () => {
  it('brands collaboration, task, and worktree ids while parsing their durable records', () => {
    const plan = planRecord.parse({
      collaborationId: 'collab-1',
      objective: 'ship the change',
      phases: [{ id: 'phase-1', title: 'Implement', status: 'active', exitCriteria: 'Review passes' }],
      activePhaseId: 'phase-1',
      decisions: ['keep history'],
      mode: 'inject',
      updatedAt: '2026-10-16T00:00:00.000Z',
    })
    const task = collaborationTaskRecord.parse({
      id: 'task-1',
      collaborationId: 'collab-1',
      title: 'Implement',
      instruction: 'Make the change',
      assignee: 'codex',
      isolation: 'worktree',
      status: 'queued',
      dependsOn: [],
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    })
    const worktree = worktreeRecord.parse({
      id: 'worktree-1',
      path: '/repo/.worktrees/task-1',
      repoRoot: '/repo',
      branch: 'codex/task-1',
      baseCommit: 'a'.repeat(40),
      baseRef: 'main',
      agentId: 'codex',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
      state: 'idle',
      reusable: true,
    })
    expect(plan.collaborationId).toBe('collab-1')
    expect(task).toMatchObject({ id: 'task-1', collaborationId: 'collab-1' })
    expect(worktree.id).toBe('worktree-1')
  })
})
