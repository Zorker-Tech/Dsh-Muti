/**
 * Agent mesh, browser half: the **Agents** entry of the sidebar and the panel
 * it opens in the main column. The panel lists the external coding agents the
 * Host's mesh has registered, one agent's own sessions, the selected session's
 * transcript and native todos with its plan, the current Session's binding to
 * an agent, the tracked runs, and every agent's credential state, all over the
 * `agentMesh` Remote namespace.
 *
 * The panel is a global page: it belongs to the profile, not to a Session, and
 * the sidebar's entry selects it. Its one Session-bound surface reads the
 * open Session from the framework's `useSessions` seat rather than naming one.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-agent-mesh-collaboration/remote'
import type { AgentId } from '@deepseek-ai/dsh-agent-mesh/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the root `main` keyed slot the panel registers into, declared by
// ui-layout with the panel id brand, the `sidebar.panellist` list the entry
// registers into, and the Session standard seats.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: the ctx.remote Context merge with the `agentMesh` namespace.
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { AgentsPanelIcon } from './AgentsPanelIcon.tsx'
import { en, NS, zh, type AgentMeshKey } from './locales.ts'
import { MeshPanel, type MeshPanelInjected } from './MeshPanel.tsx'
import { createAgentMeshStore } from './mesh-store.ts'
import { createMeshCollaborationStore } from './collaboration-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent mesh panel, binding, run, and account copy. */
    'agentMesh': AgentMeshKey
  }
}

/** Return a successful Remote value or preserve its reported failure. */
async function remoteValue<T>(result: Promise<RemoteResult<T>>): Promise<T> {
  const response = await result
  if (!response.ok) throw response.error
  return response.value
}

/** Identity needed to open one session from an external agent's own store. */
export interface AgentMeshSessionReference {
  /** Agent that owns the native session. */
  readonly agentId: AgentId
  /** Agent-native session id. */
  readonly nativeId: string
}

/** Cross-plugin navigation into the Agent Mesh panel. */
export interface AgentMeshNavigation {
  /**
   * Select the Agent Mesh panel and show this session's transcript and tasks.
   * @param reference - Exact agent-owned session identity.
   */
  openSession(reference: AgentMeshSessionReference): void
  /**
   * Pin one source-owned session in Harness browsing surfaces.
   * @param reference - Exact agent-owned session identity.
   */
  pinSession(reference: AgentMeshSessionReference): Promise<void>
  /**
   * Remove one source-owned session from the Harness pin list.
   * @param reference - Exact agent-owned session identity.
   */
  unpinSession(reference: AgentMeshSessionReference): Promise<void>
  /**
   * Archive one source-owned session from Harness browsing surfaces.
   * @param reference - Exact agent-owned session identity.
   */
  archiveSession(reference: AgentMeshSessionReference): Promise<void>
  /**
   * Restore one source-owned session to Harness browsing surfaces.
   * @param reference - Exact agent-owned session identity.
   */
  unarchiveSession(reference: AgentMeshSessionReference): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Navigation to the Agent Mesh panel and its source-owned sessions. */
    agentMeshNavigation: AgentMeshNavigation
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Prompt admission initiated from the Agent Mesh panel. */
    agentMeshPanel: unknown
  }
}

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'agents' as MainPanelId

/** Required services: panel navigation, the slot registry, copy, and the Agent mesh Remote namespaces. */
export const inject = ['slots', 'locale', 'remote', 'remote.agentMesh', 'remote.meshCollaboration', 'layout', 'inputTriggers', 'sessions']

/**
 * Contribute the Agents entry to the sidebar with the panel it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-agent-mesh: dictionaries')
  const t = ctx.locale.bind(NS)
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = ctx.get('sessions') as ISessions
  const skillSource: InputTriggerSource = {
    trigger: '/',
    name: t('skillMenu.group'),
    order: 3,
    async candidates(session, { query, signal }) {
      if (isSignalAborted(signal)) return []
      const bindings = await ctx.remote.agentMesh.bindings()
      if (!bindings.ok) throw bindings.error
      const binding = bindings.value.find(item => item.sessionId === session.sessionId)
      if (binding === undefined || isSignalAborted(signal)) return []
      const cwd = sessions.list.getSnapshot().byId[session.sessionId]?.cwd
      const capabilities = await ctx.remote.agentMesh.capabilities({
        agentId: binding.agentId,
        ...(cwd === undefined ? {} : { cwd }),
      })
      if (!capabilities.ok) throw capabilities.error
      if (isSignalAborted(signal) || capabilities.value === null) return []
      const needle = query.trim().toLowerCase()
      const skills = capabilities.value.skills
        .filter(skill => needle === '' || skill.name.toLowerCase().includes(needle))
        .map(skill => ({
          name: skill.name,
          description: skill.description ?? t('skillMenu.fromAgent', { agent: binding.agentId }),
          value: `${binding.agentId}\u0000${skill.name}`,
        }))
      const commands = capabilities.value.commands
        .filter(command => command.path !== undefined && (needle === ''
          || command.name.toLowerCase().includes(needle)
          || `command:${command.name}`.includes(needle)))
        .map(command => ({
          name: `command:${command.name}`,
          label: command.name,
          description: command.description ?? t('skillMenu.commandFromAgent', { agent: binding.agentId }),
          value: `${binding.agentId}\u0000command\u0000${command.name}`,
        }))
      return [...skills, ...commands]
    },
    onPick({ candidate }) {
      const [agentId, kind, nativeName] = candidate.value?.split('\u0000') ?? []
      if (kind === 'command' && agentId !== undefined && nativeName !== undefined) {
        return { text: t('skillMenu.commandPrompt', { agent: agentId, command: nativeName }) }
      }
      return { text: t('skillMenu.skillPrompt', { agent: agentId ?? t('skillMenu.boundAgent'), skill: kind ?? candidate.name }) }
    },
  }
  ctx.effect(() => inputTriggers.registerSource(skillSource), 'ui-agent-mesh: agent skill menu')
  // One source per plugin instance, shared by every surface registered here;
  // the renderer binds its `mesh` snapshot to the panel's `useMesh` hook and
  // the panel issues only the actions the source declares.
  const handle = createAgentMeshStore({
    agents: () => ctx.remote.agentMesh.agents(),
    sessions: request => ctx.remote.agentMesh.sessions(request),
    capabilities: request => ctx.remote.agentMesh.capabilities(request),
    transcript: request => ctx.remote.agentMesh.transcript(request),
    tasks: request => ctx.remote.agentMesh.tasks(request),
    credentials: agentId => ctx.remote.agentMesh.credentials(agentId),
    bindings: () => ctx.remote.agentMesh.bindings(),
    runs: () => ctx.remote.agentMesh.runs(),
    runCancel: runId => ctx.remote.agentMesh.runCancel(runId),
    bind: (sessionId, agentId) => ctx.remote.agentMesh.bind(sessionId, agentId),
    unbind: sessionId => ctx.remote.agentMesh.unbind(sessionId),
    login: request => ctx.remote.agentMesh.login(request),
    logout: agentId => ctx.remote.agentMesh.logout(agentId),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  const collaboration = createMeshCollaborationStore({
    collaborations: collaborationId => ctx.remote.meshCollaboration.collaborations(collaborationId),
    todosGet: request => ctx.remote.meshCollaboration.todosGet(request),
    worktrees: request => ctx.remote.meshCollaboration.worktrees(request),
    worktreeConflicts: request => ctx.remote.meshCollaboration.worktreeConflicts(request),
    worktreeIntegrated: request => ctx.remote.meshCollaboration.worktreeIntegrated(request),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  const disposeNavigation = ctx.reflect.provide('agentMeshNavigation', {
    openSession: ({ agentId, nativeId }) => {
      ctx.layout.selectPanel(PANEL_ID)
      handle.actions.selectAgent(agentId)
      handle.actions.selectSession({ agentId, sessionId: nativeId })
    },
    pinSession: ({ agentId, nativeId }) => remoteValue(ctx.remote.agentMesh.pinSession({ agentId, sessionId: nativeId })),
    unpinSession: ({ agentId, nativeId }) => remoteValue(ctx.remote.agentMesh.unpinSession({ agentId, sessionId: nativeId })),
    archiveSession: ({ agentId, nativeId }) => remoteValue(ctx.remote.agentMesh.archiveSession({ agentId, sessionId: nativeId })),
    unarchiveSession: ({ agentId, nativeId }) => remoteValue(ctx.remote.agentMesh.unarchiveSession({ agentId, sessionId: nativeId })),
  } satisfies AgentMeshNavigation)
  ctx.effect(() => () => { void disposeNavigation() }, 'ui-agent-mesh: session navigation')
  const injected: MeshPanelInjected = {
    hooks: { ...handle.hooks, ...collaboration.hooks },
    ...handle.actions,
    collaborationActions: collaboration.actions,
    launchCommand: async request => remoteValue(ctx.remote.agentMesh.launchCommand(request)),
    queueDispatchPrompt: async (sessionId: SessionId, prompt: string) => {
      await sessions.using(sessionId, { source: 'agentMeshPanel' }, async (reference) => {
        const session = reference.binding.session
        const state = session.getSnapshot()
        if (state.openState !== 'open') {
          throw state.openError ?? new Error(t('dispatch.sessionNotOpen', { sessionId }))
        }
        const result = await session.prompt([{ type: 'text', text: prompt }], 'queue')
        if (!result.ok) throw result.error
      })
    },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => injected,
  }, MeshPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('panel'),
    locale: NS,
  }, AgentsPanelIcon))
}

/** Read an AbortSignal after asynchronous work without relying on a stale narrowing. */
function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted
}
