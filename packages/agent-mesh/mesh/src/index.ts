/**
 * The agent mesh service (`ctx.agentMesh`): the registry external-agent
 * adapters register on, and the durable binding that says which agent one
 * harness session belongs to.
 *
 * The service owns no agent-specific knowledge. Everything it reports about a
 * specific agent comes from that agent's adapter; a failure inside one adapter
 * is reported as a diagnostic for that agent and never removes the others.
 * @module @deepseek-ai/dsh-agent-mesh
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { AgentMeshError } from './errors.ts'
import { agentMeshDomainSpec, agentMeshSessionMarkDomainSpec } from './domain.ts'
import type { AgentBindingRecord, AgentSessionMarkRecord } from './domain.ts'
import { AgentRunRegistry } from './runs.ts'
import type { MeshRunHandle, MeshRunSnapshot } from './runs.ts'
import type {
  AgentMeshBindingChange,
  AgentAdapter,
  AgentCapabilityInventory,
  AgentCapabilityReadRequest,
  AgentMcpServerConfig,
  AgentMcpServerResolveRequest,
  AgentCapabilities,
  AgentDescriptor,
  AgentDetection,
  AgentSessionCatalog,
  AgentSessionDisposition,
  AgentSessionKey,
  AgentSessionListOptions,
  AgentSessionMark,
  AgentSessionReference,
  AgentId,
  AgentRunRequest,
} from './types.ts'

export { AgentMeshError } from './errors.ts'
export type { AgentMeshErrorCode } from './errors.ts'
export { agentMeshDomainSpec, agentMeshSessionMarkDomainSpec, agentBindingRecord, agentSessionMarkRecord } from './domain.ts'
export type { AgentBindingRecord, AgentSessionMarkRecord } from './domain.ts'
export { findAgentContextFiles, listAgentContextFiles, MAX_AGENT_CAPABILITY_FILE_BYTES, readAgentCapabilityFile, readAgentSkillRoot } from './capabilities.ts'
export type { AgentCapabilityFileRead, AgentSkillRootRead } from './capabilities.ts'
export {
  expandMcpEnvValue,
  mcpEndpointSummary,
  mcpExecutableSummary,
  mcpOptionalBoolean,
  mcpRecord,
  mcpRequiredString,
  mcpStringArray,
  mcpStringRecord,
  rejectMixedMcpTransports,
  resolveMcpCwd,
  resolveMcpEnv,
  resolveMcpHeaders,
  resolveMcpUrl,
} from './mcp-config.ts'
export { createContextHost } from './context-host.ts'
export type { ContextHostOptions } from './context-host.ts'
export { AgentRunRegistry } from './runs.ts'
export type { AgentRunRegistryOptions, MeshRunHandle, MeshRunSnapshot } from './runs.ts'
export type * from './types.ts'

/** One agent as diagnostics reports it, including what could not be observed. */
export interface AgentDiagnostic {
  /** Registry identity. */
  readonly id: AgentId
  /** Human-facing name, when the adapter could be described. */
  readonly displayName?: string
  /** Detection result. */
  readonly detection?: AgentDetection
  /** Capabilities, when the adapter could be described. */
  readonly capabilities?: AgentCapabilities
  /** Directory the agent keeps its sessions in, when known. */
  readonly sessionRoot?: string
  /** File the agent keeps its credentials in, when known. */
  readonly credentialPath?: string
  /** What could not be observed, or what the adapter reports as a limitation. */
  readonly warnings: readonly string[]
}

/** The mesh's view of every registered agent. */
export interface AgentMeshDiagnostics {
  /** One entry per registered adapter, in registration order. */
  readonly agents: readonly AgentDiagnostic[]
  /** Whether the durable binding store is open. */
  readonly bindingsReady: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The durable external-agent binding changed after its storage write completed.
     * @param change - Harness Session and its new external-agent binding, if any.
     * @mode parallel
     */
    'agent-mesh/binding-change'(change: AgentMeshBindingChange): Promise<void>
  }

  interface Context {
    agentMesh: AgentMesh
  }
}

/**
 * The mesh registry. Adapters register as effects, so unmounting an adapter
 * removes it and its agents' rows disappear with it.
 */
export class AgentMesh extends Service {
  /** The durable binding store lives on the storage hub's domain form. */
  static inject = ['storageDomain']

  private readonly adapters = new Map<AgentId, AgentAdapter>()
  private readonly runRegistry: AgentRunRegistry
  private table?: KvTable<SessionId, AgentBindingRecord>
  private sessionMarksTable?: KvTable<AgentSessionKey, AgentSessionMarkRecord>
  private sessionMarkQueue: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Owning context.
   */
  constructor(ctx: Context) {
    super(ctx, 'agentMesh')
    this.runRegistry = new AgentRunRegistry(ctx)
  }

  /** Open the durable binding domain before any consumer binds a session. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentMeshDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'agent-mesh.domainClose')
    this.table = domain.table('bindings')
    const sessionMarks = await this.ctx.storageDomain.open(agentMeshSessionMarkDomainSpec)
    this.ctx.effect(() => () => sessionMarks.close(), 'agent-mesh.sessionMarksDomainClose')
    this.sessionMarksTable = sessionMarks.table('marks')
    this.ctx.effect(() => () => { this.runRegistry.dispose() }, 'agent-mesh.runsDispose')
  }

  /**
   * Dispatch one run on a registered agent.
   * @param agentId - Agent to run.
   * @param request - Prompt, working directory, and transport options.
   * @returns the run's identity and its terminal result. The run continues.
   */
  startRun(agentId: AgentId | string, request: AgentRunRequest): MeshRunHandle {
    return this.runRegistry.start(this.adapter(agentId), request)
  }

  /** Every tracked run, newest first. */
  get runs(): readonly MeshRunSnapshot[] {
    return this.runRegistry.list()
  }

  /**
   * Read one tracked run.
   * @param runId - Run identity.
   * @returns the snapshot, or undefined when the run is unknown or evicted.
   */
  run(runId: string): MeshRunSnapshot | undefined {
    return this.runRegistry.get(runId)
  }

  /**
   * Read one agent's declared tools, skills, servers, commands, and context files.
   * @param agentId - Agent whose native configuration is read.
   * @param request - Project directory and cancellation signal.
   * @returns the agent's capability inventory and any declared gaps.
   */
  async readCapabilities(
    agentId: AgentId | string,
    request: AgentCapabilityReadRequest = {},
  ): Promise<AgentCapabilityInventory> {
    return await this.adapter(agentId).readCapabilities(request)
  }

  /**
   * Resolve one native MCP server declaration without connecting to it.
   * @param agentId - Agent whose native MCP configuration is read.
   * @param request - Server name, project working directory, and cancellation.
   * @returns the effective server config, or `undefined` when that name is absent.
   */
  async resolveMcpServer(
    agentId: AgentId | string,
    request: AgentMcpServerResolveRequest,
  ): Promise<AgentMcpServerConfig | undefined> {
    return await this.adapter(agentId).resolveMcpServer(request)
  }

  /**
   * Cancel one run.
   * @param runId - Run identity.
   * @param reason - Recorded reason.
   * @returns whether a live run was cancelled.
   */
  cancelRun(runId: string, reason?: string): boolean {
    return this.runRegistry.cancel(runId, reason)
  }

  /**
   * Wait for one run to settle.
   * @param runId - Run identity.
   * @returns the terminal snapshot, or undefined when the run is unknown.
   */
  async waitForRun(runId: string): Promise<MeshRunSnapshot | undefined> {
    return await this.runRegistry.wait(runId)
  }

  /**
   * Read every registered agent's own session store.
   * A single adapter failure is retained beside readable stores so callers
   * can show incomplete coverage without losing usable rows.
   * @param options - Session filters, result bound, and cancellation.
   * @returns readable sessions in activity order and per-adapter failures.
   */
  async listSessions(options: AgentSessionListOptions = {}): Promise<AgentSessionCatalog> {
    const results = await Promise.all([...this.adapters.values()].map(async (adapter) => {
      options.signal?.throwIfAborted()
      try {
        const items = await adapter.listSessions(options)
        options.signal?.throwIfAborted()
        return { items }
      } catch (error: unknown) {
        options.signal?.throwIfAborted()
        return {
          items: [],
          failure: {
            agentId: adapter.id,
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }))
    options.signal?.throwIfAborted()
    const items = results.flatMap(result => result.items)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const failures = results.flatMap(result => 'failure' in result ? [result.failure] : [])
    return { items, failures }
  }

  /**
   * Read the persisted pin/archive choices for external sessions.
   * @returns marks newest first.
   */
  sessionMarks(): readonly AgentSessionMark[] {
    return [...this.requireSessionMarksTable().entries()]
      .map(([key, record]) => ({ key, ...record }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * Read one external session's persisted pin/archive choice.
   * @param reference - Exact agent-owned session identity.
   * @returns the current mark, or undefined when neither pinned nor archived.
   */
  sessionMark(reference: AgentSessionReference): AgentSessionMark | undefined {
    const key = sessionKey(reference)
    const record = this.requireSessionMarksTable().get(key)
    return record === undefined ? undefined : { key, ...record }
  }

  /**
   * Pin an existing external session.
   * @param reference - Exact agent-owned session identity.
   * @returns resolution after the Harness-owned mark is durable.
   */
  async pinSession(reference: AgentSessionReference): Promise<void> {
    await this.setSessionDisposition(reference, 'pinned')
  }

  /**
   * Archive an existing external session.
   * @param reference - Exact agent-owned session identity.
   * @returns resolution after the Harness-owned mark is durable.
   */
  async archiveSession(reference: AgentSessionReference): Promise<void> {
    await this.setSessionDisposition(reference, 'archived')
  }

  /**
   * Remove a session's pin or archive mark.
   * @param reference - Exact agent-owned session identity.
   * @param expected - Current disposition to remove when the caller is reversing one specific action.
   * @returns whether a persisted mark was removed.
   */
  async clearSessionDisposition(
    reference: AgentSessionReference,
    expected?: AgentSessionDisposition,
  ): Promise<boolean> {
    const key = sessionKey(reference)
    return await this.enqueueSessionMark(async () => {
      const table = this.requireSessionMarksTable()
      const current = table.get(key)
      if (current === undefined || (expected !== undefined && current.disposition !== expected)) return false
      return await table.delete(key)
    })
  }

  /**
   * Register one agent adapter.
   * @param adapter - The provider to register.
   * @returns the disposer that unregisters it.
   */
  register(adapter: AgentAdapter): () => void {
    if (this.adapters.has(adapter.id)) {
      throw new AgentMeshError(
        'mesh/duplicate-agent',
        `an adapter for agent "${adapter.id}" is already registered`,
        { remediation: 'Mount one adapter per agent id; each mounted instance needs a unique id.' },
      )
    }
    this.adapters.set(adapter.id, adapter)
    return () => {
      if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id)
    }
  }

  /**
   * Resolve one adapter.
   * @param id - Agent identity.
   * @returns the registered adapter.
   */
  adapter(id: AgentId | string): AgentAdapter {
    const agentId = brandString<AgentId>(String(id))
    const adapter = this.adapters.get(agentId)
    if (adapter === undefined) {
      throw new AgentMeshError('mesh/agent-not-registered', `no adapter is registered for agent "${agentId}"`, {
        remediation: 'Mount the adapter package for this agent, or list the registered ids first.',
      })
    }
    return adapter
  }

  private async setSessionDisposition(
    reference: AgentSessionReference,
    disposition: AgentSessionDisposition,
  ): Promise<void> {
    const key = sessionKey(reference)
    await this.enqueueSessionMark(async () => {
      const adapter = this.adapter(reference.agentId)
      const sessions = await adapter.listSessions({})
      if (!sessions.some(session => session.nativeId === reference.nativeId)) {
        throw new AgentMeshError(
          'mesh/session-not-found',
          `agent "${reference.agentId}" has no session "${reference.nativeId}"`,
          { remediation: 'Refresh the external session list and choose a session that still exists.' },
        )
      }
      await this.requireSessionMarksTable().put(key, {
        agentId: reference.agentId,
        nativeId: reference.nativeId,
        disposition,
        updatedAt: new Date().toISOString(),
      })
    })
  }

  private enqueueSessionMark<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sessionMarkQueue.then(operation, operation)
    this.sessionMarkQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private requireSessionMarksTable(): KvTable<AgentSessionKey, AgentSessionMarkRecord> {
    if (this.sessionMarksTable === undefined) {
      throw new Error('agent mesh session marks are not available before the service is ready')
    }
    return this.sessionMarksTable
  }

  /** Registered agent ids, in registration order. */
  get ids(): readonly AgentId[] {
    return [...this.adapters.keys()]
  }

  /**
   * Describe every registered agent.
   * @returns one descriptor per adapter, in registration order.
   */
  async describe(): Promise<readonly AgentDescriptor[]> {
    return await Promise.all([...this.adapters.values()].map(async adapter => await adapter.describe()))
  }

  /**
   * Report every registered agent, turning an adapter failure into a warning
   * for that agent instead of failing the whole report.
   * @returns the diagnostics report.
   */
  async diagnostics(): Promise<AgentMeshDiagnostics> {
    const agents = await Promise.all([...this.adapters.values()].map(async (adapter): Promise<AgentDiagnostic> => {
      try {
        const descriptor = await adapter.describe()
        return {
          id: adapter.id,
          displayName: descriptor.displayName,
          detection: descriptor.detection,
          capabilities: descriptor.capabilities,
          warnings: descriptor.detection.installed ? [] : [descriptor.detection.reason ?? 'the agent binary was not found'],
          ...(descriptor.sessionRoot === undefined ? {} : { sessionRoot: descriptor.sessionRoot }),
          ...(descriptor.credentialPath === undefined ? {} : { credentialPath: descriptor.credentialPath }),
        }
      } catch (error: unknown) {
        return {
          id: adapter.id,
          warnings: [`the adapter could not describe this agent: ${error instanceof Error ? error.message : String(error)}`],
        }
      }
    }))
    return { agents, bindingsReady: this.table !== undefined }
  }

  /**
   * Bind one harness session to one agent.
   * @param sessionId - Harness session identity.
   * @param agentId - Agent the session belongs to.
   */
  async bind(sessionId: SessionId, agentId: AgentId): Promise<void> {
    const table = this.requireTable()
    this.adapter(agentId)
    await table.put(sessionId, { agentId, boundAt: new Date().toISOString() })
    await this.notifyBindingChange({ sessionId, agentId })
  }

  /**
   * Read one session's binding.
   * @param sessionId - Harness session identity.
   * @returns the bound agent, or undefined when the session is unbound.
   */
  bound(sessionId: SessionId): AgentId | undefined {
    return this.requireTable().get(sessionId)?.agentId
  }

  /**
   * Remove one session's binding.
   * @param sessionId - Harness session identity.
   * @returns whether a binding was removed.
   */
  async unbind(sessionId: SessionId): Promise<boolean> {
    const removed = await this.requireTable().delete(sessionId)
    if (removed) await this.notifyBindingChange({ sessionId })
    return removed
  }

  /**
   * Every binding, for callers that project the binding onto session lists.
   * @returns one row per bound session.
   */
  bindings(): readonly { readonly sessionId: SessionId; readonly agentId: AgentId; readonly boundAt: string }[] {
    return [...this.requireTable().entries()].map(([sessionId, record]) => ({
      sessionId,
      agentId: record.agentId,
      boundAt: record.boundAt,
    }))
  }

  private requireTable(): KvTable<SessionId, AgentBindingRecord> {
    if (this.table === undefined) {
      throw new AgentMeshError('mesh/unsupported-operation', 'the agent mesh binding store is not open yet')
    }
    return this.table
  }

  /** Notify binding consumers without letting observer failure undo a durable write. */
  private async notifyBindingChange(change: AgentMeshBindingChange): Promise<void> {
    try {
      await this.ctx.parallel('agent-mesh/binding-change', change)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '<non-Error observer failure>'
      this.ctx.logger.warn(`agent-mesh: binding-change observer failed: ${message}`)
    }
  }
}

/** Form one stable mesh key without giving the external id a Harness Session brand. */
function sessionKey(reference: AgentSessionReference): AgentSessionKey {
  return brandString<AgentSessionKey>(`${reference.agentId}:${reference.nativeId}`)
}

export default AgentMesh
