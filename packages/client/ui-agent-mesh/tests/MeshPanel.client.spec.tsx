// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentCapabilityInventory, AgentId, AgentRunId } from '@deepseek-ai/dsh-agent-mesh/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MeshPanelProps } from '../src/client/MeshPanel.tsx'
import { MeshPanel } from '../src/client/MeshPanel.tsx'
import type { MeshCollaborationSnapshot } from '../src/client/collaboration-store.ts'
import { authPendingKey, bindPendingKey, runPendingKey } from '../src/client/mesh-store.ts'
import type { AgentMeshSnapshot } from '../src/client/mesh-store.ts'
import { standardProps } from './standard-props.ts'
import type {
  MeshAgentRow, MeshCredentialRow, MeshLaunchCommand, MeshRunRow, MeshSessionRequest, MeshSessionRow,
} from '@deepseek-ai/dsh-agent-mesh-controller/types'

afterEach(cleanup)

const activeSessionId = brandString<SessionId>('harness-1')
const codexAgentId = brandString<AgentId>('codex')
const codexRunId = brandString<AgentRunId>('run-1')
const externalRunId = brandString<AgentRunId>('run-2')
const codex: MeshAgentRow = {
  agentId: 'codex', displayName: 'Codex', installed: true, version: '1.0', binaryPath: '/bin/codex', warnings: ['probe note'],
}
const pi: MeshAgentRow = {
  agentId: 'pi', displayName: 'Pi', installed: false, detectionReason: 'not installed', warnings: [],
}
const session: MeshSessionRow = {
  key: 'codex:native-1', agentId: 'codex', nativeId: 'native-1', title: '', cwd: '/repo', model: 'o3',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', status: 'compacting', messageCount: 4,
  notes: ['session note'], pinned: false, archived: false,
}
const secondSession: MeshSessionRow = {
  key: 'codex:native-2', agentId: 'codex', nativeId: 'native-2', title: 'Follow-up',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:02:00.000Z', status: 'idle', notes: [], pinned: false, archived: false,
}

function readySnapshot(): AgentMeshSnapshot {
  const runs: MeshRunRow[] = [
    {
      runId: 'run-1', agentId: 'codex', cwd: '/repo', prompt: 'fix it', status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z', notes: ['run note'], events: [
        { kind: 'message.delta', runId: codexRunId, at: '2026-01-01T00:00:01.000Z', text: 'Inspecting the failing path.' },
        { kind: 'reasoning.delta', runId: codexRunId, at: '2026-01-01T00:00:02.000Z', text: 'private reasoning must stay hidden' },
        { kind: 'tool.started', runId: codexRunId, at: '2026-01-01T00:00:03.000Z', toolName: 'read_file', input: 'private input' },
      ], eventCount: 23,
    },
    {
      runId: 'run-2', agentId: 'external', cwd: '/repo', prompt: 'try it', status: 'failed',
      startedAt: 'bad timestamp', finishedAt: '2026-01-01T00:01:00.000Z', finalText: 'partial',
      error: { code: 'failed', message: 'process failed', remediation: 'sign in', output: 'redacted' },
      notes: [], events: [
        { kind: 'warning', runId: externalRunId, at: '2026-01-01T00:00:04.000Z', message: 'the adapter reported a warning' },
      ], eventCount: 1,
    },
  ]
  const credentials: MeshCredentialRow[] = [
    {
      agentId: 'codex', displayName: 'Codex',
      state: { status: 'authenticated', source: 'file', method: 'oauth', detail: 'signed in', expiresAt: 'bad expiry' },
      loginFlows: ['api-key'], canLogout: true,
    },
    {
      agentId: 'pi', displayName: 'Pi', state: { status: 'unauthenticated', source: 'none' },
      loginFlows: ['interactive'], canLogout: false,
    },
    {
      agentId: 'grok', displayName: 'Grok', state: { status: 'unauthenticated', source: 'none' },
      loginFlows: [], canLogout: false,
    },
  ]
  const capabilityKey = JSON.stringify(['codex', '/repo'])
  return {
    agents: { status: 'ready', rows: [codex, pi], error: null },
    sessions: {
      codex: { status: 'ready', rows: [session, secondSession], error: null },
    },
    capabilities: {
      [capabilityKey]: {
        status: 'ready', error: null, value: {
          agentId: codexAgentId,
          tools: [
            { name: 'read_file', source: 'builtin', approval: 'read', discoverable: true, path: '/bin/read', description: 'Read a file' },
            { name: 'write_file', source: 'project' },
          ],
          skills: [
            { name: 'review', description: 'Review changes', source: 'user', path: '/home/.codex/skills/review/SKILL.md' },
            { name: 'learn', source: 'project' },
          ],
          mcpServers: [
            { name: 'docs', transport: 'stdio', command: 'docs-mcp', enabled: true, source: 'user' },
            { name: 'remote', transport: 'sse', url: 'https://localhost/events', enabled: false, source: 'project' },
          ],
          commands: [
            { name: 'review', description: 'Run review', source: 'user' },
            { name: 'clear', source: 'project' },
          ],
          contextFiles: ['/repo/AGENTS.md'],
          sources: [{ path: '/home/.codex/config.toml', present: true }],
          notes: [{ field: 'tools', reason: 'built-in tools come from the CLI' }],
          observedAt: '2026-10-16T08:00:00.000Z',
        },
      },
    },
    transcripts: {
      'codex:native-1': {
        status: 'ready', error: null, value: {
          key: 'codex:native-1', totalMessages: 4, hasMore: true, notes: ['transcript note'], messages: [
            { index: 0, role: 'assistant', kind: 'assistant', text: 'answer', timestamp: '2026-01-01T00:00:00.000Z', paths: ['/repo/a.ts'] },
            { index: 1, role: 'tool', kind: 'tool-call', toolName: 'bash', toolInput: 'npm test', failed: true, truncated: true },
            { index: 2, role: 'tool', kind: 'tool-result', toolOutput: 'failed', timestamp: 'bad time' },
            { index: 3, role: 'unknown', kind: 'unknown', nativeType: 'custom', text: '', paths: [] },
          ],
        },
      },
      'codex:native-2': { status: 'ready', error: null, value: { key: 'codex:native-2', hasMore: false, messages: [], notes: [] } },
    },
    tasks: {
      'codex:native-1': {
        status: 'ready', error: null, value: {
          available: true,
          todos: [
            { id: 'todo-1', content: 'run tests', status: 'in_progress', owner: 'codex', blockedBy: ['todo-0'], updatedAt: '2026-01-01T00:00:00.000Z' },
            { id: 'todo-2', content: 'write report', status: 'completed', owner: 'codex', blockedBy: [], updatedAt: '2026-01-01T00:00:00.000Z' },
          ],
          plan: { active: true, items: ['inspect', 'fix'] },
          notes: ['task note'],
        },
      },
      'codex:native-2': { status: 'ready', error: null, value: { available: false, todos: [], notes: [] } },
    },
    credentials: { status: 'ready', rows: credentials, error: null },
    bindings: { status: 'ready', rows: [{ sessionId: activeSessionId, agentId: 'codex', boundAt: '2026-01-01T00:00:00.000Z' }], error: null },
    runs: { status: 'ready', rows: runs, error: null },
    selectedAgentId: 'codex',
    selectedSessionKey: session.key,
    selectedCapabilityKey: capabilityKey,
    auth: { agentId: 'codex', action: 'login', ok: false, instructions: null, output: 'redacted' },
    bindingError: 'binding rejected',
    runError: 'cancel rejected',
    pending: [bindPendingKey(activeSessionId), authPendingKey('codex'), runPendingKey('run-1')],
  }
}

function sessionState(active: boolean): SessionListState {
  const unretainedSessionId = brandString<SessionId>('unretained-session')
  return {
    ids: active ? [unretainedSessionId, activeSessionId] : [],
    agentSessions: [], agentSessionFailures: [],
    byId: active ? {
      [unretainedSessionId]: {
        id: unretainedSessionId,
        displayTitle: 'Unretained session',
        running: false,
        retainedBy: {},
        blank: false,
        updatedAt: 0,
      },
      [activeSessionId]: {
        id: activeSessionId,
        displayTitle: 'Current session',
        running: false,
        retainedBy: { mainView: 1 },
        blank: false,
        updatedAt: 0,
      },
    } : {},
    phase: 'ready',
    projectionsBySession: {},
  }
}

function panelProps(snapshot: AgentMeshSnapshot, active = true, translate?: MeshPanelProps['t']): MeshPanelProps {
  const actions = {
    refreshAgents: vi.fn(async () => {}),
    selectAgent: vi.fn(),
    refreshSessions: vi.fn(async () => {}),
    refreshCapabilities: vi.fn(async () => {}),
    selectSession: vi.fn(),
    refreshSession: vi.fn(async () => {}),
    refreshCredentials: vi.fn(async () => {}),
    refreshBindings: vi.fn(async () => {}),
    refreshRuns: vi.fn(async () => {}),
    cancelRun: vi.fn(async () => {}),
    bind: vi.fn(async () => {}),
    unbind: vi.fn(async () => {}),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    queueDispatchPrompt: vi.fn(async () => {}),
    launchCommand: vi.fn(async (request: MeshSessionRequest): Promise<MeshLaunchCommand | null> => ({
      argv: ['/Applications/Codex CLI/codex', 'resume', request.sessionId], shell: 'posix',
    })),
    dismissAuth: vi.fn(),
    dismissBindingError: vi.fn(),
    dismissRunError: vi.fn(),
    refreshAll: vi.fn(),
  }
  const collaborationActions: MeshPanelProps['collaborationActions'] = {
    refreshAll: vi.fn(async () => {}),
    select: vi.fn(),
    refreshBoard: vi.fn(async () => {}),
    refreshWorktrees: vi.fn(async () => {}),
    refreshConflicts: vi.fn(async () => {}),
    markIntegrated: vi.fn(async () => {}),
  }
  const collaborationSnapshot: MeshCollaborationSnapshot = {
    collaborations: { status: 'idle', rows: [], error: null },
    selectedId: null,
    boards: {},
    worktrees: {},
    conflicts: {},
    pending: [],
  }
  const useMesh: MeshPanelProps['useMesh'] = selector => selector(snapshot)
  const useSessions: MeshPanelProps['useSessions'] = selector => selector(sessionState(active))
  const useCollaboration: MeshPanelProps['useCollaboration'] = selector => selector(collaborationSnapshot)
  const t: MeshPanelProps['t'] = translate ?? (key => key)
  return { ...actions, ...standardProps, collaborationActions, useMesh, useSessions, useCollaboration, t }
}

const translateDispatchError: MeshPanelProps['t'] = (key, params) => key === 'dispatch.error'
  ? `${key}: ${String(params?.message ?? '')}`
  : key

describe('MeshPanel', () => {
  it('renders populated agent, session, transcript, tasks, binding, account, and run sections', () => {
    const ready = readySnapshot()
    const snapshot: AgentMeshSnapshot = {
      ...ready,
      runs: { ...ready.runs, rows: [...ready.runs.rows, { ...ready.runs.rows[0]!, runId: 'run-3', events: [], eventCount: 0 }] },
    }
    render(<MeshPanel {...panelProps(snapshot)} />)
    expect(screen.getByTestId('agent-mesh-panel')).toBeTruthy()
    expect(screen.getAllByText('Codex')).toHaveLength(2)
    expect(screen.getByText('not installed')).toBeTruthy()
    expect(screen.getAllByText('native-1').length).toBeGreaterThan(0)
    expect(screen.getByText('answer')).toBeTruthy()
    expect(screen.getByText('capabilities.heading')).toBeTruthy()
    const capabilities = screen.getByRole('region', { name: 'capabilities.heading' })
    expect(within(capabilities).getByText('read_file')).toBeTruthy()
    expect(screen.getByText('/bin/read')).toBeTruthy()
    expect(screen.getByText('Read a file')).toBeTruthy()
    expect(screen.getByText('review')).toBeTruthy()
    expect(screen.getByText('docs-mcp')).toBeTruthy()
    expect(screen.getByText('https://localhost/events')).toBeTruthy()
    expect(screen.getByText('Run review')).toBeTruthy()
    expect(screen.getByText('/clear')).toBeTruthy()
    expect(screen.getByText('/repo/AGENTS.md')).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()
    expect(screen.getByText('failed')).toBeTruthy()
    expect(screen.getByText('run tests')).toBeTruthy()
    expect(screen.getAllByText('runs.activity')).toHaveLength(2)
    expect(screen.getByText('Inspecting the failing path.')).toBeTruthy()
    expect(screen.getByText('the adapter reported a warning')).toBeTruthy()
    expect(screen.getByText('runs.activityOmitted')).toBeTruthy()
    expect(screen.queryByText('private reasoning must stay hidden')).toBeNull()
    expect(screen.getByText(/binding rejected/)).toBeTruthy()
    expect(screen.getByText('sign in')).toBeTruthy()
    expect(screen.getByText('partial')).toBeTruthy()
    expect(screen.getByText(/cancel rejected/)).toBeTruthy()
  })

  it('mounts the collaboration panel after its tab is selected', () => {
    render(<MeshPanel {...panelProps(readySnapshot())} />)

    expect(screen.queryByTestId('agent-mesh-collaboration')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'tabs.collaboration' }))
    expect(screen.getByTestId('agent-mesh-collaboration')).toBeTruthy()
  })

  it('dispatches panel actions from rows and menu choices', () => {
    const snapshot: AgentMeshSnapshot = { ...readySnapshot(), pending: [] }
    const props = panelProps(snapshot)
    render(<MeshPanel {...props} />)

    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[1]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[2]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[3]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'agents.select' })[0]!)
    fireEvent.click(screen.getAllByText('native-1')[0]!.closest('button')!)
    const sessionHeading = screen.getByRole('heading', { name: 'native-1' })
    const reloadButton = sessionHeading.parentElement?.querySelector('button')
    if (reloadButton === null || reloadButton === undefined) throw new Error('the selected session has no reload button')
    fireEvent.click(reloadButton)
    fireEvent.click(screen.getByRole('button', { name: 'binding.choose' }))
    const binding = screen.getByRole('region', { name: 'binding.heading' })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(binding).getByRole('button', { name: 'binding.choose' }))
    fireEvent.click(within(binding).getByText('Codex'))
    fireEvent.click(within(binding).getByRole('button', { name: 'binding.unbind' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'accounts.login' })[0]!)
    const accounts = screen.getByRole('region', { name: 'accounts.heading' })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(accounts).getAllByRole('button', { name: 'accounts.login' })[0]!)
    fireEvent.click(within(accounts).getByText('accounts.flow.api-key'))
    fireEvent.change(within(accounts).getByLabelText('accounts.apiKeyLabel'), { target: { value: 'codex-secret' } })
    fireEvent.click(within(accounts).getByRole('button', { name: 'accounts.submitLogin' }))
    expect(within(accounts).queryByLabelText('accounts.apiKeyLabel')).toBeNull()
    fireEvent.click(within(accounts).getAllByRole('button', { name: 'accounts.logout' })[0]!)
    fireEvent.click(within(accounts).getByRole('button', { name: 'dismiss' }))
    fireEvent.click(within(binding).getByRole('button', { name: 'dismiss' }))
    const runs = screen.getByRole('region', { name: 'runs.heading' })
    fireEvent.click(within(runs).getByRole('button', { name: 'dismiss' }))
    fireEvent.click(within(runs).getByRole('button', { name: 'refresh' }))
    fireEvent.click(within(runs).getByRole('button', { name: 'runs.cancel' }))

    expect(props.refreshAll).toHaveBeenCalledOnce()
    expect(props.bind).toHaveBeenCalledWith(activeSessionId, 'codex')
    expect(props.unbind).toHaveBeenCalledWith(activeSessionId)
    expect(props.login).toHaveBeenCalledWith('codex', 'api-key', 'codex-secret')
    expect(props.logout).toHaveBeenCalledWith('codex')
    expect(props.refreshSession).toHaveBeenCalledWith('codex', 'native-1')
    expect(props.dismissAuth).toHaveBeenCalledOnce()
    expect(props.dismissBindingError).toHaveBeenCalledOnce()
    expect(props.dismissRunError).toHaveBeenCalledOnce()
    expect(props.cancelRun).toHaveBeenCalledWith('run-1')
  })

  it('shows a quoted native resume command only after the user requests it', async () => {
    const props = panelProps(readySnapshot())
    render(<MeshPanel {...props} />)

    expect(props.launchCommand).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'sessions.showLaunch' }))
    const region = screen.getByRole('region', { name: 'sessions.nativeLaunch' })
    await waitFor(() =>{  expect(region.textContent).toContain("'/Applications/Codex CLI/codex' 'resume' 'native-1'") })
    expect(props.launchCommand).toHaveBeenCalledExactlyOnceWith({ agentId: 'codex', sessionId: 'native-1' })
    expect(region.textContent).toContain('sessions.launchHelp')
    expect(within(region).getByRole('button', { name: 'sessions.refreshLaunch' })).toBeTruthy()
  })

  it('offers only each adapter’s declared login flows and logout action', () => {
    const snapshot = readySnapshot()
    const props = panelProps({
      ...snapshot,
      pending: snapshot.pending.filter(key => key !== authPendingKey('codex')),
    })
    render(<MeshPanel {...props} />)
    const accounts = screen.getByRole('region', { name: 'accounts.heading' })
    const loginButtons = within(accounts).getAllByRole('button', { name: 'accounts.login' })
    expect(loginButtons).toHaveLength(2)
    fireEvent.click(loginButtons[0]!)
    expect(within(accounts).getByText('accounts.flow.api-key')).toBeTruthy()
    expect(within(accounts).queryByText('accounts.flow.interactive')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(loginButtons[1]!)

    expect(within(accounts).getByText('accounts.flow.interactive')).toBeTruthy()
    expect(within(accounts).queryByText('accounts.flow.api-key')).toBeNull()
    fireEvent.click(within(accounts).getByText('accounts.flow.interactive'))
    expect(props.login).toHaveBeenCalledWith('pi', 'interactive', undefined)
    const pi = within(accounts).getByText('Pi').closest('li')
    if (pi === null) throw new Error('the Pi account row is missing')
    expect(within(pi).queryByRole('button', { name: 'accounts.logout' })).toBeNull()
    const grok = within(accounts).getByText('Grok').closest('li')
    if (grok === null) throw new Error('the Grok account row is missing')
    expect(within(grok).queryByRole('button', { name: 'accounts.login' })).toBeNull()
    expect(within(grok).queryByRole('button', { name: 'accounts.logout' })).toBeNull()
  })

  it('queues the verbatim task and selected native target in the open Harness Session', async () => {
    const translate: MeshPanelProps['t'] = (key, params) => key === 'dispatch.promptTemplate'
      ? `${key}\n${String(params?.argumentsJson ?? '')}`
      : key
    const props = panelProps(readySnapshot(), true, translate)
    render(<MeshPanel {...props} />)

    const dispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    const task = 'Review the auth flow.\nPreserve existing behavior.'
    fireEvent.change(within(dispatch).getByRole('textbox', { name: 'dispatch.taskLabel' }), { target: { value: task } })
    fireEvent.click(within(dispatch).getByRole('button', { name: 'dispatch.queue' }))

    await waitFor(() => { expect(props.queueDispatchPrompt).toHaveBeenCalledOnce() })
    const [targetSessionId, generatedPrompt] = vi.mocked(props.queueDispatchPrompt).mock.calls[0]!
    expect(targetSessionId).toBe(activeSessionId)
    expect(generatedPrompt).toContain('"agentId": "codex"')
    expect(generatedPrompt).toContain('"cwd": "/repo"')
    expect(generatedPrompt).toContain('"resumeNativeId": "native-1"')
    expect(generatedPrompt).toContain('"prompt": "Review the auth flow.\\nPreserve existing behavior."')
    const textbox = within(dispatch).getByRole('textbox')
    if (!(textbox instanceof HTMLTextAreaElement)) throw new Error('dispatch task control is not a textarea')
    await waitFor(() => { expect(textbox.value).toBe('') })
    expect(within(dispatch).getByRole('status').textContent).toBe('dispatch.queued')
  })

  it('keeps the task and reports an admission failure', async () => {
    const props = panelProps(readySnapshot(), true, translateDispatchError)
    vi.mocked(props.queueDispatchPrompt).mockRejectedValueOnce(new Error('session is closed'))
    render(<MeshPanel {...props} />)
    const dispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    const task = 'Continue this native session.'
    const textbox = within(dispatch).getByRole('textbox', { name: 'dispatch.taskLabel' })
    if (!(textbox instanceof HTMLTextAreaElement)) throw new Error('dispatch task control is not a textarea')
    fireEvent.change(textbox, { target: { value: task } })
    fireEvent.click(within(dispatch).getByRole('button', { name: 'dispatch.queue' }))

    expect((await within(dispatch).findByRole('alert')).textContent).toContain('session is closed')
    expect(textbox.value).toBe(task)
  })

  it('shows message fields and string fallbacks from dispatch rejections', async () => {
    const props = panelProps(readySnapshot(), true, translateDispatchError)
    vi.mocked(props.queueDispatchPrompt)
      .mockRejectedValueOnce({ message: 'structured admission failure' })
      .mockRejectedValueOnce('plain admission failure')
    render(<MeshPanel {...props} />)
    const dispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    const textbox = within(dispatch).getByRole('textbox', { name: 'dispatch.taskLabel' })
    fireEvent.change(textbox, { target: { value: 'Continue this native session.' } })

    fireEvent.click(within(dispatch).getByRole('button', { name: 'dispatch.queue' }))
    expect((await within(dispatch).findByRole('alert')).textContent).toContain('structured admission failure')
    await waitFor(() => {
      expect(within(dispatch).getByRole('button', { name: 'dispatch.queue' }).hasAttribute('disabled')).toBe(false)
    })

    fireEvent.click(within(dispatch).getByRole('button', { name: 'dispatch.queue' }))
    expect((await within(dispatch).findByRole('alert')).textContent).toContain('plain admission failure')
  })

  it('ignores dispatch submissions without a Harness Session, native cwd, or task', () => {
    const noSessionProps = panelProps(readySnapshot(), false)
    const view = render(<MeshPanel {...noSessionProps} />)
    let dispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    let textbox = within(dispatch).getByRole('textbox', { name: 'dispatch.taskLabel' })
    fireEvent.change(textbox, { target: { value: 'Do not dispatch without a Harness Session.' } })
    let form = dispatch.querySelector('form')
    if (!(form instanceof HTMLFormElement)) throw new Error('dispatch form is missing')
    fireEvent.submit(form)
    expect(noSessionProps.queueDispatchPrompt).not.toHaveBeenCalled()

    const noCwdSnapshot = { ...readySnapshot(), selectedSessionKey: secondSession.key }
    const noCwdProps = panelProps(noCwdSnapshot)
    view.rerender(<MeshPanel {...noCwdProps} />)
    dispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    textbox = within(dispatch).getByRole('textbox', { name: 'dispatch.taskLabel' })
    fireEvent.change(textbox, { target: { value: 'Do not dispatch without a native cwd.' } })
    form = dispatch.querySelector('form')
    if (!(form instanceof HTMLFormElement)) throw new Error('dispatch form is missing')
    fireEvent.submit(form)
    expect(noCwdProps.queueDispatchPrompt).not.toHaveBeenCalled()

    const activeProps = panelProps(readySnapshot())
    view.rerender(<MeshPanel {...activeProps} />)
    dispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    textbox = within(dispatch).getByRole('textbox', { name: 'dispatch.taskLabel' })
    fireEvent.change(textbox, { target: { value: '  \n  ' } })
    form = dispatch.querySelector('form')
    if (!(form instanceof HTMLFormElement)) throw new Error('dispatch form is missing')
    fireEvent.submit(form)
    expect(activeProps.queueDispatchPrompt).not.toHaveBeenCalled()
  })

  it('ignores a duplicate dispatch submission while the first request is pending', async () => {
    const props = panelProps(readySnapshot())
    let resolveDispatch: () => void = () => {}
    vi.mocked(props.queueDispatchPrompt).mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveDispatch = resolve
    }))
    render(<MeshPanel {...props} />)
    const dispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    fireEvent.change(within(dispatch).getByRole('textbox', { name: 'dispatch.taskLabel' }), {
      target: { value: 'Run this task once.' },
    })
    const form = dispatch.querySelector('form')
    if (!(form instanceof HTMLFormElement)) throw new Error('dispatch form is missing')
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(props.queueDispatchPrompt).toHaveBeenCalledOnce()

    await act(async () => { resolveDispatch() })
    expect(within(dispatch).getByRole('status').textContent).toBe('dispatch.queued')
  })

  it('ignores dispatch success and failure after the panel unmounts', async () => {
    const successProps = panelProps(readySnapshot())
    let resolveDispatch: () => void = () => {}
    vi.mocked(successProps.queueDispatchPrompt).mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveDispatch = resolve
    }))
    const successView = render(<MeshPanel {...successProps} />)
    const successDispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    fireEvent.change(within(successDispatch).getByRole('textbox', { name: 'dispatch.taskLabel' }), {
      target: { value: 'Finish after unmount.' },
    })
    fireEvent.click(within(successDispatch).getByRole('button', { name: 'dispatch.queue' }))
    successView.unmount()
    await act(async () => { resolveDispatch() })

    const failureProps = panelProps(readySnapshot())
    let rejectDispatch: (cause: unknown) => void = () => {}
    vi.mocked(failureProps.queueDispatchPrompt).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectDispatch = reject
    }))
    const failureView = render(<MeshPanel {...failureProps} />)
    const failureDispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    fireEvent.change(within(failureDispatch).getByRole('textbox', { name: 'dispatch.taskLabel' }), {
      target: { value: 'Fail after unmount.' },
    })
    fireEvent.click(within(failureDispatch).getByRole('button', { name: 'dispatch.queue' }))
    failureView.unmount()
    await act(async () => { rejectDispatch('late failure') })
  })

  it('requires an open Harness Session and a native working directory', () => {
    const noHarnessSession = panelProps(readySnapshot(), false)
    const view = render(<MeshPanel {...noHarnessSession} />)
    const noSessionDispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    expect(within(noSessionDispatch).getByRole('button', { name: 'dispatch.queue' }).hasAttribute('disabled')).toBe(true)

    const noCwdSnapshot = { ...readySnapshot(), selectedSessionKey: secondSession.key }
    view.rerender(<MeshPanel {...panelProps(noCwdSnapshot)} />)
    const noCwdDispatch = screen.getByRole('region', { name: 'dispatch.heading' })
    expect(within(noCwdDispatch).getByRole('button', { name: 'dispatch.queue' }).hasAttribute('disabled')).toBe(true)
    expect(within(noCwdDispatch).getByText('dispatch.cwdUnavailable')).toBeTruthy()
  })

  it('reports when the selected adapter has no native TUI launcher', async () => {
    const props = panelProps(readySnapshot())
    vi.mocked(props.launchCommand).mockResolvedValue(null)
    render(<MeshPanel {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'sessions.showLaunch' }))
    expect(await screen.findByText('sessions.launchUnavailable')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'sessions.nativeLaunch' }).querySelector('pre')).toBeNull()
  })

  it('keeps the native launch read retryable after a failure and disables while loading', async () => {
    const props = panelProps(readySnapshot())
    let resolveCommand: (value: MeshLaunchCommand | null) => void = () => {}
    vi.mocked(props.launchCommand)
      .mockRejectedValueOnce(new Error('session launch failed'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCommand = resolve }))
    render(<MeshPanel {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'sessions.showLaunch' }))
    expect(await screen.findByText('session launch failed')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('region', { name: 'sessions.nativeLaunch' })).getByRole('button', { name: 'retry' }))
    expect(screen.getByRole('button', { name: 'sessions.showLaunch' }).hasAttribute('disabled')).toBe(true)
    expect(await screen.findByText('loading')).toBeTruthy()
    resolveCommand({ argv: ['codex', 'resume', 'native-1'], shell: 'powershell' })
    const region = screen.getByRole('region', { name: 'sessions.nativeLaunch' })
    await waitFor(() =>{  expect(region.textContent).toContain("'codex' 'resume' 'native-1'") })
  })

  it('ignores a native launch result after the panel unmounts', async () => {
    const props = panelProps(readySnapshot())
    let resolveCommand: (value: MeshLaunchCommand | null) => void = () => {}
    vi.mocked(props.launchCommand).mockImplementationOnce(() => new Promise((resolve) => { resolveCommand = resolve }))
    const view = render(<MeshPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'sessions.showLaunch' }))
    view.unmount()

    await act(async () => {
      resolveCommand({ argv: ['codex', 'resume', 'native-1'], shell: 'posix' })
      await Promise.resolve()
    })
  })

  it('ignores a native launch failure after the panel unmounts', async () => {
    const props = panelProps(readySnapshot())
    vi.mocked(props.launchCommand).mockRejectedValueOnce('late failure')
    const view = render(<MeshPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'sessions.showLaunch' }))
    view.unmount()

    await act(async () => { await Promise.resolve() })
  })

  it('renders a non-Error native launch failure as text', async () => {
    const props = panelProps(readySnapshot())
    vi.mocked(props.launchCommand).mockRejectedValueOnce('could not build command')
    render(<MeshPanel {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'sessions.showLaunch' }))
    expect(await screen.findByText('could not build command')).toBeTruthy()
  })

  it('renders loading, empty, and no-session states and lets the user retry reads', () => {
    const snapshot = readySnapshot()
    const loading: AgentMeshSnapshot = {
      ...snapshot,
      agents: { status: 'loading', rows: [], error: null },
      sessions: {},
      capabilities: {},
      transcripts: {},
      tasks: {},
      credentials: { status: 'loading', rows: [], error: null },
      bindings: { status: 'loading', rows: [], error: null },
      runs: { status: 'loading', rows: [], error: null },
      selectedAgentId: null,
      selectedSessionKey: null,
      selectedCapabilityKey: null,
      auth: null,
      bindingError: null,
      runError: null,
      pending: [],
    }
    const props = panelProps(loading, false)
    render(<MeshPanel {...props} />)
    expect(screen.getAllByRole('status')).toHaveLength(3)
    expect(screen.getByText('sessions.pick')).toBeTruthy()
    expect(screen.getByText('binding.noSession')).toBeTruthy()
    expect(screen.getAllByText('transcript.pick')).toHaveLength(2)
    expect(screen.getByText('tasks.heading')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[0]!)
    expect(props.refreshAll).toHaveBeenCalledOnce()
  })

  it('covers empty transcript and task projections and a completed account outcome', () => {
    const selected: AgentMeshSnapshot = {
      ...readySnapshot(),
      sessions: { codex: { status: 'ready', rows: [secondSession], error: null } },
      selectedSessionKey: secondSession.key,
      transcripts: {
        [secondSession.key]: {
          status: 'ready', error: null,
          value: { key: secondSession.key, hasMore: false, messages: [], notes: [] },
        },
      },
      tasks: { [secondSession.key]: { status: 'ready', error: null, value: { available: false, todos: [], notes: [] } } },
      bindings: { status: 'ready', rows: [], error: null },
      pending: [],
    }
    const view = render(<MeshPanel {...panelProps(selected)} />)
    expect(screen.getByRole('heading', { name: 'Follow-up' })).toBeTruthy()
    expect(screen.getByText('transcript.empty')).toBeTruthy()
    expect(screen.getByText('tasks.unavailable')).toBeTruthy()
    expect(screen.getByText('binding.none')).toBeTruthy()

    const withEmptyPlan: AgentMeshSnapshot = {
      ...selected,
      tasks: {
        [secondSession.key]: {
          status: 'ready', error: null,
          value: { available: true, todos: [], plan: { active: false, items: [] }, notes: [] },
        },
      },
      credentials: {
        status: 'ready', error: null,
        rows: [{
          agentId: 'pi', displayName: 'Pi', state: { status: 'unauthenticated', source: 'none' },
          loginFlows: ['interactive'], canLogout: false,
        }],
      },
      auth: { agentId: 'pi', action: 'logout', ok: false, instructions: 'finish manually', output: null },
    }
    view.rerender(<MeshPanel {...panelProps(withEmptyPlan)} />)
    expect(screen.getByText('tasks.empty')).toBeTruthy()
    expect(screen.getByText('tasks.planInactive')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'accounts.heading' })).getAllByText('accounts.logout')).toHaveLength(1)
    expect(screen.getByText('finish manually')).toBeTruthy()

    view.rerender(<MeshPanel {...panelProps({
      ...withEmptyPlan,
      auth: { agentId: 'pi', action: 'logout', ok: true, instructions: null, output: null },
    })} />)
    expect(within(screen.getByRole('region', { name: 'accounts.heading' })).getAllByText('accounts.logout')).toHaveLength(1)
  })

  it('shows retry controls for read errors and empty ready lists', () => {
    const snapshot = readySnapshot()
    const failed: AgentMeshSnapshot = {
      ...snapshot,
      agents: { status: 'error', rows: [], error: 'agent read failed' },
      sessions: { codex: { status: 'error', rows: [], error: 'session read failed' } },
      transcripts: { 'codex:native-1': { status: 'error', value: null, error: 'transcript read failed' } },
      tasks: { 'codex:native-1': { status: 'error', value: null, error: 'tasks read failed' } },
      capabilities: {
        [JSON.stringify(['codex', '/repo'])]: { status: 'error', value: null, error: 'capability read failed' },
      },
      credentials: { status: 'error', rows: [], error: 'credential read failed' },
      runs: { status: 'ready', rows: [], error: null },
      bindings: { status: 'ready', rows: [], error: null },
      bindingError: null,
      runError: null,
    }
    const props = panelProps(failed)
    render(<MeshPanel {...props} />)
    expect(screen.getByText('agent read failed')).toBeTruthy()
    expect(screen.getByText('session read failed')).toBeTruthy()
    expect(screen.getByText('transcript read failed')).toBeTruthy()
    expect(screen.getByText('tasks read failed')).toBeTruthy()
    expect(screen.getByText('capability read failed')).toBeTruthy()
    expect(screen.getByText('runs.empty')).toBeTruthy()
    expect(screen.getByText('credential read failed')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'retry' })[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'retry' })[1]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'retry' })[2]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'retry' })[3]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'retry' })[4]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[2]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[3]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[4]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'refresh' })[5]!)
    const accounts = screen.getByRole('region', { name: 'accounts.heading' })
    fireEvent.click(within(accounts).getByRole('button', { name: 'retry' }))
    expect(props.refreshAgents).toHaveBeenCalled()
    expect(props.refreshSessions).toHaveBeenCalled()
    expect(props.refreshCredentials).toHaveBeenCalled()
    expect(props.refreshRuns).toHaveBeenCalled()
    expect(props.refreshSession).not.toHaveBeenCalled()
    expect(props.refreshCapabilities).toHaveBeenCalledWith({ agentId: 'codex' })
    expect(props.refreshSession).not.toHaveBeenCalled()
  })

  it('renders empty and denied capability inventories and protects a retry without an agent', () => {
    const base = readySnapshot()
    const key = JSON.stringify(['codex', '/repo'])
    const emptyInventory: AgentCapabilityInventory = {
      agentId: codexAgentId, tools: [], skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T08:00:00.000Z',
    }
    const view = render(<MeshPanel {...panelProps({
      ...base,
      capabilities: { [key]: { status: 'ready', value: emptyInventory, error: null } },
    })} />)
    expect(screen.getByText('capabilities.empty')).toBeTruthy()

    view.rerender(<MeshPanel {...panelProps({
      ...base,
      capabilities: { [key]: { status: 'ready', value: null, error: null } },
    })} />)
    expect(screen.getByText('capabilities.unavailable')).toBeTruthy()

    const missing = panelProps({ ...base, selectedCapabilityKey: 'missing', capabilities: {} })
    view.rerender(<MeshPanel {...missing} />)
    expect(screen.getByText('capabilities.pick')).toBeTruthy()

    const withoutAgent = panelProps({
      ...base,
      selectedAgentId: null,
      selectedCapabilityKey: key,
      capabilities: { [key]: { status: 'error', value: null, error: 'permission denied' } },
    })
    view.rerender(<MeshPanel {...withoutAgent} />)
    fireEvent.click(within(screen.getByRole('region', { name: 'capabilities.heading' })).getByRole('button', { name: 'retry' }))
    expect(withoutAgent.refreshCapabilities).not.toHaveBeenCalled()
  })

  it('renders ready empty lists and a selected agent without a session cache', () => {
    const empty: AgentMeshSnapshot = {
      ...readySnapshot(),
      agents: { status: 'ready', rows: [], error: null },
      sessions: {},
      selectedSessionKey: 'missing-session',
      transcripts: {},
      tasks: {},
      credentials: { status: 'ready', rows: [], error: null },
      bindings: { status: 'ready', rows: [], error: null },
      runs: { status: 'ready', rows: [], error: null },
      auth: null,
      pending: [],
    }
    const view = render(<MeshPanel {...panelProps(empty)} />)
    expect(screen.getByText('agents.empty')).toBeTruthy()
    expect(screen.getByText('sessions.pick')).toBeTruthy()
    expect(screen.getByText('accounts.empty')).toBeTruthy()
    expect(screen.getByText('runs.empty')).toBeTruthy()

    view.rerender(<MeshPanel {...panelProps({
      ...empty,
      sessions: { codex: { status: 'ready', rows: [], error: null } },
      selectedSessionKey: null,
      transcripts: {},
      tasks: {},
    })} />)
    expect(screen.getByText('sessions.empty')).toBeTruthy()
  })

  it('retries transcript and task reads for the selected session', () => {
    const snapshot: AgentMeshSnapshot = {
      ...readySnapshot(),
      transcripts: { [session.key]: { status: 'error', value: null, error: 'transcript unavailable' } },
      tasks: { [session.key]: { status: 'error', value: null, error: 'tasks unavailable' } },
    }
    const props = panelProps(snapshot)
    render(<MeshPanel {...props} />)
    fireEvent.click(within(screen.getByRole('region', { name: 'transcript.heading' })).getByRole('button', { name: 'retry' }))
    fireEvent.click(within(screen.getByRole('region', { name: 'tasks.heading' })).getByRole('button', { name: 'retry' }))
    expect(props.refreshSession).toHaveBeenCalledTimes(2)
  })
})
