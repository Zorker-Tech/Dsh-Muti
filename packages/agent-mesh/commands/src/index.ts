/**
 * Human-facing commands for reading native Agent Mesh state.
 * @module @deepseek-ai/dsh-agent-mesh-commands
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentAuthStatus, AgentCommandInfo, AgentId, AgentSession } from '@deepseek-ai/dsh-agent-mesh'
import type {} from '@deepseek-ai/dsh-working-directory'

export const name = 'agent-mesh-commands'
export const inject = ['agentMesh', 'commands', 'agents', 'workingDirectory']

const PACKAGE_ID = '@deepseek-ai/dsh-agent-mesh-commands'
const SESSION_LIMIT = 20
const REFRESH_LIMIT = 100
const RUN_LIMIT = 20

interface CommandSpec {
  readonly name: string
  readonly description: string
  readonly hint?: string
  readonly handler: (ctx: Context, invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

interface NativeCommandRegistration {
  readonly signature: string
  readonly dispose: () => void
}

interface NativeCommandState {
  readonly registrations: Map<string, NativeCommandRegistration>
  readonly refreshTasks: Set<Promise<void>>
  binding?: AgentId
  refresh?: AbortController
  commandFiber?: Fiber
  commandRegistryReady?: Promise<void>
  registerCommand?: (definition: CommandDefinition) => () => void
  disposed?: boolean
}

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

/** Build a DSH command name that keeps each provider's native name distinct. */
function nativeCommandAlias(agentId: AgentId, commandName: string): string | undefined {
  if (!/^[a-z][a-z0-9_-]*$/u.test(agentId) || !/^[a-z][a-z0-9_-]*$/u.test(commandName)) return undefined
  return `agent-${agentId}-${commandName}`
}

/** Prompt the Harness model to dispatch one native command through its approved mesh tool. */
function nativeCommandMessage(agentId: AgentId, command: AgentCommandInfo, cwd: string, task: string): string {
  return [
    `Dispatch this task to external agent "${agentId}" with mesh_run and commandName "${command.name}".`,
    `Use working directory ${JSON.stringify(cwd)}. Do not do the task with this Harness agent's local tools.`,
    'Task:',
    task,
  ].join('\n\n')
}

/** Remove registrations owned by one live Harness Agent. */
function clearNativeCommandRegistrations(state: NativeCommandState): void {
  for (const registration of state.registrations.values()) registration.dispose()
  state.registrations.clear()
}

/** Load the commands service under the exact Agent scope so registrations stay Session-scoped. */
async function ensureNativeCommandRegistry(agent: Agent, state: NativeCommandState): Promise<void> {
  if (state.registerCommand !== undefined) return
  if (state.commandRegistryReady !== undefined) {  await state.commandRegistryReady; return }

  const fiber = agent.ctx.inject(['commands'], (commandCtx) => {
    state.registerCommand = definition => commandCtx.commands.register(definition)
  })
  state.commandFiber = fiber
  let ready: Promise<void> = Promise.resolve()
  ready = (async () => {
    try {
      await fiber
      if (state.registerCommand === undefined) throw new Error('Agent command scope loaded without ctx.commands')
    } catch (error: unknown) {
      /* v8 ignore next -- disposal drains refreshTasks before deleting commandFiber, so a replacement cannot race this cleanup. */
      if (state.commandFiber === fiber) {
        delete state.commandFiber
        delete state.registerCommand
      }
      await fiber.dispose()
      throw error
    } finally {
      /* v8 ignore next -- this promise still owns the slot until disposal clears it. */
      if (state.commandRegistryReady === ready) delete state.commandRegistryReady
    }
  })()
  state.commandRegistryReady = ready
  await ready
}

/** Stop one Agent's refreshes and release its scoped commands service. */
async function disposeNativeCommandState(state: NativeCommandState): Promise<void> {
  state.disposed = true
  state.refresh?.abort()
  await Promise.allSettled([...state.refreshTasks])
  clearNativeCommandRegistrations(state)
  const fiber = state.commandFiber
  delete state.commandFiber
  delete state.registerCommand
  delete state.commandRegistryReady
  await fiber?.dispose()
}

/** Refresh this Harness Agent's scoped commands from its current mesh binding and cwd. */
async function refreshNativeCommands(
  ctx: Context,
  states: Map<Agent, NativeCommandState>,
  agent: Agent,
  parentSignal?: AbortSignal,
): Promise<void> {
  let state = states.get(agent)
  if (state === undefined) {
    state = { registrations: new Map(), refreshTasks: new Set() }
    states.set(agent, state)
  }
  if (state.disposed || ctx.agents.get(agent.id) !== agent) return
  state.refresh?.abort()
  const controller = new AbortController()
  state.refresh = controller
  const signal = parentSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, parentSignal])
  const task = (async () => {
    const agentId = ctx.agentMesh.bound(agent.id)
    if (state.binding !== agentId) {
      clearNativeCommandRegistrations(state)
      if (agentId === undefined) delete state.binding
      else state.binding = agentId
    }
    if (agentId === undefined) return

    try {
      const cwd = await ctx.workingDirectory.ensure(agent, signal)
      const inventory = await ctx.agentMesh.readCapabilities(agentId, { cwd, signal })
      signal.throwIfAborted()
      const desired = new Map<string, { readonly command: AgentCommandInfo; readonly signature: string }>()
      for (const command of inventory.commands) {
        if (command.path === undefined) continue
        const name = nativeCommandAlias(agentId, command.name)
        if (name === undefined) {
          ctx.logger.warn(`agent-mesh-commands: skipped native command with unsupported name ${JSON.stringify(command.name)} from ${agentId}`)
          continue
        }
        desired.set(name, {
          command,
          signature: JSON.stringify([command.description ?? '', command.path]),
        })
      }

      for (const [name, registration] of state.registrations) {
        if (desired.get(name)?.signature === registration.signature) continue
        registration.dispose()
        state.registrations.delete(name)
      }
      if (desired.size === 0) return
      await ensureNativeCommandRegistry(agent, state)
      signal.throwIfAborted()
      if (state.disposed || ctx.agents.get(agent.id) !== agent) return
      for (const [name, entry] of desired) {
        if (state.registrations.has(name)) continue
        if (ctx.commands.find(agent, name) !== undefined) {
          ctx.logger.warn(`agent-mesh-commands: skipped native command /${name}; the name is already registered`)
          continue
        }
        const { command } = entry
        try {
          const register = state.registerCommand
          /* v8 ignore next -- registry setup assigns this before resolving; disposal drains refresh tasks before clearing it. */
          if (register === undefined) throw new Error('the Agent command registry was disposed during refresh')
          const dispose = register({
            definitionId: CommandDefinitionId(`${PACKAGE_ID}/native/${agentId}/${command.name}`),
            name,
            description: command.description ?? `Run ${agentId}'s native /${command.name} command through DSH approval.`,
            input: { hint: '<task>' },
            handler: async (invocation) => {
              const task = invocation.rawInput.trim()
              if (task.length === 0) return { kind: 'error', text: `Usage: /${name} <task>` }
              if (ctx.agentMesh.bound(invocation.agent.id) !== agentId) {
                return { kind: 'error', text: `/${name} is no longer available because this Session is not bound to ${agentId}.` }
              }
              const activeCwd = await ctx.workingDirectory.ensure(invocation.agent, invocation.signal)
              const current = await ctx.agentMesh.readCapabilities(agentId, { cwd: activeCwd, signal: invocation.signal })
              const currentCommand = current.commands.find(candidate => candidate.name === command.name && candidate.path !== undefined)
              if (currentCommand === undefined) {
                return { kind: 'error', text: `/${name} is no longer declared by ${agentId} for ${activeCwd}; refresh the Agent Mesh command list.` }
              }
              invocation.agent.followup(createUserMessage({
                content: [{ type: 'text', text: nativeCommandMessage(agentId, currentCommand, activeCwd, task) }],
                source: { kind: 'user' },
              }))
              return success(`Queued ${agentId}'s native /${command.name} command. The external run will require DSH approval.`)
            },
          })
          state.registrations.set(name, { signature: entry.signature, dispose })
        } catch (error: unknown) {
          if (signal.aborted) return
          const message = error instanceof Error ? error.message : '<non-Error throw>'
          ctx.logger.warn(`agent-mesh-commands: could not register /${name}: ${message}`)
        }
      }
    } catch (error: unknown) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : '<non-Error throw>'
      ctx.logger.warn(`agent-mesh-commands: native commands for ${agentId} could not be refreshed: ${message}`)
    }
  })()
  state.refreshTasks.add(task)
  try {
    await task
  } finally {
    state.refreshTasks.delete(task)
    if (state.refresh === controller) delete state.refresh
  }
}

/** Schedule a contained refresh from a non-awaitable lifecycle notification. */
function scheduleNativeCommandRefresh(ctx: Context, states: Map<Agent, NativeCommandState>, agent: Agent): void {
  void refreshNativeCommands(ctx, states, agent).catch((error: unknown) => {
    const message = rejectionMessage(error)
    ctx.logger.warn(`agent-mesh-commands: native command refresh failed for ${agent.id}: ${message}`)
  })
}

/** Summarize an unknown promise rejection without discarding non-Error failures. */
function rejectionMessage(error: unknown): string {
  return error instanceof Error ? error.message : '<non-Error rejection>'
}

function rejectArguments(command: string, invocation: CommandInvocation): CommandResult | undefined {
  return invocation.rawInput.trim().length === 0
    ? undefined
    : { kind: 'error', text: `Usage: /${command}` }
}

function authStatus(status: AgentAuthStatus): string {
  switch (status) {
    case 'authenticated': return 'authenticated'
    case 'unauthenticated': return 'unauthenticated'
    case 'expired': return 'expired'
    case 'misconfigured': return 'misconfigured'
    case 'unknown': return 'unknown'
    /* v8 ignore next 2 -- AgentAuthStatus is closed and every member is handled above. */
    default: return assertNever(status, 'agent authentication status')
  }
}

/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract. */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

async function listAgents(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const invalid = rejectArguments('agents', invocation)
  if (invalid !== undefined) return invalid
  const ids = ctx.agentMesh.ids
  if (ids.length === 0) return success('No external agents are registered.')
  const rows = await Promise.all(ids.map(async (id) => {
    let adapter
    try {
      adapter = ctx.agentMesh.adapter(id)
    } catch {
      return `${id}: unavailable`
    }
    let descriptor
    try {
      descriptor = await adapter.describe()
    } catch {
      return `${id}: details unavailable`
    }
    let status: AgentAuthStatus = 'unknown'
    try {
      status = (await adapter.readAuthState()).status
    } catch (error: unknown) {
      // Only the coarse state is shown when the native credential store cannot be read.
      void error
    }
    const installed = descriptor.detection.installed ? 'installed' : 'not installed'
    return `${descriptor.displayName} (${id}) · ${installed} · auth ${authStatus(status)}`
  }))
  return success(['Agents', ...rows.map(row => `- ${row}`)].join('\n'))
}

function sessionRow(session: AgentSession): string {
  const title = session.title ?? session.nativeId
  const location = session.cwd === undefined ? '' : ` · ${session.cwd}`
  return `- ${session.agentId} · ${title} · ${session.status} · ${session.updatedAt}${location}`
}

function failureRows(failures: readonly { readonly agentId: string; readonly message: string }[]): string[] {
  return failures.map(failure => `- ${failure.agentId}: ${failure.message}`)
}

async function listSessions(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const cwd = invocation.rawInput.trim()
  if (cwd.includes('\n') || cwd.includes('\r')) {
    return { kind: 'error', text: 'Usage: /agent-sessions [cwd]' }
  }
  const catalog = await ctx.agentMesh.listSessions({
    ...(cwd.length === 0 ? {} : { cwd }),
    limit: SESSION_LIMIT,
    signal: invocation.signal,
  })
  const visible = catalog.items.slice(0, SESSION_LIMIT)
  const lines = [cwd.length === 0 ? 'Native agent sessions' : `Native agent sessions in ${cwd}`]
  if (visible.length === 0) lines.push('- No sessions returned.')
  else lines.push(...visible.map(sessionRow))
  if (catalog.items.length > visible.length) {
    lines.push(`Showing ${visible.length} of ${catalog.items.length} returned sessions; each provider was limited to ${SESSION_LIMIT}.`)
  }
  if (catalog.failures.length > 0) lines.push('Store read failures:', ...failureRows(catalog.failures))
  return success(lines.join('\n'))
}

async function refreshSessions(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const invalid = rejectArguments('agent-refresh', invocation)
  if (invalid !== undefined) return invalid
  const catalog = await ctx.agentMesh.listSessions({ limit: REFRESH_LIMIT, signal: invocation.signal })
  const counts = ctx.agentMesh.ids.map((id) => {
    const count = catalog.items.filter(session => session.agentId === id).length
    return `- ${id}: ${count}`
  })
  return success([
    'Live native-store read completed.',
    `Read up to ${REFRESH_LIMIT} sessions per provider; DSH does not build a second session index.`,
    ...(counts.length === 0 ? ['- No external agents are registered.'] : counts),
    ...(catalog.failures.length === 0 ? [] : ['Store read failures:', ...failureRows(catalog.failures)]),
  ].join('\n'))
}

async function diagnostics(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const invalid = rejectArguments('agents-diagnostics', invocation)
  if (invalid !== undefined) return invalid
  const report = await ctx.agentMesh.diagnostics()
  if (report.agents.length === 0) return success('No external agents are registered.')
  const lines = ['Agent diagnostics', `Binding store: ${report.bindingsReady ? 'ready' : 'not ready'}`]
  for (const agent of report.agents) {
    lines.push(`- ${agent.displayName ?? agent.id} (${agent.id})`)
    if (agent.detection !== undefined) {
      lines.push(`  Detection: ${agent.detection.installed ? 'installed' : 'not installed'} via ${agent.detection.source}`)
      if (agent.detection.version !== undefined) lines.push(`  Version: ${agent.detection.version}`)
      if (agent.detection.binaryPath !== undefined) lines.push(`  Binary: ${agent.detection.binaryPath}`)
    }
    if (agent.sessionRoot !== undefined) lines.push(`  Sessions: ${agent.sessionRoot}`)
    if (agent.credentialPath !== undefined) lines.push(`  Credentials: ${agent.credentialPath}`)
    if (agent.warnings.length > 0) lines.push(...agent.warnings.map(warning => `  Warning: ${warning}`))
  }
  return success(lines.join('\n'))
}

function listRuns(ctx: Context, invocation: CommandInvocation): CommandResult {
  const invalid = rejectArguments('mesh-runs', invocation)
  if (invalid !== undefined) return invalid
  const runs = ctx.agentMesh.runs.slice(0, RUN_LIMIT)
  if (runs.length === 0) return success('No tracked Agent Mesh runs.')
  const lines = ['Recent Agent Mesh runs']
  for (const run of runs) {
    const end = run.finishedAt === undefined ? '' : ` · finished ${run.finishedAt}`
    const failure = run.error === undefined ? '' : ` · error ${run.error.code}`
    lines.push(`- ${run.runId} · ${run.agentId} · ${run.status} · ${run.startedAt}${end}${failure}`)
  }
  return success(lines.join('\n'))
}

async function meshState(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const invalid = rejectArguments('mesh-state', invocation)
  if (invalid !== undefined) return invalid
  const report = await ctx.agentMesh.diagnostics()
  const bindings = report.bindingsReady ? ctx.agentMesh.bindings().length : undefined
  const marks = ctx.agentMesh.sessionMarks()
  const pinned = marks.filter(mark => mark.disposition === 'pinned').length
  const archived = marks.filter(mark => mark.disposition === 'archived').length
  const runs = ctx.agentMesh.runs
  return success([
    'Agent Mesh state',
    `Agents: ${ctx.agentMesh.ids.length}`,
    `Binding store: ${bindings === undefined ? 'not ready' : `ready (${bindings} bindings)`}`,
    `Session marks: ${pinned} pinned, ${archived} archived`,
    `Runs: ${runs.length} tracked, ${runs.filter(run => run.status === 'running').length} running`,
    'State is owned by DSH storage domains and the agents’ native stores.',
  ].join('\n'))
}

const commands: readonly CommandSpec[] = [
  { name: 'agents', description: 'List registered agents and their credential status.', handler: listAgents },
  { name: 'agent-sessions', description: 'List recent sessions from native agent stores.', hint: '[cwd]', handler: listSessions },
  { name: 'agent-refresh', description: 'Read native agent session stores again.', handler: refreshSessions },
  { name: 'agents-diagnostics', description: 'Show agent detection and integration diagnostics.', handler: diagnostics },
  { name: 'mesh-runs', description: 'List recent Agent Mesh runs.', handler: listRuns },
  { name: 'mesh-state', description: 'Show Agent Mesh storage and run state.', handler: meshState },
]

/** Register the Agent Mesh human commands in DSH's command registry. */
export function apply(ctx: Context): void {
  const nativeCommandStates = new Map<Agent, NativeCommandState>()
  ctx.effect(() => async () => {
    for (const state of nativeCommandStates.values()) {
      await disposeNativeCommandState(state)
    }
    nativeCommandStates.clear()
  }, 'agent-mesh-commands.nativeCommands')
  for (const command of commands) {
    ctx.commands.register({
      definitionId: CommandDefinitionId(`${PACKAGE_ID}/${command.name}`),
      name: command.name,
      description: command.description,
      ...(command.hint === undefined ? {} : { input: { hint: command.hint } }),
      handler: invocation => command.handler(ctx, invocation),
    })
  }
  ctx.on('agent/created', async ({ agent, signal }) => {
    await refreshNativeCommands(ctx, nativeCommandStates, agent, signal)
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    await refreshNativeCommands(ctx, nativeCommandStates, agent, signal)
    return decision
  })
  ctx.on('agent-mesh/binding-change', async ({ sessionId }) => {
    const agent = ctx.agents.get(sessionId)
    if (agent !== undefined) await refreshNativeCommands(ctx, nativeCommandStates, agent)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'working-directory/change') return
    const agent = ctx.agents.get(session.id)
    if (agent !== undefined) scheduleNativeCommandRefresh(ctx, nativeCommandStates, agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = nativeCommandStates.get(agent)
    if (state === undefined) return
    void disposeNativeCommandState(state)
      .catch((error: unknown) => {
        const message = rejectionMessage(error)
        ctx.logger.warn(`agent-mesh-commands: could not dispose native commands for ${agent.id}: ${message}`)
      })
      .finally(() => nativeCommandStates.delete(agent))
  })
}
