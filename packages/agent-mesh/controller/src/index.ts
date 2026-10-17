/**
 * The mesh's Remote surface: what the Web Client reads to show the external
 * agents, their own sessions, their transcripts and native tasks, their
 * credential state, and the session-to-agent bindings.
 *
 * Every method delegates to `ctx.agentMesh` and the adapters registered on it,
 * so a client never reaches an agent's store itself.
 * @module @deepseek-ai/dsh-agent-mesh-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { platform } from 'node:process'
import type {} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentAuthOperationResult, AgentId, AgentNativeTasks } from '@deepseek-ai/dsh-agent-mesh/types'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {
  MeshAgentRow,
  MeshBindingRow,
  MeshCredentialRow,
  MeshCapabilityRequest,
  MeshCapabilityResponse,
  MeshLoginRequest,
  MeshLaunchCommand,
  MeshSessionListRequest,
  MeshSessionRequest,
  MeshSessionRow,
  MeshRunRow,
  MeshRunStartRequest,
  MeshTranscriptRequest,
  MeshTranscriptResponse,
  MeshSessionDispositionRequest,
} from './types.ts'
import { nativeLaunchShell } from './native-launch-shell.ts'

export type * from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No adapter is registered for that agent id. */
    'agent-mesh/unknown-agent': { readonly agentId: string }
    /** The agent's own store has no such session. */
    'agent-mesh/unknown-session': { readonly agentId: string; readonly sessionId: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentMeshController: AgentMeshController
  }
}

/** The mesh's Remote service, mounted in the API assembly as `remote.agentMesh`. */
export class AgentMeshController extends TypertRemoteService {
  static inject = ['agentMesh', 'remoteAccess', 'typert']

  /**
   * @param ctx - Owning context.
   */
  constructor(ctx: Context) {
    super(ctx, 'agentMeshController', { namespace: 'agentMesh' })
    ctx.typert.resources.register('agent', { field: 'agentId' })
  }

  /**
   * Every registered agent with its detection state.
   * @param signal - Carrier cancellation.
   * @returns one row per registered adapter, in registration order.
   */
  @Remote('agents')
  async remoteExportAgents(signal: AbortSignal): Promise<readonly MeshAgentRow[]> {
    signal.throwIfAborted()
    const report = await this.ctx.agentMesh.diagnostics()
    return report.agents.filter(agent => this.ctx.remoteAccess.allows({ kind: 'agent', id: agent.id })).map(agent => ({
      agentId: agent.id,
      displayName: agent.displayName ?? agent.id,
      installed: agent.detection?.installed ?? false,
      ...(agent.detection?.version === undefined ? {} : { version: agent.detection.version }),
      ...(agent.detection?.binaryPath === undefined ? {} : { binaryPath: agent.detection.binaryPath }),
      ...(agent.detection?.reason === undefined ? {} : { detectionReason: agent.detection.reason }),
      ...(agent.sessionRoot === undefined ? {} : { sessionRoot: agent.sessionRoot }),
      ...(agent.credentialPath === undefined ? {} : { credentialPath: agent.credentialPath }),
      warnings: [...agent.warnings],
    }))
  }

  /**
   * One agent's own sessions, newest first.
   * @param request - Agent and filters.
   * @param signal - Carrier cancellation.
   * @returns the session rows.
   */
  @Remote('sessions')
  async remoteExportSessions(request: MeshSessionListRequest, signal: AbortSignal): Promise<readonly MeshSessionRow[]> {
    signal.throwIfAborted()
    if (!this.ctx.remoteAccess.allows({ kind: 'agent', id: brandString<AgentId>(request.agentId) })) return []
    const adapter = this.adapter(request.agentId)
    const sessions = await adapter.listSessions({
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      signal,
    })
    return sessions.map((session) => {
      const mark = this.ctx.agentMesh.sessionMark({ agentId: session.agentId, nativeId: session.nativeId })
      return {
        key: session.key,
        agentId: session.agentId,
        nativeId: session.nativeId,
        title: session.title ?? '',
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        ...(session.model === undefined ? {} : { model: session.model }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: session.status,
        pinned: mark?.disposition === 'pinned',
        archived: mark?.disposition === 'archived',
        ...(session.messageCount === undefined ? {} : { messageCount: session.messageCount }),
        notes: [...session.notes],
      }
    })
  }

  /**
   * Native TUI argv for one exact agent-owned session; this endpoint never starts it.
   * @param request - Agent and native session identity.
   * @param signal - Carrier cancellation.
   * @returns argv plus the Host shell dialect, or null when this adapter has no native TUI launcher.
   */
  @Remote('launchCommand')
  async remoteExportLaunchCommand(request: MeshSessionRequest, signal: AbortSignal): Promise<MeshLaunchCommand | null> {
    signal.throwIfAborted()
    const adapter = this.adapter(request.agentId)
    const session = await this.session(adapter, request.agentId, request.sessionId)
    if (adapter.nativeLaunchCommand === undefined) return null
    const argv = await adapter.nativeLaunchCommand(session.nativeId)
    signal.throwIfAborted()
    return { argv: [...argv], shell: nativeLaunchShell(platform) }
  }

  /**
   * Pin one session in its source-owned store in Harness browsing surfaces.
   * @param request - Agent and native session identity.
   * @param signal - Carrier cancellation.
   */
  @Remote('pinSession')
  async remotePinSession(request: MeshSessionDispositionRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.ctx.agentMesh.pinSession({ agentId: brandString<AgentId>(request.agentId), nativeId: request.sessionId })
  }

  /**
   * Remove one external session from the Harness pin list.
   * @param request - Agent and native session identity.
   * @param signal - Carrier cancellation.
   */
  @Remote('unpinSession')
  async remoteUnpinSession(request: MeshSessionDispositionRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.ctx.agentMesh.clearSessionDisposition(
      { agentId: brandString<AgentId>(request.agentId), nativeId: request.sessionId }, 'pinned',
    )
  }

  /**
   * Archive one external session from the Harness browsing surfaces without stopping its agent.
   * @param request - Agent and native session identity.
   * @param signal - Carrier cancellation.
   */
  @Remote('archiveSession')
  async remoteArchiveSession(request: MeshSessionDispositionRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.ctx.agentMesh.archiveSession({ agentId: brandString<AgentId>(request.agentId), nativeId: request.sessionId })
  }

  /**
   * Restore one external session to the Harness browsing surfaces.
   * @param request - Agent and native session identity.
   * @param signal - Carrier cancellation.
   */
  @Remote('unarchiveSession')
  async remoteUnarchiveSession(request: MeshSessionDispositionRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.ctx.agentMesh.clearSessionDisposition(
      { agentId: brandString<AgentId>(request.agentId), nativeId: request.sessionId }, 'archived',
    )
  }

  /**
   * One window of a session's transcript.
   * @param request - Agent, session, and window bound.
   * @param signal - Carrier cancellation.
   * @returns the transcript window.
   */
  @Remote('transcript')
  async remoteExportTranscript(request: MeshTranscriptRequest, signal: AbortSignal): Promise<MeshTranscriptResponse> {
    signal.throwIfAborted()
    const adapter = this.adapter(request.agentId)
    const session = await this.session(adapter, request.agentId, request.sessionId)
    const transcript = await adapter.readTranscript({
      session,
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
    })
    return {
      key: transcript.key,
      messages: [...transcript.messages],
      ...(transcript.totalMessages === undefined ? {} : { totalMessages: transcript.totalMessages }),
      hasMore: transcript.hasMore,
      notes: [...transcript.notes],
    }
  }

  /**
   * One session's native todo and plan state.
   * @param request - Agent and session.
   * @param signal - Carrier cancellation.
   * @returns the agent's own task state.
   */
  @Remote('tasks')
  async remoteExportTasks(request: MeshSessionRequest, signal: AbortSignal): Promise<AgentNativeTasks> {
    signal.throwIfAborted()
    const adapter = this.adapter(request.agentId)
    const session = await this.session(adapter, request.agentId, request.sessionId)
    return await adapter.readNativeTasks({ session })
  }

  /**
   * Read the declarations in one agent's own configuration and skill roots.
   * @param request - Agent and optional project directory.
   * @param signal - Carrier cancellation.
   * @returns the inventory, or null when remote access excludes this agent.
   */
  @Remote('capabilities')
  async remoteExportCapabilities(
    request: MeshCapabilityRequest,
    signal: AbortSignal,
  ): Promise<MeshCapabilityResponse | null> {
    signal.throwIfAborted()
    const agentId = brandString<AgentId>(request.agentId)
    if (!this.ctx.remoteAccess.allows({ kind: 'agent', id: agentId })) return null
    return await this.ctx.agentMesh.readCapabilities(agentId, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      signal,
    })
  }

  /**
   * Credential state for every agent, or one agent.
   * @param agentId - Optional agent filter.
   * @param signal - Carrier cancellation.
   * @returns one row per requested agent.
   */
  @Remote('credentials')
  async remoteExportCredentials(agentId: string | null, signal: AbortSignal): Promise<readonly MeshCredentialRow[]> {
    signal.throwIfAborted()
    const ids = (agentId === null ? this.ctx.agentMesh.ids : [brandString<AgentId>(agentId)])
      .filter(id => this.ctx.remoteAccess.allows({ kind: 'agent', id }))
    return await Promise.all(ids.map(async (id): Promise<MeshCredentialRow> => {
      const adapter = this.adapter(id)
      const descriptor = await adapter.describe()
      const state = await adapter.readAuthState()
      return {
        agentId: id,
        displayName: descriptor.displayName,
        state,
        loginFlows: descriptor.capabilities.credentials.login,
        canLogout: descriptor.capabilities.credentials.logout && state.source !== 'env',
      }
    }))
  }

  /**
   * Log one agent in.
   * @param request - Agent, flow, and optional secret.
   * @param signal - Carrier cancellation.
   * @returns the operation result.
   */
  @Remote('login')
  async remoteExportLogin(request: MeshLoginRequest, signal: AbortSignal): Promise<AgentAuthOperationResult> {
    signal.throwIfAborted()
    return await this.adapter(request.agentId).login({
      flow: request.flow,
      ...(request.secret === undefined ? {} : { secret: request.secret }),
    })
  }

  /**
   * Log one agent out.
   * @param agentId - Agent to log out.
   * @param signal - Carrier cancellation.
   * @returns the operation result.
   */
  @Remote('logout')
  async remoteExportLogout(agentId: string, signal: AbortSignal): Promise<AgentAuthOperationResult> {
    signal.throwIfAborted()
    return await this.adapter(agentId).logout()
  }

  /**
   * Bind one Harness session to one agent.
   * @param sessionId - Harness session id.
   * @param agentId - Agent to bind.
   * @param signal - Carrier cancellation.
   */
  @Remote('bind')
  async remoteExportBind(sessionId: string, agentId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.ctx.agentMesh.bind(brandString<SessionId>(sessionId), brandString<AgentId>(agentId))
  }

  /**
   * Remove one Harness session's binding.
   * @param sessionId - Harness session id.
   * @param signal - Carrier cancellation.
   * @returns whether a binding was removed.
   */
  @Remote('unbind')
  async remoteExportUnbind(sessionId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    return await this.ctx.agentMesh.unbind(brandString<SessionId>(sessionId))
  }

  /**
   * Every binding, so a session list can show which agent each session belongs to.
   * @param signal - Carrier cancellation.
   * @returns one row per binding.
   */
  @Remote('bindings')
  remoteExportBindings(signal: AbortSignal): Promise<readonly MeshBindingRow[]> {
    signal.throwIfAborted()
    return Promise.resolve(this.ctx.agentMesh.bindings().map(binding => ({
      sessionId: binding.sessionId,
      agentId: binding.agentId,
      boundAt: binding.boundAt,
    })))
  }

  /**
   * Dispatch one run to an external agent.
   * @param request - Agent, prompt, working directory, and transport options.
   * @param signal - Carrier cancellation.
   * @returns the new run's id and agent.
   */
  @Remote('runStart')
  remoteExportRunStart(
    request: MeshRunStartRequest,
    signal: AbortSignal,
  ): Promise<{ readonly runId: string; readonly agentId: string }> {
    signal.throwIfAborted()
    const handle = this.ctx.agentMesh.startRun(request.agentId, {
      prompt: request.prompt,
      cwd: request.cwd,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.approval === undefined ? {} : { approval: request.approval }),
      ...(request.resumeNativeId === undefined ? {} : { resumeNativeId: request.resumeNativeId }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    })
    return Promise.resolve({ runId: handle.runId, agentId: request.agentId })
  }

  /**
   * Every tracked run, newest first.
   * @param signal - Carrier cancellation.
   * @returns the run rows.
   */
  @Remote('runs')
  remoteExportRuns(signal: AbortSignal): Promise<readonly MeshRunRow[]> {
    signal.throwIfAborted()
    return Promise.resolve(this.ctx.agentMesh.runs.map(run => ({
      runId: run.runId,
      agentId: run.agentId,
      cwd: run.cwd,
      prompt: run.prompt,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(run.finalText === undefined ? {} : { finalText: run.finalText }),
      ...(run.error === undefined ? {} : { error: run.error }),
      notes: [...run.notes],
      events: [...run.events],
      eventCount: run.eventCount,
    })))
  }

  /**
   * Cancel one run.
   * @param runId - Run to cancel.
   * @param signal - Carrier cancellation.
   * @returns whether a live run was cancelled.
   */
  @Remote('runCancel')
  remoteExportRunCancel(runId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    return Promise.resolve(this.ctx.agentMesh.cancelRun(runId))
  }

  /** Resolve an adapter, mapping a missing registration onto the wire code. */
  private adapter(agentId: string): ReturnType<Context['agentMesh']['adapter']> {
    try {
      return this.ctx.agentMesh.adapter(brandString<AgentId>(agentId))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteError('agent-mesh/unknown-agent', message, { agentId }, { cause: error })
    }
  }

  /** Resolve one session of an agent's store, mapping a miss onto the wire code. */
  private async session(
    adapter: ReturnType<Context['agentMesh']['adapter']>,
    agentId: string,
    sessionId: string,
  ): Promise<Awaited<ReturnType<ReturnType<Context['agentMesh']['adapter']>['listSessions']>>[number]> {
    const sessions = await adapter.listSessions({})
    const found = sessions.find(candidate => candidate.nativeId === sessionId)
    if (found === undefined) {
      throw new RemoteError('agent-mesh/unknown-session', `agent "${agentId}" has no session "${sessionId}"`, { agentId, sessionId })
    }
    return found
  }
}

export default AgentMeshController
