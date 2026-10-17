/**
 * Collaboration board invariants and prompt projection over small in-memory tables.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tests/boards.spec
 */

import { describe, expect, it } from 'vitest'
import type { AgentNativeTasks } from '@deepseek-ai/dsh-agent-mesh'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { CollaborationError } from '../src/errors.ts'
import { CollaborationBoard } from '../src/boards.ts'
import type { CollaborationTables } from '../src/boards.ts'
import type {
  CollaborationId,
  CollaborationRecord,
  CollaborationTaskId,
  CollaborationTaskRecord,
  PlanRecord,
  TodoBoardRecord,
  WorktreeId,
  WorktreeRecord,
} from '../src/domain.ts'
import { contentHash, renderContext, renderPrompt } from '../src/boards.ts'
import type { CollaborationView } from '../src/types.ts'

const now = '2026-10-16T00:00:00.000Z'

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

function memoryTables(): CollaborationTables {
  return {
    collaborations: new MemoryTable<CollaborationId, CollaborationRecord>(),
    plans: new MemoryTable<CollaborationId, PlanRecord>(),
    todos: new MemoryTable<CollaborationId, TodoBoardRecord>(),
    tasks: new MemoryTable<CollaborationTaskId, CollaborationTaskRecord>(),
    worktrees: new MemoryTable<WorktreeId, WorktreeRecord>(),
  }
}

function boardFor(tables: CollaborationTables): CollaborationBoard {
  return new CollaborationBoard(tables, () => now)
}

describe('collaboration board records', () => {
  it('reads owned records, orders tasks, rejects missing records, and settles task states', async () => {
    const tables = memoryTables()
    const board = boardFor(tables)
    const first = await board.start({
      title: 'First', objective: 'Own the first board', repoRoot: '/repo',
      tasks: [
        { title: 'second', instruction: 'Second', assignee: 'grok' },
        { title: 'first', instruction: 'First', assignee: 'codex' },
        { title: 'external dependency', instruction: 'Wait for external work', assignee: 'pi', dependsOn: ['external-task'] },
      ],
    }, 'worktree')
    const second = await board.start({
      title: 'Second', objective: 'Own another board', repoRoot: '/repo',
      tasks: [{ title: 'orphaned task', instruction: 'Still stored', assignee: 'pi' }],
    }, 'shared-cwd')

    expect(board.list().map(view => view.id)).toContain(first.id)
    expect(board.view(first.id).tasks.map(task => task.title)).toEqual(['second', 'first', 'external dependency'])
    expect(board.tasks(first.id).map(task => task.title)).toEqual(['second', 'first', 'external dependency'])
    expect(board.plan(first.id).objective).toBe('Own the first board')
    expect(board.board(first.id).revision).toBe(1)
    await expect(Promise.resolve().then(() => board.task(first.id, requiredTaskId(second.tasks))))
      .rejects.toBeInstanceOf(CollaborationError)

    const task = requiredTask(first.tasks)
    const blocked = await board.markTaskBlocked(task, 'waiting for review')
    expect(blocked).toMatchObject({ status: 'blocked', note: 'waiting for review' })
    const running = await board.markTaskRunning(blocked, 'run-1', undefined)
    expect(await board.settleTask(running.id, 'run-1', 'running')).toBeUndefined()
    expect(await board.settleTask('missing-task', 'run-1', 'failed')).toBeUndefined()
    expect(await board.settleTask(running.id, 'different-run', 'failed')).toBeUndefined()
    const succeeded = await board.settleTask(running.id, 'run-1', 'succeeded')
    expect(succeeded).toMatchObject({ status: 'succeeded', note: 'waiting for review' })

    const cancelledRun = await board.markTaskRunning(requiredTask(second.tasks), 'run-2', undefined)
    expect(await board.settleTask(cancelledRun.id, 'run-2', 'cancelled', 'cancelled by owner'))
      .toMatchObject({ status: 'cancelled', note: 'cancelled by owner' })

    await tables.plans.delete(first.id)
    expect(() => board.plan(first.id)).toThrow('has no plan')
    expect(() => board.view(first.id)).toThrow('missing its plan or board')
    await tables.todos.delete(first.id)
    expect(() => board.board(first.id)).toThrow('has no todo board')

    const secondPlan = board.plan(second.id)
    const { activePhaseId: _activePhaseId, ...planWithoutActive } = secondPlan
    await tables.plans.put(second.id, planWithoutActive)
    expect((await board.setPlan(second.id, { objective: 'No phase selected' })).activePhaseId).toBeUndefined()

    await tables.collaborations.delete(second.id)
    expect((await board.markTaskBlocked(requiredTask(second.tasks), 'orphaned collaboration')).status).toBe('blocked')
  })

  it('folds observed tasks without changing another owner’s or completed items', async () => {
    const tables = memoryTables()
    const board = boardFor(tables)
    const view = await board.start({ title: 'Observe', objective: 'Fold native work', repoRoot: '/repo' }, 'worktree')
    const native: AgentNativeTasks = {
      available: true,
      todos: [{
        id: 'native-1', content: 'write the parser', status: 'pending', owner: 'codex', blockedBy: [], updatedAt: now,
      }],
      notes: [],
    }

    const inserted = await board.observe(view.id, 'codex', native)
    const observed = requiredTodo(inserted.board.todos)
    expect(inserted.observed).toBe(1)
    expect(observed).toMatchObject({ nativeKey: 'native-1', owner: 'codex' })
    expect(observed.observedIn).toBeUndefined()
    expect((await board.observe(view.id, 'codex', native)).observed).toBe(0)

    await board.setTodos(view.id, [{
      id: observed.id, content: observed.content, status: 'pending', owner: 'grok', nativeKey: 'native-1', observedIn: 'grok:session',
    }])
    expect((await board.observe(view.id, 'codex', native)).observed).toBe(0)

    await board.setTodos(view.id, [{
      id: observed.id, content: observed.content, status: 'pending', owner: 'codex', nativeKey: 'native-1', observedIn: 'codex:session',
    }])
    const updated = await board.observe(view.id, 'codex', { ...native, todos: [{ ...native.todos[0]!, status: 'in_progress' }] })
    expect(updated.observed).toBe(1)
    expect(updated.board.todos[0]?.status).toBe('in_progress')

    await board.setTodos(view.id, [{
      id: observed.id, content: observed.content, status: 'completed', owner: 'codex', nativeKey: 'native-1', observedIn: 'codex:session',
    }])
    const completed = await board.observe(view.id, 'codex', { ...native, todos: [{ ...native.todos[0]!, status: 'pending' }] })
    expect(completed.observed).toBe(0)
    expect(completed.board.todos[0]?.status).toBe('completed')
    expect((await board.observe(view.id, 'codex', { ...native, available: false })).notes)
      .toContain('agent "codex" keeps no native todo state; nothing was folded in')
  })

  it('renders context groups, status ordering, ownership, and prompt fallbacks', async () => {
    const tables = memoryTables()
    const board = boardFor(tables)
    const view = await board.start({
      title: 'Render', objective: 'Render shared work', repoRoot: '/repo',
      tasks: [
        { title: 'local task', instruction: 'Local', assignee: 'codex' },
        { title: 'sibling task', instruction: 'Sibling', assignee: 'grok' },
        { title: 'cancelled task', instruction: 'Ignore', assignee: 'pi' },
      ],
    }, 'worktree')
    const cancelled = requiredTask(view.tasks, 'cancelled task')
    await tables.tasks.put(cancelled.id, { ...cancelled, status: 'cancelled' })
    await board.setPlan(view.id, {
      phases: [
        { id: 'phase-1', title: 'prepare', status: 'active', exitCriteria: 'reviewed' },
        { id: 'phase-2', title: 'build', status: 'todo' },
      ],
      activePhaseId: 'phase-1',
      decisions: ['keep the contract stable'],
    })
    await board.setTodos(view.id, [
      { id: 'todo-done', content: 'done item', status: 'completed', owner: 'grok' },
      { id: 'todo-pending', content: 'pending item', status: 'pending', owner: 'codex' },
      { id: 'todo-blocked', content: 'blocked item', status: 'blocked', owner: 'grok', blockedBy: ['todo-pending'] },
      { id: 'todo-running', content: 'running item', status: 'in_progress', owner: 'codex' },
      { id: 'todo-cancelled', content: 'cancelled item', status: 'cancelled', owner: 'shared' },
      { id: 'todo-explicit', content: 'explicit metadata', status: 'pending', nativeKey: 'native', observedIn: 'codex:session' },
    ])

    const text = renderContext(board.view(view.id), 'codex')
    expect(text).toContain('Current phase: prepare (done when: reviewed)')
    expect(text).toContain('Remaining phases: build')
    expect(text).toContain('Decisions already made')
    expect(text.indexOf('running item')).toBeLessThan(text.indexOf('pending item'))
    expect(text).toContain('[blocked by todo-pending]')
    expect(text).toContain('Other agents in this collaboration')
    expect(text).not.toContain('cancelled task')

    const emptyPlan = { ...view.plan, phases: [], decisions: [] }
    delete emptyPlan.activePhaseId
    const emptyView: CollaborationView = {
      ...view,
      plan: emptyPlan,
      board: { ...view.board, todos: [] },
      tasks: [],
    }
    const emptyText = renderContext(emptyView, 'codex')
    expect(emptyText).toContain('Objective: Render shared work')
    expect(emptyText).not.toContain('Current phase:')
    expect(emptyText).not.toContain('Remaining phases:')
    expect(emptyText).not.toContain('Decisions already made')
    expect(emptyText).not.toContain('Shared task board')
    expect(emptyText).not.toContain('Other agents in this collaboration')

    const promptContext = { collaborationId: view.id, agentId: 'codex', text: '  shared context  ', hash: contentHash('shared context') }
    expect(renderPrompt('do work', undefined)).toBe('do work')
    expect(renderPrompt('do work', { ...promptContext, text: '  \n' })).toBe('do work')
    expect(renderPrompt('do work', promptContext)).toBe('shared context\n\n---\n\ndo work')
  })
})

function requiredTask(tasks: readonly CollaborationTaskRecord[], title?: string): CollaborationTaskRecord {
  const task = tasks.find(candidate => title === undefined || candidate.title === title)
  if (task === undefined) throw new Error('the test task should exist')
  return task
}

function requiredTaskId(tasks: readonly CollaborationTaskRecord[]): string {
  return requiredTask(tasks).id
}

function requiredTodo<T>(todos: readonly T[]): T {
  const todo = todos[0]
  if (todo === undefined) throw new Error('the test todo should exist')
  return todo
}
