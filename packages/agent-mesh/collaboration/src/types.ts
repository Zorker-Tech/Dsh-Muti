/**
 * The collaboration vocabulary: what a caller asks for and what it gets back, on
 * top of the durable record types the domain owns, plus the wire types a Client
 * receives over `remote.meshCollaboration` and sends back.
 *
 * The module carries no durable record of its own; it exists so the service, the
 * model-facing tools, and the Remote controller share one set of request and result
 * types instead of three local ones.
 *
 * Every wire type is plain JSON. Ids are plain strings (the branded ids the domain
 * uses have no runtime representation, so nothing is lost on the wire), closed sets
 * travel as strings, and an absent optional field is absent rather than null.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/types
 */

import { z } from 'zod'
import type {
  AgentAdapter,
  AgentId,
  AgentRunRequest,
  AgentNativeTasks,
  AgentNativeTasksRequest,
  AgentSessionListOptions,
  MeshRunHandle,
  MeshRunSnapshot,
} from '@deepseek-ai/dsh-agent-mesh/types'
import type {
  CollaborationId,
  CollaborationRecord,
  CollaborationTaskRecord,
  PlanPhase,
  PlanRecord,
  TodoBoardRecord,
  WorktreeProgress,
  WorktreeRecord,
} from './domain.ts'
import { isolationMode, planMode, planPhaseStatus, taskStatus, todoStatus, worktreeState } from './domain.ts'

/** Whether the plan is injected into a dispatched run's prompt or only observed. */
export type PlanMode = z.infer<typeof planMode>

/** Where one plan phase stands. */
export type PlanPhaseStatus = z.infer<typeof planPhaseStatus>

/** How a task's working directory is isolated. */
export type IsolationMode = z.infer<typeof isolationMode>

/** Lifecycle state of one task. */
export type TaskStatus = z.infer<typeof taskStatus>

/** Status of one board item. */
export type TodoStatus = z.infer<typeof todoStatus>

/** Lifecycle state of a mesh-owned worktree. */
export type WorktreeState = z.infer<typeof worktreeState>

/** One worktree record together with the live progress sample taken for it. */
export interface WorktreeView extends WorktreeRecord {
  /** The sample this view was built with; absent when the worktree was never sampled. */
  readonly progress?: WorktreeProgress
}

export type {
  CollaborationId,
  CollaborationRecord,
  CollaborationTaskRecord,
  FileChangeStatus,
  PlanPhase,
  PlanRecord,
  TodoBoardRecord,
  WorktreeProgress,
  WorktreeRecord,
} from './domain.ts'

/** One task as a caller seeds it when starting a collaboration. */
export interface TaskSeed {
  /** One-line description of the deliverable. */
  readonly title: string
  /** Full instruction handed to the agent. */
  readonly instruction: string
  /** Agent the task is assigned to. */
  readonly assignee: string
  /** Task ids that must succeed first. */
  readonly dependsOn?: readonly string[]
  /** Isolation for this task; a collaboration's default applies when absent. */
  readonly isolation?: IsolationMode
}

/** Request to create one collaboration. */
export interface StartCollaborationRequest {
  /** Human title. */
  readonly title: string
  /** What the collaboration as a whole must achieve. */
  readonly objective: string
  /** Repository the tasks work in. */
  readonly repoRoot: string
  /** Initial tasks, queued or blocked by their declared dependencies. */
  readonly tasks?: readonly TaskSeed[]
}

/** One collaboration with its plan, board, tasks and worktrees. */
export interface CollaborationView {
  /** Collaboration identity. */
  readonly id: CollaborationId
  /** Identity and repository. */
  readonly record: CollaborationRecord
  /** The one authoritative plan. */
  readonly plan: PlanRecord
  /** The one shared todo board. */
  readonly board: TodoBoardRecord
  /** Every task, in creation order. */
  readonly tasks: readonly CollaborationTaskRecord[]
  /** Every worktree recorded for this collaboration. */
  readonly worktrees: readonly WorktreeRecord[]
}

/** Request to replace the plan's fields; an absent field keeps its current value. */
export interface PlanPatch {
  /** New objective. */
  readonly objective?: string
  /** Complete new phase list. */
  readonly phases?: readonly PlanPhase[]
  /** Phase to mark active; the phase must exist in the resulting list. */
  readonly activePhaseId?: string
  /** Complete new decisions log. */
  readonly decisions?: readonly string[]
  /** Whether the plan is injected into dispatched prompts. */
  readonly mode?: PlanMode
}

/** One board item as a caller supplies it. */
export interface TodoInput {
  /** Stable item id. */
  readonly id: string
  /** Item text. */
  readonly content: string
  /** Item status. */
  readonly status: TodoStatus
  /** Owning agent id, or `shared`; defaults to `shared`. */
  readonly owner?: string
  /** Ids of items blocking this one. */
  readonly blockedBy?: readonly string[]
  /** The item's key in a native store, for an observed item. */
  readonly nativeKey?: string
  /** Session the item was observed in. */
  readonly observedIn?: string
}

/** Options for a board write; a mismatch refuses the write instead of clobbering. */
export interface SetTodosOptions {
  /** Revision the caller read; a different current revision refuses the write. */
  readonly expectedRevision?: number
}

/** Result of folding an agent's native task state into the board. */
export interface ObserveOutcome {
  /** The board after the fold; unchanged when nothing was added or updated. */
  readonly board: TodoBoardRecord
  /** Number of items added or updated by this fold. */
  readonly observed: number
  /** What could not be observed, stated for the reader. */
  readonly notes: readonly string[]
}

/** The exact context a dispatched run for one agent would receive. */
export interface ContextPreview {
  /** Collaboration the context was rendered for. */
  readonly collaborationId: string
  /** Agent the context was rendered for. */
  readonly agentId: string
  /** The rendered text, byte-identical to what dispatch would prepend. */
  readonly text: string
  /** Deterministic content hash of `text`. */
  readonly hash: string
}

/** Request to create or reuse one worktree. */
export interface CreateWorktreeRequest {
  /** Agent the worktree is reserved for. */
  readonly agentId: string
  /** Any directory inside the repository. */
  readonly repoRoot: string
  /** Commit-ish to branch from; the repository's current HEAD when absent. */
  readonly baseRef?: string
  /** Label used in the branch name and the worktree path. */
  readonly label?: string
  /** Collaboration the worktree serves. */
  readonly collaborationId?: string
  /** Task the worktree serves. */
  readonly taskId?: string
  /** Reuse a clean, idle worktree already reserved for this agent and repository. */
  readonly reuse?: boolean
}

/** Options for removing a worktree. */
export interface RemoveWorktreeOptions {
  /** Discard uncommitted and unmerged work; refused by default because it is unrecoverable. */
  readonly force?: boolean
}

/** How a worktree conflict was detected. */
export type ConflictKind = 'same-file' | 'same-hunk' | 'feature-boundary' | 'base-drift'

/** Severity assigned to an advisory worktree conflict finding. */
export type ConflictSeverity = 'info' | 'warning' | 'blocking'

/** Whether overlapping line edits are reported as warnings or blocking findings. */
export type ConflictPolicy = 'report' | 'block'

/** One detected conflict between two worktrees. */
export interface ConflictFinding {
  /** How the conflict was detected. */
  readonly kind: ConflictKind
  /** How serious it is under the configured conflict policy. */
  readonly severity: ConflictSeverity
  /** First worktree. */
  readonly left: string
  /** Second worktree. */
  readonly right: string
  /** Paths both worktrees changed. */
  readonly paths: readonly string[]
  /** Human explanation. */
  readonly detail: string
}

/** A whole-repository conflict report over the live worktrees of one repository. */
export interface ConflictReport {
  /** Canonical repository root the report covers. */
  readonly repoRoot: string
  /** ISO-8601 time of the report. */
  readonly at: string
  /** Worktrees considered, in report order. */
  readonly worktrees: readonly string[]
  /** Findings, most severe first. */
  readonly findings: readonly ConflictFinding[]
  /** Proposed integration order, present when there are findings. */
  readonly suggestedOrder?: readonly string[]
  /** Declared gaps and boundaries of this analysis. */
  readonly notes: readonly string[]
}

/** Options for dispatching one task. */
export interface DispatchOptions {
  /** Commit-ish a freshly created worktree branches from. */
  readonly baseRef?: string
  /** Wall-clock budget handed to the agent. */
  readonly timeoutMs?: number
}

/** What one dispatch produced. */
export interface TaskDispatchResult {
  /** The task after dispatch, with its run id, worktree and `running` status. */
  readonly task: CollaborationTaskRecord
  /** The dispatched run. */
  readonly runId: string
  /** Working directory the agent runs in. */
  readonly cwd: string
  /** The context block prepended to the instruction, when the plan is injected. */
  readonly context: ContextPreview | undefined
}

/**
 * The part of `ctx.agentMesh` this package consumes. Stating it as a narrow port
 * keeps the collaboration service unit-testable with a fake mesh while the real
 * service remains structurally checked against it at the assignment site.
 */
export interface CollaborationMeshPort {
  /**
   * Dispatch one run on a registered agent.
   * @param agentId - Agent to run.
   * @param request - Prompt, working directory, and transport options.
   * @returns the run's identity and its terminal result.
   */
  startRun(agentId: AgentId | string, request: AgentRunRequest): MeshRunHandle

  /**
   * Wait for one run to settle.
   * @param runId - Run identity.
   * @returns the terminal snapshot, or undefined when the run is unknown or evicted.
   */
  waitForRun(runId: string): Promise<MeshRunSnapshot | undefined>

  /**
   * Resolve one registered adapter.
   * @param id - Agent identity.
   * @returns the adapter, narrowed to the two reads collaboration needs.
   */
  adapter(id: AgentId | string): Pick<AgentAdapter, 'listSessions' | 'readNativeTasks'>
}

/** The native-task read of one agent, as observation consumes it. */
export interface NativeTaskRead {
  /** Agent the state was read from. */
  readonly agentId: string
  /** The agent's own todo and plan state. */
  readonly tasks: AgentNativeTasks
  /** Session the state was read from, when a session was named or resolved. */
  readonly sessionKey?: string
}

/** Re-exported mesh request types, so a caller needs one import for observation. */
export type { AgentNativeTasksRequest, AgentSessionListOptions }

/** One collaboration, as a Client renders it in a list. */
export interface MeshCollaborationRow {
  /** Collaboration id. */
  readonly id: string
  /** Human title. */
  readonly title: string
  /** Repository the tasks work in. */
  readonly repoRoot: string
  /** ISO-8601 creation time. */
  readonly createdAt: string
  /** ISO-8601 time of the last change. */
  readonly updatedAt: string
  /** What the collaboration must achieve. */
  readonly objective: string
  /** `inject` or `observe`. */
  readonly mode: string
  /** Phase currently active, or the empty string when none is. */
  readonly activePhaseId: string
  /** The plan phases, in order. */
  readonly phases: readonly MeshPlanPhaseRow[]
  /** Decisions already made. */
  readonly decisions: readonly string[]
  /** Board revision. */
  readonly todoRevision: number
  /** Number of board items. */
  readonly todoCount: number
  /** The tasks. */
  readonly tasks: readonly MeshTaskRow[]
  /** The worktrees recorded for this collaboration. */
  readonly worktrees: readonly MeshCollaborationWorktreeRow[]
}

/** One plan phase on the wire. */
export interface MeshPlanPhaseRow {
  /** Phase id. */
  readonly id: string
  /** Phase title. */
  readonly title: string
  /** `todo`, `active`, or `done`. */
  readonly status: string
  /** What must be true for the phase to be done; the empty string when the author said nothing. */
  readonly exitCriteria: string
}

/** One task on the wire. */
export interface MeshTaskRow {
  /** Task id. */
  readonly id: string
  /** Collaboration the task belongs to. */
  readonly collaborationId: string
  /** One-line description of the deliverable. */
  readonly title: string
  /** The instruction handed to the agent before the shared context block. */
  readonly instruction: string
  /** Agent the task is assigned to. */
  readonly assignee: string
  /** Task lifecycle state. */
  readonly status: string
  /** `worktree` or `shared-cwd`. */
  readonly isolation: string
  /** Task ids that must succeed first. */
  readonly dependsOn: readonly string[]
  /** Run id, when the task was dispatched. */
  readonly runId: string
  /** Worktree the task runs in, when it is isolated. */
  readonly worktreeId: string
  /** Why the task is blocked or failed. */
  readonly note: string
  /** ISO-8601 creation time. */
  readonly createdAt: string
  /** ISO-8601 last state change. */
  readonly updatedAt: string
}

/** One worktree as it appears inside a collaboration row. */
export interface MeshCollaborationWorktreeRow {
  /** Worktree id. */
  readonly id: string
  /** Absolute path of the worktree. */
  readonly path: string
  /** Branch checked out in the worktree. */
  readonly branch: string
  /** Worktree lifecycle state. */
  readonly state: string
  /** Run executing here, or the empty string. */
  readonly runId: string
  /** Task the worktree serves, or the empty string. */
  readonly taskId: string
}

/** One worktree with its live progress sample. */
export interface MeshWorktreeRow {
  /** Worktree id. */
  readonly id: string
  /** Absolute path of the worktree. */
  readonly path: string
  /** Absolute path of the repository the worktree belongs to. */
  readonly repoRoot: string
  /** Branch checked out in the worktree. */
  readonly branch: string
  /** Commit the worktree was created from. */
  readonly baseCommit: string
  /** Ref the base commit belongs to. */
  readonly baseRef: string
  /** Agent the worktree is reserved for. */
  readonly agentId: string
  /** Worktree lifecycle state. */
  readonly state: string
  /** Whether a later task for the same agent may reuse it. */
  readonly reusable: boolean
  /** Collaboration the worktree serves, or the empty string. */
  readonly collaborationId: string
  /** Task the worktree serves, or the empty string. */
  readonly taskId: string
  /** Run executing here, or the empty string. */
  readonly runId: string
  /** Number of changed paths in the latest sample. */
  readonly changedFiles: number
  /** Whether the working tree has uncommitted changes. */
  readonly dirty: boolean
  /** Commits between the base commit and HEAD. */
  readonly ahead: number
  /** Changed paths in the latest sample. */
  readonly files: readonly MeshFileChangeRow[]
  /** Declared gaps in the latest sample. */
  readonly notes: readonly string[]
  /** ISO-8601 time of the latest sample, or the empty string when none was taken. */
  readonly sampledAt: string
}

/** One changed path of a worktree sample. */
export interface MeshFileChangeRow {
  /** Repository-relative path. */
  readonly path: string
  /** `added`, `modified`, `deleted`, `renamed`, `untracked`, or `conflicted`. */
  readonly status: string
}

/** One todo item on the wire. */
export interface MeshTodoRow {
  /** Item id. */
  readonly id: string
  /** Item text. */
  readonly content: string
  /** Item status. */
  readonly status: string
  /** Owning agent id, or `shared`. */
  readonly owner: string
  /** Ids of items blocking this one. */
  readonly blockedBy: readonly string[]
  /** ISO-8601 last change. */
  readonly updatedAt: string
  /** The item's key in an agent's native store, or the empty string. */
  readonly nativeKey: string
  /** Session the item was observed in, or the empty string. */
  readonly observedIn: string
}

/** The shared todo board on the wire. */
export interface MeshTodoBoardRow {
  /** Collaboration the board belongs to. */
  readonly collaborationId: string
  /** Monotonic revision every write is guarded against. */
  readonly revision: number
  /** ISO-8601 last change. */
  readonly updatedAt: string
  /** Every item. */
  readonly todos: readonly MeshTodoRow[]
}

/** One detected conflict between two worktrees. */
export interface MeshConflictFindingRow {
  /** How the finding was detected. */
  readonly kind: ConflictKind
  /** Severity under the configured conflict policy. */
  readonly severity: ConflictSeverity
  /** First worktree. */
  readonly left: string
  /** Second worktree. */
  readonly right: string
  /** Paths both worktrees changed. */
  readonly paths: readonly string[]
  /** Human explanation. */
  readonly detail: string
}

/** A whole-repository conflict report. */
export interface MeshConflictReportRow {
  /** Canonical repository root the report covers. */
  readonly repoRoot: string
  /** ISO-8601 time of the report. */
  readonly at: string
  /** Worktrees considered. */
  readonly worktrees: readonly string[]
  /** Findings, most severe first. */
  readonly findings: readonly MeshConflictFindingRow[]
  /** Proposed integration order, empty when there is nothing to order. */
  readonly suggestedOrder: readonly string[]
  /** Declared gaps and limits of the analysis. */
  readonly notes: readonly string[]
}

/** The context a dispatched run for one agent would receive. */
export interface MeshContextPreviewRow {
  /** Whether a context block exists for that agent. */
  readonly available: boolean
  /** The rendered block; the empty string when none exists. */
  readonly text: string
  /** Content hash of the block; the empty string when none exists. */
  readonly hash: string
}

/** Request to create one collaboration. */
export interface MeshCollaborationStartRequest {
  /** Human title. */
  readonly title: string
  /** What the collaboration must achieve. */
  readonly objective: string
  /** Repository the tasks work in. */
  readonly repoRoot: string
  /** Initial tasks; omitted for none. */
  readonly tasks?: readonly MeshTaskSeedRow[]
}

/** One task as a caller seeds it when starting a collaboration. */
export interface MeshTaskSeedRow {
  /** One-line description of the deliverable. */
  readonly title: string
  /** Full instruction handed to the agent. */
  readonly instruction: string
  /** Agent the task is assigned to. */
  readonly assignee: string
  /** Task ids or sibling positions that must succeed first. */
  readonly dependsOn?: readonly string[]
  /** `worktree` or `shared-cwd`. */
  readonly isolation?: string
}

/** Request to replace a collaboration's plan fields. */
export interface MeshPlanSetRequest {
  /** Collaboration to change. */
  readonly collaborationId: string
  /** The objective; it replaces the current one. */
  readonly objective: string
  /** The complete new phase list; omitted to keep the current one. */
  readonly phases?: readonly MeshPlanPhaseRow[]
  /** Phase to mark active; must exist in the resulting list. */
  readonly activePhaseId?: string
  /** The complete decisions log; omitted to keep the current one. */
  readonly decisions?: readonly string[]
  /** `inject` or `observe`; omitted to keep the current one. */
  readonly mode?: string
}

/** Request to activate one plan phase. */
export interface MeshPlanAdvanceRequest {
  /** Collaboration to change. */
  readonly collaborationId: string
  /** Phase to activate. */
  readonly phaseId: string
}

/** Request to read one collaboration's plan or board. */
export interface MeshCollaborationRequest {
  /** Collaboration to read. */
  readonly collaborationId: string
}

/** Request to replace a collaboration's todo board. */
export interface MeshTodosSetRequest {
  /** Collaboration whose board is replaced. */
  readonly collaborationId: string
  /** The complete new board. */
  readonly todos: readonly MeshTodoInputRow[]
  /** Revision the caller read; the write is refused when the board moved on. */
  readonly expectedRevision?: number
}

/** One board item as a caller supplies it. */
export interface MeshTodoInputRow {
  /** Stable item id. */
  readonly id: string
  /** Item text. */
  readonly content: string
  /** Item status. */
  readonly status: string
  /** Owning agent id, or `shared`; defaults to `shared`. */
  readonly owner?: string
  /** Ids of items blocking this one. */
  readonly blockedBy?: readonly string[]
}

/** Request to fold one agent's native task state into the board. */
export interface MeshTodosObserveRequest {
  /** Collaboration whose board is folded into. */
  readonly collaborationId: string
  /** Agent whose own store is read. */
  readonly agentId: string
  /** The agent's native session id; its newest session when omitted. */
  readonly sessionId?: string
}

/** Result of folding one agent's native task state into the board. */
export interface MeshTodosObserveResponse {
  /** Number of items added or updated. */
  readonly observed: number
  /** The board after the fold. */
  readonly board: MeshTodoBoardRow
  /** What could not be observed. */
  readonly notes: readonly string[]
}

/** Request to dispatch one task. */
export interface MeshTaskDispatchRequest {
  /** Collaboration owning the task. */
  readonly collaborationId: string
  /** Task to dispatch. */
  readonly taskId: string
  /** Commit-ish a newly created worktree branches from. */
  readonly baseRef?: string
  /** Wall-clock budget handed to the agent. */
  readonly timeoutMs?: number
}

/** What one dispatch produced. */
export interface MeshTaskDispatchResponse {
  /** The dispatched run. */
  readonly runId: string
  /** Task id. */
  readonly taskId: string
  /** Working directory the agent runs in. */
  readonly cwd: string
  /** Task status after dispatch. */
  readonly status: string
  /** Content hash of the injected context, or the empty string when none was injected. */
  readonly contextHash: string
}

/** Request to list worktrees, optionally of one repository. */
export interface MeshWorktreeListRequest {
  /** Repository to restrict to; omitted for every recorded worktree. */
  readonly repoRoot?: string
}

/** Request to create or reuse one worktree. */
export interface MeshWorktreeCreateRequest {
  /** Agent the worktree is reserved for. */
  readonly agentId: string
  /** Absolute path inside the repository. */
  readonly repoRoot: string
  /** Commit-ish to branch from; the repository HEAD when omitted. */
  readonly baseRef?: string
  /** Label used in the branch name and the worktree directory. */
  readonly label?: string
  /** Collaboration the worktree serves. */
  readonly collaborationId?: string
  /** Reuse a clean idle worktree reserved for the same agent. */
  readonly reuse?: boolean
}

/** Request to analyse one repository's live worktrees. */
export interface MeshWorktreeConflictsRequest {
  /** Repository to analyse. */
  readonly repoRoot: string
}

/** Request to remove one worktree. */
export interface MeshWorktreeRemoveRequest {
  /** Worktree to remove. */
  readonly worktreeId: string
  /** Discard uncommitted and unmerged work; refused by default. */
  readonly force?: boolean
}

/** Result of removing one worktree. */
export interface MeshWorktreeRemoveResponse {
  /** The removed worktree. */
  readonly worktreeId: string
  /** The record's state after removal. */
  readonly state: string
  /** Whether the work in it was discarded. */
  readonly forced: boolean
}

/** Request to mark one worktree integrated, or outstanding again. */
export interface MeshWorktreeIntegratedRequest {
  /** Worktree to mark. */
  readonly worktreeId: string
  /** `false` marks it outstanding again; omitted means true. */
  readonly merged?: boolean
}

/** Request for the context a dispatched run for one agent would receive. */
export interface MeshContextPreviewRequest {
  /** Collaboration to render for. */
  readonly collaborationId: string
  /** Agent the context is rendered for. */
  readonly agentId: string
}
