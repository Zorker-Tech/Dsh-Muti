// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh/types'
import type {
  AgentSessionListFailure, AgentSessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { AgentMeshSessionReference } from '@deepseek-ai/dsh-client-ui-agent-mesh/client'
import { zh } from '../src/client/locales.ts'
import {
  AgentSessionSection, agentSessionsForWorkspace, dispatchAgentSessionAction, filterAgentSessions, visibleAgentSessions,
} from '../src/client/rows/AgentSessionSection.tsx'

const t = makeTranslate(zh)
afterEach(cleanup)

const agentId = (value: string): AgentId => brandString<AgentId>(value)
const sessionKey = (value: string): AgentSessionKey => brandString<AgentSessionKey>(value)

const session = (overrides: Partial<AgentSessionSummary> = {}, omitOptionalMetadata = false): AgentSessionSummary => {
  const row: AgentSessionSummary = {
    source: 'agent-mesh',
    agentId: agentId('codex'),
    key: sessionKey('codex:native-1'),
    nativeId: 'native-1',
    title: 'Refactor workspace list',
    cwd: '/work/project',
    model: 'provider/model',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T11:00:00.000Z',
    status: 'idle',
    pinned: false,
    archived: false,
    notes: [],
    ...overrides,
  }
  if (!omitOptionalMetadata) return row
  const { cwd: _cwd, model: _model, ...withoutOptionalMetadata } = row
  return withoutOptionalMetadata
}

const onSetPinned = vi.fn(async (_reference: AgentMeshSessionReference, _pinned: boolean) => {})
const onSetArchived = vi.fn(async (_reference: AgentMeshSessionReference, _archived: boolean) => {})

describe('AgentSessionSection', () => {
  it('keeps the source-owned list intact for an absent or blank query', () => {
    const sessions = [session(), session({
      agentId: agentId('pi'), key: sessionKey('pi:native-2'), nativeId: 'native-2', title: 'Second session',
    })]
    expect(filterAgentSessions(sessions)).toBe(sessions)
    expect(filterAgentSessions(sessions, '  ')).toBe(sessions)
  })

  it('matches agent id, native key, title, path, and model without reading transcript content', () => {
    const row = session()
    for (const query of ['CODEX', 'native-1', 'workspace list', '/work/project', 'provider/model']) {
      expect(filterAgentSessions([row], query)).toEqual([row])
    }
    expect(filterAgentSessions([row], 'message body')).toEqual([])
  })

  it('treats absent optional search metadata as empty fields', () => {
    const row = session({ title: '' }, true)
    expect(filterAgentSessions([row], 'codex')).toEqual([row])
    expect(filterAgentSessions([row], 'missing')).toEqual([])
    const { title: _title, ...withoutTitle } = session()
    expect(filterAgentSessions([withoutTitle], 'native-1')).toHaveLength(1)
  })

  it('applies archive visibility and orders pinned sessions before recent unpinned sessions', () => {
    const sessions = [
      session({ key: sessionKey('codex:archived'), nativeId: 'archived', archived: true }),
      session({ key: sessionKey('pi:pinned'), agentId: agentId('pi'), nativeId: 'pinned', pinned: true, updatedAt: '2026-10-14T00:00:00.000Z' }),
      session({ key: sessionKey('grok:recent'), agentId: agentId('grok'), nativeId: 'recent' }),
    ]
    expect(visibleAgentSessions(sessions, 'default').map(row => row.nativeId)).toEqual(['pinned', 'recent'])
    expect(visibleAgentSessions(sessions, 'show').map(row => row.nativeId)).toEqual(['pinned', 'archived', 'recent'])
    expect(visibleAgentSessions(sessions, 'only').map(row => row.nativeId)).toEqual(['archived'])
  })

  it('groups source sessions by exact recorded working directory and leaves unmatched paths ungrouped', () => {
    const sessions = [
      session(),
      session({ key: sessionKey('pi:other'), nativeId: 'other', agentId: agentId('pi'), cwd: '/other' }),
      session({ key: sessionKey('grok:no-cwd'), nativeId: 'no-cwd', agentId: agentId('grok') }, true),
    ]
    const paths = new Set(['/work/project'])
    expect(agentSessionsForWorkspace(sessions, '/work/project', paths).map(row => row.nativeId)).toEqual(['native-1'])
    expect(agentSessionsForWorkspace(sessions, undefined, paths).map(row => row.nativeId)).toEqual(['other', 'no-cwd'])
  })

  it('ignores menu selections outside the declared actions', () => {
    const row = session()
    const run = vi.fn<(action: () => Promise<void>) => void>()
    dispatchAgentSessionAction(
      'unknown', row, { agentId: row.agentId, nativeId: row.nativeId },
      { pin: onSetPinned, archive: onSetArchived }, run,
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('renders searchable source metadata, reports store failures, and opens the exact external identity', () => {
    const open = vi.fn<(reference: AgentMeshSessionReference) => void>()
    const failures: AgentSessionListFailure[] = [{ agentId: agentId('pi'), message: 'store locked' }]
    render(<AgentSessionSection
      sessions={[session({ pinned: true, archived: true })]}
      failures={failures}
      onOpen={open}
      onSetPinned={onSetPinned}
      onSetArchived={onSetArchived}
      t={t}
      searching
    />)

    expect(screen.getByRole('heading', { name: '智能体会话' })).toBeTruthy()
    expect(screen.getByText('按名称、路径、模型或 ID 匹配；不搜索会话正文。')).toBeTruthy()
    expect(screen.getByText('来自 codex')).toBeTruthy()
    expect(screen.getByText('已置顶')).toBeTruthy()
    expect(screen.getByText('已归档')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('pi：store locked')
    fireEvent.click(screen.getByRole('button', { name: '打开智能体会话“Refactor workspace list”' }))
    expect(open).toHaveBeenCalledExactlyOnceWith({ agentId: 'codex', nativeId: 'native-1' })
  })

  it('pins and archives the source session by its exact native identity', async () => {
    onSetPinned.mockClear()
    onSetArchived.mockClear()
    render(<AgentSessionSection
      sessions={[session()]}
      failures={[]}
      onOpen={vi.fn()}
      onSetPinned={onSetPinned}
      onSetArchived={onSetArchived}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '智能体会话“Refactor workspace list”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶会话' }))
    await waitFor(() =>{  expect(onSetPinned).toHaveBeenCalledExactlyOnceWith(
      { agentId: 'codex', nativeId: 'native-1' }, true,
    ) })

    fireEvent.click(screen.getByRole('button', { name: '智能体会话“Refactor workspace list”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }))
    await waitFor(() =>{  expect(onSetArchived).toHaveBeenCalledExactlyOnceWith(
      { agentId: 'codex', nativeId: 'native-1' }, true,
    ) })
  })

  it('closes the action menu on Escape without selecting an action', () => {
    onSetPinned.mockClear()
    onSetArchived.mockClear()
    render(<AgentSessionSection
      sessions={[session()]}
      failures={[]}
      onOpen={vi.fn()}
      onSetPinned={onSetPinned}
      onSetArchived={onSetArchived}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '智能体会话“Refactor workspace list”的操作' }))
    expect(screen.getByRole('menuitem', { name: '置顶会话' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: '置顶会话' })).toBeNull()
    expect(onSetPinned).not.toHaveBeenCalled()
    expect(onSetArchived).not.toHaveBeenCalled()
  })

  it('shows a retryable status when a source-session action fails', async () => {
    const rejectPinned = vi.fn(async () => { throw new Error('store unavailable') })
    render(<AgentSessionSection
      sessions={[session()]}
      failures={[]}
      onOpen={vi.fn()}
      onSetPinned={rejectPinned}
      onSetArchived={onSetArchived}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '智能体会话“Refactor workspace list”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶会话' }))
    await waitFor(() =>{  expect(screen.getByRole('alert').textContent).toBe('无法更新智能体会话状态，请稍后重试。') })
  })

  it('uses the native id when the agent has no title and returns no section for an empty catalog', () => {
    const { container, rerender } = render(<AgentSessionSection
      sessions={[session({ title: '' }, true)]}
      failures={[{ agentId: agentId('omp'), message: 'store unreadable' }]}
      onOpen={vi.fn()} onSetPinned={onSetPinned} onSetArchived={onSetArchived} t={t} tree
    />)
    expect(screen.getByText('native-1')).toBeTruthy()
    expect(screen.getAllByRole('treeitem')[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('omp：store unreadable')
    rerender(
      <AgentSessionSection
        sessions={[]}
        failures={[]}
        onOpen={vi.fn()}
        onSetPinned={onSetPinned}
        onSetArchived={onSetArchived}
        t={t}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('names a workspace-scoped source session section', () => {
    render(<AgentSessionSection
      sessions={[session()]}
      failures={[]}
      onOpen={vi.fn()}
      onSetPinned={onSetPinned}
      onSetArchived={onSetArchived}
      t={t}
      workspaceTitle="project"
    />)
    expect(screen.getByRole('heading', { name: 'project · 智能体会话' })).toBeTruthy()
  })
})
