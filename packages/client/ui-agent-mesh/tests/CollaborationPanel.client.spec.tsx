// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MeshCollaborationRow,
  MeshConflictReportRow,
  MeshTodoBoardRow,
  MeshWorktreeRow,
} from '@deepseek-ai/dsh-agent-mesh-collaboration/types'
import type { MeshCollaborationSnapshot } from '../src/client/collaboration-store.ts'
import { CollaborationPanel } from '../src/client/CollaborationPanel.tsx'
import type { CollaborationPanelProps } from '../src/client/CollaborationPanel.tsx'

afterEach(cleanup)

const COLLABORATION: MeshCollaborationRow = {
  id: 'collab-1',
  title: 'Ship dashboard',
  repoRoot: '/repo',
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:01:00.000Z',
  objective: 'Ship the dashboard',
  mode: 'inject',
  activePhaseId: 'phase-build',
  phases: [
    { id: 'phase-plan', title: 'Plan', status: 'done', exitCriteria: '' },
    { id: 'phase-build', title: 'Build', status: 'active', exitCriteria: 'UI is ready' },
    { id: 'phase-review', title: 'Review', status: 'todo', exitCriteria: '' },
  ],
  decisions: ['Keep the API native'],
  todoRevision: 3,
  todoCount: 1,
  tasks: [
    {
      id: 'task-1', collaborationId: 'collab-1', title: 'Build UI', instruction: 'Render the shared state',
      assignee: 'codex', status: 'running', isolation: 'worktree', dependsOn: ['task-0'],
      runId: 'run-1', worktreeId: 'worktree-1', note: 'Keep the layout responsive',
      createdAt: '', updatedAt: '',
    },
  ],
  worktrees: [],
}

function worktree(id: string, state: string, fileStatuses: readonly string[] = []): MeshWorktreeRow {
  return {
    id, path: `/repo/.dsh-agent-mesh/worktrees/${id}`, repoRoot: '/repo', branch: `codex/${id}`,
    baseCommit: 'abcdef', baseRef: 'main', agentId: 'codex', state, reusable: false,
    collaborationId: 'collab-1', taskId: 'task-1', runId: 'run-1',
    changedFiles: fileStatuses.length, dirty: true, ahead: 2,
    files: fileStatuses.map((status, index) => ({ path: `src/file-${index}.ts`, status })),
    notes: ['Sample is incomplete'], sampledAt: '2026-10-17T00:02:00.000Z',
  }
}

const BOARD: MeshTodoBoardRow = {
  collaborationId: 'collab-1', revision: 3, updatedAt: '2026-10-17T00:03:00.000Z',
  todos: [
    { id: 'todo-1', content: 'Review the patch', status: 'blocked', owner: 'shared', blockedBy: ['todo-0'], updatedAt: '', nativeKey: '', observedIn: '' },
  ],
}

const CONFLICTS: MeshConflictReportRow = {
  repoRoot: '/repo', at: '2026-10-17T00:04:00.000Z', worktrees: ['worktree-1'],
  findings: [
    { kind: 'same-hunk', severity: 'blocking', left: 'worktree-1', right: 'worktree-2', paths: ['src/shared.ts'], detail: 'Both edits overlap.' },
    { kind: 'same-file', severity: 'warning', left: 'worktree-1', right: 'worktree-3', paths: [], detail: 'Both change one file.' },
    { kind: 'feature-boundary', severity: 'info', left: 'worktree-2', right: 'worktree-3', paths: ['src/ui/'], detail: 'Both change the UI area.' },
    { kind: 'base-drift', severity: 'info', left: 'worktree-1', right: 'worktree-4', paths: [], detail: 'The base commits differ.' },
  ],
  suggestedOrder: ['worktree-1', 'worktree-2'],
  notes: ['Line ranges are approximate.'],
}

/** Simulate enum values added by a newer remote service version. */
function futureConflictFinding(): MeshConflictReportRow['findings'][number] {
  const finding = { ...CONFLICTS.findings[0]!, paths: [] }
  Reflect.set(finding, 'kind', 'future')
  Reflect.set(finding, 'severity', 'future')
  return finding
}

function snapshot(overrides: Partial<MeshCollaborationSnapshot> = {}): MeshCollaborationSnapshot {
  return {
    collaborations: { status: 'ready', rows: [COLLABORATION], error: null },
    selectedId: COLLABORATION.id,
    boards: { [COLLABORATION.id]: { status: 'ready', value: BOARD, error: null } },
    worktrees: { [COLLABORATION.repoRoot]: { status: 'ready', rows: [worktree('worktree-1', 'active')], error: null } },
    conflicts: { [COLLABORATION.repoRoot]: { status: 'ready', value: CONFLICTS, error: null } },
    pending: [],
    ...overrides,
  }
}

function panelProps(state: MeshCollaborationSnapshot): CollaborationPanelProps {
  const useCollaboration: CollaborationPanelProps['useCollaboration'] = selector => selector(state)
  const t: CollaborationPanelProps['t'] = key => key
  return {
    useCollaboration,
    refreshAll: vi.fn(async () => {}),
    select: vi.fn(),
    refreshBoard: vi.fn(async () => {}),
    refreshWorktrees: vi.fn(async () => {}),
    refreshConflicts: vi.fn(async () => {}),
    markIntegrated: vi.fn(async () => {}),
    actionError: null,
    onActionError: vi.fn(),
    t,
  }
}

describe('CollaborationPanel', () => {
  it('renders the selected plan, tasks, board, worktrees, and advisory conflicts', () => {
    render(<CollaborationPanel {...panelProps(snapshot())} />)

    expect(screen.getByRole('heading', { name: 'collaboration.title' })).toBeTruthy()
    expect(screen.getByText('Ship the dashboard')).toBeTruthy()
    expect(screen.getByText('collaboration.mode.inject')).toBeTruthy()
    expect(screen.getByText('collaboration.phase.done')).toBeTruthy()
    expect(screen.getByText('collaboration.phase.active')).toBeTruthy()
    expect(screen.getByText('collaboration.phase.todo')).toBeTruthy()
    expect(screen.getByText('Keep the API native')).toBeTruthy()
    expect(screen.getByText('Build UI')).toBeTruthy()
    expect(screen.getByText('collaboration.taskStatus.running')).toBeTruthy()
    expect(screen.getByText('collaboration.isolation.worktree')).toBeTruthy()
    expect(screen.getByText('collaboration.todo.blocked')).toBeTruthy()
    expect(screen.getByText('collaboration.worktreeState.active')).toBeTruthy()
    expect(screen.getByText('collaboration.conflictKind.sameHunk')).toBeTruthy()
    expect(screen.getByText('collaboration.severity.blocking')).toBeTruthy()
    expect(screen.getByText('collaboration.suggestedOrder')).toBeTruthy()
    expect(screen.getByText('Line ranges are approximate.')).toBeTruthy()
  })

  it('routes refresh, selection, conflict, and integration actions to the source', async () => {
    const props = panelProps(snapshot())
    vi.mocked(props.markIntegrated)
      .mockRejectedValueOnce(new Error('integration update failed'))
      .mockRejectedValueOnce('integration transport failed')
    render(<CollaborationPanel {...props} />)

    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[0]!)
    const board = screen.getByRole('region', { name: 'collaboration.sharedTodos' })
    fireEvent.click(within(board).getByRole('button', { name: 'refresh' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'collaboration.selector' }), { target: { value: 'collab-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'collaboration.refreshConflicts' }))
    fireEvent.click(screen.getByRole('button', { name: 'collaboration.markIntegrated' }))

    await waitFor(() => { expect(props.onActionError).toHaveBeenCalledWith('integration update failed') })
    fireEvent.click(screen.getByRole('button', { name: 'collaboration.markIntegrated' }))
    await waitFor(() => { expect(props.onActionError).toHaveBeenCalledWith('integration transport failed') })
    expect(props.refreshAll).toHaveBeenCalledOnce()
    expect(props.refreshBoard).toHaveBeenCalledWith('collab-1')
    expect(props.select).toHaveBeenCalledWith('collab-1')
    expect(props.refreshConflicts).toHaveBeenCalledWith('/repo')
    expect(props.markIntegrated).toHaveBeenCalledWith('worktree-1')
    expect(props.onActionError).toHaveBeenNthCalledWith(1, null)
  })

  it('localizes supported states and limits integration actions to outstanding worktrees', () => {
    const manyChanges = ['added', 'modified', 'deleted', 'renamed', 'untracked', 'conflicted']
    const worktrees = [
      worktree('idle', 'idle', manyChanges),
      worktree('active', 'active'),
      worktree('merged', 'merged'),
      worktree('removed', 'removed'),
    ]
    const tasks = ['queued', 'blocked', 'running', 'succeeded', 'failed', 'cancelled'].map((status, index) => ({
      ...COLLABORATION.tasks[0]!, id: `task-${index}`, status,
      isolation: index % 2 === 0 ? 'shared-cwd' : 'worktree',
    }))
    const manyStatuses = snapshot({
      collaborations: { status: 'ready', rows: [{ ...COLLABORATION, mode: 'observe', tasks }], error: null },
      boards: { [COLLABORATION.id]: { status: 'ready', value: { ...BOARD, todos: [
        ...BOARD.todos,
        ...(['pending', 'in_progress', 'completed', 'cancelled'].map((status, index) => ({
          ...BOARD.todos[0]!, id: `todo-${index + 2}`, status,
        }))),
      ] }, error: null } },
      worktrees: { [COLLABORATION.repoRoot]: { status: 'ready', rows: worktrees, error: null } },
      conflicts: { [COLLABORATION.repoRoot]: { status: 'ready', value: {
        ...CONFLICTS,
      }, error: null } },
    })
    render(<CollaborationPanel {...panelProps(manyStatuses)} />)

    for (const key of [
      'collaboration.mode.observe', 'collaboration.isolation.sharedCwd', 'collaboration.taskStatus.queued',
      'collaboration.taskStatus.blocked', 'collaboration.taskStatus.running', 'collaboration.taskStatus.succeeded',
      'collaboration.taskStatus.failed', 'collaboration.taskStatus.cancelled', 'collaboration.todo.pending',
      'collaboration.todo.inProgress', 'collaboration.todo.completed', 'collaboration.todo.cancelled',
      'collaboration.worktreeState.idle', 'collaboration.worktreeState.active', 'collaboration.worktreeState.merged',
      'collaboration.worktreeState.removed', 'collaboration.fileStatus.added', 'collaboration.fileStatus.modified',
      'collaboration.fileStatus.deleted', 'collaboration.fileStatus.renamed', 'collaboration.fileStatus.untracked',
      'collaboration.fileStatus.conflicted', 'collaboration.conflictKind.sameFile', 'collaboration.conflictKind.featureBoundary',
      'collaboration.conflictKind.baseDrift', 'collaboration.severity.warning', 'collaboration.severity.info',
    ]) expect(screen.getAllByText(key).length).toBeGreaterThan(0)

    expect(screen.getAllByRole('button', { name: 'collaboration.markIntegrated' })).toHaveLength(2)
    expect(screen.queryByText('collaboration.moreFiles')).toBeNull()
  })

  it('renders unknown native states and absent optional records safely', () => {
    const withoutRecords = snapshot({
      collaborations: { status: 'ready', rows: [{ ...COLLABORATION, mode: 'future', activePhaseId: '', phases: [], tasks: [], decisions: [] }], error: null },
      boards: {},
      worktrees: {},
      conflicts: {},
    })
    const view = render(<CollaborationPanel {...panelProps(withoutRecords)} actionError="integration failed" />)

    expect(screen.getByRole('alert').textContent).toContain('integration failed')
    expect(screen.getByText('collaboration.status.unknown')).toBeTruthy()
    expect(screen.getByText('collaboration.phases.empty')).toBeTruthy()
    expect(screen.getByText('collaboration.tasks.empty')).toBeTruthy()
    expect(screen.getAllByText('collaboration.select').length).toBeGreaterThan(0)

    const unknownWorktree = {
      ...worktree('worktree-fallback', 'future', Array.from({ length: 9 }, () => 'future')),
      branch: '', dirty: false, runId: '', taskId: '', notes: [],
    }
    const populated = snapshot({
      collaborations: { status: 'ready', rows: [{
        ...COLLABORATION,
        mode: 'future',
        activePhaseId: '',
        phases: [{ ...COLLABORATION.phases[0]!, status: 'future' }],
        tasks: [{ ...COLLABORATION.tasks[0]!, status: 'future', isolation: 'future', runId: '', worktreeId: '', dependsOn: [], note: '' }],
        decisions: [],
      }], error: null },
      boards: { [COLLABORATION.id]: { status: 'ready', value: { ...BOARD, todos: [{ ...BOARD.todos[0]!, status: 'future', blockedBy: [] }] }, error: null } },
      worktrees: { [COLLABORATION.repoRoot]: { status: 'ready', rows: [unknownWorktree], error: null } },
      conflicts: { [COLLABORATION.repoRoot]: { status: 'ready', value: {
        ...CONFLICTS,
        findings: [futureConflictFinding()],
      }, error: null } },
      pending: ['integrate:worktree-fallback'],
    })
    view.rerender(<CollaborationPanel {...panelProps(populated)} />)

    expect(screen.getAllByText('collaboration.status.unknown').length).toBeGreaterThan(0)
    expect(screen.getByText('worktree-fallback')).toBeTruthy()
    expect(screen.getByText('collaboration.clean')).toBeTruthy()
    expect(screen.getByText('collaboration.moreFiles')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'collaboration.pending' }).hasAttribute('disabled')).toBe(true)
  })

  it('renders empty, loading, and failed read states with retry actions', () => {
    const props = panelProps(snapshot({
      collaborations: { status: 'error', rows: [], error: 'collaboration read failed' },
      selectedId: null,
      boards: {},
      worktrees: {},
      conflicts: {},
    }))
    const view = render(<CollaborationPanel {...props} />)

    expect(screen.getByText('collaboration read failed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'retry' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(props.refreshAll).toHaveBeenCalledOnce()

    view.rerender(<CollaborationPanel {...panelProps(snapshot({
      collaborations: { status: 'ready', rows: [], error: null },
      selectedId: null,
    }))} />)
    expect(screen.getByText('collaboration.empty')).toBeTruthy()

    const loading = snapshot({
      collaborations: { status: 'loading', rows: [], error: null },
      selectedId: null,
    })
    view.rerender(<CollaborationPanel {...panelProps(loading)} />)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('reports board, worktree, and conflict read failures while retaining known values', () => {
    const failed = snapshot({
      boards: { [COLLABORATION.id]: { status: 'error', value: null, error: 'board read failed' } },
      worktrees: { [COLLABORATION.repoRoot]: { status: 'error', rows: [], error: 'worktree read failed' } },
      conflicts: { [COLLABORATION.repoRoot]: { status: 'error', value: null, error: 'conflict read failed' } },
    })
    const props = panelProps(failed)
    const view = render(<CollaborationPanel {...props} />)

    expect(screen.getByText('board read failed')).toBeTruthy()
    expect(screen.getByText('worktree read failed')).toBeTruthy()
    expect(screen.getByText('conflict read failed')).toBeTruthy()
    const retryButtons = screen.getAllByRole('button', { name: 'retry' })
    fireEvent.click(retryButtons[0]!)
    fireEvent.click(retryButtons[1]!)
    fireEvent.click(retryButtons[2]!)
    expect(props.refreshBoard).toHaveBeenCalledWith('collab-1')
    expect(props.refreshWorktrees).toHaveBeenCalledWith('/repo')
    expect(props.refreshConflicts).toHaveBeenCalledWith('/repo')

    view.rerender(<CollaborationPanel {...panelProps(snapshot({
      boards: { [COLLABORATION.id]: { status: 'ready', value: { ...BOARD, todos: [] }, error: null } },
      worktrees: { [COLLABORATION.repoRoot]: { status: 'ready', rows: [], error: null } },
      conflicts: { [COLLABORATION.repoRoot]: { status: 'ready', value: { ...CONFLICTS, findings: [], notes: [] }, error: null } },
    }))} />)
    expect(screen.getByText('collaboration.todos.empty')).toBeTruthy()
    expect(screen.getByText('collaboration.worktrees.empty')).toBeTruthy()
    expect(screen.getByText('collaboration.conflicts.empty')).toBeTruthy()
  })
})
