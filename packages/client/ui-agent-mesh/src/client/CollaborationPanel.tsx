/** The collaboration, shared plan and board, worktrees, and advisory conflicts. */

import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MeshCollaborationRow,
  MeshConflictFindingRow,
  MeshConflictReportRow,
  MeshPlanPhaseRow,
  MeshTaskRow,
  MeshTodoBoardRow,
  MeshTodoRow,
  MeshWorktreeRow,
} from '@deepseek-ai/dsh-agent-mesh-collaboration/types'
import type { AgentMeshKey } from './locales.ts'
import type { MeshCollaborationSnapshot } from './collaboration-store.ts'
import type { MeshListState, MeshReadStatus, MeshValueState } from './mesh-store.ts'
import css from './CollaborationPanel.module.css'

type Translate = TranslateNS<'agentMesh'>

/** Localize a task lifecycle state. */
function taskStatusKey(status: string): AgentMeshKey {
  switch (status) {
    case 'queued': return 'collaboration.taskStatus.queued'
    case 'blocked': return 'collaboration.taskStatus.blocked'
    case 'running': return 'collaboration.taskStatus.running'
    case 'succeeded': return 'collaboration.taskStatus.succeeded'
    case 'failed': return 'collaboration.taskStatus.failed'
    case 'cancelled': return 'collaboration.taskStatus.cancelled'
    default: return 'collaboration.status.unknown'
  }
}

/** Localize a task's working-directory isolation mode. */
function isolationKey(mode: string): AgentMeshKey {
  switch (mode) {
    case 'worktree': return 'collaboration.isolation.worktree'
    case 'shared-cwd': return 'collaboration.isolation.sharedCwd'
    default: return 'collaboration.status.unknown'
  }
}

/** Localize a collaboration plan mode. */
function planModeKey(mode: string): AgentMeshKey {
  switch (mode) {
    case 'inject': return 'collaboration.mode.inject'
    case 'observe': return 'collaboration.mode.observe'
    default: return 'collaboration.status.unknown'
  }
}

/** Localize one shared todo status. */
function todoStatusKey(status: string): AgentMeshKey {
  switch (status) {
    case 'pending': return 'collaboration.todo.pending'
    case 'in_progress': return 'collaboration.todo.inProgress'
    case 'completed': return 'collaboration.todo.completed'
    case 'blocked': return 'collaboration.todo.blocked'
    case 'cancelled': return 'collaboration.todo.cancelled'
    default: return 'collaboration.status.unknown'
  }
}

/** Localize one worktree lifecycle state. */
function worktreeStateKey(state: string): AgentMeshKey {
  switch (state) {
    case 'idle': return 'collaboration.worktreeState.idle'
    case 'active': return 'collaboration.worktreeState.active'
    case 'merged': return 'collaboration.worktreeState.merged'
    case 'removed': return 'collaboration.worktreeState.removed'
    default: return 'collaboration.status.unknown'
  }
}

/** Localize one changed-file state. */
function fileChangeStatusKey(status: string): AgentMeshKey {
  switch (status) {
    case 'added': return 'collaboration.fileStatus.added'
    case 'modified': return 'collaboration.fileStatus.modified'
    case 'deleted': return 'collaboration.fileStatus.deleted'
    case 'renamed': return 'collaboration.fileStatus.renamed'
    case 'untracked': return 'collaboration.fileStatus.untracked'
    case 'conflicted': return 'collaboration.fileStatus.conflicted'
    default: return 'collaboration.status.unknown'
  }
}

/** Localize one conflict-detection method. */
function conflictKindKey(kind: string): AgentMeshKey {
  switch (kind) {
    case 'same-file': return 'collaboration.conflictKind.sameFile'
    case 'same-hunk': return 'collaboration.conflictKind.sameHunk'
    case 'feature-boundary': return 'collaboration.conflictKind.featureBoundary'
    case 'base-drift': return 'collaboration.conflictKind.baseDrift'
    default: return 'collaboration.status.unknown'
  }
}

/** Props received from the panel's Remote-backed collaboration source. */
export interface CollaborationPanelProps {
  /** Select one snapshot from the shared collaboration source. */
  readonly useCollaboration: SnapshotSelectorHook<MeshCollaborationSnapshot>
  /** Re-read collaborations, the selected board and its worktrees. */
  readonly refreshAll: () => Promise<void>
  /** Select a collaboration. */
  readonly select: (collaborationId: string) => void
  /** Re-read one collaboration's board. */
  readonly refreshBoard: (collaborationId: string) => Promise<void>
  /** Re-read one repository's worktrees. */
  readonly refreshWorktrees: (repoRoot: string) => Promise<void>
  /** Recompute one repository's conflict report. */
  readonly refreshConflicts: (repoRoot: string) => Promise<void>
  /** Mark one worktree integrated and refresh the visible records. */
  readonly markIntegrated: (worktreeId: string) => Promise<void>
  /** Current mutation failure, if any. */
  readonly actionError: string | null
  /** Publish a mutation failure for the visible page. */
  readonly onActionError: (error: string | null) => void
  /** Translate this package's localized copy. */
  readonly t: Translate
}

/** Render one Remote read's loading and failure state. */
function ReadFeedback({ status, populated, error, onRetry, t }: {
  readonly status: MeshReadStatus
  readonly populated: boolean
  readonly error: string | null
  readonly onRetry: () => void
  readonly t: Translate
}) {
  if (status === 'error' && error !== null) {
    return (
      <p className={css.error} role="alert">
        <span>{error}</span>
        <Button size="sm" onClick={onRetry}>{t('retry')}</Button>
      </p>
    )
  }
  if (status === 'loading' && !populated) return <p className={css.muted} role="status">{t('loading')}</p>
  return null
}

/** Render one shared plan phase. */
function PhaseRow({ phase, t }: { readonly phase: MeshPlanPhaseRow; readonly t: Translate }) {
  const label = phase.status === 'active'
    ? t('collaboration.phase.active')
    : phase.status === 'done'
      ? t('collaboration.phase.done')
      : phase.status === 'todo'
        ? t('collaboration.phase.todo')
        : t('collaboration.status.unknown')
  return (
    <li className={css.phase}>
      <Pill>{label}</Pill>
      <span className={css.primary}>{phase.title}</span>
      {phase.exitCriteria !== '' && <span className={css.muted}>{phase.exitCriteria}</span>}
    </li>
  )
}

/** Render one collaboration task and its latest run/worktree references. */
function TaskRow({ task, t }: { readonly task: MeshTaskRow; readonly t: Translate }) {
  return (
    <li className={css.cardRow}>
      <div className={css.rowHeading}>
        <strong className={css.primary}>{task.title}</strong>
        <Pill>{t(taskStatusKey(task.status))}</Pill>
      </div>
      <p className={css.taskInstruction}>{task.instruction}</p>
      <div className={css.meta}>
        <span>{t('collaboration.assignee', { agent: task.assignee })}</span>
        <span>{t(isolationKey(task.isolation))}</span>
        {task.runId !== '' && <span>{t('collaboration.run', { id: task.runId })}</span>}
        {task.worktreeId !== '' && <span>{t('collaboration.worktree', { id: task.worktreeId })}</span>}
      </div>
      {task.dependsOn.length > 0 && <p className={css.muted}>{t('collaboration.dependsOn', { ids: task.dependsOn.join(', ') })}</p>}
      {task.note !== '' && <p className={css.note}>{task.note}</p>}
    </li>
  )
}

/** Render one revisioned shared todo. */
function TodoRow({ todo, t }: { readonly todo: MeshTodoRow; readonly t: Translate }) {
  const label = t(todoStatusKey(todo.status))
  return (
    <li className={css.cardRow}>
      <div className={css.rowHeading}>
        <span className={css.primary}>{todo.content}</span>
        <Pill>{label}</Pill>
      </div>
      <div className={css.meta}>
        <span>{t('collaboration.owner', { owner: todo.owner })}</span>
        {todo.blockedBy.length > 0 && <span>{t('collaboration.dependsOn', { ids: todo.blockedBy.join(', ') })}</span>}
      </div>
    </li>
  )
}

/** Render one live worktree and the latest progress sample. */
function WorktreeRow({ worktree, pending, onIntegrated, t }: {
  readonly worktree: MeshWorktreeRow
  readonly pending: boolean
  readonly onIntegrated: () => void
  readonly t: Translate
}) {
  const isIntegrated = worktree.state === 'merged' || worktree.state === 'removed'
  return (
    <li className={css.cardRow}>
      <div className={css.rowHeading}>
        <strong className={css.primary}>{worktree.branch || worktree.id}</strong>
        <Pill>{t(worktreeStateKey(worktree.state))}</Pill>
      </div>
      <p className={css.path}>{worktree.path}</p>
      <div className={css.meta}>
        <span>{t('collaboration.assignee', { agent: worktree.agentId })}</span>
        <span>{t('collaboration.progress', { files: worktree.changedFiles, ahead: worktree.ahead })}</span>
        <span>{worktree.dirty ? t('collaboration.dirty') : t('collaboration.clean')}</span>
        {worktree.runId !== '' && <span>{t('collaboration.run', { id: worktree.runId })}</span>}
        {worktree.taskId !== '' && <span>{t('collaboration.task', { id: worktree.taskId })}</span>}
      </div>
      {worktree.files.length > 0 && <ul className={css.fileList}>
        {worktree.files.slice(0, 8).map(file => <li key={`${file.path}:${file.status}`}>
          <span className={css.fileStatus}>{t(fileChangeStatusKey(file.status))}</span>
          <span className={css.path}>{file.path}</span>
        </li>)}
        {worktree.files.length > 8 && <li className={css.muted}>{t('collaboration.moreFiles', { count: worktree.files.length - 8 })}</li>}
      </ul>}
      {worktree.notes.length > 0 && <ul className={css.notes}>
        {worktree.notes.map(note => <li key={note}>{note}</li>)}
      </ul>}
      {!isIntegrated && <Button size="sm" disabled={pending} onClick={onIntegrated}>
        {pending ? t('collaboration.pending') : t('collaboration.markIntegrated')}
      </Button>}
    </li>
  )
}

/** Render an advisory conflict finding. */
function FindingRow({ finding, t }: { readonly finding: MeshConflictFindingRow; readonly t: Translate }) {
  const severity = finding.severity === 'blocking'
    ? t('collaboration.severity.blocking')
    : finding.severity === 'warning'
      ? t('collaboration.severity.warning')
      : finding.severity === 'info'
        ? t('collaboration.severity.info')
        : t('collaboration.status.unknown')
  return (
    <li className={css.cardRow}>
      <div className={css.rowHeading}>
        <Pill>{severity}</Pill>
        <span className={css.muted}>{t(conflictKindKey(finding.kind))}</span>
      </div>
      <span className={css.primary}>{finding.detail}</span>
      <span className={css.meta}>{t('collaboration.conflictPair', { left: finding.left, right: finding.right })}</span>
      {finding.paths.length > 0 && <ul className={css.fileList}>
        {finding.paths.map(path => <li key={path}><span className={css.path}>{path}</span></li>)}
      </ul>}
    </li>
  )
}

/** Render the advisory conflict report returned for one repository. */
function ConflictSection({ state, onRetry, t }: {
  readonly state: MeshValueState<MeshConflictReportRow> | null
  readonly onRetry: () => void
  readonly t: Translate
}) {
  if (state === null) return null
  return (
    <section className={css.section} aria-label={t('collaboration.conflicts')}>
      <div className={css.sectionHead}>
        <h3>{t('collaboration.conflicts')}</h3>
        <Button size="sm" disabled={state.status === 'loading'} onClick={onRetry}>{t('refresh')}</Button>
      </div>
      <ReadFeedback status={state.status} populated={state.value !== null} error={state.error} onRetry={onRetry} t={t} />
      {state.value !== null && <>
        {state.value.findings.length === 0 && <p className={css.muted}>{t('collaboration.conflicts.empty')}</p>}
        {state.value.findings.length > 0 && <ul className={css.rows}>
          {state.value.findings.map((finding, index) => <FindingRow
            key={`${finding.kind}:${finding.left}:${finding.right}:${index}`}
            finding={finding}
            t={t}
          />)}
        </ul>}
        {state.value.suggestedOrder.length > 0 && <p className={css.muted}>
          {t('collaboration.suggestedOrder', { order: state.value.suggestedOrder.join(' → ') })}
        </p>}
        {state.value.notes.length > 0 && <ul className={css.notes}>
          {state.value.notes.map(note => <li key={note}>{note}</li>)}
        </ul>}
      </>}
    </section>
  )
}

function ListFeedback<Row>({ state, empty, onRetry, t }: {
  readonly state: MeshListState<Row> | null
  readonly empty: string
  readonly onRetry: () => void
  readonly t: Translate
}) {
  if (state === null) return <p className={css.muted}>{t('collaboration.select')}</p>
  return <>
    <ReadFeedback status={state.status} populated={state.rows.length > 0} error={state.error} onRetry={onRetry} t={t} />
    {state.status === 'ready' && state.rows.length === 0 && <p className={css.muted}>{empty}</p>}
  </>
}

function BoardFeedback({ state, onRetry, t }: {
  readonly state: MeshValueState<MeshTodoBoardRow> | null
  readonly onRetry: () => void
  readonly t: Translate
}) {
  if (state === null) return <p className={css.muted}>{t('collaboration.select')}</p>
  return <>
    <ReadFeedback status={state.status} populated={state.value !== null} error={state.error} onRetry={onRetry} t={t} />
    {state.value !== null && <>
      <p className={css.meta}>{t('collaboration.boardRevision', { revision: state.value.revision })}</p>
      {state.value.todos.length === 0
        ? <p className={css.muted}>{t('collaboration.todos.empty')}</p>
        : <ul className={css.rows}>{state.value.todos.map(todo => <TodoRow key={todo.id} todo={todo} t={t} />)}</ul>}
    </>}
  </>
}

function PlanSection({ collaboration, t }: { readonly collaboration: MeshCollaborationRow; readonly t: Translate }) {
  return (
    <section className={css.section} aria-label={t('collaboration.plan')}>
      <div className={css.sectionHead}><h3>{t('collaboration.plan')}</h3><Pill>{t(planModeKey(collaboration.mode))}</Pill></div>
      <dl className={css.summary}>
        <dt>{t('collaboration.objective')}</dt><dd>{collaboration.objective}</dd>
        <dt>{t('collaboration.repository')}</dt><dd className={css.path}>{collaboration.repoRoot}</dd>
        {collaboration.activePhaseId !== '' && <>
          <dt>{t('collaboration.activePhase')}</dt><dd>{collaboration.activePhaseId}</dd>
        </>}
      </dl>
      {collaboration.phases.length === 0
        ? <p className={css.muted}>{t('collaboration.phases.empty')}</p>
        : <ol className={css.rows}>{collaboration.phases.map(phase => <PhaseRow key={phase.id} phase={phase} t={t} />)}</ol>}
      {collaboration.decisions.length > 0 && <div>
        <h4 className={css.subheading}>{t('collaboration.decisions')}</h4>
        <ul className={css.notes}>{collaboration.decisions.map((decision, index) => <li key={`${index}:${decision}`}>{decision}</li>)}</ul>
      </div>}
    </section>
  )
}

function TasksSection({ tasks, t }: { readonly tasks: readonly MeshTaskRow[]; readonly t: Translate }) {
  return (
    <section className={css.section} aria-label={t('collaboration.tasks')}>
      <h3>{t('collaboration.tasks')}</h3>
      {tasks.length === 0
        ? <p className={css.muted}>{t('collaboration.tasks.empty')}</p>
        : <ul className={css.rows}>{tasks.map(task => <TaskRow key={task.id} task={task} t={t} />)}</ul>}
    </section>
  )
}

function WorktreesSection({ state, pending, onRetry, onIntegrated, t }: {
  readonly state: MeshListState<MeshWorktreeRow> | null
  readonly pending: readonly string[]
  readonly onRetry: () => void
  readonly onIntegrated: (worktreeId: string) => void
  readonly t: Translate
}) {
  return (
    <section className={css.section} aria-label={t('collaboration.worktrees')}>
      <div className={css.sectionHead}>
        <h3>{t('collaboration.worktrees')}</h3>
        {state !== null && <Button size="sm" disabled={state.status === 'loading'} onClick={onRetry}>{t('refresh')}</Button>}
      </div>
      <ListFeedback state={state} empty={t('collaboration.worktrees.empty')} onRetry={onRetry} t={t} />
      {state !== null && state.rows.length > 0 && <ul className={css.rows}>
        {state.rows.map(worktree => <WorktreeRow
          key={worktree.id}
          worktree={worktree}
          pending={pending.includes(`integrate:${worktree.id}`)}
          onIntegrated={() => { onIntegrated(worktree.id) }}
          t={t}
        />)}
      </ul>}
    </section>
  )
}

/** Render collaborations plus one plan, todo board, task list and repo view. */
export function CollaborationPanel(props: CollaborationPanelProps) {
  const {
    useCollaboration, refreshAll, select, refreshBoard, refreshWorktrees, refreshConflicts,
    markIntegrated, t,
  } = props
  const snapshot = useCollaboration(value => value)
  const selected = snapshot.collaborations.rows.find(row => row.id === snapshot.selectedId) ?? null
  const board = selected === null ? null : snapshot.boards[selected.id] ?? null
  const worktrees = selected === null ? null : snapshot.worktrees[selected.repoRoot] ?? null
  const conflicts = selected === null ? null : snapshot.conflicts[selected.repoRoot] ?? null
  const actionError = props.actionError

  return (
    <div className={css.page} data-testid="agent-mesh-collaboration">
      <header className={css.header}>
        <div>
          <h2>{t('collaboration.title')}</h2>
          <p className={css.muted}>{t('collaboration.intro')}</p>
        </div>
        <Button disabled={snapshot.collaborations.status === 'loading'} onClick={() => { void refreshAll() }}>{t('refresh')}</Button>
      </header>
      <section className={css.selector} aria-label={t('collaboration.selector')}>
        <label htmlFor="agent-mesh-collaboration-select">{t('collaboration.selector')}</label>
        <select
          id="agent-mesh-collaboration-select"
          value={snapshot.selectedId ?? ''}
          disabled={snapshot.collaborations.rows.length === 0}
          onChange={(event) => { select(event.currentTarget.value) }}
        >
          {snapshot.collaborations.rows.map(collaboration => <option key={collaboration.id} value={collaboration.id}>
            {collaboration.title}
          </option>)}
        </select>
      </section>
      <ReadFeedback
        status={snapshot.collaborations.status}
        populated={snapshot.collaborations.rows.length > 0}
        error={snapshot.collaborations.error}
        onRetry={() => { void refreshAll() }}
        t={t}
      />
      {snapshot.collaborations.status === 'ready' && selected === null && <p className={css.empty}>
        {t('collaboration.empty')}
      </p>}
      {actionError !== null && <p className={css.error} role="alert">{actionError}</p>}
      {selected !== null && <div className={css.grid}>
        <div className={css.column}>
          <PlanSection collaboration={selected} t={t} />
          <TasksSection tasks={selected.tasks} t={t} />
        </div>
        <div className={css.column}>
          <section className={css.section} aria-label={t('collaboration.sharedTodos')}>
            <div className={css.sectionHead}>
              <h3>{t('collaboration.sharedTodos')}</h3>
              {board !== null && <Button size="sm" disabled={board.status === 'loading'} onClick={() => { void refreshBoard(selected.id) }}>
                {t('refresh')}
              </Button>}
            </div>
            <BoardFeedback state={board} onRetry={() => { void refreshBoard(selected.id) }} t={t} />
          </section>
          <WorktreesSection
            state={worktrees}
            pending={snapshot.pending}
            onRetry={() => { void refreshWorktrees(selected.repoRoot) }}
            onIntegrated={(worktreeId) => {
              props.onActionError(null)
              void markIntegrated(worktreeId).catch((error: unknown) => {
                props.onActionError(error instanceof Error ? error.message : String(error))
              })
            }}
            t={t}
          />
          <div className={css.actions}>
            <Button
              size="sm"
              disabled={snapshot.conflicts[selected.repoRoot]?.status === 'loading'}
              onClick={() => { void refreshConflicts(selected.repoRoot) }}
            >
              {conflicts === null ? t('collaboration.checkConflicts') : t('collaboration.refreshConflicts')}
            </Button>
            <span className={css.muted}>{t('collaboration.conflictsAdvisory')}</span>
          </div>
          <ConflictSection
            state={conflicts}
            onRetry={() => { void refreshConflicts(selected.repoRoot) }}
            t={t}
          />
        </div>
      </div>}
    </div>
  )
}
