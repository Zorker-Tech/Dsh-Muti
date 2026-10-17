/**
 * Agent mesh pages: the registered external agents, one agent's own sessions,
 * the selected session's transcript and native tasks, the current Session's
 * binding, tracked runs, account state, and shared collaboration records.
 *
 * The panel owns no data of its own: it renders the shared mesh source
 * (`props.useMesh`) and issues that source's actions. Selection lives in the
 * source so the panel and its connection-reset readback agree on what is on
 * screen.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { Button, CodeBlock, Menu, Pill, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the root-scoped `useSessions` seat the panel reads the open Session from.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentCapabilityInventory, AgentLoginFlow, AgentMessage, AgentNativeTasks } from '@deepseek-ai/dsh-agent-mesh/types'
import type { MeshCollaborationActions, MeshCollaborationSnapshot } from './collaboration-store.ts'
import { CollaborationPanel } from './CollaborationPanel.tsx'
import type {
  MeshAgentRow, MeshCapabilityRequest, MeshCredentialRow, MeshLaunchCommand, MeshRunRow,
  MeshSessionRequest, MeshSessionRow, MeshTranscriptResponse,
} from '@deepseek-ai/dsh-agent-mesh-controller/types'
import {
  agentLabel, authSourceKey, authStatusKey, loginFlowKey, messageRoleKey,
  moment, runStatusKey, sessionStatusKey, todoStatusKey,
  nativeLaunchCommandText,
} from './mesh-format.ts'
import { runEventPreview } from './run-event-preview.ts'
import type { AgentMeshActions, AgentMeshSnapshot, MeshListState, MeshReadStatus, MeshValueState } from './mesh-store.ts'
import { authPendingKey, bindPendingKey, runPendingKey } from './mesh-store.ts'
import css from './MeshPanel.module.css'

/** Injected mesh source and its complete mutation API. */
export interface MeshPanelInjected extends AgentMeshActions {
  /** Shared mesh snapshot; the renderer binds it to `useMesh`. */
  readonly hooks: {
    readonly mesh: HostObservable<AgentMeshSnapshot>
    readonly collaboration: HostObservable<MeshCollaborationSnapshot>
  }
  /** Read and update the Remote-backed collaboration view. */
  readonly collaborationActions: MeshCollaborationActions
  /** Resolve one exact native session's TUI argv without starting the CLI. */
  readonly launchCommand: (request: MeshSessionRequest) => Promise<MeshLaunchCommand | null>
  /** Queue one selected native-session task into an open Harness Session. */
  readonly queueDispatchPrompt: (sessionId: SessionId, prompt: string) => Promise<void>
}

/** Composed props of the Agent mesh main panel. */
export type MeshPanelProps = PropsRuntime<'main'>
  & InjectFace<MeshPanelInjected>
  & PropsLocale<'agentMesh'>

/** Translate seat of this panel's namespace. */
type Translate = TranslateNS<'agentMesh'>
type PanelTab = 'agents' | 'collaboration'

/** One read's non-content states, shared by every section of the panel. */
function ReadFeedback({ status, populated, error, onRetry, t }: {
  status: MeshReadStatus
  populated: boolean
  error: string | null
  onRetry: () => void
  t: Translate
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

/** One agent row: detection state, version, and the diagnostics it reported. */
function AgentRow({ agent, selected, onSelect, t }: {
  agent: MeshAgentRow
  selected: boolean
  onSelect: () => void
  t: Translate
}) {
  return (
    <li>
      <button
        type="button"
        className={clsx(css.row, selected && css.rowSelected)}
        aria-pressed={selected}
        aria-label={t('agents.select', { name: agent.displayName })}
        onClick={onSelect}
      >
        <span className={css.rowTitle}>{agent.displayName}</span>
        <span className={css.rowMeta}>
          <span className={agent.installed ? css.installed : css.missing}>
            {t(agent.installed ? 'agents.installed' : 'agents.notInstalled')}
          </span>
          {agent.version !== undefined && <span>{t('agents.version', { version: agent.version })}</span>}
          {!agent.installed && agent.detectionReason !== undefined && <span>{agent.detectionReason}</span>}
        </span>
        {agent.binaryPath !== undefined
          && <span className={css.rowDetail}>{t('agents.binary', { path: agent.binaryPath })}</span>}
        {agent.warnings.length > 0 && (
          <span className={css.rowNotes}>
            <span className={css.rowMeta}>{t('agents.warnings')}</span>
            <ul>{agent.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
          </span>
        )}
      </button>
    </li>
  )
}

/** One session of the selected agent, in the agent's own naming. */
function SessionRow({ session, selected, onSelect, t }: {
  session: MeshSessionRow
  selected: boolean
  onSelect: () => void
  t: Translate
}) {
  const status = sessionStatusKey(session.status)
  return (
    <li>
      <button
        type="button"
        className={clsx(css.row, selected && css.rowSelected)}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className={css.rowTitle}>{session.title === '' ? session.nativeId : session.title}</span>
        <span className={css.rowMeta}>
          <span>{t('sessions.updated', { time: moment(session.updatedAt) })}</span>
          <span>{status === null ? session.status : t(status)}</span>
          {session.messageCount !== undefined && <span>{t('sessions.messages', { count: session.messageCount })}</span>}
        </span>
        {session.cwd !== undefined && <span className={css.rowDetail}>{t('sessions.cwd')} {session.cwd}</span>}
        {session.model !== undefined && <span className={css.rowDetail}>{t('sessions.model')} {session.model}</span>}
        {session.notes.length > 0 && (
          <span className={css.rowNotes}>
            <span className={css.rowMeta}>{t('sessions.notes')}</span>
            <ul>{session.notes.map(note => <li key={note}>{note}</li>)}</ul>
          </span>
        )}
      </button>
    </li>
  )
}

/** Display a shell-safe native TUI command only after the person asks for it. */
function NativeLaunchSection({ session, launchCommand, t }: {
  session: MeshSessionRow
  launchCommand: (request: MeshSessionRequest) => Promise<MeshLaunchCommand | null>
  t: Translate
}) {
  const [state, setState] = useState<MeshValueState<MeshLaunchCommand | null> | null>(null)
  const requestSequence = useRef(0)
  useEffect(() => () => { requestSequence.current++ }, [])
  const load = (): void => {
    const sequence = ++requestSequence.current
    setState({ status: 'loading', value: null, error: null })
    void launchCommand({ agentId: session.agentId, sessionId: session.nativeId }).then((value) => {
      if (requestSequence.current === sequence) setState({ status: 'ready', value, error: null })
    }).catch((cause: unknown) => {
      if (requestSequence.current !== sequence) return
      setState({ status: 'error', value: null, error: cause instanceof Error ? cause.message : String(cause) })
    })
  }
  return (
    <section className={css.section} aria-label={t('sessions.nativeLaunch')}>
      <div className={css.sectionHead}>
        <h3>{t('sessions.nativeLaunch')}</h3>
        <Button size="sm" disabled={state?.status === 'loading'} onClick={load}>
          {state?.status === 'ready' ? t('sessions.refreshLaunch') : t('sessions.showLaunch')}
        </Button>
      </div>
      {state !== null && <ReadFeedback
        status={state.status}
        populated={state.value !== null}
        error={state.error}
        onRetry={load}
        t={t}
      />}
      {state?.value !== null && state?.value !== undefined && <>
        <p className={css.muted}>{t('sessions.launchHelp')}</p>
        <CodeBlock
          code={nativeLaunchCommandText(state.value.argv, state.value.shell)}
          lang={state.value.shell === 'powershell' ? 'powershell' : 'bash'}
          showHeader={false}
          copyLabel={t('sessions.copyCommand')}
          copiedLabel={t('sessions.copiedCommand')}
        />
      </>}
      {state?.status === 'ready' && state.value === null && <p className={css.muted}>{t('sessions.launchUnavailable')}</p>}
    </section>
  )
}

/** Queue a selected native-session task as a logged user message for DSH mesh_run. */
function DispatchTaskSection({ session, currentSessionId, currentSessionTitle, queueDispatchPrompt, t }: {
  session: MeshSessionRow
  currentSessionId: SessionId | null
  currentSessionTitle: string | null
  queueDispatchPrompt: (sessionId: SessionId, prompt: string) => Promise<void>
  t: Translate
}) {
  const taskInputId = useId()
  const [task, setTask] = useState('')
  const [pending, setPending] = useState(false)
  const [queued, setQueued] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  useEffect(() => () => { requestSequence.current++ }, [])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (currentSessionId === null || session.cwd === undefined || task.trim() === '' || pending) return
    const sequence = ++requestSequence.current
    const generatedPrompt = t('dispatch.promptTemplate', {
      argumentsJson: JSON.stringify({
        agentId: session.agentId,
        cwd: session.cwd,
        resumeNativeId: session.nativeId,
        prompt: task,
      }, null, 2),
    })
    setPending(true)
    setQueued(false)
    setError(null)
    void queueDispatchPrompt(currentSessionId, generatedPrompt).then(() => {
      if (requestSequence.current !== sequence) return
      setTask('')
      setQueued(true)
    }).catch((cause: unknown) => {
      if (requestSequence.current !== sequence) return
      const message = cause instanceof Error
        ? cause.message
        : typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string'
          ? cause.message
          : String(cause)
      setError(message)
    }).finally(() => {
      if (requestSequence.current === sequence) setPending(false)
    })
  }

  const unavailable = currentSessionId === null || session.cwd === undefined
  return (
    <section className={css.section} aria-label={t('dispatch.heading')}>
      <h3>{t('dispatch.heading')}</h3>
      <p className={css.muted}>{t('dispatch.target', {
        agentId: session.agentId,
        nativeId: session.nativeId,
        cwd: session.cwd ?? t('dispatch.cwdNotRecorded'),
      })}</p>
      {currentSessionTitle === null
        ? <p className={css.muted} role="status">{t('dispatch.noHarnessSession')}</p>
        : <p className={css.muted}>{t('dispatch.currentSession', { title: currentSessionTitle })}</p>}
      {session.cwd === undefined && <p className={css.muted} role="status">{t('dispatch.cwdUnavailable')}</p>}
      <p className={css.muted}>{t('dispatch.help')}</p>
      <form className={css.dispatchForm} onSubmit={submit}>
        <label htmlFor={taskInputId}>{t('dispatch.taskLabel')}</label>
        <textarea
          id={taskInputId}
          className={css.dispatchTextarea}
          value={task}
          placeholder={t('dispatch.placeholder')}
          disabled={pending}
          onChange={(event) => {
            setTask(event.currentTarget.value)
            setQueued(false)
            setError(null)
          }}
        />
        <div className={css.actions}>
          <Button type="submit" disabled={unavailable || pending || task.trim() === ''}>
            {pending ? t('dispatch.sending') : t('dispatch.queue')}
          </Button>
          {queued && <span className={css.muted} role="status">{t('dispatch.queued')}</span>}
          {error !== null && <span className={css.failed} role="alert">{t('dispatch.error', { message: error })}</span>}
        </div>
      </form>
    </section>
  )
}

/** Body text of one projected message; the projection caps it, never the panel. */
function messageBody(message: AgentMessage): string | null {
  if (message.text !== undefined && message.text !== '') return message.text
  if (message.toolInput !== undefined && message.toolInput !== '') return message.toolInput
  if (message.toolOutput !== undefined && message.toolOutput !== '') return message.toolOutput
  return null
}

/** One transcript message: role, kind-specific annotations, and its text. */
function MessageRow({ message, t }: { message: AgentMessage; t: Translate }) {
  const body = messageBody(message)
  return (
    <li className={css.message}>
      <div className={css.itemHead}>
        <span className={css.role}>{t(messageRoleKey(message.role))}</span>
        {message.toolName !== undefined
          && <span className={css.tag}>{t('transcript.tool', { name: message.toolName })}</span>}
        {message.kind === 'unknown' && message.nativeType !== undefined
          && <span className={css.tag}>{t('transcript.nativeType', { type: message.nativeType })}</span>}
        {message.failed === true && <span className={css.failed}>{t('transcript.failed')}</span>}
        {message.truncated === true && <span className={css.tag}>{t('transcript.truncated')}</span>}
        {message.timestamp !== undefined && <span className={css.time}>{moment(message.timestamp)}</span>}
      </div>
      {body !== null && <pre className={css.messageBody}>{body}</pre>}
      {message.paths !== undefined && message.paths.length > 0
        && <ul className={css.notes}>{message.paths.map(path => <li key={path}>{path}</li>)}</ul>}
    </li>
  )
}

/** The selected session's transcript window. */
function TranscriptSection({ state, onRetry, t }: {
  state: MeshValueState<MeshTranscriptResponse> | null
  onRetry: () => void
  t: Translate
}) {
  return (
    <section className={css.section} aria-label={t('transcript.heading')}>
      <h2>{t('transcript.heading')}</h2>
      {state === null
        ? <p className={css.muted}>{t('transcript.pick')}</p>
        : <>
          <ReadFeedback
            status={state.status}
            populated={state.value !== null}
            error={state.error}
            onRetry={onRetry}
            t={t}
          />
          {state.value !== null && <>
            {state.value.totalMessages !== undefined
              && <p className={css.muted}>{t('transcript.total', { count: state.value.totalMessages })}</p>}
            {state.value.hasMore && <p className={css.muted}>{t('transcript.more')}</p>}
            {state.value.messages.length === 0
              ? <p className={css.muted}>{t('transcript.empty')}</p>
              : <ol className={css.messages}>
                {state.value.messages.map(message => <MessageRow key={message.index} message={message} t={t} />)}
              </ol>}
            {state.value.notes.length > 0 && <ul className={css.notes}>
              {state.value.notes.map(note => <li key={note}>{note}</li>)}
            </ul>}
          </>}
        </>}
    </section>
  )
}

/** The selected session's native todos and plan. */
function TasksSection({ state, onRetry, t }: {
  state: MeshValueState<AgentNativeTasks> | null
  onRetry: () => void
  t: Translate
}) {
  return (
    <section className={css.section} aria-label={t('tasks.heading')}>
      <h2>{t('tasks.heading')}</h2>
      {state === null
        ? <p className={css.muted}>{t('transcript.pick')}</p>
        : <>
          <ReadFeedback
            status={state.status}
            populated={state.value !== null}
            error={state.error}
            onRetry={onRetry}
            t={t}
          />
          {state.value !== null && (!state.value.available
            ? <p className={css.muted}>{t('tasks.unavailable')}</p>
            : <>
              {state.value.todos.length === 0
                ? <p className={css.muted}>{t('tasks.empty')}</p>
                : <ul className={css.todos}>
                  {state.value.todos.map(todo => (
                    <li key={todo.id} className={css.todo}>
                      <Pill>{t(todoStatusKey(todo.status))}</Pill>
                      <span>{todo.content}</span>
                      {todo.blockedBy.length > 0
                        && <span className={css.tag}>{t('tasks.blockedBy', { keys: todo.blockedBy.join(', ') })}</span>}
                    </li>
                  ))}
                </ul>}
              {state.value.plan !== undefined && (
                <div className={css.plan}>
                  <h3>{t('tasks.plan')}</h3>
                  <p className={css.muted}>{t(state.value.plan.active ? 'tasks.planActive' : 'tasks.planInactive')}</p>
                  <ol className={css.planItems}>
                    {state.value.plan.items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
                  </ol>
                </div>
              )}
              {state.value.notes.length > 0 && <ul className={css.notes}>
                {state.value.notes.map(note => <li key={note}>{note}</li>)}
              </ul>}
            </>)}
        </>}
    </section>
  )
}

/** One read-only inventory of native tools, skills, MCP servers, and context. */
function CapabilitiesSection({ state, onRetry, t }: {
  state: MeshValueState<AgentCapabilityInventory | null> | null
  onRetry: () => void
  t: Translate
}) {
  return (
    <section className={css.section} aria-label={t('capabilities.heading')}>
      <div className={css.sectionHead}>
        <h2>{t('capabilities.heading')}</h2>
        {state !== null && <Button size="sm" onClick={onRetry}>{t('refresh')}</Button>}
      </div>
      {state === null
        ? <p className={css.muted}>{t('capabilities.pick')}</p>
        : <>
          <ReadFeedback status={state.status} populated={state.value !== null} error={state.error} onRetry={onRetry} t={t} />
          {state.status === 'ready' && state.value === null && <p className={css.muted}>{t('capabilities.unavailable')}</p>}
          {state.value !== null && <>
            {state.value.tools.length === 0 && state.value.skills.length === 0 && state.value.mcpServers.length === 0
              && state.value.commands.length === 0 && state.value.contextFiles.length === 0
              && <p className={css.muted}>{t('capabilities.empty')}</p>}
            {state.value.tools.length > 0 && <CapabilityGroup title={t('capabilities.tools')}>
              {state.value.tools.map((tool, index) => (
                <li key={`${tool.name}:${tool.source}:${tool.path ?? ''}:${index}`}>
                  <span>{tool.name}</span><span className={css.rowMeta}>{t('capabilities.source', { source: tool.source })}</span>
                  {tool.approval !== undefined && <span className={css.rowDetail}>{t('capabilities.approval', { mode: tool.approval })}</span>}
                  {tool.discoverable === true && <span className={css.rowDetail}>{t('capabilities.discoverable')}</span>}
                  {tool.path !== undefined && <span className={css.rowDetail}>{tool.path}</span>}
                  {tool.description !== undefined && <span className={css.rowDetail}>{tool.description}</span>}
                </li>
              ))}
            </CapabilityGroup>}
            {state.value.skills.length > 0 && <CapabilityGroup title={t('capabilities.skills')}>
              {state.value.skills.map((skill, index) => (
                <li key={`${skill.name}:${skill.source}:${skill.path ?? ''}:${index}`}>
                  <span>{skill.name}</span><span className={css.rowMeta}>{t('capabilities.source', { source: skill.source })}</span>
                  {skill.description !== undefined && <span className={css.rowDetail}>{skill.description}</span>}
                  {skill.path !== undefined && <span className={css.rowDetail}>{skill.path}</span>}
                </li>
              ))}
            </CapabilityGroup>}
            {state.value.mcpServers.length > 0 && <CapabilityGroup title={t('capabilities.mcp')}>
              {state.value.mcpServers.map(server => (
                <li key={`${server.name}:${server.source}`}>
                  <span>{server.name}</span><span className={css.rowMeta}>{t('capabilities.server', { transport: server.transport, state: t(server.enabled ? 'capabilities.enabled' : 'capabilities.disabled') })}</span>
                  {server.command !== undefined && <span className={css.rowDetail}>{server.command}</span>}
                  {server.url !== undefined && <span className={css.rowDetail}>{server.url}</span>}
                </li>
              ))}
            </CapabilityGroup>}
            {state.value.commands.length > 0 && <CapabilityGroup title={t('capabilities.commands')}>
              {state.value.commands.map((command, index) => (
                <li key={`${command.name}:${command.source}:${index}`}>
                  <span>/{command.name}</span><span className={css.rowMeta}>{t('capabilities.source', { source: command.source })}</span>
                  {command.description !== undefined && <span className={css.rowDetail}>{command.description}</span>}
                </li>
              ))}
            </CapabilityGroup>}
            {state.value.contextFiles.length > 0 && <CapabilityGroup title={t('capabilities.contextFiles')}>
              {state.value.contextFiles.map(path => <li key={path}>{path}</li>)}
            </CapabilityGroup>}
            {state.value.notes.length > 0 && <>
              <h3 className={css.rowMeta}>{t('capabilities.notes')}</h3>
              <ul className={css.notes}>
                {state.value.notes.map((note, index) => <li key={`${note.field}:${index}`}>{note.field}: {note.reason}</li>)}
              </ul>
            </>}
          </>}
        </>}
    </section>
  )
}

/** Render one titled group in the capability inventory. */
function CapabilityGroup({ title, children }: { title: string; children: ReactNode }) {
  return <div><h3 className={css.rowMeta}>{title}</h3><ul className={css.items}>{children}</ul></div>
}

/** The current Session's bound agent, with binding and unbinding. */
function BindingSection({ sessionId, boundAgentId, agents, pending, error, onBind, onUnbind, onDismissError, t }: {
  sessionId: string | null
  boundAgentId: string | null
  agents: readonly MeshAgentRow[]
  pending: boolean
  error: string | null
  onBind: (agentId: string) => void
  onUnbind: () => void
  onDismissError: () => void
  t: Translate
}) {
  const [picking, setPicking] = useState(false)
  return (
    <section className={css.section} aria-label={t('binding.heading')}>
      <h2>{t('binding.heading')}</h2>
      {sessionId === null
        ? <p className={css.muted}>{t('binding.noSession')}</p>
        : <>
          {boundAgentId === null
            ? <p className={css.muted}>{t('binding.none')}</p>
            : <p>{t('binding.bound', { name: agentLabel(agents, boundAgentId) })}</p>}
          {error !== null && (
            <p className={css.error} role="alert">
              <span>{t('binding.error')} {error}</span>
              <Button size="sm" onClick={onDismissError}>{t('dismiss')}</Button>
            </p>
          )}
          <div className={css.actions}>
            <Menu
              open={picking}
              anchor={<Button size="sm" disabled={pending} onClick={() => { setPicking(true) }}>{t('binding.choose')}</Button>}
              items={agents.map(agent => ({
                id: agent.agentId,
                disabled: !agent.installed,
                label: agent.installed ? agent.displayName : t('binding.agentUninstalled', { name: agent.displayName }),
              }))}
              onSelect={(agentId) => {
                setPicking(false)
                onBind(agentId)
              }}
              onClose={() => { setPicking(false) }}
            />
            {boundAgentId !== null && <Button size="sm" disabled={pending} onClick={onUnbind}>{t('binding.unbind')}</Button>}
            {pending && <span className={css.muted}>{t('binding.pending')}</span>}
          </div>
        </>}
    </section>
  )
}

/** One dispatched run: its identity, state, and outcome. */
function RunRow({ run, pending, agentName, onCancel, t }: {
  run: MeshRunRow
  pending: boolean
  agentName: string
  onCancel: () => void
  t: Translate
}) {
  return (
    <li className={css.item}>
      <div className={css.itemHead}>
        <code className={css.id}>{run.runId}</code>
        <span className={css.tag}>{t('runs.agent', { agentId: agentName })}</span>
        <Pill>{t(runStatusKey(run.status))}</Pill>
        <span className={css.time}>{t('runs.started', { time: moment(run.startedAt) })}</span>
        {run.status === 'running' && <Button size="sm" disabled={pending} onClick={onCancel}>
          {t(pending ? 'runs.cancelling' : 'runs.cancel')}
        </Button>}
      </div>
      <RunActivity run={run} t={t} />
      {run.finalText !== undefined && (
        <div className={css.itemBlock}>
          <span className={css.rowMeta}>{t('runs.final')}</span>
          <pre className={css.messageBody}>{run.finalText}</pre>
        </div>
      )}
      {run.error !== undefined && (
        <div className={css.itemBlock}>
          <span className={css.rowMeta}>{t('runs.failure')}</span>
          <p className={css.failed}>{run.error.message}</p>
          <span className={css.tag}>{t('runs.code', { code: run.error.code })}</span>
          {run.error.remediation !== undefined && <>
            <span className={css.rowMeta}>{t('runs.remediation')}</span>
            <p>{run.error.remediation}</p>
          </>}
        </div>
      )}
      {run.notes.length > 0 && <ul className={css.notes}>{run.notes.map(note => <li key={note}>{note}</li>)}</ul>}
    </li>
  )
}

/** Recent safe progress events from one tracked run. */
function RunActivity({ run, t }: { readonly run: MeshRunRow; readonly t: Translate }) {
  const events = run.events.slice(-20)
  if (events.length === 0) return null
  const omitted = Math.max(0, run.eventCount - events.length)
  return (
    <details className={css.runActivity} open={run.status === 'running'}>
      <summary>{t('runs.activity', { count: run.eventCount })}</summary>
      {omitted > 0 && <p className={css.muted}>{t('runs.activityOmitted', { count: omitted })}</p>}
      <ol className={css.runEvents}>
        {events.map((event, index) => {
          const preview = runEventPreview(event)
          return (
            <li key={`${event.kind}:${index}`} className={css.runEvent}>
              <div className={css.runEventHeading}>
                <code>{event.kind}</code>
                <time dateTime={event.at}>{moment(event.at)}</time>
              </div>
              {preview !== null && preview !== '' && <p className={css.runEventPreview}>{preview}</p>}
            </li>
          )
        })}
      </ol>
    </details>
  )
}

/** The tracked runs, with their refresh and cancellation. */
function RunsSection({ state, pending, agents, error, onRefresh, onCancel, onDismissError, t }: {
  state: MeshListState<MeshRunRow>
  pending: readonly string[]
  agents: readonly MeshAgentRow[]
  error: string | null
  onRefresh: () => void
  onCancel: (runId: string) => void
  onDismissError: () => void
  t: Translate
}) {
  return (
    <section className={css.section} aria-label={t('runs.heading')}>
      <div className={css.sectionHead}>
        <h2>{t('runs.heading')}</h2>
        <Button size="sm" onClick={onRefresh}>{t('refresh')}</Button>
      </div>
      {error !== null && (
        <p className={css.error} role="alert">
          <span>{t('runs.cancelError')} {error}</span>
          <Button size="sm" onClick={onDismissError}>{t('dismiss')}</Button>
        </p>
      )}
      <ReadFeedback status={state.status} populated={state.rows.length > 0} error={state.error} onRetry={onRefresh} t={t} />
      {state.status === 'ready' && state.rows.length === 0 && <p className={css.muted}>{t('runs.empty')}</p>}
      <ul className={css.items}>
        {state.rows.map(run => (
          <RunRow
            key={run.runId}
            run={run}
            pending={pending.includes(runPendingKey(run.runId))}
            agentName={agentLabel(agents, run.agentId)}
            onCancel={() => { onCancel(run.runId) }}
            t={t}
          />
        ))}
      </ul>
    </section>
  )
}

/** One agent's account state with its sign-in and sign-out controls. */
function AccountRow({ row, pending, outcome, onLogin, onLogout, onDismiss, t }: {
  row: MeshCredentialRow
  pending: boolean
  outcome: AgentMeshSnapshot['auth']
  onLogin: (flow: AgentLoginFlow, secret?: string) => void
  onLogout: () => void
  onDismiss: () => void
  t: Translate
}) {
  const [picking, setPicking] = useState(false)
  const [apiKeyEntryOpen, setApiKeyEntryOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const apiKeyInputId = useId()
  const { state } = row
  const clearApiKeyEntry = (): void => {
    setApiKey('')
    setApiKeyEntryOpen(false)
  }
  return (
    <li className={css.item}>
      <div className={css.itemHead}>
        <span className={css.rowTitle}>{row.displayName}</span>
        <Pill>{t(authStatusKey(state.status))}</Pill>
        <span className={css.tag}>{t(authSourceKey(state.source))}</span>
        {state.method !== undefined && <span className={css.tag}>{t('accounts.method', { method: state.method })}</span>}
        {state.expiresAt !== undefined
          && <span className={css.time}>{t('accounts.expires', { time: moment(state.expiresAt) })}</span>}
        {row.loginFlows.length > 0 && <Menu
          open={picking}
          anchor={<Button size="sm" disabled={pending} onClick={() => { setPicking(true) }}>{t('accounts.login')}</Button>}
          items={row.loginFlows.map(flow => ({ id: flow, label: t(loginFlowKey(flow)) }))}
          onSelect={(id) => {
            setPicking(false)
            const flow = row.loginFlows.find(candidate => candidate === id)
            /* v8 ignore next -- Menu only emits ids from this row's declared flow items. */
            if (flow === undefined) return
            if (flow === 'api-key') {
              setApiKey('')
              setApiKeyEntryOpen(true)
              return
            }
            clearApiKeyEntry()
            onLogin(flow)
          }}
          onClose={() => { setPicking(false) }}
        />}
        {row.canLogout && <Button size="sm" disabled={pending} onClick={onLogout}>{t('accounts.logout')}</Button>}
        {pending && <span className={css.muted}>{t('accounts.pending')}</span>}
      </div>
      {state.detail !== undefined && <p className={css.rowDetail}>{t('accounts.detail')} {state.detail}</p>}
      {apiKeyEntryOpen && <form
        className={css.apiKeyForm}
        onSubmit={(event) => {
          event.preventDefault()
          const secret = apiKey
          clearApiKeyEntry()
          onLogin('api-key', secret)
        }}
      >
        <label htmlFor={apiKeyInputId}>{t('accounts.apiKeyLabel')}</label>
        <input
          id={apiKeyInputId}
          className={css.apiKeyInput}
          type="password"
          autoComplete="new-password"
          required
          spellCheck={false}
          maxLength={16_384}
          value={apiKey}
          disabled={pending}
          onChange={(event) => { setApiKey(event.currentTarget.value) }}
        />
        <p className={css.muted}>{t('accounts.apiKeyHelp')}</p>
        <div className={css.actions}>
          <Button type="submit" size="sm" disabled={pending || apiKey.trim() === ''}>
            {t('accounts.submitLogin')}
          </Button>
          <Button type="button" size="sm" disabled={pending} onClick={clearApiKeyEntry}>
            {t('dismiss')}
          </Button>
        </div>
      </form>}
      {outcome !== null && outcome.agentId === row.agentId && (
        <div className={css.itemBlock}>
          <span className={css.rowMeta}>
            {t(outcome.action === 'login' ? 'accounts.login' : 'accounts.logout')}
          </span>
          {/* An adapter that could not complete the operation itself states what the user must run. */}
          {!outcome.ok && <>
            <span className={css.rowMeta}>{t('accounts.instructions')}</span>
            {outcome.instructions !== null && <p>{outcome.instructions}</p>}
          </>}
          {outcome.output !== null && <>
            <span className={css.rowMeta}>{t('accounts.output')}</span>
            <pre className={css.messageBody}>{outcome.output}</pre>
          </>}
          <Button size="sm" onClick={onDismiss}>{t('dismiss')}</Button>
        </div>
      )}
    </li>
  )
}

/**
 * Render the Agent mesh panel: agents, their sessions, the selected session's
 * transcript and native tasks, the current Session's binding, runs, and
 * accounts.
 * @param props - framework runtime and hook shares, the injected source with its actions, and the locale seat.
 * @returns the panel body.
 */
export function MeshPanel(props: MeshPanelProps) {
  const {
    useMesh, useSessions, t, refreshAll, refreshAgents, refreshSessions, refreshSession, refreshRuns,
    refreshCredentials, refreshCapabilities, selectAgent, selectSession, bind, unbind, cancelRun, login, logout,
    dismissAuth, dismissBindingError, dismissRunError, launchCommand, queueDispatchPrompt,
    useCollaboration, collaborationActions,
  } = props
  const [activePanelTab, setActivePanelTab] = useState<PanelTab>('agents')
  const [collaborationActionError, setCollaborationActionError] = useState<string | null>(null)
  const mesh = useMesh(snapshot => snapshot)
  // The main-view-retained Session is the one the user is working in; this
  // panel names no Session of its own.
  const activeSession = useSessions(state =>
    Object.values(state.byId).find(row => (row.retainedBy.mainView ?? 0) > 0) ?? null)
  const activeSessionId = activeSession?.id ?? null
  const {
    agents, sessions, capabilities, transcripts, tasks, credentials, bindings, runs,
    selectedAgentId, selectedSessionKey, selectedCapabilityKey, auth, bindingError, runError, pending,
  } = mesh
  const sessionList = selectedAgentId === null ? null : sessions[selectedAgentId] ?? null
  const selectedSession = selectedAgentId === null || selectedSessionKey === null
    ? null
    : sessionList?.rows.find(row => row.key === selectedSessionKey) ?? null
  const transcriptState = selectedSessionKey === null ? null : transcripts[selectedSessionKey] ?? null
  const taskState = selectedSessionKey === null ? null : tasks[selectedSessionKey] ?? null
  const capabilityState = selectedCapabilityKey === null ? null : capabilities[selectedCapabilityKey] ?? null
  const capabilityRequest: MeshCapabilityRequest | null = selectedAgentId === null ? null : {
    agentId: selectedAgentId,
    ...(selectedSession?.cwd === undefined ? {} : { cwd: selectedSession.cwd }),
  }
  const boundAgentId = activeSessionId === null
    ? null
    : bindings.rows.find(row => row.sessionId === activeSessionId)?.agentId ?? null
  const bindingsPending = activeSessionId === null ? false : pending.includes(bindPendingKey(activeSessionId))
  const headingName = selectedAgentId === null ? null : agentLabel(agents.rows, selectedAgentId)
  const reloadSession = (): void => {
    if (selectedSession !== null) void refreshSession(selectedSession.agentId, selectedSession.nativeId)
  }
  const panelTabs: [SegmentedTab<PanelTab>, SegmentedTab<PanelTab>] = [
    { value: 'agents', label: t('tabs.agents'), id: 'agent-mesh-tab-agents', panelId: 'agent-mesh-panel-agents' },
    { value: 'collaboration', label: t('tabs.collaboration'), id: 'agent-mesh-tab-collaboration', panelId: 'agent-mesh-panel-collaboration' },
  ]

  return (
    <section className={css.page} aria-label={t('title')} data-testid="agent-mesh-panel">
      <header className={css.head}>
        <div>
          <h1>{t('title')}</h1>
          <p className={css.intro}>{t('intro')}</p>
        </div>
        <Button onClick={refreshAll}>{t('refresh')}</Button>
      </header>
      <div className={css.tabs}>
        <SegmentedTabs
          items={panelTabs}
          value={activePanelTab}
          onChange={setActivePanelTab}
          label={t('tabs.label')}
        />
      </div>
      <div className={css.body}>
        <section
          id="agent-mesh-panel-agents"
          className={css.tabPanel}
          role="tabpanel"
          aria-labelledby="agent-mesh-tab-agents"
          tabIndex={0}
          hidden={activePanelTab !== 'agents'}
        >
          <div className={css.columns}>
            <div className={css.column}>
              <div className={css.sectionHead}>
                <h2>{t('agents.heading')}</h2>
                <Button size="sm" onClick={() => { void refreshAgents() }}>{t('refresh')}</Button>
              </div>
              <ReadFeedback
                status={agents.status}
                populated={agents.rows.length > 0}
                error={agents.error}
                onRetry={() => { void refreshAgents() }}
                t={t}
              />
              {agents.status === 'ready' && agents.rows.length === 0 && <p className={css.muted}>{t('agents.empty')}</p>}
              <ul className={css.rows}>
                {agents.rows.map(agent => (
                  <AgentRow
                    key={agent.agentId}
                    agent={agent}
                    selected={agent.agentId === selectedAgentId}
                    onSelect={() => { selectAgent(agent.agentId) }}
                    t={t}
                  />
                ))}
              </ul>
            </div>
            <div className={css.column}>
              <div className={css.sectionHead}>
                <h2>{headingName === null ? t('sessions.headingFallback') : t('sessions.heading', { name: headingName })}</h2>
                {selectedAgentId !== null && (
                  <Button size="sm" onClick={() => { void refreshSessions(selectedAgentId) }}>{t('refresh')}</Button>
                )}
              </div>
              {selectedAgentId === null || sessionList === null
                ? <p className={css.muted}>{t('sessions.pick')}</p>
                : <>
                  <ReadFeedback
                    status={sessionList.status}
                    populated={sessionList.rows.length > 0}
                    error={sessionList.error}
                    onRetry={() => { void refreshSessions(selectedAgentId) }}
                    t={t}
                  />
                  {sessionList.status === 'ready' && sessionList.rows.length === 0
                && <p className={css.muted}>{t('sessions.empty')}</p>}
                  <ul className={css.rows}>
                    {sessionList.rows.map(session => (
                      <SessionRow
                        key={session.key}
                        session={session}
                        selected={session.key === selectedSessionKey}
                        onSelect={() => { selectSession({ agentId: session.agentId, sessionId: session.nativeId }) }}
                        t={t}
                      />
                    ))}
                  </ul>
                </>}
            </div>
            <div className={css.column}>
              <BindingSection
                sessionId={activeSessionId}
                boundAgentId={boundAgentId}
                agents={agents.rows}
                pending={bindingsPending}
                error={bindingError}
                // BindingSection renders these controls only with an active Session.
                onBind={(agentId) => {
                  /* v8 ignore next -- BindingSection only renders the picker with a non-null Session id. */
                  if (activeSessionId !== null) void bind(activeSessionId, agentId)
                }}
                onUnbind={() => {
                  /* v8 ignore next -- BindingSection only renders unbind with a non-null Session id. */
                  if (activeSessionId !== null) void unbind(activeSessionId)
                }}
                onDismissError={dismissBindingError}
                t={t}
              />
              {selectedSession !== null && (
                <div className={css.sectionHead}>
                  <h2>{selectedSession.title === '' ? selectedSession.nativeId : selectedSession.title}</h2>
                  <Button size="sm" onClick={reloadSession}>{t('refresh')}</Button>
                </div>
              )}
              {selectedSession !== null && <NativeLaunchSection
                key={selectedSession.key}
                session={selectedSession}
                launchCommand={launchCommand}
                t={t}
              />}
              {selectedSession !== null && <DispatchTaskSection
                key={`dispatch:${selectedSession.key}`}
                session={selectedSession}
                currentSessionId={activeSessionId}
                currentSessionTitle={activeSession?.displayTitle ?? null}
                queueDispatchPrompt={queueDispatchPrompt}
                t={t}
              />}
              <CapabilitiesSection
                state={capabilityState}
                onRetry={() => { if (capabilityRequest !== null) void refreshCapabilities(capabilityRequest) }}
                t={t}
              />
              <TranscriptSection state={transcriptState} onRetry={reloadSession} t={t} />
              <TasksSection state={taskState} onRetry={reloadSession} t={t} />
              <section className={css.section} aria-label={t('accounts.heading')}>
                <div className={css.sectionHead}>
                  <h2>{t('accounts.heading')}</h2>
                  <Button size="sm" onClick={() => { void refreshCredentials() }}>{t('refresh')}</Button>
                </div>
                <ReadFeedback
                  status={credentials.status}
                  populated={credentials.rows.length > 0}
                  error={credentials.error}
                  onRetry={() => { void refreshCredentials() }}
                  t={t}
                />
                {credentials.status === 'ready' && credentials.rows.length === 0
              && <p className={css.muted}>{t('accounts.empty')}</p>}
                <ul className={css.items}>
                  {credentials.rows.map(row => (
                    <AccountRow
                      key={row.agentId}
                      row={row}
                      pending={pending.includes(authPendingKey(row.agentId))}
                      outcome={auth}
                      onLogin={(flow, secret) => { void login(row.agentId, flow, secret) }}
                      onLogout={() => { void logout(row.agentId) }}
                      onDismiss={dismissAuth}
                      t={t}
                    />
                  ))}
                </ul>
              </section>
              <RunsSection
                state={runs}
                pending={pending}
                agents={agents.rows}
                error={runError}
                onRefresh={() => { void refreshRuns() }}
                onCancel={(runId) => { void cancelRun(runId) }}
                onDismissError={dismissRunError}
                t={t}
              />
            </div>
          </div>
        </section>
        <section
          id="agent-mesh-panel-collaboration"
          className={css.tabPanel}
          role="tabpanel"
          aria-labelledby="agent-mesh-tab-collaboration"
          tabIndex={0}
          hidden={activePanelTab !== 'collaboration'}
        >
          {activePanelTab === 'collaboration' && (
            <CollaborationPanel
              useCollaboration={useCollaboration}
              {...collaborationActions}
              actionError={collaborationActionError}
              onActionError={setCollaborationActionError}
              t={t}
            />
          )}
        </section>
      </div>
    </section>
  )
}
