/**
 * Agent-mesh panel data source.
 *
 * One source serves the whole panel: the registered external agents, one
 * agent's own sessions, the transcript and native tasks of one session,
 * credential rows, the Harness-session bindings, and the tracked runs, plus
 * the mutations (select, bind, unbind, login, logout, cancel) those surfaces
 * issue. Every surface of the plugin shares one snapshot of the same facts and
 * none owns a private subscription.
 *
 * A read that a later selection can supersede carries an epoch: only the
 * newest request for one key may publish its result, so an answer for a
 * selection the user has already left cannot replace the current one. The
 * connection-reset listener and run refresh timer are installed only
 * while the source has a subscriber.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentAuthOperationResult, AgentLoginFlow, AgentNativeTasks } from '@deepseek-ai/dsh-agent-mesh/types'
import type { AgentCapabilityInventory } from '@deepseek-ai/dsh-agent-mesh/types'
import type {
  MeshAgentRow,
  MeshBindingRow,
  MeshCapabilityRequest,
  MeshCapabilityResponse,
  MeshCredentialRow,
  MeshLoginRequest,
  MeshRunRow,
  MeshSessionListRequest,
  MeshSessionRequest,
  MeshSessionRow,
  MeshTranscriptRequest,
  MeshTranscriptResponse,
} from '@deepseek-ai/dsh-agent-mesh-controller/types'

/** Lifecycle of one read this source issues. */
export type MeshReadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** State of one list read. */
export interface MeshListState<Row> {
  readonly status: MeshReadStatus
  readonly rows: readonly Row[]
  /** Message of the failed call; null while the read shows no failure. */
  readonly error: string | null
}

/** State of one addressed read. */
export interface MeshValueState<Value> {
  readonly status: MeshReadStatus
  readonly value: Value | null
  readonly error: string | null
}

/** Outcome of one credential operation, shown until the user dismisses it. */
export interface AuthOperationOutcome {
  /** Agent the operation addressed. */
  readonly agentId: string
  /** Operation the adapter performed. */
  readonly action: 'login' | 'logout'
  /** Whether the adapter completed it itself. */
  readonly ok: boolean
  /** What the user must do by hand when the adapter could not complete it. */
  readonly instructions: string | null
  /** Redacted command output the adapter reported. */
  readonly output: string | null
}

/** List state a keyed read reports before its first request. */
export const IDLE_LIST: MeshListState<never> = { status: 'idle', rows: [], error: null }

/** Value state a keyed read reports before its first request. */
export const IDLE_VALUE: MeshValueState<never> = { status: 'idle', value: null, error: null }

/** Everything the panel and the composer seat render from. */
export interface AgentMeshSnapshot {
  /** Registered agents with their detection state. */
  readonly agents: MeshListState<MeshAgentRow>
  /** One entry per agent whose session list was requested. */
  readonly sessions: Readonly<Record<string, MeshListState<MeshSessionRow>>>
  /** One inventory per agent and project directory. */
  readonly capabilities: Readonly<Record<string, MeshValueState<AgentCapabilityInventory | null>>>
  /** One entry per requested session key, `<agentId>:<nativeId>`. */
  readonly transcripts: Readonly<Record<string, MeshValueState<MeshTranscriptResponse>>>
  /** One entry per requested session key. */
  readonly tasks: Readonly<Record<string, MeshValueState<AgentNativeTasks>>>
  readonly credentials: MeshListState<MeshCredentialRow>
  readonly bindings: MeshListState<MeshBindingRow>
  /** Tracked runs of every agent; idle until a surface asks for them. */
  readonly runs: MeshListState<MeshRunRow>
  /** Agent whose sessions the panel lists; null before the first selection. */
  readonly selectedAgentId: string | null
  /** Session the panel shows; null before the first selection. */
  readonly selectedSessionKey: string | null
  /** Capability scope currently shown by the panel. */
  readonly selectedCapabilityKey: string | null
  /** Last credential operation's outcome, shown until dismissed. */
  readonly auth: AuthOperationOutcome | null
  /** Message of the last failed binding change, shown until dismissed. */
  readonly bindingError: string | null
  /** Message of the last failed run cancellation, shown until dismissed. */
  readonly runError: string | null
  /** Action keys in flight, so their controls can refuse a second press. */
  readonly pending: readonly string[]
}

/** Remote calls and invalidations the source reads and mutates through. */
export interface AgentMeshStoreDependencies {
  readonly agents: () => Promise<RemoteResult<readonly MeshAgentRow[]>>
  readonly sessions: (request: MeshSessionListRequest) => Promise<RemoteResult<readonly MeshSessionRow[]>>
  readonly capabilities: (request: MeshCapabilityRequest) => Promise<RemoteResult<MeshCapabilityResponse | null>>
  readonly transcript: (request: MeshTranscriptRequest) => Promise<RemoteResult<MeshTranscriptResponse>>
  readonly tasks: (request: MeshSessionRequest) => Promise<RemoteResult<AgentNativeTasks>>
  readonly credentials: (agentId: string | null) => Promise<RemoteResult<readonly MeshCredentialRow[]>>
  readonly bindings: () => Promise<RemoteResult<readonly MeshBindingRow[]>>
  readonly runs: () => Promise<RemoteResult<readonly MeshRunRow[]>>
  readonly runCancel: (runId: string) => Promise<RemoteResult<boolean>>
  readonly bind: (sessionId: string, agentId: string) => Promise<RemoteResult<void>>
  readonly unbind: (sessionId: string) => Promise<RemoteResult<boolean>>
  readonly login: (request: MeshLoginRequest) => Promise<RemoteResult<AgentAuthOperationResult>>
  readonly logout: (agentId: string) => Promise<RemoteResult<AgentAuthOperationResult>>
  readonly subscribeReset: (listener: () => void) => () => void
}

/** Read and mutation callbacks the source exposes to its surfaces. */
export interface AgentMeshActions {
  /** Read the agent roster again. */
  refreshAgents: () => Promise<void>
  /** Show one agent's sessions, reading them when they are not settled yet. */
  selectAgent: (agentId: string) => void
  /** Read one agent's sessions again. */
  refreshSessions: (agentId: string) => Promise<void>
  /** Read one agent's declared capabilities for a project directory. */
  refreshCapabilities: (request: MeshCapabilityRequest) => Promise<void>
  /** Show one session's transcript and native tasks, reading both. */
  selectSession: (request: MeshSessionRequest) => void
  /** Read one session's transcript and native tasks again. */
  refreshSession: (agentId: string, sessionId: string) => Promise<void>
  /** Read the credential rows again. */
  refreshCredentials: () => Promise<void>
  /** Read the Harness-session bindings again. */
  refreshBindings: () => Promise<void>
  /** Read the tracked runs again. */
  refreshRuns: () => Promise<void>
  /** Cancel one run, then read the runs again. */
  cancelRun: (runId: string) => Promise<void>
  /** Bind one Harness session to one agent, then read the bindings again. */
  bind: (sessionId: string, agentId: string) => Promise<void>
  /** Remove one Harness session's binding, then read the bindings again. */
  unbind: (sessionId: string) => Promise<void>
  /**
   * Log one agent in with a declared flow, then read credentials again.
   * @param agentId - Agent whose credential store receives the login.
   * @param flow - Flow declared by that adapter.
   * @param secret - Optional one-request secret; it is not published in the source snapshot.
   * @returns Nothing.
   */
  login: (agentId: string, flow: AgentLoginFlow, secret?: string) => Promise<void>
  /** Log one agent out, then read credentials again. */
  logout: (agentId: string) => Promise<void>
  /** Clear the shown credential-operation outcome. */
  dismissAuth: () => void
  /** Clear the shown binding failure. */
  dismissBindingError: () => void
  /** Clear the shown run-cancellation failure. */
  dismissRunError: () => void
  /** Re-read everything currently shown; also the connection-reset path. */
  refreshAll: () => void
}

/** One source: its observable snapshot and its complete mutation API. */
export interface AgentMeshStore {
  readonly hooks: { readonly mesh: HostObservable<AgentMeshSnapshot> }
  readonly actions: AgentMeshActions
}

/**
 * Pending key of one agent's credential operation.
 * @param agentId - agent the operation addresses.
 * @returns the pending key of that agent's operation.
 */
export const authPendingKey = (agentId: string): string => `auth:${agentId}`

/**
 * Pending key of one Harness session's binding change.
 * @param sessionId - Harness session the binding change addresses.
 * @returns the pending key of that session's binding change.
 */
export const bindPendingKey = (sessionId: string): string => `bind:${sessionId}`

/**
 * Pending key of one run cancellation.
 * @param runId - run the cancellation addresses.
 * @returns the pending key of that run's cancellation.
 */
export const runPendingKey = (runId: string): string => `run:${runId}`

const RUN_IDLE_REFRESH_INTERVAL_MS = 5_000
const RUN_ACTIVE_REFRESH_INTERVAL_MS = 1_500

/** Outcome of one Remote call reduced to its value or its message. */
type ReadOutcome<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly message: string }

/**
 * Run one Remote call, folding a transport rejection into the same failure
 * form as a Remote failure so a caller has one branch to render.
 * @param call - the generated Remote method.
 * @returns the call's value, or the message to show.
 */
async function readCall<Value>(call: () => Promise<RemoteResult<Value>>): Promise<ReadOutcome<Value>> {
  let result: RemoteResult<Value>
  try {
    result = await call()
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message }
}

/**
 * Create the panel's data source.
 * @param deps - Remote calls, the reset subscription, and nothing else.
 * @returns the observable snapshot and the actions that mutate it.
 */
export function createAgentMeshStore(deps: AgentMeshStoreDependencies): AgentMeshStore {
  let snapshot: AgentMeshSnapshot = {
    agents: IDLE_LIST, sessions: {}, capabilities: {}, transcripts: {}, tasks: {},
    credentials: IDLE_LIST, bindings: IDLE_LIST, runs: IDLE_LIST,
    selectedAgentId: null, selectedSessionKey: null, selectedCapabilityKey: null,
    auth: null, bindingError: null, runError: null, pending: [],
  }
  const listeners = new Set<() => void>()
  // One epoch per read key: a superseded request may not publish its result.
  const epochs = new Map<string, number>()
  // Sessions whose transcript and native tasks were requested, so a reconnect
  // re-reads exactly what is on screen.
  const sessionReads = new Map<string, MeshSessionRequest>()
  const capabilityReads = new Map<string, MeshCapabilityRequest>()
  let disposeReset: (() => void) | undefined
  let runRefreshTimer: ReturnType<typeof setTimeout> | undefined

  const publish = (next: AgentMeshSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const beginRead = (key: string): number => {
    const epoch = (epochs.get(key) ?? 0) + 1
    epochs.set(key, epoch)
    return epoch
  }
  const mayPublish = (key: string, epoch: number): boolean => epochs.get(key) === epoch
  const withPending = (key: string, value: boolean): void => {
    publish({
      ...snapshot,
      pending: value
        ? (snapshot.pending.includes(key) ? snapshot.pending : [...snapshot.pending, key])
        : snapshot.pending.filter(entry => entry !== key),
    })
  }
  const clearRunRefresh = (): void => {
    if (runRefreshTimer === undefined) return
    clearTimeout(runRefreshTimer)
    runRefreshTimer = undefined
  }
  const sessionKey = (request: MeshSessionRequest): string => `${request.agentId}:${request.sessionId}`
  const capabilityKey = (request: MeshCapabilityRequest): string => JSON.stringify([request.agentId, request.cwd ?? null])

  const loadAgents = async (): Promise<void> => {
    const epoch = beginRead('agents')
    publish({ ...snapshot, agents: { ...snapshot.agents, status: 'loading' } })
    const outcome = await readCall(deps.agents)
    if (!mayPublish('agents', epoch)) return
    publish({
      ...snapshot,
      agents: outcome.ok
        ? { status: 'ready', rows: outcome.value, error: null }
        : { status: 'error', rows: snapshot.agents.rows, error: outcome.message },
    })
  }

  const loadSessions = async (agentId: string): Promise<void> => {
    const key = `sessions:${agentId}`
    const epoch = beginRead(key)
    const previous: MeshListState<MeshSessionRow> = snapshot.sessions[agentId] ?? IDLE_LIST
    publish({
      ...snapshot,
      sessions: { ...snapshot.sessions, [agentId]: { ...snapshot.sessions[agentId] ?? IDLE_LIST, status: 'loading' } },
    })
    const outcome = await readCall(() => deps.sessions({ agentId }))
    if (!mayPublish(key, epoch)) return
    publish({
      ...snapshot,
      sessions: {
        ...snapshot.sessions,
        [agentId]: outcome.ok
          ? { status: 'ready', rows: outcome.value, error: null }
          : { status: 'error', rows: previous.rows, error: outcome.message },
      },
    })
  }

  const loadCapabilities = async (request: MeshCapabilityRequest): Promise<void> => {
    const key = capabilityKey(request)
    capabilityReads.set(key, request)
    const epoch = beginRead(`capabilities:${key}`)
    const previous: MeshValueState<AgentCapabilityInventory | null> = snapshot.capabilities[key] ?? IDLE_VALUE
    publish({
      ...snapshot,
      selectedCapabilityKey: key,
      capabilities: { ...snapshot.capabilities, [key]: { ...previous, status: 'loading' } },
    })
    const outcome = await readCall(() => deps.capabilities(request))
    if (!mayPublish(`capabilities:${key}`, epoch)) return
    publish({
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        [key]: outcome.ok
          ? { status: 'ready', value: outcome.value, error: null }
          : { status: 'error', value: previous.value, error: outcome.message },
      },
    })
  }

  const loadTranscript = async (request: MeshSessionRequest): Promise<void> => {
    const key = `transcript:${sessionKey(request)}`
    const epoch = beginRead(key)
    const target = sessionKey(request)
    const previous: MeshValueState<MeshTranscriptResponse> = snapshot.transcripts[target] ?? IDLE_VALUE
    publish({
      ...snapshot,
      transcripts: { ...snapshot.transcripts, [target]: { ...snapshot.transcripts[target] ?? IDLE_VALUE, status: 'loading' } },
    })
    const outcome = await readCall(() => deps.transcript({ agentId: request.agentId, sessionId: request.sessionId }))
    if (!mayPublish(key, epoch)) return
    publish({
      ...snapshot,
      transcripts: {
        ...snapshot.transcripts,
        [target]: outcome.ok
          ? { status: 'ready', value: outcome.value, error: null }
          : { status: 'error', value: previous.value, error: outcome.message },
      },
    })
  }

  const loadTasks = async (request: MeshSessionRequest): Promise<void> => {
    const key = `tasks:${sessionKey(request)}`
    const epoch = beginRead(key)
    const target = sessionKey(request)
    const previous: MeshValueState<AgentNativeTasks> = snapshot.tasks[target] ?? IDLE_VALUE
    publish({
      ...snapshot,
      tasks: { ...snapshot.tasks, [target]: { ...snapshot.tasks[target] ?? IDLE_VALUE, status: 'loading' } },
    })
    const outcome = await readCall(() => deps.tasks({ agentId: request.agentId, sessionId: request.sessionId }))
    if (!mayPublish(key, epoch)) return
    publish({
      ...snapshot,
      tasks: {
        ...snapshot.tasks,
        [target]: outcome.ok
          ? { status: 'ready', value: outcome.value, error: null }
          : { status: 'error', value: previous.value, error: outcome.message },
      },
    })
  }

  const loadCredentials = async (): Promise<void> => {
    const epoch = beginRead('credentials')
    publish({ ...snapshot, credentials: { ...snapshot.credentials, status: 'loading' } })
    const outcome = await readCall(() => deps.credentials(null))
    if (!mayPublish('credentials', epoch)) return
    publish({
      ...snapshot,
      credentials: outcome.ok
        ? { status: 'ready', rows: outcome.value, error: null }
        : { status: 'error', rows: snapshot.credentials.rows, error: outcome.message },
    })
  }

  const loadBindings = async (): Promise<void> => {
    const epoch = beginRead('bindings')
    publish({ ...snapshot, bindings: { ...snapshot.bindings, status: 'loading' } })
    const outcome = await readCall(deps.bindings)
    if (!mayPublish('bindings', epoch)) return
    publish({
      ...snapshot,
      bindings: outcome.ok
        ? { status: 'ready', rows: outcome.value, error: null }
        : { status: 'error', rows: snapshot.bindings.rows, error: outcome.message },
    })
  }

  const loadRuns = async (): Promise<void> => {
    clearRunRefresh()
    const epoch = beginRead('runs')
    publish({ ...snapshot, runs: { ...snapshot.runs, status: 'loading' } })
    const outcome = await readCall(deps.runs)
    if (!mayPublish('runs', epoch)) return
    publish({
      ...snapshot,
      runs: outcome.ok
        ? { status: 'ready', rows: outcome.value, error: null }
        : { status: 'error', rows: snapshot.runs.rows, error: outcome.message },
    })
    if (listeners.size > 0) {
      const interval = snapshot.runs.rows.some(run => run.status === 'running')
        ? RUN_ACTIVE_REFRESH_INTERVAL_MS
        : RUN_IDLE_REFRESH_INTERVAL_MS
      runRefreshTimer = setTimeout(() => {
        runRefreshTimer = undefined
        void loadRuns()
      }, interval)
    }
  }

  const loadSession = (request: MeshSessionRequest): void => {
    sessionReads.set(sessionKey(request), request)
    void loadTranscript(request)
    void loadTasks(request)
  }

  const refreshAll = (): void => {
    void loadAgents()
    void loadCredentials()
    void loadBindings()
    void loadRuns()
    if (snapshot.selectedAgentId !== null) void loadSessions(snapshot.selectedAgentId)
    for (const request of [...sessionReads.values()]) {
      void loadTranscript(request)
      void loadTasks(request)
    }
    if (snapshot.selectedCapabilityKey !== null) {
      // loadCapabilities records the request before publishing its selected key.
      const request = capabilityReads.get(snapshot.selectedCapabilityKey)
      /* v8 ignore next -- selectedCapabilityKey is published only after the matching request is stored. */
      if (request !== undefined) void loadCapabilities(request)
    }
  }

  const actions: AgentMeshActions = {
    refreshAgents: loadAgents,
    selectAgent: (agentId) => {
      publish({ ...snapshot, selectedAgentId: agentId })
      void loadCapabilities({ agentId })
      const entry = snapshot.sessions[agentId]
      if (entry === undefined || entry.status === 'idle' || entry.status === 'error') void loadSessions(agentId)
    },
    refreshSessions: loadSessions,
    refreshCapabilities: loadCapabilities,
    selectSession: (request) => {
      publish({ ...snapshot, selectedSessionKey: sessionKey(request) })
      loadSession(request)
      const selected = snapshot.sessions[request.agentId]?.rows.find(row => row.nativeId === request.sessionId)
      void loadCapabilities({ agentId: request.agentId, ...(selected?.cwd === undefined ? {} : { cwd: selected.cwd }) })
    },
    refreshSession: (agentId, sessionId) => {
      const request = { agentId, sessionId }
      sessionReads.set(sessionKey(request), request)
      return Promise.all([loadTranscript(request), loadTasks(request)]).then(() => undefined)
    },
    refreshCredentials: loadCredentials,
    refreshBindings: loadBindings,
    refreshRuns: loadRuns,
    cancelRun: async (runId) => {
      const key = runPendingKey(runId)
      withPending(key, true)
      const outcome = await readCall(() => deps.runCancel(runId))
      withPending(key, false)
      publish({ ...snapshot, runError: outcome.ok ? null : outcome.message })
      if (outcome.ok) await loadRuns()
    },
    bind: async (sessionId, agentId) => {
      const key = bindPendingKey(sessionId)
      withPending(key, true)
      const outcome = await readCall(() => deps.bind(sessionId, agentId))
      withPending(key, false)
      publish({
        ...snapshot,
        bindingError: outcome.ok ? null : outcome.message,
      })
      if (outcome.ok) await loadBindings()
    },
    unbind: async (sessionId) => {
      const key = bindPendingKey(sessionId)
      withPending(key, true)
      const outcome = await readCall(() => deps.unbind(sessionId))
      withPending(key, false)
      publish({ ...snapshot, bindingError: outcome.ok ? null : outcome.message })
      if (outcome.ok) await loadBindings()
    },
    login: async (agentId, flow, secret) => {
      const key = authPendingKey(agentId)
      withPending(key, true)
      const outcome = await readCall(() => deps.login({
        agentId,
        flow,
        ...(secret === undefined ? {} : { secret }),
      }))
      withPending(key, false)
      if (outcome.ok) {
        publish({
          ...snapshot,
          auth: {
            agentId, action: 'login', ok: outcome.value.ok,
            instructions: outcome.value.instructions ?? null, output: outcome.value.output ?? null,
          },
        })
      } else {
        publish({ ...snapshot, auth: { agentId, action: 'login', ok: false, instructions: outcome.message, output: null } })
      }
      await loadCredentials()
    },
    logout: async (agentId) => {
      const key = authPendingKey(agentId)
      withPending(key, true)
      const outcome = await readCall(() => deps.logout(agentId))
      withPending(key, false)
      if (outcome.ok) {
        publish({
          ...snapshot,
          auth: {
            agentId, action: 'logout', ok: outcome.value.ok,
            instructions: outcome.value.instructions ?? null, output: outcome.value.output ?? null,
          },
        })
      } else {
        publish({ ...snapshot, auth: { agentId, action: 'logout', ok: false, instructions: outcome.message, output: null } })
      }
      await loadCredentials()
    },
    dismissAuth: () => { publish({ ...snapshot, auth: null }) },
    dismissBindingError: () => { publish({ ...snapshot, bindingError: null }) },
    dismissRunError: () => { publish({ ...snapshot, runError: null }) },
    refreshAll,
  }

  return {
    hooks: {
      mesh: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            disposeReset = deps.subscribeReset(refreshAll)
            refreshAll()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            clearRunRefresh()
            disposeReset?.()
            disposeReset = undefined
            // Answers still in flight belong to the generation this source
            // just left; a remount must read the facts again.
            epochs.clear()
            publish({
              ...snapshot,
              agents: IDLE_LIST, sessions: {}, transcripts: {}, tasks: {},
              credentials: IDLE_LIST, bindings: IDLE_LIST, runs: IDLE_LIST,
              auth: null, bindingError: null, runError: null, pending: [],
            })
          }
        },
      },
    },
    actions,
  }
}
