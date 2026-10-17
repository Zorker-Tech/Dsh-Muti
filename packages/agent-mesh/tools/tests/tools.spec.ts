import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AgentRegistry, agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { PreToolDecision, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import AgentMesh from '@deepseek-ai/dsh-agent-mesh'
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentId,
  AgentRunEvent,
  AgentRunId,
  AgentRunResult,
  AgentSession,
  AgentSessionKey,
  MeshRunSnapshot,
} from '@deepseek-ai/dsh-agent-mesh'
import * as meshTools from '../src/index.ts'

const fakeMcp = vi.hoisted(() => ({
  configurations: [] as unknown[],
  closed: [] as string[],
  startupGate: undefined as Promise<void> | undefined,
  failStartup: false,
  failScopeDispose: false,
}))

vi.mock('@deepseek-ai/dsh-mcp-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client')>()
  return {
    ...original,
    async apply(ctx: Context, config: { readonly serverName: string }) {
      fakeMcp.configurations.push(config)
      await fakeMcp.startupGate
      ctx.tools.register(defineTool({
        name: `mcp__${config.serverName}__ping`,
        description: 'Ping the test MCP server.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return 'pong' },
      }))
      ctx.effect(() => () => {
        fakeMcp.closed.push(config.serverName)
      }, 'test MCP client disposal')
      if (fakeMcp.failStartup) throw new Error('test MCP startup failed')
    },
  }
})

vi.mock('@deepseek-ai/dsh-scope', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-scope')>()
  return {
    ...original,
    createScope: (...args: Parameters<typeof original.createScope>) => {
      const scope = original.createScope(...args)
      return {
        ...scope,
        async dispose() {
          await scope.dispose()
          if (fakeMcp.failScopeDispose) throw new Error('test scope disposal rejected')
        },
      }
    },
  }
})

const roots: string[] = []
const fibers: Fiber[] = []
const registeredAgents: Array<() => Promise<void>> = []
const agentScopes: Scope[] = []
let callNumber = 0
let approvalAgentNumber = 0

afterEach(async () => {
  for (const registration of registeredAgents.splice(0)) await registration()
  for (const scope of agentScopes.splice(0)) await scope.dispose()
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  fakeMcp.configurations.length = 0
  fakeMcp.closed.length = 0
  fakeMcp.startupGate = undefined
  fakeMcp.failStartup = false
  fakeMcp.failScopeDispose = false
})

const agentId = (value: string): AgentId => brandString<AgentId>(value)
const sessionId = (value: string): SessionId => brandString<SessionId>(value)

/** An adapter whose session store holds exactly one readable session. */
function adapter(): AgentAdapter {
  const descriptor: AgentDescriptor = {
    id: agentId('codex'),
    displayName: 'Codex',
    summary: 'test agent',
    capabilities: {
      runModes: ['headless-exec'],
      streaming: true,
      resume: false,
      interrupt: false,
      listSessions: true,
      readTranscript: true,
      nativeTodos: true,
      nativePlan: false,
      listModels: false,
      sandboxProfiles: [],
      approvalModes: [],
      credentials: { status: true, login: [], logout: false },
    },
    detection: { installed: true, binaryPath: '/usr/bin/codex', source: 'path', version: '1.2.3' },
    transports: [{ mode: 'headless-exec', mechanism: 'codex exec --json', available: true }],
    sessionRoot: '/home/person/.codex/sessions',
    environmentKeys: [],
  }
  return {
    id: descriptor.id,
    describe: async () => descriptor,
    readAuthState: async () => ({ status: 'authenticated', source: 'file' }),
    listSessions: async () => [{
      key: brandString<AgentSessionKey>('codex:abc'),
      agentId: descriptor.id,
      nativeId: 'abc',
      title: 'a stored session',
      cwd: '/work',
      createdAt: '2026-10-16T02:00:00.000Z',
      updatedAt: '2026-10-16T03:00:00.000Z',
      status: 'idle',
      messageCount: 4,
      notes: [],
    }],
    nativeLaunchCommand: async nativeId => ['/usr/bin/codex', 'resume', nativeId],
    readTranscript: async request => ({
      key: request.session.key,
      messages: [{ index: 0, role: 'user', kind: 'user', text: 'hello' }],
      totalMessages: 1,
      hasMore: false,
      notes: [],
    }),
    readNativeTasks: async () => ({
      available: true,
      todos: [{ id: 'codex:1', content: 'do the thing', status: 'in_progress', owner: 'codex', blockedBy: [], updatedAt: '2026-10-16T03:00:00.000Z' }],
      notes: [],
    }),
    listModels: async () => [],
    readCapabilities: async () => ({
      agentId: descriptor.id, tools: [], skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    }),
    resolveMcpServer: async () => undefined,
    login: async () => ({ ok: false, action: 'login', state: { status: 'unauthenticated', source: 'none' } }),
    logout: async () => ({ ok: false, action: 'logout', state: { status: 'unauthenticated', source: 'none' } }),
    startRun: () => {
      throw new Error('not used in this test')
    },
  }
}

async function mount(
  beforeMeshTools?: (ctx: Context) => void,
  approvalOutcome: ApprovalOutcome = 'allowed-once',
  config: meshTools.Config = {},
  installMeshTools = true,
): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-mesh-tools-'))
  roots.push(root)
  const ctx = new Context()
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(root, '.storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  fibers.push(await ctx.plugin(LocalFileSystem, { cwd: root }))
  provideWorkingDirectoryFixture(ctx, root)
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(Tools))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(AgentMesh))
  fibers.push(await ctx.plugin(ApprovalService))
  beforeMeshTools?.(ctx)
  ctx.on('approval/request', () => Promise.resolve(approvalOutcome))
  if (installMeshTools) fibers.push(await ctx.plugin(meshTools, config))
  return ctx
}

/** One open session for driving an approval request through the real service. */
function approvalAgent(ctx?: Context): Agent {
  const session = Session.create(SessionId(`mesh-tools-approval-${++approvalAgentNumber}`))
  session.append('turn/start', { turn: 1 })
  return { id: session.id, session, ...(ctx === undefined ? {} : { ctx }) } as Agent
}

/** Session-scoped subject for direct pre-step contribution tests. */
function contextAgent(): Agent {
  const session = Session.create(SessionId(`mesh-context-${++approvalAgentNumber}`))
  return { id: session.id, session } as Agent
}

/** Session-scoped Agent fixture for tool visibility and approval dispatch tests. */
async function scopedContextAgent(ctx: Context): Promise<Agent> {
  const agent = contextAgent()
  agent.session.append('turn/start', { turn: 1 })
  const scope = createScope(ctx, agent)
  agentScopes.push(scope)
  Object.assign(agent, { ctx: scope.ctx })
  registeredAgents.push(await ctx.agents.register(agent))
  return agent
}

async function preStep(ctx: Context, agent: Agent, step: number) {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

async function nativeContext(ctx: Context, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({ agent })
  const refreshed = ctx.systemPrompt.refreshContext(assembly, { agent })
  return refreshed.contexts.find(context => context.name === 'agent-mesh:native-context')?.text ?? ''
}

/** Call one registered mesh tool through the normal runtime. */
function callTool(ctx: Context, name: string, args: unknown, agent?: Agent, signal?: AbortSignal) {
  return ctx.tools.execute({
    signal: signal ?? new AbortController().signal,
    callId: ToolCallId(`mesh-tool-${++callNumber}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
}

/** Call one registered mesh tool through a user-approved open session. */
function callApprovedTool(ctx: Context, name: string, args: unknown) {
  return callTool(ctx, name, args, approvalAgent())
}

/** Build the minimum execution identity needed to exercise a proxy's owner guard directly. */
function proxyExecution(agent: Agent | undefined, name: string): ToolRunContext {
  const callId = ToolCallId(`mesh-proxy-direct-${++callNumber}`)
  return {
    callId,
    rootCallId: callId,
    name,
    arguments: { task: 'Read README.md.' },
    ...(agent === undefined ? {} : { agent }),
    token: Symbol('test tool execution') as ToolExecutionToken,
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  }
}

/** Join the text blocks rendered for a tool result. */
function renderedText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('agent mesh tools', () => {
  it('registers the mesh tools on the tool runtime', async () => {
    const ctx = await mount()
    for (const name of ['mesh_agents', 'mesh_capabilities', 'mesh_capability_read', 'mesh_sessions', 'mesh_transcript', 'mesh_tasks']) {
      const definition = ctx.get('tools')?.get(name)
      expect(definition, `${name} should be registered`).toBeDefined()
      expect(definition?.description.length ?? 0).toBeGreaterThan(20)
    }
  })

  it('rejects invalid native-context byte budgets', () => {
    expect(() =>{  meshTools.apply(new Context(), { contextMaxBytes: 0 }) }).toThrow(
      'agent-mesh-tools: contextMaxBytes must be a positive safe integer',
    )
    expect(() =>{  meshTools.apply(new Context(), { contextMaxBytes: 1.5 }) }).toThrow(
      'agent-mesh-tools: contextMaxBytes must be a positive safe integer',
    )
  })

  it('rejects proxy tool counts outside the configured bound', () => {
    expect(() =>{  meshTools.apply(new Context(), { maxProxyTools: -1 }) }).toThrow(
      'agent-mesh-tools: maxProxyTools must be an integer between 0 and 64',
    )
    expect(() =>{  meshTools.apply(new Context(), { maxProxyTools: 65 }) }).toThrow(
      'agent-mesh-tools: maxProxyTools must be an integer between 0 and 64',
    )
  })

  it('can disable native tool proxies', async () => {
    const ctx = await mount(undefined, 'allowed-once', { maxProxyTools: 0 })
    const external = adapter()
    ctx.agentMesh.register(external)
    vi.spyOn(external, 'readCapabilities').mockResolvedValue({
      agentId: external.id,
      tools: [{ name: 'read_file', source: 'builtin' }],
      skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    })
    const agent = await scopedContextAgent(ctx)
    await ctx.agentMesh.bind(agent.id, external.id)

    expect(ctx.tools.schemas(agent).some(schema => schema.name.startsWith('mesh_agent_tool_'))).toBe(false)
  })

  it('uses the default native-context budget when apply receives no config', async () => {
    const ctx = await mount(undefined, 'allowed-once', {}, false)
    const directPlugin = {
      name: 'agent-mesh-tools-direct-config',
      inject: meshTools.inject,
      apply: meshTools.apply,
    }
    fibers.push(await ctx.plugin(directPlugin))

    expect(ctx.tools.get('mesh_agents')).toBeDefined()
  })

  it('keeps the mesh registry and the binding reachable through the same context', async () => {
    const ctx = await mount()
    ctx.agentMesh.register(adapter())
    await ctx.agentMesh.bind(sessionId('sess-1'), agentId('codex'))
    expect(ctx.agentMesh.bound(sessionId('sess-1'))).toBe(agentId('codex'))
    const sessions = await ctx.agentMesh.adapter(agentId('codex')).listSessions({})
    expect(sessions[0]?.key).toBe('codex:abc')
  })

  it('reads and renders an agent capability inventory', async () => {
    const ctx = await mount()
    const agent = adapter()
    ctx.agentMesh.register(agent)
    const inventory = {
      agentId: agentId('codex'),
      tools: [{ name: 'read_file', source: 'builtin' as const }],
      skills: [{ name: 'review', description: 'Review changes', source: 'user' as const, path: '/home/person/.codex/skills/review/SKILL.md' }],
      mcpServers: [{ name: 'docs', transport: 'stdio' as const, command: 'docs-mcp', enabled: true, source: 'user' as const }],
      commands: [{ name: 'review', source: 'user' as const, path: '/home/person/.codex/prompts/review.md' }],
      contextFiles: ['/repo/AGENTS.md'],
      sources: [{ path: '/home/person/.codex/config.toml', present: true }],
      notes: [{ field: 'tools', reason: 'built-in tools come from the CLI' }],
      observedAt: '2026-10-16T00:00:00.000Z',
    }
    const read = vi.spyOn(agent, 'readCapabilities').mockResolvedValue(inventory)
    const result = await callTool(ctx, 'mesh_capabilities', { agentId: 'codex', cwd: '/repo' })
    expect(read).toHaveBeenCalledWith({ cwd: '/repo' })
    expect(result.isError).toBe(false)
    expect(JSON.parse(renderedText(result))).toEqual(inventory)

    const noScope = await callTool(ctx, 'mesh_capabilities', { agentId: 'codex' })
    expect(read).toHaveBeenLastCalledWith({})
    expect(JSON.parse(renderedText(noScope))).toEqual(inventory)
  })

  it('refreshes native context through the durable runtime-context projection', async () => {
    const ctx = await mount()
    const root = roots.at(-1)!
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, 'Follow the native project rules.', 'utf8')
    const external = adapter()
    ctx.agentMesh.register(external)
    const readCapabilities = vi.spyOn(external, 'readCapabilities').mockResolvedValue({
      agentId: external.id,
      tools: [], skills: [], mcpServers: [], commands: [],
      contextFiles: [path], sources: [],
      notes: [{ field: 'contextFiles', reason: 'one native instruction file could not be read' }],
      observedAt: '2026-10-16T00:00:00.000Z',
    })
    const agent = contextAgent()
    const neverPreparedAgent = contextAgent()
    expect(await nativeContext(ctx, neverPreparedAgent)).toBe('')

    const unbound = await preStep(ctx, agent, 1)
    expect(unbound.kind).toBe('enter')
    if (unbound.kind !== 'enter') throw new Error('pre-step was unexpectedly rejected')
    expect(unbound.messages).toEqual([])
    expect(readCapabilities).not.toHaveBeenCalled()
    expect(await nativeContext(ctx, agent)).toBe('')

    await ctx.agentMesh.bind(agent.id, external.id)
    const initial = await preStep(ctx, agent, 2)
    expect(initial.kind).toBe('enter')
    if (initial.kind !== 'enter') throw new Error('pre-step was unexpectedly rejected')
    expect(initial.messages).toEqual([])
    const firstText = await nativeContext(ctx, agent)
    expect(firstText).toContain(`Native context for codex in ${JSON.stringify(root)}.`)
    expect(firstText).toContain(`Instructions from native file ${JSON.stringify(path)}`)
    expect(firstText).toContain('Follow the native project rules.')
    expect(firstText).toContain('The native adapter could not fully discover context files: one native instruction file could not be read')

    const unchanged = await preStep(ctx, agent, 3)
    expect(unchanged.kind).toBe('enter')
    if (unchanged.kind !== 'enter') throw new Error('pre-step was unexpectedly rejected')
    expect(unchanged.messages).toEqual([])
    expect(await nativeContext(ctx, agent)).toBe(firstText)

    writeFileSync(path, 'The native project rules changed.', 'utf8')
    const changed = await preStep(ctx, agent, 4)
    expect(changed.kind).toBe('enter')
    if (changed.kind !== 'enter') throw new Error('pre-step was unexpectedly rejected')
    expect(changed.messages).toEqual([])
    const changedText = await nativeContext(ctx, agent)
    expect(changedText).not.toBe(firstText)
    expect(changedText).toContain('The native project rules changed.')

    readCapabilities.mockResolvedValue({
      agentId: external.id,
      tools: [], skills: [], mcpServers: [], commands: [],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:01.000Z',
    })
    const cleared = await preStep(ctx, agent, 5)
    expect(cleared.kind).toBe('enter')
    if (cleared.kind !== 'enter') throw new Error('pre-step was unexpectedly rejected')
    expect(cleared.messages).toEqual([])
    expect(await nativeContext(ctx, agent)).toBe('')

    const stillClear = await preStep(ctx, agent, 6)
    expect(stillClear.kind).toBe('enter')
    if (stillClear.kind !== 'enter') throw new Error('pre-step was unexpectedly rejected')
    expect(stillClear.messages).toEqual([])
  })

  it('registers only current native tool proxies in the bound Agent scope', async () => {
    const ctx = await mount()
    const external = adapter()
    ctx.agentMesh.register(external)
    let tools = [
      { name: 'read_file', description: 'Native-only read implementation details.', source: 'builtin' as const },
      { name: 'shell', source: 'builtin' as const },
    ]
    vi.spyOn(external, 'readCapabilities').mockImplementation(async () => ({
      agentId: external.id, tools, skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    }))
    const boundAgent = await scopedContextAgent(ctx)
    const otherAgent = await scopedContextAgent(ctx)
    await ctx.agentMesh.bind(boundAgent.id, external.id)

    const firstAssembly = await ctx.systemPrompt.assemble({ agent: boundAgent, scope: boundAgent })
    const firstAssemblyNames = firstAssembly.tools.map(schema => schema.name)
    const firstNames = ctx.tools.schemas(boundAgent).map(schema => schema.name)
    const readFileProxy = firstNames.find(name => name.startsWith('mesh_agent_tool_') && name.includes('read_file'))
    const shellProxy = firstNames.find(name => name.startsWith('mesh_agent_tool_') && name.includes('shell'))
    expect(readFileProxy).toBeDefined()
    expect(shellProxy).toBeDefined()
    const readFileSchema = firstAssembly.tools.find(schema => schema.name === readFileProxy)
    expect(readFileSchema?.description).not.toContain('Native-only read implementation details')
    expect(JSON.stringify(readFileSchema?.parameters)).toContain('task')
    expect(firstAssemblyNames).toContain(readFileProxy)
    expect(ctx.tools.schemas(otherAgent).map(schema => schema.name)).not.toContain(readFileProxy)
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain(readFileProxy)

    tools = [{ name: 'read_file', source: 'builtin' }]
    await ctx.agentMesh.bind(boundAgent.id, external.id)
    expect(ctx.tools.schemas(boundAgent).map(schema => schema.name)).toContain(readFileProxy)
    expect(ctx.tools.schemas(boundAgent).map(schema => schema.name)).not.toContain(shellProxy)

    tools = []
    await ctx.agentMesh.bind(boundAgent.id, external.id)
    expect(ctx.tools.schemas(boundAgent).map(schema => schema.name)).not.toContain(readFileProxy)

    await ctx.agentMesh.unbind(boundAgent.id)
    expect(ctx.tools.schemas(boundAgent).map(schema => schema.name)).not.toContain(readFileProxy)
  })

  it('discovers native tools for an Agent created after an existing mesh binding', async () => {
    const ctx = await mount()
    const external = adapter()
    ctx.agentMesh.register(external)
    const readCapabilities = vi.spyOn(external, 'readCapabilities').mockResolvedValue({
      agentId: external.id,
      tools: [{ name: '***', source: 'builtin' }],
      skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    })
    const agent = contextAgent()
    agent.session.append('turn/start', { turn: 1 })
    const scope = createScope(ctx, agent)
    agentScopes.push(scope)
    Object.assign(agent, { ctx: scope.ctx })

    await ctx.agentMesh.bind(agent.id, external.id)
    registeredAgents.push(await ctx.agents.register(agent))

    const proxyName = ctx.tools.schemas(agent).find(schema => schema.name.startsWith('mesh_agent_tool_'))?.name
    expect(proxyName).toMatch(/^mesh_agent_tool_codex_tool_[a-f0-9]{10}$/u)
    const signal = new AbortController().signal
    await agentEvents(ctx, agent).serial('agent/created', { source: 'startup', signal })
    expect(readCapabilities).toHaveBeenLastCalledWith({ cwd: roots.at(-1)!, signal })
  })

  it('delegates a free-text task through DSH approval and forwards native approvals', async () => {
    const approvals: {
      readonly toolName: string
      readonly reason?: string
      readonly callId?: unknown
      readonly displayReason?: unknown
    }[] = []
    const ctx = await mount((inner) => {
      inner.on('approval/request', (request, next) => {
        approvals.push({
          toolName: request.toolName,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
        })
        return next()
      })
    })
    const external = adapter()
    ctx.agentMesh.register(external)
    vi.spyOn(external, 'readCapabilities').mockResolvedValue({
      agentId: external.id,
      tools: [{ name: 'read_file', description: 'Read a file.', source: 'builtin' }],
      skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    })
    const agent = await scopedContextAgent(ctx)
    await ctx.agentMesh.bind(agent.id, external.id)
    const proxyName = ctx.tools.schemas(agent).find(schema => schema.name.startsWith('mesh_agent_tool_'))?.name
    expect(proxyName).toBeDefined()
    const result: AgentRunResult = {
      runId: brandString<AgentRunId>('proxy-run'),
      agentId: external.id,
      status: 'succeeded',
      startedAt: '2026-10-16T03:00:00.000Z',
      finishedAt: '2026-10-16T03:00:01.000Z',
      durationMs: 1,
      cwd: roots.at(-1)!,
      finalText: 'file contents summarized',
      notes: [],
    }
    let nativeApproval: Promise<unknown[]> | undefined
    const startRun = vi.spyOn(ctx.agentMesh, 'startRun').mockImplementation((_agentId, request) => {
      nativeApproval = (async () => [
        await request.requestApproval?.({
          kind: 'command', title: 'Read file command', detail: 'Command: cat README.md', signal: new AbortController().signal,
        }),
        await request.requestApproval?.({
          kind: 'file-change', title: 'Update\nfile', detail: 'Path: /repo/README.md', signal: new AbortController().signal,
        }),
        await request.requestApproval?.({
          kind: 'interaction', title: 'Confirm tool action', detail: 'The agent needs confirmation.', signal: new AbortController().signal,
        }),
      ])()
      return { runId: result.runId, result: Promise.resolve(result) }
    })

    const dispatched = await callTool(ctx, proxyName!, { task: 'Read README.md and summarize it.' }, agent)
    expect(dispatched.isError).toBe(false)
    expect(renderedText(dispatched)).toContain('Delegated to codex\'s native tool "read_file".')
    expect(renderedText(dispatched)).toContain('answer: file contents summarized')
    expect(startRun).toHaveBeenCalledWith('codex', expect.objectContaining({
      cwd: roots.at(-1)!,
      prompt: 'Read README.md and summarize it.\n\nUse your native tool "read_file" to accomplish the task above. Report what you did and the result.',
    }))
    expect(await nativeApproval).toEqual(['allowed-once', 'allowed-once', 'allowed-once'])
    expect(approvals).toHaveLength(4)
    expect(approvals[0]?.toolName).toBe(proxyName)
    expect(approvals[1]?.toolName).toBe(proxyName)
    expect(approvals[1]?.reason).toBe('codex ("read_file"): Read file command\nCommand: cat README.md')
    expect(approvals[1]?.callId).toBeTypeOf('string')
    expect(approvals[2]?.reason).toBe('codex ("read_file"): Update file\nPath: /repo/README.md')
    expect(approvals[2]?.callId).toBe(approvals[1]?.callId)
    expect(approvals[3]?.reason).toBe('codex ("read_file"): Confirm tool action\nThe agent needs confirmation.')
    expect(approvals[3]?.displayReason).toEqual({
      en: 'The delegated agent needs a confirmation before it can continue.',
      zh: '被派发的智能体需要你的确认才能继续。',
    })
    expect(approvals[3]?.callId).toBe(approvals[1]?.callId)
  })

  it('renders native run errors and adapter notes without a final answer', async () => {
    const ctx = await mount()
    const external = adapter()
    ctx.agentMesh.register(external)
    vi.spyOn(external, 'readCapabilities').mockResolvedValue({
      agentId: external.id,
      tools: [{ name: 'read_file', source: 'builtin' }],
      skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    })
    const agent = await scopedContextAgent(ctx)
    await ctx.agentMesh.bind(agent.id, external.id)
    const proxyName = ctx.tools.schemas(agent).find(schema => schema.name.startsWith('mesh_agent_tool_'))?.name
    if (proxyName === undefined) throw new Error('native tool proxy was not registered')
    const runId = brandString<AgentRunId>('proxy-error-run')
    vi.spyOn(ctx.agentMesh, 'startRun').mockReturnValue({
      runId,
      result: Promise.resolve({
        runId,
        agentId: external.id,
        status: 'failed',
        startedAt: '2026-10-16T03:00:00.000Z',
        finishedAt: '2026-10-16T03:00:01.000Z',
        durationMs: 1,
        cwd: roots.at(-1)!,
        error: { code: 'run/failed', message: 'native tool request failed', remediation: 'Retry once.' },
        notes: ['the adapter omitted one native detail'],
      }),
    })

    const failed = await callTool(ctx, proxyName, { task: 'Read README.md.' }, agent)
    expect(failed.isError).toBe(false)
    expect(renderedText(failed)).toContain('Run proxy-error-run finished with status failed.')
    expect(renderedText(failed)).toContain('error (run/failed): native tool request failed')
    expect(renderedText(failed)).toContain('note: the adapter omitted one native detail')
    expect(renderedText(failed)).not.toContain('answer:')
  })

  it('denies a stale native tool proxy before starting an external run', async () => {
    const ctx = await mount()
    const external = adapter()
    ctx.agentMesh.register(external)
    let available = true
    vi.spyOn(external, 'readCapabilities').mockImplementation(async () => ({
      agentId: external.id,
      tools: available ? [{ name: 'read_file', source: 'builtin' }] : [],
      skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    }))
    const agent = await scopedContextAgent(ctx)
    const otherAgent = await scopedContextAgent(ctx)
    await ctx.agentMesh.bind(agent.id, external.id)
    const proxyName = ctx.tools.schemas(agent).find(schema => schema.name.startsWith('mesh_agent_tool_'))?.name
    expect(proxyName).toBeDefined()
    const proxy = ctx.tools.get(proxyName!, agent)
    expect(proxy).toBeDefined()
    const startRun = vi.spyOn(ctx.agentMesh, 'startRun')
    await expect(proxy!.execute({ task: 'Read README.md.' }, proxyExecution(otherAgent, proxyName!)))
      .rejects.toMatchObject({ code: 'mesh/unsupported-operation' })
    available = false

    const stale = await callTool(ctx, proxyName!, { task: 'Read README.md.' }, agent)
    expect(stale.isError).toBe(true)
    expect(renderedText(stale)).toContain('is no longer declared by codex')
    await ctx.agentMesh.unbind(agent.id)
    await expect(proxy!.execute({ task: 'Read README.md.' }, proxyExecution(agent, proxyName!)))
      .rejects.toMatchObject({ code: 'mesh/capability-not-declared' })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('ignores a native inventory read that finishes after the Agent is unbound', async () => {
    const ctx = await mount()
    const external = adapter()
    ctx.agentMesh.register(external)
    const agent = await scopedContextAgent(ctx)
    vi.spyOn(external, 'readCapabilities').mockImplementation(async () => {
      await ctx.agentMesh.unbind(agent.id)
      return {
        agentId: external.id,
        tools: [{ name: 'read_file', source: 'builtin' }],
        skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
        observedAt: '2026-10-16T00:00:00.000Z',
      }
    })

    await ctx.agentMesh.bind(agent.id, external.id)

    expect(ctx.tools.schemas(agent).some(schema => schema.name.startsWith('mesh_agent_tool_'))).toBe(false)
  })

  it('does not read native capabilities when a later pre-step listener rejects admission', async () => {
    const ctx = await mount()
    const external = adapter()
    ctx.agentMesh.register(external)
    const readCapabilities = vi.spyOn(external, 'readCapabilities')
    const agent = contextAgent()
    await ctx.agentMesh.bind(agent.id, external.id)
    ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))

    await expect(preStep(ctx, agent, 1)).resolves.toEqual({ kind: 'reject' })
    expect(readCapabilities).not.toHaveBeenCalled()
  })

  it('contributes an empty native context when prompt assembly has no Agent', async () => {
    const ctx = await mount()
    const assembly = await ctx.systemPrompt.assemble()
    const refreshed = ctx.systemPrompt.refreshContext(assembly)

    expect(refreshed.contexts.find(context => context.name === 'agent-mesh:native-context')?.text).toBe('')
  })

  it('stops step admission when rendered native context exceeds its configured byte budget', async () => {
    const ctx = await mount(undefined, 'allowed-once', { contextMaxBytes: 1 })
    const root = roots.at(-1)!
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, 'Native context.', 'utf8')
    const external = adapter()
    ctx.agentMesh.register(external)
    vi.spyOn(external, 'readCapabilities').mockResolvedValue({
      agentId: external.id,
      tools: [], skills: [], mcpServers: [], commands: [],
      contextFiles: [path], sources: [],
      notes: [{ field: 'contextFiles', reason: 'one native instruction file could not be read' }],
      observedAt: '2026-10-16T00:00:00.000Z',
    })
    const agent = contextAgent()
    await ctx.agentMesh.bind(agent.id, external.id)

    await expect(preStep(ctx, agent, 1)).rejects.toThrow('over contextMaxBytes 1')
  })

  it('reads only declared context and command files through the DSH filesystem', async () => {
    const ctx = await mount()
    const root = roots.at(-1)!
    const contextPath = join(root, 'AGENTS.md')
    const commandPath = join(root, 'prompts', 'review.md')
    const skillPath = join(root, 'skills', 'review', 'SKILL.md')
    const directoryPath = join(root, 'docs')
    const missingPath = join(root, 'missing.md')
    const largePath = join(root, 'large.md')
    const binaryPath = join(root, 'binary.md')
    const decoderErrorPath = join(root, 'decoder-error.md')
    mkdirSync(join(root, 'skills', 'review'), { recursive: true })
    mkdirSync(join(root, 'prompts'))
    mkdirSync(directoryPath)
    writeFileSync(contextPath, 'Use the project conventions.', 'utf8')
    writeFileSync(commandPath, '# Review\nInspect the diff.', 'utf8')
    writeFileSync(skillPath, '# Review skill\nInspect changed files.', 'utf8')
    writeFileSync(largePath, Buffer.alloc(1024 * 1024 + 1, 120))
    writeFileSync(binaryPath, Buffer.from([0xff]))
    writeFileSync(decoderErrorPath, 'ordinary text', 'utf8')
    const nulPath = join(root, 'nul.md')
    writeFileSync(nulPath, Buffer.from([0x41, 0x00, 0x42]))
    const external = adapter()
    ctx.agentMesh.register(external)
    const inventory = {
      agentId: external.id,
      tools: [],
      skills: [{ name: 'review', source: 'user' as const, path: skillPath }],
      mcpServers: [],
      commands: [{ name: 'review', source: 'user' as const, path: commandPath }],
      contextFiles: [contextPath, directoryPath, missingPath, largePath, binaryPath, nulPath, decoderErrorPath],
      sources: [],
      notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    }
    vi.spyOn(external, 'readCapabilities').mockResolvedValue(inventory)

    const context = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: contextPath, cwd: root })
    expect(context.isError).toBe(false)
    expect(JSON.parse(renderedText(context))).toEqual({
      agentId: 'codex', path: contextPath, kind: 'context', content: 'Use the project conventions.',
    })
    const contextWithoutCwd = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: contextPath })
    expect(contextWithoutCwd.isError).toBe(false)
    const command = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: commandPath, cwd: root })
    expect(JSON.parse(renderedText(command))).toEqual({
      agentId: 'codex', path: commandPath, kind: 'command', content: '# Review\nInspect the diff.',
    })
    const skill = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: skillPath, cwd: root })
    expect(JSON.parse(renderedText(skill))).toEqual({
      agentId: 'codex', path: skillPath, kind: 'skill', content: '# Review skill\nInspect changed files.',
    })
    const undeclared = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: join(root, 'other.md'), cwd: root })
    expect(undeclared.isError).toBe(true)
    expect(renderedText(undeclared)).toContain('not currently listed as codex')
    const missing = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: missingPath, cwd: root })
    expect(missing.isError).toBe(true)
    if (!missing.isError) throw new Error('missing capability file unexpectedly succeeded')
    expect(missing.error.info?.code).toBe('FS_NOT_FOUND')
    const directory = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: directoryPath, cwd: root })
    expect(directory.isError).toBe(true)
    if (!directory.isError) throw new Error('capability directory unexpectedly succeeded')
    expect(directory.error.info?.code).toBe('FS_NOT_REGULAR_FILE')
    const large = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: largePath, cwd: root })
    expect(large.isError).toBe(true)
    if (!large.isError) throw new Error('oversized capability file unexpectedly succeeded')
    expect(large.error.info?.code).toBe('FS_TOO_LARGE')
    const binary = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: binaryPath, cwd: root })
    expect(binary.isError).toBe(true)
    if (!binary.isError) throw new Error('invalid UTF-8 capability file unexpectedly succeeded')
    expect(binary.error.info?.code).toBe('FS_NOT_TEXT')
    const nul = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: nulPath, cwd: root })
    expect(nul.isError).toBe(true)
    if (!nul.isError) throw new Error('binary capability file unexpectedly succeeded')
    expect(nul.error.info?.code).toBe('FS_NOT_TEXT')
    const decoderFailure = new Error('unexpected text decoder failure')
    const decoderSpy = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementationOnce(() => { throw decoderFailure })
    const decoderError = await callTool(ctx, 'mesh_capability_read', { agentId: 'codex', path: decoderErrorPath, cwd: root })
    decoderSpy.mockRestore()
    expect(decoderError.isError).toBe(true)
    expect(renderedText(decoderError)).toContain(decoderFailure.message)
  })

  it('dispatches a selected file-backed native command with its frontmatter removed', async () => {
    const ctx = await mount()
    const root = roots.at(-1)!
    const commandPath = join(root, 'prompts', 'review.md')
    const plainCommandPath = join(root, 'prompts', 'plain.md')
    const emptyCommandPath = join(root, 'prompts', 'empty.md')
    mkdirSync(join(root, 'prompts'))
    writeFileSync(commandPath, '---\ndescription: Review changes\n---\nReview the diff carefully.', 'utf8')
    writeFileSync(plainCommandPath, 'Use the plain prompt.', 'utf8')
    writeFileSync(emptyCommandPath, '', 'utf8')
    const external = adapter()
    ctx.agentMesh.register(external)
    vi.spyOn(external, 'readCapabilities').mockResolvedValue({
      agentId: external.id,
      tools: [], skills: [], mcpServers: [],
      commands: [
        { name: 'review', source: 'user', path: commandPath },
        { name: 'plain', source: 'user', path: plainCommandPath },
        { name: 'empty', source: 'user', path: emptyCommandPath },
        { name: 'native', source: 'builtin' },
      ],
      contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T00:00:00.000Z',
    })
    const runId = brandString<AgentRunId>('command-run')
    const startedAt = '2026-10-16T03:00:00.000Z'
    const finishedAt = '2026-10-16T03:00:01.000Z'
    const result: AgentRunResult = {
      runId, agentId: external.id, status: 'succeeded', startedAt, finishedAt, durationMs: 1,
      cwd: root, finalText: 'finished', notes: [],
    }
    const startRun = vi.spyOn(ctx.agentMesh, 'startRun').mockReturnValue({ runId, result: Promise.resolve(result) })

    const dispatched = await callApprovedTool(ctx, 'mesh_run', {
      agentId: 'codex', commandName: 'review', prompt: 'Review src/index.ts', cwd: root,
    })
    expect(dispatched.isError).toBe(false)
    expect(startRun).toHaveBeenCalledWith('codex', expect.objectContaining({
      cwd: root,
      prompt: 'Review the diff carefully.\n\nReview src/index.ts',
    }))
    const plain = await callApprovedTool(ctx, 'mesh_run', {
      agentId: 'codex', commandName: 'plain', prompt: 'Continue.', cwd: root,
    })
    expect(plain.isError).toBe(false)
    expect(startRun).toHaveBeenNthCalledWith(2, 'codex', expect.objectContaining({
      prompt: 'Use the plain prompt.\n\nContinue.',
    }))
    const empty = await callApprovedTool(ctx, 'mesh_run', {
      agentId: 'codex', commandName: 'empty', prompt: 'Continue.', cwd: root,
    })
    expect(empty.isError).toBe(false)
    expect(startRun).toHaveBeenNthCalledWith(3, 'codex', expect.objectContaining({ prompt: 'Continue.' }))

    const unknown = await callApprovedTool(ctx, 'mesh_run', {
      agentId: 'codex', commandName: 'unknown', prompt: 'Review src/index.ts', cwd: root,
    })
    expect(unknown.isError).toBe(true)
    expect(renderedText(unknown)).toContain('not currently listed for codex')
    const native = await callApprovedTool(ctx, 'mesh_run', {
      agentId: 'codex', commandName: 'native', prompt: 'Review src/index.ts', cwd: root,
    })
    expect(native.isError).toBe(true)
    expect(renderedText(native)).toContain('has no file-backed prompt template')
    expect(startRun).toHaveBeenCalledTimes(3)
  })

  it('projects and renders agent diagnostics, sessions, transcripts, and native tasks', async () => {
    const ctx = await mount()
    const agent = adapter()
    ctx.agentMesh.register(agent)
    const session = (await agent.listSessions({}))[0]!

    vi.spyOn(ctx.agentMesh, 'diagnostics').mockResolvedValueOnce({ agents: [], bindingsReady: true })
    expect(renderedText(await callTool(ctx, 'mesh_agents', {})))
      .toBe('No external coding agents are registered with the mesh.')
    vi.spyOn(ctx.agentMesh, 'diagnostics').mockResolvedValueOnce({
      bindingsReady: true,
      agents: [
        {
          id: agentId('codex'),
          displayName: 'Codex',
          detection: { installed: true, source: 'path', binaryPath: '/usr/bin/codex', version: '1.2.3' },
          sessionRoot: '/home/person/.codex/sessions',
          credentialPath: '/home/person/.codex/auth.json',
          warnings: [],
        },
        { id: agentId('grok'), warnings: ['the agent binary was not found'] },
      ],
    })
    const diagnostics = renderedText(await callTool(ctx, 'mesh_agents', {}))
    expect(diagnostics).toContain('codex (Codex): installed version 1.2.3 sessions in /home/person/.codex/sessions')
    expect(diagnostics).toContain('grok (grok): not installed — the agent binary was not found')

    const listSessions = vi.spyOn(agent, 'listSessions')
    const minimal: AgentSession = {
      key: session.key,
      agentId: session.agentId,
      nativeId: session.nativeId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: 'idle',
      notes: session.notes,
    }
    const detailed: AgentSession = {
      ...session,
      key: brandString<AgentSessionKey>('codex:def'),
      nativeId: 'def',
      title: 'active work',
      cwd: '/repo',
      status: 'running',
      messageCount: 3,
    }
    listSessions.mockResolvedValue([minimal, detailed])
    const sessionResult = await callTool(ctx, 'mesh_sessions', { agentId: 'codex' })
    expect(renderedText(sessionResult)).toContain('codex:abc · (untitled) · 2026-10-16T03:00:00.000Z')
    expect(renderedText(sessionResult)).toContain('codex:def · active work · 2026-10-16T03:00:00.000Z · /repo · [running] · 3 messages')
    await callTool(ctx, 'mesh_sessions', { agentId: 'codex', cwd: '/repo', limit: 1 })
    expect(listSessions).toHaveBeenLastCalledWith({ cwd: '/repo', limit: 1 })
    listSessions.mockResolvedValueOnce([])
    expect(renderedText(await callTool(ctx, 'mesh_sessions', { agentId: 'codex' })))
      .toBe('That agent has no sessions in its own store.')
    listSessions.mockResolvedValue([session])

    const readTranscript = vi.spyOn(agent, 'readTranscript')
    readTranscript.mockResolvedValueOnce({
      key: session.key,
      hasMore: true,
      messages: [
        { index: 0, role: 'assistant', kind: 'reasoning' },
        { index: 1, role: 'tool', kind: 'tool-result', text: 'command failed', toolName: 'shell', failed: true },
      ],
      notes: ['truncated source'],
    })
    const transcript = renderedText(await callTool(ctx, 'mesh_transcript', { agentId: 'codex', sessionId: 'abc' }))
    expect(transcript).toContain('[0] assistant/reasoning')
    expect(transcript).toContain('[1] tool/tool-result shell (failed): command failed')
    const transcriptCall = await callTool(ctx, 'mesh_transcript', { agentId: 'codex', sessionId: 'abc', maxMessages: 5 })
    expect(readTranscript).toHaveBeenLastCalledWith({ session, maxMessages: 5 })
    expect(transcriptCall.isError).toBe(false)
    listSessions.mockResolvedValueOnce([])
    expect((await callTool(ctx, 'mesh_transcript', { agentId: 'codex', sessionId: 'missing' })).isError).toBe(true)
    readTranscript.mockResolvedValueOnce({ key: session.key, hasMore: false, messages: [], notes: [] })
    const emptyTranscript = await callTool(ctx, 'mesh_transcript', { agentId: 'codex', sessionId: 'abc' })
    expect(emptyTranscript.isError).toBe(false)
    expect(renderedText(emptyTranscript)).toBe('No messages in the read window (hasMore=false).')

    const readNativeTasks = vi.spyOn(agent, 'readNativeTasks')
    readNativeTasks.mockResolvedValueOnce({ available: false, todos: [], notes: ['not recorded'] })
    const unavailable = await callTool(ctx, 'mesh_tasks', { agentId: 'codex', sessionId: 'abc' })
    expect(renderedText(unavailable)).toBe('That agent keeps no native todo or plan state.')
    readNativeTasks.mockResolvedValueOnce({ available: true, todos: [], notes: [] })
    expect(renderedText(await callTool(ctx, 'mesh_tasks', { agentId: 'codex', sessionId: 'abc' })))
      .toBe('todos (0)')
    readNativeTasks.mockResolvedValueOnce({
      available: true,
      todos: [{ id: 'todo-1', content: 'write tests', status: 'in_progress', owner: 'codex', blockedBy: [], updatedAt: '' }],
      plan: { active: false, items: ['inspect the parser'] },
      notes: [],
    })
    const inactivePlan = await callTool(ctx, 'mesh_tasks', { agentId: 'codex', sessionId: 'abc' })
    expect(renderedText(inactivePlan)).toContain('plan:\ninspect the parser')
    readNativeTasks.mockResolvedValueOnce({
      available: true,
      todos: [],
      plan: { active: true, items: ['finish the review'] },
      notes: ['native note'],
    })
    const activePlan = await callTool(ctx, 'mesh_tasks', { agentId: 'codex', sessionId: 'abc' })
    expect(renderedText(activePlan)).toContain('todos (0)\nplan (active):\nfinish the review')
    expect(readNativeTasks).toHaveBeenLastCalledWith({ session })
    listSessions.mockResolvedValueOnce([])
    expect((await callTool(ctx, 'mesh_tasks', { agentId: 'codex', sessionId: 'missing' })).isError).toBe(true)
  })

  it('projects run requests, event variants, waits, errors, and cancellation results', async () => {
    const approvals: { readonly toolName: string; readonly reason?: string; readonly callId?: unknown }[] = []
    const ctx = await mount((inner) => {
      inner.on('approval/request', (request, next) => {
        approvals.push({
          toolName: request.toolName,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.callId === undefined ? {} : { callId: request.callId }),
        })
        return next()
      })
    })
    const agent = adapter()
    ctx.agentMesh.register(agent)
    const runId = brandString<AgentRunId>('run-one')
    const secondRunId = brandString<AgentRunId>('run-two')
    const thirdRunId = brandString<AgentRunId>('run-three')
    const startedAt = '2026-10-16T03:00:00.000Z'
    const finishedAt = '2026-10-16T03:01:00.000Z'
    const success: AgentRunResult = {
      runId,
      agentId: agentId('codex'),
      status: 'succeeded',
      startedAt,
      finishedAt,
      durationMs: 60_000,
      cwd: '/repo',
      finalText: 'done',
      notes: ['complete'],
    }
    const failedRun: AgentRunResult = {
      runId: thirdRunId,
      agentId: agentId('codex'),
      status: 'failed',
      startedAt,
      finishedAt,
      durationMs: 1_000,
      cwd: '/repo',
      error: { code: 'run/failed', message: 'the delegated agent failed' },
      notes: [],
    }
    const events: AgentRunEvent[] = [
      { kind: 'run.started', runId, agentId: agentId('codex'), at: startedAt },
      { kind: 'session.bound', runId, at: startedAt, nativeSessionId: 'native-1' },
      { kind: 'message.delta', runId, at: startedAt, text: 'hello' },
      { kind: 'reasoning.delta', runId, at: startedAt, text: 'thinking' },
      { kind: 'message.completed', runId, at: startedAt, text: 'answer' },
      { kind: 'tool.started', runId, at: startedAt, toolName: 'shell' },
      { kind: 'tool.completed', runId, at: startedAt, toolName: 'shell', failed: true },
      { kind: 'tool.completed', runId, at: startedAt, toolName: 'shell', failed: false },
      { kind: 'todos.updated', runId, at: startedAt, todos: [{ content: 'review', status: 'pending' }] },
      { kind: 'files.changed', runId, at: startedAt, paths: ['src/index.ts'] },
      { kind: 'usage.updated', runId, at: startedAt, usage: { totalTokens: 9 } },
      { kind: 'usage.updated', runId, at: startedAt, usage: {} },
      { kind: 'warning', runId, at: startedAt, message: 'slow response' },
      { kind: 'unknown', runId, at: startedAt },
      { kind: 'unknown', runId, at: startedAt, nativeType: 'native.tick' },
      { kind: 'run.finished', runId, at: finishedAt, result: success },
    ]
    const successfulSnapshot: MeshRunSnapshot = {
      runId,
      agentId: 'codex',
      status: 'succeeded',
      cwd: '/repo',
      prompt: 'implement it',
      startedAt,
      finishedAt,
      finalText: 'done',
      notes: ['complete'],
      events,
      eventCount: events.length,
    }
    const failedSnapshot: MeshRunSnapshot = {
      runId: secondRunId,
      agentId: 'codex',
      status: 'failed',
      cwd: '/repo/other',
      prompt: 'check it',
      startedAt,
      finishedAt,
      error: { code: 'run/failed', message: 'the child exited' },
      notes: [],
      events: [],
      eventCount: 0,
    }
    let nativeApproval: Promise<unknown> | undefined
    let fileApproval: Promise<unknown> | undefined
    const startRun = vi.spyOn(ctx.agentMesh, 'startRun')
      .mockImplementationOnce((_agentId, request) => {
        nativeApproval = request.requestApproval?.({
          kind: 'command', title: 'Codex command approval', detail: 'Command: pnpm build', signal: new AbortController().signal,
        })
        return { runId, result: Promise.resolve(success) }
      })
      .mockReturnValueOnce({ runId: secondRunId, result: Promise.resolve(success) })
      .mockImplementationOnce((_agentId, request) => {
        fileApproval = request.requestApproval?.({
          kind: 'file-change', title: 'Codex file approval', detail: 'Write: src/index.ts', signal: new AbortController().signal,
        })
        return { runId: thirdRunId, result: Promise.resolve(failedRun) }
      })
    const basicDispatch = await callApprovedTool(ctx, 'mesh_run', { agentId: 'codex', prompt: 'implement it', cwd: '/repo' })
    expect(renderedText(basicDispatch)).toContain('Run run-one for codex finished with status succeeded.')
    expect(renderedText(basicDispatch)).toContain('answer: done\nnote: complete')
    expect(startRun).toHaveBeenNthCalledWith(1, 'codex', expect.objectContaining({ prompt: 'implement it', cwd: '/repo' }))
    expect(await nativeApproval).toBe('allowed-once')
    expect(approvals).toHaveLength(2)
    expect(approvals[1]?.toolName).toBe('mesh_run')
    expect(approvals[1]?.callId).toBeTypeOf('string')
    expect(approvals[1]?.reason).toBe('codex: Codex command approval\nCommand: pnpm build')
    await callApprovedTool(ctx, 'mesh_run', {
      agentId: 'codex', prompt: 'check it', cwd: '/repo/other', model: 'model-x', approval: 'always',
      resumeNativeId: 'native-1', timeoutMs: 2_000,
    })
    expect(startRun).toHaveBeenNthCalledWith(2, 'codex', expect.objectContaining({
      prompt: 'check it', cwd: '/repo/other', model: 'model-x', approval: 'always',
      resumeNativeId: 'native-1', timeoutMs: 2_000,
    }))
    const failedDispatch = await callApprovedTool(ctx, 'mesh_run', { agentId: 'codex', prompt: 'change it', cwd: '/repo' })
    expect(renderedText(failedDispatch)).toContain('error (run/failed): the delegated agent failed')
    expect(renderedText(failedDispatch)).not.toContain('answer:')
    expect(await fileApproval).toBe('allowed-once')

    vi.spyOn(ctx.agentMesh, 'runs', 'get').mockReturnValue([successfulSnapshot, failedSnapshot])
    vi.spyOn(ctx.agentMesh, 'run').mockReturnValue(successfulSnapshot)
    vi.spyOn(ctx.agentMesh, 'waitForRun').mockResolvedValue(failedSnapshot)
    const listed = await callTool(ctx, 'mesh_runs', {})
    expect(renderedText(listed)).toContain('answer: done')
    expect(renderedText(listed)).toContain('error (run/failed): the child exited')
    expect(renderedText(await callTool(ctx, 'mesh_runs', { runId: 'run-one' }))).toContain('run-one → codex')
    expect(renderedText(await callTool(ctx, 'mesh_runs', { runId: 'run-two', wait: true }))).toContain('[failed]')
    const unsupportedEvent: AgentRunEvent = {
      kind: 'unknown',
      runId,
      at: '2026-10-16T00:00:00.000Z',
      nativeType: 'run.future',
      native: '{"kind":"run.future"}',
    }
    vi.spyOn(ctx.agentMesh, 'runs', 'get').mockReturnValue([{
      ...successfulSnapshot,
      events: [unsupportedEvent],
    }])
    const unsupportedResult = await callTool(ctx, 'mesh_runs', {})
    expect(unsupportedResult.isError).toBe(false)
    expect(renderedText(unsupportedResult)).toContain('unknown: run.future')
    vi.spyOn(ctx.agentMesh, 'runs', 'get').mockReturnValue([])
    expect(renderedText(await callTool(ctx, 'mesh_runs', {}))).toBe('No runs have been dispatched.')
    vi.spyOn(ctx.agentMesh, 'run').mockReturnValue(undefined)
    vi.spyOn(ctx.agentMesh, 'waitForRun').mockResolvedValue(undefined)
    expect(renderedText(await callTool(ctx, 'mesh_runs', { runId: 'missing' }))).toBe('No runs have been dispatched.')
    expect(renderedText(await callTool(ctx, 'mesh_runs', { runId: 'missing', wait: true })))
      .toBe('No runs have been dispatched.')

    const cancelRun = vi.spyOn(ctx.agentMesh, 'cancelRun').mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(renderedText(await callTool(ctx, 'mesh_run_cancel', { runId: 'run-one', reason: 'stop now' })))
      .toBe('Cancellation requested.')
    expect(renderedText(await callTool(ctx, 'mesh_run_cancel', { runId: 'run-one' })))
      .toBe('That run is not live, so nothing was cancelled.')
    expect(cancelRun).toHaveBeenNthCalledWith(1, 'run-one', 'stop now')
    expect(cancelRun).toHaveBeenNthCalledWith(2, 'run-one', undefined)
  })

  it('fails closed without an owning agent', async () => {
    const ctx = await mount()
    ctx.agentMesh.register(adapter())
    const startRun = vi.spyOn(ctx.agentMesh, 'startRun')

    const result = await callTool(ctx, 'mesh_run', { agentId: 'codex', prompt: 'implement it', cwd: '/repo' })
    expect(result.isError).toBe(true)
    expect(renderedText(result)).toContain('the call has no agent to route it through')
    expect(startRun).not.toHaveBeenCalled()
  })

  it('monotonically denies when an earlier listener bypasses the approval request', async () => {
    const ctx = await mount((inner) => {
      inner.on('tools/pre-execute', (_exec, _next): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' }))
    })
    ctx.agentMesh.register(adapter())
    const startRun = vi.spyOn(ctx.agentMesh, 'startRun')

    const result = await callApprovedTool(ctx, 'mesh_run', { agentId: 'codex', prompt: 'implement it', cwd: '/repo' })
    expect(result.isError).toBe(true)
    expect(renderedText(result)).toContain('mesh_run requires an approval request before it can run.')
    expect(startRun).not.toHaveBeenCalled()

    const connect = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, approvalAgent(ctx))
    expect(connect.isError).toBe(true)
    expect(renderedText(connect)).toContain('mesh_mcp_connect requires DSH approval before server activation.')
  })

  it('approves MCP activation once, hides arguments in approval, and scopes discovered tools to one Agent', async () => {
    const approvalReasons: string[] = []
    const ctx = await mount((inner) => {
      inner.on('approval/request', (request, next) => {
        if (request.toolName === 'mesh_mcp_connect') approvalReasons.push(request.reason ?? '')
        return next()
      })
    })
    const external = adapter()
    vi.spyOn(external, 'resolveMcpServer').mockResolvedValue({
      name: 'docs', source: 'user', transport: 'stdio', command: '/usr/local/bin/docs-mcp',
      args: ['--token', 'literal-secret'], env: { API_TOKEN: 'sensitive-token' }, cwd: '/repo',
    })
    ctx.agentMesh.register(external)
    const owner = await ctx.plugin(() => {})
    fibers.push(owner)
    const agent = approvalAgent(owner.ctx)
    const otherAgent = approvalAgent()

    const connected = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    expect(connected.isError).toBe(false)
    expect(renderedText(connected)).toContain('MCP server connected after DSH approval')
    expect(approvalReasons).toHaveLength(1)
    expect(approvalReasons[0]).toContain('executable: docs-mcp')
    expect(approvalReasons[0]).toContain('2 argument(s) hidden')
    expect(approvalReasons.join('')).not.toContain('literal-secret')
    expect(approvalReasons.join('')).not.toContain('sensitive-token')
    expect(fakeMcp.configurations).toHaveLength(1)
    expect(fakeMcp.configurations[0]).toMatchObject({
      transport: 'stdio', command: '/usr/local/bin/docs-mcp', args: ['--token', 'literal-secret'],
      env: { API_TOKEN: 'sensitive-token' }, cwd: '/repo', failOnStartupError: true,
      reconnect: { enabled: false },
    })

    const toolName = ctx.tools.schemas(agent).find(tool => tool.name.startsWith('mcp__mesh_docs_'))?.name
    expect(toolName).toBeDefined()
    expect(ctx.tools.schemas(otherAgent).some(tool => tool.name === toolName)).toBe(false)
    const repeated = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    expect(repeated.isError).toBe(false)
    expect(renderedText(repeated)).toContain('already connected')
    expect(approvalReasons).toHaveLength(1)
    expect(fakeMcp.configurations).toHaveLength(1)

    const disconnected = await callTool(ctx, 'mesh_mcp_disconnect', { agentId: 'codex', serverName: 'docs' }, agent)
    expect(disconnected.isError).toBe(false)
    expect(ctx.tools.schemas(agent).some(tool => tool.name === toolName)).toBe(false)
    expect(fakeMcp.closed).toEqual([expect.stringMatching(/^mesh_docs_/)])
  })

  it('does not activate a native MCP server after rejected DSH approval and closes it with Agent lifetime', async () => {
    const rejectedCtx = await mount(undefined, 'rejected')
    const rejectedAdapter = adapter()
    vi.spyOn(rejectedAdapter, 'resolveMcpServer').mockResolvedValue({
      name: 'docs', source: 'user', transport: 'stdio', command: 'docs-mcp', args: [], env: {}, cwd: '/repo',
    })
    rejectedCtx.agentMesh.register(rejectedAdapter)
    const rejectedAgent = approvalAgent(rejectedCtx)
    const rejected = await callTool(rejectedCtx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, rejectedAgent)
    expect(rejected.isError).toBe(true)
    expect(fakeMcp.configurations).toHaveLength(0)
    expect(rejectedCtx.tools.schemas(rejectedAgent).some(tool => tool.name.startsWith('mcp__mesh_docs_'))).toBe(false)

    const ctx = await mount()
    const external = adapter()
    vi.spyOn(external, 'resolveMcpServer').mockResolvedValue({
      name: 'docs', source: 'user', transport: 'stdio', command: 'docs-mcp', args: [], env: {}, cwd: '/repo',
    })
    ctx.agentMesh.register(external)
    const owner = await ctx.plugin(() => {})
    fibers.push(owner)
    const agent = approvalAgent(owner.ctx)
    await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    const names = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('mcp__mesh_docs_')).map(tool => tool.name)
    expect(names).toHaveLength(1)
    await owner.dispose()
    expect(ctx.tools.schemas(agent).some(tool => names.includes(tool.name))).toBe(false)
    expect(fakeMcp.closed).toHaveLength(1)
  })

  it('denies MCP activation without an Agent, with malformed arguments, or without readable native config', async () => {
    const ctx = await mount()
    const external = adapter()
    const resolve = vi.spyOn(external, 'resolveMcpServer')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('native config unavailable'))
    ctx.agentMesh.register(external)
    const agent = approvalAgent(ctx)

    const withoutAgent = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' })
    expect(withoutAgent.isError).toBe(true)
    expect(renderedText(withoutAgent)).toContain('requires an active DSH Agent')
    const disconnectWithoutAgent = await callTool(ctx, 'mesh_mcp_disconnect', { agentId: 'codex', serverName: 'docs' })
    expect(disconnectWithoutAgent.isError).toBe(true)
    expect(renderedText(disconnectWithoutAgent)).toContain('requires an active DSH Agent')

    for (const args of [
      null,
      [],
      {},
      { agentId: '', serverName: 'docs', cwd: '/repo' },
      { agentId: 'codex', serverName: ' ', cwd: '/repo' },
      { agentId: 'codex', serverName: 'docs', cwd: 'relative/path' },
    ]) {
      const malformed = await callTool(ctx, 'mesh_mcp_connect', args, agent)
      expect(malformed.isError).toBe(true)
      expect(renderedText(malformed)).toContain('requires agentId, serverName, and cwd')
    }
    expect(resolve).not.toHaveBeenCalled()

    const undeclared = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    expect(renderedText(undeclared)).toContain('is not declared by codex')
    const unreadable = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    expect(renderedText(unreadable)).toContain("Could not resolve MCP server \"docs\" from codex's native configuration")
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('does not reuse approval after a connected server is disconnected before dispatch', async () => {
    let disconnectBeforeDispatch = false
    const references: { ownerAgent?: Agent } = {}
    const ctx = await mount((inner) => {
      inner.on('tools/pre-execute', async (exec, next) => {
        const decision = await next()
        if (disconnectBeforeDispatch && exec.name === 'mesh_mcp_connect') {
          disconnectBeforeDispatch = false
          const result = await callTool(inner, 'mesh_mcp_disconnect', { agentId: 'codex', serverName: 'docs' }, references.ownerAgent)
          expect(result.isError).toBe(false)
        }
        return decision
      })
    })
    const external = adapter()
    vi.spyOn(external, 'resolveMcpServer').mockResolvedValue({
      name: 'docs', source: 'user', transport: 'stdio', command: 'docs-mcp', args: [], env: {}, cwd: '/repo',
    })
    ctx.agentMesh.register(external)
    const owner = await ctx.plugin(() => {})
    fibers.push(owner)
    references.ownerAgent = approvalAgent(owner.ctx)

    expect((await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, references.ownerAgent)).isError)
      .toBe(false)
    disconnectBeforeDispatch = true
    const repeated = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, references.ownerAgent)
    expect(repeated.isError).toBe(true)
    expect(renderedText(repeated)).toContain('approved MCP configuration is no longer available')
  })

  it('starts HTTP MCP servers with and without explicit timeouts and reports plugin cleanup failures', async () => {
    const ctx = await mount()
    const external = adapter()
    vi.spyOn(external, 'resolveMcpServer')
      .mockResolvedValueOnce({
        name: '!!!', source: 'project', transport: 'streamable-http', url: 'https://docs.example.test/mcp',
        headers: { Authorization: 'Bearer hidden' }, toolCallTimeoutMs: 1_500,
      })
      .mockResolvedValueOnce({
        name: 'notes', source: 'user', transport: 'streamable-http', url: 'https://notes.example.test/mcp', headers: {},
      })
    ctx.agentMesh.register(external)
    const owner = await ctx.plugin(() => {})
    fibers.push(owner)
    const agent = approvalAgent(owner.ctx)

    const punctuation = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: '!!!', cwd: '/repo' }, agent)
    expect(punctuation.isError).toBe(false)
    expect(renderedText(punctuation)).toContain('mesh_server_')
    const notes = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'notes', cwd: '/repo' }, agent)
    expect(notes.isError).toBe(false)
    expect(fakeMcp.configurations).toMatchObject([
      {
        transport: 'streamable-http', url: 'https://docs.example.test/mcp',
        headers: { Authorization: 'Bearer hidden' }, toolCallTimeoutMs: 1_500, failOnStartupError: true,
      },
      { transport: 'streamable-http', url: 'https://notes.example.test/mcp', headers: {}, failOnStartupError: true },
    ])

    const logError = vi.spyOn(ctx.logger, 'error')
    fakeMcp.failScopeDispose = true
    const pluginFiber = fibers[fibers.length - 2]
    await pluginFiber?.dispose()
    expect(logError).toHaveBeenCalledWith('agent-mesh-tools: one or more MCP clients did not close during plugin disposal')
    fakeMcp.failScopeDispose = false
  })

  it('shares one concurrent MCP startup and permits disconnect races to settle idempotently', async () => {
    const ctx = await mount()
    const external = adapter()
    let releaseResolution!: () => void
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve })
    const resolve = vi.spyOn(external, 'resolveMcpServer').mockImplementation(async () => {
      await resolutionGate
      return {
        name: 'docs', source: 'user', transport: 'stdio', command: 'docs-mcp', args: [], env: {}, cwd: '/repo',
        toolCallTimeoutMs: 2_000,
      }
    })
    ctx.agentMesh.register(external)
    const owner = await ctx.plugin(() => {})
    fibers.push(owner)
    const agent = approvalAgent(owner.ctx)

    const first = callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    const second = callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    await vi.waitFor(() => {
      expect(resolve).toHaveBeenCalledTimes(2)
    })
    releaseResolution()
    const results = await Promise.all([first, second])
    expect(results.every(result => !result.isError)).toBe(true)
    expect(fakeMcp.configurations).toHaveLength(1)

    const absent = await callTool(ctx, 'mesh_mcp_disconnect', { agentId: 'codex', serverName: 'missing' }, agent)
    expect(renderedText(absent)).toContain('is not connected')
    const disconnects = await Promise.all([
      callTool(ctx, 'mesh_mcp_disconnect', { agentId: 'codex', serverName: 'docs' }, agent),
      callTool(ctx, 'mesh_mcp_disconnect', { agentId: 'codex', serverName: 'docs' }, agent),
    ])
    expect(disconnects.every(result => !result.isError)).toBe(true)
    expect(fakeMcp.closed).toHaveLength(1)
  })

  it('cleans up failed and cancelled MCP startup and reports Agent cleanup failures', async () => {
    const ctx = await mount()
    const external = adapter()
    vi.spyOn(external, 'resolveMcpServer').mockResolvedValue({
      name: 'docs', source: 'user', transport: 'stdio', command: 'docs-mcp', args: [], env: {}, cwd: '/repo',
    })
    ctx.agentMesh.register(external)
    const owner = await ctx.plugin(() => {})
    fibers.push(owner)
    const agent = approvalAgent(owner.ctx)

    fakeMcp.failStartup = true
    const failed = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    expect(failed.isError).toBe(true)
    expect(renderedText(failed)).toContain('failed to connect')
    expect(fakeMcp.closed).toHaveLength(1)
    fakeMcp.failStartup = false

    let releaseStartup!: () => void
    const gate = new Promise<void>((resolve) => { releaseStartup = resolve })
    fakeMcp.startupGate = gate
    const controller = new AbortController()
    const pending = callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent, controller.signal)
    await vi.waitFor(() => {
      expect(fakeMcp.configurations).toHaveLength(2)
    })
    controller.abort()
    releaseStartup()
    const cancelled = await pending
    expect(cancelled.isError).toBe(true)
    expect(renderedText(cancelled)).toContain('failed to connect')

    const connected = await callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    expect(connected.isError).toBe(false)
    const logError = vi.spyOn(ctx.logger, 'error')
    fakeMcp.failScopeDispose = true
    await owner.dispose()
    expect(logError).toHaveBeenCalledWith('agent-mesh-tools: one or more MCP clients did not close during Agent disposal')
    fakeMcp.failScopeDispose = false
  })

  it('settles rejected MCP startup while its owning Agent is being disposed', async () => {
    const ctx = await mount()
    const external = adapter()
    vi.spyOn(external, 'resolveMcpServer').mockResolvedValue({
      name: 'docs', source: 'user', transport: 'stdio', command: 'docs-mcp', args: [], env: {}, cwd: '/repo',
    })
    ctx.agentMesh.register(external)
    const owner = await ctx.plugin(() => {})
    fibers.push(owner)
    const agent = approvalAgent(owner.ctx)
    let releaseStartup!: () => void
    fakeMcp.startupGate = new Promise<void>((resolve) => { releaseStartup = resolve })
    fakeMcp.failStartup = true

    const connecting = callTool(ctx, 'mesh_mcp_connect', { agentId: 'codex', serverName: 'docs', cwd: '/repo' }, agent)
    await vi.waitFor(() => {
      expect(fakeMcp.configurations).toHaveLength(1)
    })
    const disposing = owner.dispose()
    releaseStartup()
    const [result] = await Promise.all([connecting, disposing])
    expect(result?.isError).toBe(true)
    expect(renderedText(result)).toContain('failed to connect')
  })
})
