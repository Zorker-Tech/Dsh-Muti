/**
 * The mesh collaboration domain: the durable records behind one collaboration —
 * its identity, its authoritative plan, its shared todo board, its tasks, and the
 * git worktrees those tasks run in.
 *
 * The domain is mesh-owned and versioned independently of the session format, so a
 * harness that does not know it reads only its own data. Nothing here is written
 * into a session log, a session event, or the session-query index.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/domain
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Identity of one collaboration. */
export type CollaborationId = Branded<'CollaborationId'>

/** Identity of one task inside a collaboration. */
export type CollaborationTaskId = Branded<'CollaborationTaskId'>

/** Identity of one mesh-owned git worktree. */
export type WorktreeId = Branded<'WorktreeId'>

const collaborationId = z.string().transform(value => brandString<CollaborationId>(value))
const collaborationTaskId = z.string().transform(value => brandString<CollaborationTaskId>(value))
const worktreeId = z.string().transform(value => brandString<WorktreeId>(value))

/** Where one plan phase stands. */
export const planPhaseStatus = z.enum(['todo', 'active', 'done'])

/** One ordered plan phase. */
export const planPhase = z.object({
  id: z.string(),
  title: z.string(),
  status: planPhaseStatus,
  /** What must be true for the phase to count as done, when the author said so. */
  exitCriteria: z.string().optional(),
})

/** One plan phase, inferred from {@link planPhase}. */
export type PlanPhase = z.infer<typeof planPhase>

/** Whether the plan is injected into a dispatched run's prompt or only observed. */
export const planMode = z.enum(['inject', 'observe'])

/** The one authoritative plan of a collaboration. */
export const planRecord = z.object({
  collaborationId,
  objective: z.string(),
  phases: z.array(planPhase).readonly(),
  /** Phase currently active; absent when no phase is active. */
  activePhaseId: z.string().optional(),
  decisions: z.array(z.string()).readonly(),
  mode: planMode,
  updatedAt: z.string(),
})

/** One collaboration's plan, inferred from {@link planRecord}. */
export type PlanRecord = z.infer<typeof planRecord>

/** Status of one board item; the same closed set the mesh projects from a native store. */
export const todoStatus = z.enum(['pending', 'in_progress', 'completed', 'blocked', 'cancelled'])

/** One item on the shared todo board. */
export const collaborationTodo = z.object({
  id: z.string(),
  content: z.string(),
  status: todoStatus,
  /** Owning agent id, or `shared` for an item the board itself owns. */
  owner: z.string(),
  blockedBy: z.array(z.string()).readonly(),
  updatedAt: z.string(),
  /** The item's key in the agent's own store, for an item folded in by observation. */
  nativeKey: z.string().optional(),
  /** Session the item was observed in. */
  observedIn: z.string().optional(),
})

/** One board item, inferred from {@link collaborationTodo}. */
export type CollaborationTodo = z.infer<typeof collaborationTodo>

/** The shared todo board; `revision` is monotonic and guards stale writes. */
export const todoBoardRecord = z.object({
  collaborationId,
  todos: z.array(collaborationTodo).readonly(),
  updatedAt: z.string(),
  revision: z.number(),
})

/** One todo board, inferred from {@link todoBoardRecord}. */
export type TodoBoardRecord = z.infer<typeof todoBoardRecord>

/** How a task's working directory is isolated. */
export const isolationMode = z.enum(['worktree', 'shared-cwd'])

/** Lifecycle state of one task. */
export const taskStatus = z.enum(['queued', 'blocked', 'running', 'succeeded', 'failed', 'cancelled'])

/** One unit of delegated work inside a collaboration. */
export const collaborationTaskRecord = z.object({
  /** Task id; the same value as the record key, carried so a returned record identifies itself. */
  id: collaborationTaskId,
  collaborationId,
  title: z.string(),
  /** The instruction handed to the agent, before the shared context block. */
  instruction: z.string(),
  /** Agent the task is assigned to. */
  assignee: z.string(),
  isolation: isolationMode,
  status: taskStatus,
  /** Tasks that must succeed before this one may be dispatched. */
  dependsOn: z.array(z.string()).readonly(),
  /** Run dispatched for this task, once any. */
  runId: z.string().optional(),
  /** Worktree the task runs in, when it is isolated. */
  worktreeId: z.string().optional(),
  /** Why the task is blocked or failed. */
  note: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One task, inferred from {@link collaborationTaskRecord}. */
export type CollaborationTaskRecord = z.infer<typeof collaborationTaskRecord>

/** One collaboration: identity and the repository its tasks work in. */
export const collaborationRecord = z.object({
  title: z.string(),
  repoRoot: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One collaboration record, inferred from {@link collaborationRecord}. */
export type CollaborationRecord = z.infer<typeof collaborationRecord>

/** Kind of change git reported for one path. */
export const fileChangeStatus = z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'conflicted'])

/** Kind of change git reported for one path, inferred from {@link fileChangeStatus}. */
export type FileChangeStatus = z.infer<typeof fileChangeStatus>

/** One changed path in a worktree sample. */
export const fileChangeStat = z.object({
  path: z.string(),
  status: fileChangeStatus,
})

/** One changed path, inferred from {@link fileChangeStat}. */
export type FileChangeStat = z.infer<typeof fileChangeStat>

/** One live progress sample of a worktree. */
export const worktreeProgress = z.object({
  /** ISO-8601 time of the sample. */
  at: z.string(),
  /** Commit the worktree's HEAD resolved to. */
  head: z.string(),
  /** Branch checked out in the worktree. */
  branch: z.string(),
  /** Commits between the recorded base commit and HEAD. */
  ahead: z.number(),
  /** Changed paths, sorted by path. */
  files: z.array(fileChangeStat).readonly(),
  /** Whether the working tree has uncommitted changes. */
  dirty: z.boolean(),
  /** Declared gaps, e.g. a git probe that failed. */
  notes: z.array(z.string()).readonly(),
})

/** One worktree sample, inferred from {@link worktreeProgress}. */
export type WorktreeProgress = z.infer<typeof worktreeProgress>

/** Lifecycle state of a mesh-owned worktree. */
export const worktreeState = z.enum(['idle', 'active', 'merged', 'removed'])

/** One mesh-owned git worktree. */
export const worktreeRecord = z.object({
  /** Worktree id; the same value as the record key, carried so a returned record identifies itself. */
  id: worktreeId,
  path: z.string(),
  repoRoot: z.string(),
  branch: z.string(),
  /** Commit the worktree was created from; later samples compare against it. */
  baseCommit: z.string(),
  /** Ref the base commit belongs to, or `HEAD` when the caller named none. */
  baseRef: z.string(),
  /** Agent the worktree is reserved for. */
  agentId: z.string(),
  collaborationId: z.string().optional(),
  taskId: z.string().optional(),
  /** Run currently executing here, when one is. */
  runId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: worktreeState,
  /** Whether a later task for the same agent may reuse this worktree. */
  reusable: z.boolean(),
})

/** One worktree, inferred from {@link worktreeRecord}. */
export type WorktreeRecord = z.infer<typeof worktreeRecord>

/**
 * The collaboration domain: five tables, all keyed by their own identity.
 * `collaborations`, `plans` and `todos` are keyed by collaboration id because a
 * collaboration owns exactly one plan and exactly one board; tasks and worktrees
 * are keyed by their own id so a write never rewrites a sibling.
 */
export const collaborationDomainSpec = defineDomain({
  name: 'agent_mesh_collab',
  version: 1,
  tables: {
    collaborations: domainTable<CollaborationId, CollaborationRecord>(collaborationRecord),
    plans: domainTable<CollaborationId, PlanRecord>(planRecord),
    todos: domainTable<CollaborationId, TodoBoardRecord>(todoBoardRecord),
    tasks: domainTable<CollaborationTaskId, CollaborationTaskRecord>(collaborationTaskRecord),
    worktrees: domainTable<WorktreeId, WorktreeRecord>(worktreeRecord),
  },
})
