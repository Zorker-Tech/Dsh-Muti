import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  AgentAdapter,
  AgentAuthState,
  AgentCapabilityInventory,
  AgentDescriptor,
  AgentId,
  AgentMeshDiagnostics,
  AgentSession,
  AgentSessionKey,
  MeshRunSnapshot,
} from '@deepseek-ai/dsh-agent-mesh'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import AgentMesh from '@deepseek-ai/dsh-agent-mesh'
import * as agentMeshCommands from '../src/index.ts'

const roots: string[] = []
const fibers: Fiber[] = []
const scopes: Scope[] = []
let commandNumber = 0

interface AdapterOptions {
  readonly auth?: AgentAuthState
  readonly authError?: boolean
  readonly descriptor?: AgentDescriptor
  readonly describeError?: boolean
  readonly sessions?: readonly AgentSession[]
  readonly listError?: string
  readonly onList?: (options: { readonly cwd?: string; readonly limit?: number; readonly signal?: AbortSignal }) => void
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly commandFiber: Fiber
  readonly followups: UserMessage[]
  readonly unregisterAgent: () => Promise<void>
}

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await scope.dispose()
  for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const agentId = (value: string): AgentId => brandString<AgentId>(value)

function session(
  id: string,
  agent: AgentId = agentId('codex'),
  updatedAt = '2026-10-16T03:00:00.000Z',
  details = true,
): AgentSession {
  return {
    key: brandString<AgentSessionKey>(`${agent}:${id}`),
    agentId: agent,
    nativeId: id,
    ...(details ? { title: `session ${id}`, cwd: '/work' } : {}),
    createdAt: '2026-10-16T02:00:00.000Z',
    updatedAt,
    status: 'idle',
    notes: [],
  }
}

function descriptor(id: string, installed = true): AgentDescriptor {
  return {
    id: agentId(id),
    displayName: id.toUpperCase(),
    summary: `${id} test agent`,
    capabilities: {
      runModes: ['headless-exec'],
      streaming: true,
      resume: false,
      interrupt: false,
      listSessions: true,
      readTranscript: true,
      nativeTodos: false,
      nativePlan: false,
      listModels: false,
      sandboxProfiles: [],
      approvalModes: [],
      credentials: { status: true, login: [], logout: false },
    },
    detection: {
      installed,
      binaryPath: `/opt/${id}/bin/${id}`,
      source: 'path',
      ...(installed ? { version: '1.2.3' } : { reason: `${id} binary was not found` }),
    },
    transports: [{ mode: 'headless-exec', mechanism: `${id} exec`, available: true }],
    sessionRoot: `/Users/person/.${id}/sessions`,
    credentialPath: `/Users/person/.${id}/credentials.json`,
    environmentKeys: [],
  }
}

function adapter(id: string, options: AdapterOptions = {}): AgentAdapter {
  const details = options.descriptor ?? descriptor(id)
  return {
    id: agentId(id),
    describe: async () => {
      if (options.describeError) throw new Error('description unavailable')
      return details
    },
    readAuthState: async () => {
      if (options.authError) throw new Error('credential store unavailable')
      return options.auth ?? { status: 'authenticated', source: 'file' }
    },
    listSessions: async (request) => {
      options.onList?.(request)
      if (options.listError !== undefined) throw new Error(options.listError)
      return options.sessions ?? []
    },
    nativeLaunchCommand: async nativeId => [id, '--resume', nativeId],
    readTranscript: async request => ({ key: request.session.key, messages: [], hasMore: false, notes: [] }),
    readNativeTasks: async () => ({ available: false, todos: [], notes: [] }),
    listModels: async () => [],
    readCapabilities: async () => ({
      agentId: agentId(id), tools: [], skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    }),
    resolveMcpServer: async () => undefined,
    login: async () => ({ ok: false, action: 'login', state: { status: 'unauthenticated', source: 'none' } }),
    logout: async () => ({ ok: false, action: 'logout', state: { status: 'unauthenticated', source: 'none' } }),
    startRun: () => {
      throw new Error('run dispatch is not used by these commands')
    },
  }
}

function testAgent(ctx: Context, followups: UserMessage[]): Agent {
  const session = ctx.sessions.create(SessionId(`agent-mesh-command-${++commandNumber}`))
  const inbox = createInboxStub()
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    get ctx() { return scope.ctx },
    get status() { return status },
    send: () => {},
    followup: message => followups.push(message),
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  const scope: Scope = createScope(ctx, agent)
  scopes.push(scope)
  return agent
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-mesh-commands-'))
  roots.push(root)
  const ctx = new Context()
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(root, '.storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(CommandRuntime))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(AgentMesh))
  provideWorkingDirectoryFixture(ctx, root)
  const commandFiber = await ctx.plugin(agentMeshCommands)
  fibers.push(commandFiber)
  const followups: UserMessage[] = []
  const agent = testAgent(ctx, followups)
  const unregisterAgent = await ctx.agents.register(agent)
  return { ctx, agent, commandFiber, followups, unregisterAgent }
}

async function run(test: Harness, command: string, suffix = '', signal = new AbortController().signal) {
  const execution = await test.ctx.commands.execute(test.agent, `/${command}${suffix}`, [], signal)
  if (execution === undefined) throw new Error(`${command} command was not registered`)
  return execution.result
}

async function preStep(test: Harness, signal = new AbortController().signal, agent = test.agent) {
  return await agentEvents(test.ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

describe('@deepseek-ai/dsh-agent-mesh-commands', () => {
  it('registers the native command set and disposes each registration', async () => {
    const test = await harness()
    expect(agentMeshCommands.name).toBe('agent-mesh-commands')
    expect(agentMeshCommands.inject).toEqual(['agentMesh', 'commands', 'agents', 'workingDirectory'])
    expect('default' in agentMeshCommands).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(agentMeshCommands)).toBe(agentMeshCommands)
    expect(test.ctx.commands.list(test.agent).map(command => command.name)).toEqual([
      'agent-refresh', 'agent-sessions', 'agents', 'agents-diagnostics', 'mesh-runs', 'mesh-state',
    ])
    await test.commandFiber.dispose()
    expect(test.ctx.commands.list(test.agent)).toEqual([])
  })

  it('registers scoped file-backed native command handlers and keeps their runs behind DSH approval', async () => {
    const test = await harness()
    const codex = adapter('codex')
    const inventory: AgentCapabilityInventory = {
      agentId: codex.id,
      tools: [],
      skills: [],
      mcpServers: [],
      commands: [
        { name: 'review', description: 'Review changed files', source: 'user', path: '/home/person/.codex/prompts/review.md' },
        { name: 'plain', source: 'user', path: '/home/person/.codex/prompts/plain.md' },
        { name: 'builtin', source: 'builtin' },
        { name: 'Review', source: 'user', path: '/home/person/.codex/prompts/invalid-name.md' },
      ],
      contextFiles: [],
      sources: [],
      notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    }
    const readCapabilities = vi.spyOn(codex, 'readCapabilities').mockResolvedValue(inventory)
    test.ctx.agentMesh.register(codex)

    await agentEvents(test.ctx, test.agent).serial('agent/created', { source: 'startup' })
    expect(test.ctx.commands.list(test.agent).some(command => command.name === 'agent-codex-review')).toBe(false)
    await test.ctx.agentMesh.bind(test.agent.id, codex.id)

    expect(test.ctx.commands.list(test.agent).map(command => command.name)).toContain('agent-codex-review')
    expect(test.ctx.commands.find(test.agent, 'agent-codex-plain')?.description)
      .toBe("Run codex's native /plain command through DSH approval.")
    expect(test.ctx.commands.find(test.agent, 'agent-codex-builtin')).toBeUndefined()
    expect(test.ctx.commands.find(test.agent, 'agent-codex-Review')).toBeUndefined()
    const capabilityRequest = readCapabilities.mock.calls[0]?.[0]
    expect(capabilityRequest?.cwd).toBeTypeOf('string')
    expect(capabilityRequest?.signal).toBeInstanceOf(AbortSignal)
    expect(await run(test, 'agent-codex-review')).toEqual({ kind: 'error', text: 'Usage: /agent-codex-review <task>' })

    const result = await run(test, 'agent-codex-review', ' Inspect the staged changes')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('The external run will require DSH approval.')
    expect(test.followups).toHaveLength(1)
    expect(test.followups[0]?.content).toEqual([{
      type: 'text',
      text: [
        'Dispatch this task to external agent "codex" with mesh_run and commandName "review".',
        `Use working directory ${JSON.stringify(test.ctx.workingDirectory.defaultDirectory)}. Do not do the task with this Harness agent's local tools.`,
        'Task:',
        'Inspect the staged changes',
      ].join('\n\n'),
    }])

    await preStep(test)
    expect(test.ctx.commands.list(test.agent).filter(command => command.name.startsWith('agent-codex-'))).toHaveLength(2)

    readCapabilities.mockResolvedValue({
      ...inventory,
      commands: inventory.commands.map(command => command.name === 'review'
        ? { ...command, description: 'Review only staged files' }
        : command),
    })
    await preStep(test)
    expect(test.ctx.commands.find(test.agent, 'agent-codex-review')?.description).toBe('Review only staged files')

    readCapabilities.mockResolvedValue({ ...inventory, commands: [] })
    expect(await run(test, 'agent-codex-review', ' try a stale shortcut')).toEqual({
      kind: 'error',
      text: `/agent-codex-review is no longer declared by codex for ${test.ctx.workingDirectory.defaultDirectory}; refresh the Agent Mesh command list.`,
    })
    expect(test.followups).toHaveLength(1)

    await test.ctx.agentMesh.unbind(test.agent.id)
    expect(test.ctx.commands.list(test.agent).some(command => command.name === 'agent-codex-review')).toBe(false)

    readCapabilities.mockResolvedValue(inventory)
    await test.ctx.agentMesh.bind(test.agent.id, codex.id)
    expect(test.ctx.commands.list(test.agent).some(command => command.name === 'agent-codex-review')).toBe(true)
    await test.commandFiber.dispose()
    expect(test.ctx.commands.list(test.agent).some(command => command.name === 'agent-codex-review')).toBe(false)
  })

  it('keeps native shortcuts scoped to the current binding and reports pre-step rejection', async () => {
    const test = await harness()
    const codex = adapter('codex')
    const grok = adapter('grok')
    const inventory: AgentCapabilityInventory = {
      agentId: codex.id,
      tools: [], skills: [], mcpServers: [],
      commands: [{ name: 'review', source: 'user', path: '/home/person/.codex/prompts/review.md' }],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    }
    vi.spyOn(codex, 'readCapabilities').mockResolvedValue(inventory)
    test.ctx.agentMesh.register(codex)
    test.ctx.agentMesh.register(grok)
    await test.ctx.agentMesh.bind(test.agent.id, codex.id)
    const command = test.ctx.commands.find(test.agent, 'agent-codex-review')
    expect(command).toBeDefined()

    await test.ctx.agentMesh.bind(test.agent.id, grok.id)
    const stale = await command!.handler({
      commandId: CommandId('stale-command'),
      agent: test.agent,
      rawInput: 'Review the changes',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(stale).toEqual({
      kind: 'error',
      text: '/agent-codex-review is no longer available because this Session is not bound to codex.',
    })
    expect(test.followups).toHaveLength(0)

    const reads = vi.spyOn(grok, 'readCapabilities')
    test.ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
    await expect(preStep(test)).resolves.toEqual({ kind: 'reject' })
    expect(reads).not.toHaveBeenCalled()
  })

  it('refreshes on working-directory changes and contains scheduled refresh failures', async () => {
    const test = await harness()
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    test.agent.session.append('turn/start', { turn: 1 })

    const bound = vi.spyOn(test.ctx.agentMesh, 'bound')
      .mockImplementationOnce(() => { throw new Error('refresh lookup failed') })
      .mockImplementationOnce(() => { throw 'non-Error refresh lookup failure' })
    test.agent.session.append('working-directory/change', { cwd: '/next' })
    await vi.waitFor(() =>{  expect(warn).toHaveBeenCalledWith(
      `agent-mesh-commands: native command refresh failed for ${test.agent.id}: refresh lookup failed`,
    ) })
    test.agent.session.append('working-directory/change', { cwd: '/another' })
    await vi.waitFor(() =>{  expect(warn).toHaveBeenLastCalledWith(
      `agent-mesh-commands: native command refresh failed for ${test.agent.id}: <non-Error rejection>`,
    ) })
    expect(bound).toHaveBeenCalledTimes(2)

    await test.unregisterAgent()
    test.agent.session.append('working-directory/change', { cwd: '/after-disposal' })
    expect(bound).toHaveBeenCalledTimes(2)
    expect(test.ctx.commands.list(test.agent)).toHaveLength(6)
  })

  it('logs adapter refresh and registration failures without hiding cancellation', async () => {
    const test = await harness()
    const codex = adapter('codex')
    const inventory: AgentCapabilityInventory = {
      agentId: codex.id,
      tools: [], skills: [], mcpServers: [],
      commands: [
        { name: 'review', source: 'user', path: '/home/person/.codex/prompts/review.md' },
        { name: 'explain', source: 'user', path: '/home/person/.codex/prompts/explain.md' },
      ],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    }
    const read = vi.spyOn(codex, 'readCapabilities')
      .mockRejectedValueOnce(new Error('capability refresh failed'))
      .mockRejectedValueOnce('non-Error capability refresh failure')
      .mockResolvedValue(inventory)
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    test.ctx.agentMesh.register(codex)
    await test.ctx.agentMesh.bind(test.agent.id, codex.id)
    expect(warn).toHaveBeenLastCalledWith(
      'agent-mesh-commands: native commands for codex could not be refreshed: capability refresh failed',
    )
    await test.ctx.agentMesh.bind(test.agent.id, codex.id)
    expect(warn).toHaveBeenLastCalledWith(
      'agent-mesh-commands: native commands for codex could not be refreshed: <non-Error throw>',
    )

    const registry = vi.spyOn(test.ctx.commands, 'register')
      .mockImplementationOnce(() => { throw new Error('registration rejected') })
      .mockImplementationOnce(() => { throw 'non-Error registration failure' })
    await test.ctx.agentMesh.bind(test.agent.id, codex.id)
    expect(warn).toHaveBeenCalledWith('agent-mesh-commands: could not register /agent-codex-review: registration rejected')
    expect(warn).toHaveBeenCalledWith('agent-mesh-commands: could not register /agent-codex-explain: <non-Error throw>')
    expect(registry).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('contains a scoped command injection that completes without installing its registry', async () => {
    const test = await harness()
    const codex = adapter('codex')
    vi.spyOn(codex, 'readCapabilities').mockResolvedValue({
      agentId: codex.id,
      tools: [], skills: [], mcpServers: [],
      commands: [{ name: 'review', source: 'user', path: '/home/person/.codex/prompts/review.md' }],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    })
    test.ctx.agentMesh.register(codex)
    const inject = test.agent.ctx.inject.bind(test.agent.ctx)
    vi.spyOn(test.agent.ctx, 'inject').mockImplementation((dependencies, _callback) => inject(dependencies, () => {}))
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    await test.ctx.agentMesh.bind(test.agent.id, codex.id)

    expect(warn).toHaveBeenCalledWith(
      'agent-mesh-commands: native commands for codex could not be refreshed: Agent command scope loaded without ctx.commands',
    )
    expect(test.ctx.commands.list(test.agent)).toHaveLength(6)
  })

  it('skips a native shortcut whose alias is already registered', async () => {
    const test = await harness()
    const codex = adapter('codex')
    vi.spyOn(codex, 'readCapabilities').mockResolvedValue({
      agentId: codex.id,
      tools: [], skills: [], mcpServers: [],
      commands: [{ name: 'review', source: 'user', path: '/home/person/.codex/prompts/review.md' }],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    })
    const staticDispose = test.ctx.commands.register({
      name: 'agent-codex-review',
      description: 'Static command owns this name.',
      handler: () => ({ kind: 'success', text: 'static' }),
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    test.ctx.agentMesh.register(codex)

    await test.ctx.agentMesh.bind(test.agent.id, codex.id)

    expect(test.ctx.commands.find(test.agent, 'agent-codex-review')?.description).toBe('Static command owns this name.')
    expect(warn).toHaveBeenCalledWith(
      'agent-mesh-commands: skipped native command /agent-codex-review; the name is already registered',
    )
    staticDispose()
  })

  it('logs a failed native command scope disposal', async () => {
    const test = await harness()
    const codex = adapter('codex')
    vi.spyOn(codex, 'readCapabilities').mockResolvedValue({
      agentId: codex.id,
      tools: [], skills: [], mcpServers: [],
      commands: [{ name: 'review', source: 'user', path: '/home/person/.codex/prompts/review.md' }],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    })
    test.ctx.agentMesh.register(codex)
    const inject = test.agent.ctx.inject.bind(test.agent.ctx)
    vi.spyOn(test.agent.ctx, 'inject').mockImplementation((dependencies, callback) => {
      const fiber = inject(dependencies, callback)
      return new Proxy(fiber, {
        get(target, property, receiver) {
          if (property === 'dispose') return () => Promise.reject(new Error('scope dispose failed'))
          // oxlint-disable-next-line typescript/no-unsafe-return -- Proxy get forwards arbitrary Fiber members unchanged.
          return Reflect.get(target, property, receiver)
        },
      })
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    await test.ctx.agentMesh.bind(test.agent.id, codex.id)
    await test.unregisterAgent()
    await vi.waitFor(() =>{  expect(warn).toHaveBeenCalledWith(
      `agent-mesh-commands: could not dispose native commands for ${test.agent.id}: scope dispose failed`,
    ) })
  })

  it('ignores stale lifecycle events and bindings without a registered Agent', async () => {
    const test = await harness()
    const codex = adapter('codex')
    test.ctx.agentMesh.register(codex)
    const orphan = testAgent(test.ctx, [])
    const detach = test.ctx.agents.enter(orphan, undefined)
    await agentEvents(test.ctx, orphan).serial('agent/created', { source: 'startup' })
    detach()

    await expect(preStep(test, new AbortController().signal, orphan)).resolves.toEqual({
      kind: 'enter', messages: [],
    })
    await test.ctx.agentMesh.bind(orphan.id, codex.id)
    await agentEvents(test.ctx, orphan).serial('agent/disposed', { agent: orphan })
    expect(test.ctx.commands.list(orphan)).toHaveLength(6)

    const absent = testAgent(test.ctx, [])
    await agentEvents(test.ctx, absent).serial('agent/disposed', { agent: absent })
    await test.ctx.agentMesh.bind(SessionId('no-live-agent'), codex.id)
  })

  it('does not install commands after the Agent leaves while capability discovery is pending', async () => {
    const test = await harness()
    const codex = adapter('codex')
    const inventory: AgentCapabilityInventory = {
      agentId: codex.id,
      tools: [], skills: [], mcpServers: [],
      commands: [{ name: 'review', source: 'user', path: '/home/person/.codex/prompts/review.md' }],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    }
    let announceRead!: () => void
    const readStarted = new Promise<void>((resolve) => { announceRead = resolve })
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    vi.spyOn(codex, 'readCapabilities').mockImplementation(async () => {
      announceRead()
      await readGate
      return inventory
    })
    test.ctx.agentMesh.register(codex)
    const orphan = testAgent(test.ctx, [])
    const detach = test.ctx.agents.enter(orphan, undefined)
    await agentEvents(test.ctx, orphan).serial('agent/created', { source: 'startup' })

    const binding = test.ctx.agentMesh.bind(orphan.id, codex.id)
    await readStarted
    detach()
    await expect(preStep(test, new AbortController().signal, orphan)).resolves.toEqual({
      kind: 'enter', messages: [],
    })
    releaseRead()
    await binding
    expect(test.ctx.commands.find(orphan, 'agent-codex-review')).toBeUndefined()
    await agentEvents(test.ctx, orphan).serial('agent/disposed', { agent: orphan })
  })

  it('shares an in-flight scoped command registry across overlapping refreshes', async () => {
    const test = await harness()
    const codex = adapter('codex')
    const inventory: AgentCapabilityInventory = {
      agentId: codex.id,
      tools: [], skills: [], mcpServers: [],
      commands: [{ name: 'review', source: 'user', path: '/home/person/.codex/prompts/review.md' }],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    }
    const read = vi.spyOn(codex, 'readCapabilities').mockResolvedValue(inventory)
    test.ctx.agentMesh.register(codex)

    let announceInjection!: () => void
    const injectionStarted = new Promise<void>((resolve) => { announceInjection = resolve })
    let releaseInjection!: () => void
    const injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve })
    let announceSecondRead!: () => void
    const secondReadStarted = new Promise<void>((resolve) => { announceSecondRead = resolve })
    let announceSecondResume!: () => void
    const secondReadResumed = new Promise<void>((resolve) => { announceSecondResume = resolve })
    let releaseSecondRead!: (inventory: AgentCapabilityInventory) => void
    const inject = test.agent.ctx.inject.bind(test.agent.ctx)
    vi.spyOn(test.agent.ctx, 'inject').mockImplementation((dependencies, callback) => {
      const fiber = inject(dependencies, () => {})
      return new Proxy(fiber, {
        get(target, property, receiver) {
          if (property === 'then') {
            return (onFulfilled: ((value: Fiber) => unknown) | null | undefined,
              onRejected: ((reason: unknown) => unknown) | null | undefined) => {
              announceInjection()
              return injectionGate.then(() => {
                callback(fiber.ctx)
                return target.then(onFulfilled, onRejected)
              })
            }
          }
          // oxlint-disable-next-line typescript/no-unsafe-return -- Proxy get forwards arbitrary Fiber members unchanged.
          return Reflect.get(target, property, receiver)
        },
      })
    })

    const binding = test.ctx.agentMesh.bind(test.agent.id, codex.id)
    await injectionStarted
    read.mockImplementationOnce(() => new Promise((resolve) => {
      announceSecondRead()
      releaseSecondRead = (value) => {
        resolve(value)
        queueMicrotask(announceSecondResume)
      }
    }))
    let secondSettled = false
    const overlap = preStep(test).finally(() => { secondSettled = true })
    await secondReadStarted
    releaseSecondRead(inventory)
    await secondReadResumed
    expect(secondSettled).toBe(false)
    releaseInjection()

    await Promise.all([binding, overlap])
    expect(test.ctx.commands.find(test.agent, 'agent-codex-review')).toBeDefined()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('contains a failed in-flight injection after Agent disposal', async () => {
    const test = await harness()
    const codex = adapter('codex')
    vi.spyOn(codex, 'readCapabilities').mockResolvedValue({
      agentId: codex.id,
      tools: [], skills: [], mcpServers: [],
      commands: [{ name: 'review', source: 'user', path: '/home/person/.codex/prompts/review.md' }],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    })
    test.ctx.agentMesh.register(codex)

    let announceInjection!: () => void
    const injectionStarted = new Promise<void>((resolve) => { announceInjection = resolve })
    let releaseInjection!: () => void
    const injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve })
    const inject = test.agent.ctx.inject.bind(test.agent.ctx)
    vi.spyOn(test.agent.ctx, 'inject').mockImplementation((dependencies) => {
      const fiber = inject(dependencies, () => {})
      return new Proxy(fiber, {
        get(target, property, receiver) {
          if (property === 'then') {
            return (onFulfilled: ((value: Fiber) => unknown) | null | undefined,
              onRejected: ((reason: unknown) => unknown) | null | undefined) => {
              announceInjection()
              return injectionGate.then(() => Promise.reject(new Error('injection failed'))).then(onFulfilled, onRejected)
            }
          }
          // oxlint-disable-next-line typescript/no-unsafe-return -- Proxy get forwards arbitrary Fiber members unchanged.
          return Reflect.get(target, property, receiver)
        },
      })
    })

    const binding = test.ctx.agentMesh.bind(test.agent.id, codex.id)
    await injectionStarted
    const disposal = test.unregisterAgent()
    releaseInjection()
    await Promise.all([binding, disposal])

    expect(test.ctx.commands.list(test.agent)).toHaveLength(6)
  })

  it('silences capability-read and command-registration errors after cancellation', async () => {
    const test = await harness()
    const codex = adapter('codex')
    const inventory: AgentCapabilityInventory = {
      agentId: codex.id,
      tools: [], skills: [], mcpServers: [],
      commands: [{ name: 'review', source: 'user', path: '/home/person/.codex/prompts/review.md' }],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    }
    const empty: AgentCapabilityInventory = { ...inventory, commands: [] }
    const read = vi.spyOn(codex, 'readCapabilities').mockResolvedValue(empty)
    test.ctx.agentMesh.register(codex)
    await test.ctx.agentMesh.bind(test.agent.id, codex.id)
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    const readController = new AbortController()
    read.mockImplementationOnce(async () => {
      readController.abort()
      return inventory
    })
    await expect(preStep(test, readController.signal)).resolves.toEqual({
      kind: 'enter', messages: [],
    })
    expect(warn).not.toHaveBeenCalled()

    const registrationController = new AbortController()
    read.mockResolvedValueOnce(inventory)
    const register = vi.spyOn(test.ctx.commands, 'register').mockImplementationOnce(() => {
      registrationController.abort()
      throw new Error('registration canceled')
    })
    await expect(preStep(test, registrationController.signal)).resolves.toEqual({
      kind: 'enter', messages: [],
    })
    expect(register).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('lists registered agents with coarse credential states and keeps partial failures visible', async () => {
    const test = await harness()
    test.ctx.agentMesh.register(adapter('codex', { auth: { status: 'authenticated', source: 'file' } }))
    test.ctx.agentMesh.register(adapter('grok', { auth: { status: 'expired', source: 'keyring' } }))
    test.ctx.agentMesh.register(adapter('pi', { authError: true }))
    test.ctx.agentMesh.register(adapter('claude', { auth: { status: 'unauthenticated', source: 'none' } }))
    test.ctx.agentMesh.register(adapter('misconfigured', { auth: { status: 'misconfigured', source: 'file' } }))
    test.ctx.agentMesh.register(adapter('offline', {
      descriptor: descriptor('offline', false), auth: { status: 'unauthenticated', source: 'none' },
    }))
    test.ctx.agentMesh.register(adapter('omp', { describeError: true }))
    test.ctx.agentMesh.register(adapter('stale'))
    const lookupAdapter = test.ctx.agentMesh.adapter.bind(test.ctx.agentMesh)
    vi.spyOn(test.ctx.agentMesh, 'adapter').mockImplementation((id) => {
      if (String(id) === 'stale') throw new Error('adapter was removed during the listing')
      return lookupAdapter(id)
    })

    const result = await run(test, 'agents')
    expect(result).toEqual({
      kind: 'success',
      text: [
        'Agents',
        '- CODEX (codex) · installed · auth authenticated',
        '- GROK (grok) · installed · auth expired',
        '- PI (pi) · installed · auth unknown',
        '- CLAUDE (claude) · installed · auth unauthenticated',
        '- MISCONFIGURED (misconfigured) · installed · auth misconfigured',
        '- OFFLINE (offline) · not installed · auth unauthenticated',
        '- omp: details unavailable',
        '- stale: unavailable',
      ].join('\n'),
    })
    expect(await run(test, 'agents', ' unexpected')).toEqual({ kind: 'error', text: 'Usage: /agents' })
    expect(test.ctx.agentMesh.ids.length).toBe(8)
  })

  it('lists bounded native sessions, forwards the cwd and cancellation, and reports store failures', async () => {
    const test = await harness()
    const signal = new AbortController().signal
    const seen: { cwd?: string; limit?: number; signal?: AbortSignal }[] = []
    const codexSessions = Array.from({ length: 15 }, (_, index) => session(`c${index}`, agentId('codex'), `2026-10-16T03:${String(index).padStart(2, '0')}:00.000Z`))
    const grokSessions = Array.from({ length: 15 }, (_, index) => session(`g${index}`, agentId('grok'), `2026-10-16T03:${String(index).padStart(2, '0')}:00.000Z`))
    grokSessions.push(session('bare', agentId('grok'), '2026-10-16T03:59:00.000Z', false))
    test.ctx.agentMesh.register(adapter('codex', { sessions: codexSessions, onList: request => seen.push(request) }))
    test.ctx.agentMesh.register(adapter('grok', { sessions: grokSessions, onList: request => seen.push(request) }))
    test.ctx.agentMesh.register(adapter('pi', { listError: 'native store is unreadable' }))

    const result = await run(test, 'agent-sessions', ' /work', signal)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Native agent sessions in /work')
    expect(result.text).toContain('- codex · session c14 · idle · 2026-10-16T03:14:00.000Z · /work')
    expect(result.text).toContain('- grok · bare · idle · 2026-10-16T03:59:00.000Z')
    expect(result.text).toContain('Showing 20 of 31 returned sessions; each provider was limited to 20.')
    expect(result.text).toContain('Store read failures:\n- pi: native store is unreadable')
    expect(seen).toHaveLength(2)
    expect(seen).toEqual(expect.arrayContaining([
      { cwd: '/work', limit: 20, signal },
      { cwd: '/work', limit: 20, signal },
    ]))

    expect(await run(test, 'agent-sessions', ' /work\n/extra')).toEqual({
      kind: 'error',
      text: 'Usage: /agent-sessions [cwd]',
    })
    const emptyHarness = await harness()
    const empty = await run(emptyHarness, 'agent-sessions')
    expect(empty.text).toContain('- No sessions returned.')
  })

  it('reads native stores for refresh without creating another session index', async () => {
    const test = await harness()
    const seen: { limit?: number; signal?: AbortSignal }[] = []
    test.ctx.agentMesh.register(adapter('codex', {
      sessions: [session('one')],
      onList: request => seen.push(request),
    }))
    test.ctx.agentMesh.register(adapter('grok', { listError: 'store read failed' }))
    const result = await run(test, 'agent-refresh')
    expect(result.text).toContain('Live native-store read completed.')
    expect(result.text).toContain('DSH does not build a second session index.')
    expect(result.text).toContain('- codex: 1')
    expect(result.text).toContain('Store read failures:\n- grok: store read failed')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.limit).toBe(100)
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(await run(test, 'agent-refresh', ' --force')).toEqual({ kind: 'error', text: 'Usage: /agent-refresh' })
  })

  it('reports empty registration state and unavailable durable bindings', async () => {
    const test = await harness()
    expect((await run(test, 'agents')).text).toBe('No external agents are registered.')
    expect((await run(test, 'agents-diagnostics')).text).toBe('No external agents are registered.')
    const refresh = await run(test, 'agent-refresh')
    expect(refresh.text).toContain('- No external agents are registered.')
    expect(refresh.text).not.toContain('Store read failures:')

    const report: AgentMeshDiagnostics = {
      agents: [
        { id: agentId('ghost'), warnings: [] },
        { id: agentId('unresolved'), detection: { installed: false, source: 'none' }, warnings: [] },
      ],
      bindingsReady: false,
    }
    vi.spyOn(test.ctx.agentMesh, 'diagnostics').mockResolvedValue(report)
    const diagnostics = await run(test, 'agents-diagnostics')
    expect(diagnostics.text).toContain('Binding store: not ready')
    expect(diagnostics.text).toContain('- ghost (ghost)')
    expect(diagnostics.text).toContain('- unresolved (unresolved)')
    expect(diagnostics.text).toContain('Detection: not installed via none')
    expect(diagnostics.text).not.toContain('Version:')
    expect(diagnostics.text).not.toContain('Binary:')
    expect(diagnostics.text).not.toContain('Warning:')

    const state = await run(test, 'mesh-state')
    expect(state.text).toContain('Binding store: not ready')
    expect(state.text).toContain('Session marks: 0 pinned, 0 archived')
    expect(state.text).toContain('Runs: 0 tracked, 0 running')
  })

  it('shows native detection and store diagnostics without hiding partial provider warnings', async () => {
    const test = await harness()
    test.ctx.agentMesh.register(adapter('codex'))
    test.ctx.agentMesh.register(adapter('grok', { descriptor: descriptor('grok', false) }))
    test.ctx.agentMesh.register(adapter('partial', { describeError: true }))
    const result = await run(test, 'agents-diagnostics')
    expect(result.text).toContain('Binding store: ready')
    expect(result.text).toContain('CODEX (codex)')
    expect(result.text).toContain('Detection: installed via path')
    expect(result.text).toContain('Version: 1.2.3')
    expect(result.text).toContain('Binary: /opt/codex/bin/codex')
    expect(result.text).toContain('Sessions: /Users/person/.codex/sessions')
    expect(result.text).toContain('Credentials: /Users/person/.codex/credentials.json')
    expect(result.text).toContain('Warning: grok binary was not found')
    expect(result.text).toContain('partial (partial)')
    expect(result.text).toContain('Warning: the adapter could not describe this agent: description unavailable')
    expect(await run(test, 'agents-diagnostics', ' extra')).toEqual({ kind: 'error', text: 'Usage: /agents-diagnostics' })
  })

  it('lists recent run metadata without exposing prompts and summarizes native mesh state', async () => {
    const test = await harness()
    const codexSession = session('one')
    const archivedSession = session('two')
    test.ctx.agentMesh.register(adapter('codex', { sessions: [codexSession, archivedSession] }))
    await test.ctx.agentMesh.bind(test.agent.id, agentId('codex'))
    await test.ctx.agentMesh.pinSession({ agentId: agentId('codex'), nativeId: 'one' })
    await test.ctx.agentMesh.archiveSession({ agentId: agentId('codex'), nativeId: 'two' })

    expect((await run(test, 'mesh-runs')).text).toBe('No tracked Agent Mesh runs.')
    const snapshots: readonly MeshRunSnapshot[] = [
      {
        runId: 'run-running', agentId: 'codex', cwd: '/work', prompt: 'private prompt', status: 'running',
        startedAt: '2026-10-16T03:00:00.000Z', notes: [], events: [], eventCount: 1,
      },
      {
        runId: 'run-failed', agentId: 'grok', cwd: '/repo', prompt: 'another private prompt', status: 'failed',
        startedAt: '2026-10-16T02:00:00.000Z', finishedAt: '2026-10-16T02:01:00.000Z',
        error: { code: 'mesh/test', message: 'failure' }, notes: [], events: [], eventCount: 2,
      },
    ]
    vi.spyOn(test.ctx.agentMesh, 'runs', 'get').mockReturnValue(snapshots)
    const runs = await run(test, 'mesh-runs')
    expect(runs.text).toContain('run-running · codex · running')
    expect(runs.text).toContain('run-failed · grok · failed')
    expect(runs.text).toContain('error mesh/test')
    expect(runs.text).not.toContain('private prompt')
    expect(await run(test, 'mesh-runs', ' bad')).toEqual({ kind: 'error', text: 'Usage: /mesh-runs' })

    const state = await run(test, 'mesh-state')
    expect(state.text).toContain('Agents: 1')
    expect(state.text).toContain('Binding store: ready (1 bindings)')
    expect(state.text).toContain('Session marks: 1 pinned, 1 archived')
    expect(state.text).toContain('Runs: 2 tracked, 1 running')
    expect(state.text).toContain('DSH storage domains')
    expect(await run(test, 'mesh-state', ' bad')).toEqual({ kind: 'error', text: 'Usage: /mesh-state' })
  })
})
