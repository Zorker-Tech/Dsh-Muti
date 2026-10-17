/**
 * The shared documents of one collaboration: the one authoritative plan, the one
 * todo board, the tasks, and the deterministic context block that carries them into
 * a dispatched run's prompt.
 *
 * The sharing model is deliberately asymmetric and honest about it:
 *
 * - **Ingest** reads a named agent's own task state and folds it into the board as
 *   observed items. An observation may add an item, may update the status of an item
 *   that agent already owns, and never rewrites an authored item.
 * - **Egress** renders the plan and the board into text and prepends it at dispatch
 *   time. The render is deterministic — stable ordering, no timestamps inside — so two
 *   dispatches of the same board produce byte-identical text and the injected context
 *   can be verified by hash.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/boards
 */

import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentNativeTasks, AgentRunStatus, AgentTodo, AgentTodoStatus } from '@deepseek-ai/dsh-agent-mesh'
import { CollaborationError } from './errors.ts'
import type {
  CollaborationId,
  CollaborationRecord,
  CollaborationTaskId,
  CollaborationTaskRecord,
  PlanPhase,
  PlanRecord,
  TodoBoardRecord,
  WorktreeId,
  WorktreeRecord,
} from './domain.ts'
import type {
  CollaborationView,
  ContextPreview,
  IsolationMode,
  ObserveOutcome,
  PlanPatch,
  SetTodosOptions,
  StartCollaborationRequest,
  TodoInput,
  TodoStatus,
} from './types.ts'

/** The five domain tables one board writes and reads. */
export interface CollaborationTables {
  /** One record per collaboration. */
  readonly collaborations: KvTable<CollaborationId, CollaborationRecord>
  /** One plan per collaboration, keyed by collaboration id. */
  readonly plans: KvTable<CollaborationId, PlanRecord>
  /** One todo board per collaboration, keyed by collaboration id. */
  readonly todos: KvTable<CollaborationId, TodoBoardRecord>
  /** One record per task, keyed by task id. */
  readonly tasks: KvTable<CollaborationTaskId, CollaborationTaskRecord>
  /** One record per worktree, keyed by worktree id. */
  readonly worktrees: KvTable<WorktreeId, WorktreeRecord>
}

/**
 * Owns the shared documents of every collaboration.
 *
 * The board never touches git or an agent; it only reads and writes the domain
 * tables, so every one of its rules is testable without a repository.
 */
export class CollaborationBoard {
  /**
   * @param tables - The collaboration domain's tables.
   * @param clock - Clock returning an ISO-8601 timestamp, injected so tests can pin it.
   */
  constructor(
    private readonly tables: CollaborationTables,
    private readonly clock: () => string,
  ) {}

  /**
   * Create one collaboration with its plan, its empty board, and its initial tasks.
   * @param request - Title, objective, repository, and optional task seeds.
   * @param defaultIsolation - Isolation a seed gets when it names none.
   * @returns the created collaboration.
   */
  async start(request: StartCollaborationRequest, defaultIsolation: IsolationMode): Promise<CollaborationView> {
    const id = brandString<CollaborationId>(`collab-${randomToken()}`)
    const now = this.clock()
    const phases: readonly PlanPhase[] = [
      { id: 'phase-1', title: 'prepare', status: 'active' },
      { id: 'phase-2', title: 'execute', status: 'todo' },
      { id: 'phase-3', title: 'integrate', status: 'todo' },
    ]
    const record: CollaborationRecord = {
      title: request.title,
      repoRoot: request.repoRoot,
      createdAt: now,
      updatedAt: now,
    }
    const plan: PlanRecord = {
      collaborationId: id,
      objective: request.objective,
      phases,
      activePhaseId: 'phase-1',
      decisions: [],
      mode: 'inject',
      updatedAt: now,
    }
    const board: TodoBoardRecord = { collaborationId: id, todos: [], updatedAt: now, revision: 1 }
    const seeds = request.tasks ?? []
    // Task ids carry the collaboration token so two collaborations never collide, and a
    // seed may name a sibling by its readable position (`task-1`) in `dependsOn`.
    const taskIdFor = (index: number): CollaborationTaskId => brandString<CollaborationTaskId>(`${id}-task-${String(index + 1)}`)
    const localIds = new Map(seeds.map((_seed, index) => [`task-${String(index + 1)}`, taskIdFor(index)]))
    const tasks: CollaborationTaskRecord[] = seeds.map((seed, index) => {
      const dependsOn = (seed.dependsOn ?? []).map(entry => localIds.get(entry) ?? entry)
      return {
        id: taskIdFor(index),
        collaborationId: id,
        title: seed.title,
        instruction: seed.instruction,
        assignee: seed.assignee,
        isolation: seed.isolation ?? defaultIsolation,
        status: dependsOn.length > 0 ? 'blocked' : 'queued',
        dependsOn,
        createdAt: now,
        updatedAt: now,
      }
    })

    await this.tables.collaborations.put(id, record)
    await this.tables.plans.put(id, plan)
    await this.tables.todos.put(id, board)
    for (const task of tasks) await this.tables.tasks.put(task.id, task)
    return { id, record, plan, board, tasks, worktrees: [] }
  }

  /**
   * Every collaboration, most recently changed first.
   * @returns one view per collaboration.
   */
  list(): readonly CollaborationView[] {
    return [...this.tables.collaborations.entries()]
      .map(([id, record]) => this.buildView(id, record))
      .sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt))
  }

  /**
   * Read one collaboration.
   * @param id - Collaboration id.
   * @returns the collaboration with its plan, board, tasks and worktrees.
   */
  view(id: string): CollaborationView {
    const key = this.requireRecord(brandString<CollaborationId>(id)).id
    return this.buildView(key, this.requireRecord(key))
  }

  /**
   * Read one collaboration's plan.
   * @param id - Collaboration id.
   * @returns the plan.
   */
  plan(id: string): PlanRecord {
    const key = this.requireRecord(brandString<CollaborationId>(id)).id
    const plan = this.tables.plans.get(key)
    if (plan === undefined) {
      throw new CollaborationError('mesh/collaboration-not-found', `collaboration "${id}" has no plan`, {
        remediation: 'Start the collaboration again; a collaboration is always created with its plan.',
      })
    }
    return plan
  }

  /**
   * Read one collaboration's todo board.
   * @param id - Collaboration id.
   * @returns the board.
   */
  board(id: string): TodoBoardRecord {
    const key = this.requireRecord(brandString<CollaborationId>(id)).id
    const board = this.tables.todos.get(key)
    if (board === undefined) {
      throw new CollaborationError('mesh/collaboration-not-found', `collaboration "${id}" has no todo board`, {
        remediation: 'Start the collaboration again; a collaboration is always created with its board.',
      })
    }
    return board
  }

  /**
   * Every task of one collaboration, in creation order.
   * @param id - Collaboration id.
   * @returns the tasks.
   */
  tasks(id: string): readonly CollaborationTaskRecord[] {
    const key = this.requireRecord(brandString<CollaborationId>(id)).id
    return [...this.tables.tasks.entries()]
      .map(([, task]) => task)
      .filter(task => task.collaborationId === key)
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * Read one task.
   * @param collaborationId - Collaboration the task belongs to.
   * @param taskId - Task id.
   * @returns the task.
   */
  task(collaborationId: string, taskId: string): CollaborationTaskRecord {
    const key = this.requireRecord(brandString<CollaborationId>(collaborationId)).id
    const found = this.tables.tasks.get(brandString<CollaborationTaskId>(taskId))
    if (found === undefined || found.collaborationId !== key) {
      throw new CollaborationError('mesh/task-not-found', `collaboration "${collaborationId}" has no task "${taskId}"`, {
        remediation: 'Read the collaboration to list its tasks and their ids.',
      })
    }
    return found
  }

  /**
   * Replace the plan's fields.
   * @param id - Collaboration id.
   * @param patch - Fields to replace; an absent field keeps its current value.
   * @returns the plan after the write.
   */
  async setPlan(id: string, patch: PlanPatch): Promise<PlanRecord> {
    const current = this.plan(id)
    const phases = patch.phases ?? current.phases
    const activePhaseId = patch.activePhaseId ?? current.activePhaseId
    if (activePhaseId !== undefined && !phases.some(phase => phase.id === activePhaseId)) {
      throw new CollaborationError('mesh/invalid-transition', `no phase "${activePhaseId}" in this plan`, {
        remediation: 'Name one of the phases the plan declares, or set the phases first.',
      })
    }
    const now = this.clock()
    const plan: PlanRecord = {
      collaborationId: current.collaborationId,
      objective: patch.objective ?? current.objective,
      phases,
      decisions: patch.decisions ?? current.decisions,
      mode: patch.mode ?? current.mode,
      updatedAt: now,
      ...(activePhaseId === undefined ? {} : { activePhaseId }),
    }
    await this.tables.plans.put(plan.collaborationId, plan)
    await this.touch(plan.collaborationId, now)
    return plan
  }

  /**
   * Move the plan to a phase, marking every earlier phase done.
   *
   * The active phase counts as closed, so advancing one phase forward is a single
   * call; a phase that is neither done nor the active one still refuses the
   * transition, which is what stops a plan from skipping a phase.
   * @param id - Collaboration id.
   * @param phaseId - Phase to activate.
   * @returns the plan after the write.
   */
  async advancePhase(id: string, phaseId: string): Promise<PlanRecord> {
    const current = this.plan(id)
    const index = current.phases.findIndex(phase => phase.id === phaseId)
    if (index === -1) {
      throw new CollaborationError('mesh/invalid-transition', `no phase "${phaseId}" in this plan`, {
        remediation: 'Name one of the phases the plan declares.',
      })
    }
    const open = current.phases
      .slice(0, index)
      .filter(phase => phase.status !== 'done' && phase.id !== current.activePhaseId)
    if (open.length > 0) {
      throw new CollaborationError(
        'mesh/invalid-transition',
        `phase "${phaseId}" cannot start while ${open.map(phase => phase.id).join(', ')} is open`,
        { remediation: 'Mark the earlier phases done first, or reorder the plan.' },
      )
    }
    const phases = current.phases.map((phase, position) => {
      if (position < index) return { ...phase, status: 'done' as const }
      if (position === index) return { ...phase, status: 'active' as const }
      return phase
    })
    return await this.setPlan(id, { phases, activePhaseId: phaseId })
  }

  /**
   * Replace the shared todo board.
   * @param id - Collaboration id.
   * @param todos - The complete new list.
   * @param options - Expected revision; a mismatch is refused rather than applied.
   * @returns the board after the write.
   */
  async setTodos(id: string, todos: readonly TodoInput[], options: SetTodosOptions = {}): Promise<TodoBoardRecord> {
    const board = this.board(id)
    if (options.expectedRevision !== undefined && options.expectedRevision !== board.revision) {
      throw new CollaborationError(
        'schema/todo-conflict',
        `the todo board moved to revision ${String(board.revision)}`,
        { remediation: 'Re-read the board, re-apply your change, then write again.' },
      )
    }
    const seen = new Set<string>()
    for (const todo of todos) {
      if (seen.has(todo.id)) {
        throw new CollaborationError('mesh/duplicate-todo', `duplicate todo id "${todo.id}"`, {
          remediation: 'Give every item a distinct id; ids are the board\'s identity for an item.',
        })
      }
      seen.add(todo.id)
    }
    const now = this.clock()
    const next: TodoBoardRecord = {
      collaborationId: board.collaborationId,
      todos: todos.map(todo => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
        owner: todo.owner ?? 'shared',
        blockedBy: todo.blockedBy ?? [],
        updatedAt: now,
        ...(todo.nativeKey === undefined ? {} : { nativeKey: todo.nativeKey }),
        ...(todo.observedIn === undefined ? {} : { observedIn: todo.observedIn }),
      })),
      updatedAt: now,
      revision: board.revision + 1,
    }
    await this.tables.todos.put(next.collaborationId, next)
    await this.touch(next.collaborationId, now)
    return next
  }

  /**
   * Fold one agent's own task state into the board.
   *
   * Observation is read-only in spirit: an item the board already holds for a
   * different owner is left untouched, an item that agent already owns may only have
   * its status updated, and an item the board considers done is never reopened.
   * @param id - Collaboration id.
   * @param agentId - Agent the state was read from.
   * @param tasks - The agent's native todo and plan state.
   * @param sessionKey - Session the state was read from, recorded on new items.
   * @returns the board, how many items changed, and what could not be observed.
   */
  async observe(id: string, agentId: string, tasks: AgentNativeTasks, sessionKey?: string): Promise<ObserveOutcome> {
    const board = this.board(id)
    const notes = [...tasks.notes]
    if (!tasks.available) {
      notes.push(`agent "${agentId}" keeps no native todo state; nothing was folded in`)
    }
    const byId = new Map(board.todos.map(todo => [todo.id, todo]))
    const now = this.clock()
    let observed = 0
    for (const native of tasks.todos) {
      const id = observedItemId(agentId, native)
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, {
          id,
          content: native.content,
          status: nativeStatus(native.status),
          owner: agentId,
          blockedBy: [...native.blockedBy],
          updatedAt: now,
          nativeKey: native.nativeKey ?? native.id,
          ...(sessionKey === undefined ? {} : { observedIn: sessionKey }),
        })
        observed += 1
        continue
      }
      if (existing.owner !== agentId) continue
      const status = nativeStatus(native.status)
      if (existing.status === status) continue
      if (existing.status === 'completed') continue
      byId.set(id, { ...existing, status, updatedAt: now })
      observed += 1
    }
    if (observed === 0) return { board, observed, notes }
    const next: TodoBoardRecord = {
      collaborationId: board.collaborationId,
      todos: [...byId.values()],
      updatedAt: now,
      revision: board.revision + 1,
    }
    await this.tables.todos.put(next.collaborationId, next)
    await this.touch(next.collaborationId, now)
    return { board: next, observed, notes }
  }

  /**
   * Render the collaboration's shared documents as prompt context for one agent.
   * @param id - Collaboration id.
   * @param agentId - Agent the block is rendered for, used to mark its own items.
   * @returns the context block, or undefined when the plan mode is observe-only.
   */
  context(id: string, agentId: string): ContextPreview | undefined {
    const key = this.requireRecord(brandString<CollaborationId>(id)).id
    const view = this.buildView(key, this.requireRecord(key))
    if (view.plan.mode === 'observe') return undefined
    const text = renderContext(view, agentId)
    return { collaborationId: id, agentId, text, hash: contentHash(text) }
  }

  /**
   * Record that a task is now running.
   * @param task - The task being dispatched.
   * @param runId - The dispatched run.
   * @param worktreeId - The worktree the run executes in, when it is isolated.
   * @returns the stored task.
   */
  async markTaskRunning(task: CollaborationTaskRecord, runId: string, worktreeId: string | undefined): Promise<CollaborationTaskRecord> {
    return await this.updateTask(task, {
      status: 'running',
      runId,
      ...(worktreeId === undefined ? {} : { worktreeId }),
    })
  }

  /**
   * Fold one run's terminal status into its task.
   * @param taskId - Task the run belongs to.
   * @param runId - The run, checked against the recorded one.
   * @param status - Run status from the mesh; `running` changes nothing.
   * @param note - Failure message recorded on the task, when the run failed.
   * @returns the stored task, or undefined when the run is still going or the task moved on.
   */
  async settleTask(
    taskId: string,
    runId: string,
    status: AgentRunStatus,
    note?: string,
  ): Promise<CollaborationTaskRecord | undefined> {
    if (status === 'running') return undefined
    const key = brandString<CollaborationTaskId>(taskId)
    const task = this.tables.tasks.get(key)
    if (task === undefined || task.runId !== runId || task.status !== 'running') return undefined
    const next: CollaborationTaskRecord = {
      ...task,
      status: status === 'succeeded' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed',
      updatedAt: this.clock(),
      ...(note === undefined ? {} : { note }),
    }
    await this.tables.tasks.put(next.id, next)
    await this.touch(next.collaborationId, next.updatedAt)
    return next
  }

  /**
   * Record why a task did not run.
   * @param task - The task.
   * @param note - What stopped it.
   * @returns the stored task.
   */
  async markTaskBlocked(task: CollaborationTaskRecord, note: string): Promise<CollaborationTaskRecord> {
    return await this.updateTask(task, { status: 'blocked', note })
  }

  /** Store one task change and touch its collaboration. */
  private async updateTask(
    task: CollaborationTaskRecord,
    change: { status: CollaborationTaskRecord['status']; runId?: string; worktreeId?: string; note?: string },
  ): Promise<CollaborationTaskRecord> {
    const next: CollaborationTaskRecord = {
      ...task,
      status: change.status,
      updatedAt: this.clock(),
      ...(change.runId === undefined ? {} : { runId: change.runId }),
      ...(change.worktreeId === undefined ? {} : { worktreeId: change.worktreeId }),
      ...(change.note === undefined ? {} : { note: change.note }),
    }
    await this.tables.tasks.put(next.id, next)
    await this.touch(next.collaborationId, next.updatedAt)
    return next
  }

  /** Build a view from a known record. */
  private buildView(id: CollaborationId, record: CollaborationRecord): CollaborationView {
    const plan = this.tables.plans.get(id)
    const board = this.tables.todos.get(id)
    if (plan === undefined || board === undefined) {
      throw new CollaborationError('mesh/collaboration-not-found', `collaboration "${id}" is missing its plan or board`)
    }
    const worktrees: WorktreeRecord[] = [...this.tables.worktrees.entries()]
      .map(([, worktree]) => worktree)
      .filter(worktree => worktree.collaborationId === id)
    return {
      id,
      record,
      plan,
      board,
      tasks: [...this.tables.tasks.entries()]
        .map(([, task]) => task)
        .filter(task => task.collaborationId === id)
        .sort((left, right) => left.id.localeCompare(right.id)),
      worktrees,
    }
  }

  /** Resolve one collaboration record, refusing an unknown id. */
  private requireRecord(id: CollaborationId): CollaborationRecord & { id: CollaborationId } {
    const record = this.tables.collaborations.get(id)
    if (record === undefined) {
      throw new CollaborationError('mesh/collaboration-not-found', `no collaboration with id "${id}"`, {
        remediation: 'List collaborations to find a valid id, or start one first.',
      })
    }
    return { ...record, id }
  }

  /** Bump one collaboration's `updatedAt`. */
  private async touch(id: CollaborationId, at: string): Promise<void> {
    const record = this.tables.collaborations.get(id)
    if (record === undefined) return
    await this.tables.collaborations.put(id, { ...record, updatedAt: at })
  }
}

/**
 * The board id of an item observed in an agent's own store.
 *
 * The mesh derives an agent todo's id from the agent, the session, and the native
 * key, so the same native item keeps one board id across observations.
 * @param agentId - Agent the item was read from.
 * @param todo - The native item.
 * @returns the board id.
 */
function observedItemId(agentId: string, todo: AgentTodo): string {
  return `obs-${contentHash(`${agentId}\u0000${todo.nativeKey ?? todo.id}\u0000${todo.content}`)}`
}

/**
 * Project a native todo status onto the board's status set.
 * @param status - Status as the mesh reported it.
 * @returns the board status.
 */
function nativeStatus(status: AgentTodoStatus): TodoStatus {
  return status
}

/**
 * Render the shared documents as text.
 *
 * The block is deterministic: stable ordering and no timestamps inside, so two
 * dispatches of the same board produce byte-identical text.
 * @param view - The collaboration.
 * @param agentId - Agent the block is rendered for.
 * @returns the rendered block.
 */
export function renderContext(view: CollaborationView, agentId: string): string {
  const lines: string[] = []
  lines.push('# Shared collaboration context')
  lines.push('')
  lines.push(`Objective: ${view.plan.objective}`)
  const active = view.plan.phases.find(phase => phase.status === 'active')
  if (active !== undefined) {
    lines.push(`Current phase: ${active.title}${active.exitCriteria === undefined ? '' : ` (done when: ${active.exitCriteria})`}`)
  }
  const upcoming = view.plan.phases.filter(phase => phase.status === 'todo').map(phase => phase.title)
  if (upcoming.length > 0) lines.push(`Remaining phases: ${upcoming.join(' -> ')}`)
  if (view.plan.decisions.length > 0) {
    lines.push('')
    lines.push('Decisions already made (do not revisit):')
    for (const decision of view.plan.decisions) lines.push(`- ${decision}`)
  }

  const rank = (status: TodoStatus): number => (status === 'in_progress' ? 0 : status === 'pending' ? 1 : 2)
  const todos = [...view.board.todos].sort((left, right) => rank(left.status) - rank(right.status)
    || left.content.localeCompare(right.content))
  if (todos.length > 0) {
    lines.push('')
    lines.push('Shared task board (yours are marked `*`):')
    for (const todo of todos) {
      const mine = todo.owner === agentId ? '*' : ' '
      const blocked = todo.blockedBy.length > 0 ? ` [blocked by ${todo.blockedBy.join(', ')}]` : ''
      lines.push(`- ${mine} [${todo.status}] (${todo.owner}) ${todo.content}${blocked}`)
    }
  }

  const siblings = view.tasks.filter(task => task.assignee !== agentId && task.status !== 'cancelled')
  if (siblings.length > 0) {
    lines.push('')
    lines.push('Other agents in this collaboration:')
    for (const task of siblings) lines.push(`- ${task.assignee}: ${task.title} [${task.status}]`)
    lines.push('')
    lines.push(
      'Stay inside your own worktree. If you must change a file another agent is likely to touch, say so explicitly in your final message.',
    )
  }
  return lines.join('\n')
}

/**
 * Compose the prompt handed to an agent: the injected context first, then the task.
 * @param instruction - The task's own instruction.
 * @param context - The rendered context block, when the plan is injected.
 * @returns the prompt text.
 */
export function renderPrompt(instruction: string, context: ContextPreview | undefined): string {
  if (context === undefined || context.text.trim() === '') return instruction
  return `${context.text.trim()}\n\n---\n\n${instruction}`
}

/**
 * Deterministic content hash of a rendered block.
 * @param text - Text to hash.
 * @returns the first 16 hex digits of its SHA-256 digest.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Mint a short random token for one id.
 * @returns the token.
 */
function randomToken(): string {
  return Math.random().toString(36).slice(2, 10)
}
