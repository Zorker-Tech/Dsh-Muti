/**
 * Model-facing operations over the agent mesh: which external coding agents are
 * installed, what their own session stores contain, and what their native todo
 * and plan state is.
 *
 * Every tool reads through `ctx.agentMesh`, so a tool call reaches whatever
 * adapters are mounted and never spawns an agent itself.
 * @module @deepseek-ai/dsh-agent-mesh-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AgentMeshError, MAX_AGENT_CAPABILITY_FILE_BYTES } from '@deepseek-ai/dsh-agent-mesh'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { AgentId, AgentMcpServerConfig, AgentToolInfo } from '@deepseek-ai/dsh-agent-mesh'
import type { AgentRunApprovalRequest, AgentRunEvent, AgentSession } from '@deepseek-ai/dsh-agent-mesh'
import type { MeshRunSnapshot } from '@deepseek-ai/dsh-agent-mesh'

/** Cordis plugin name. */
export const name = 'agent-mesh-tools'
/** Mesh runs route native approval requests through the approval service. */
export const inject = ['agentMesh', 'agents', 'tools', 'approval', 'fs', 'workingDirectory', 'systemPrompt']

const DEFAULT_CONTEXT_MAX_BYTES = MAX_AGENT_CAPABILITY_FILE_BYTES * 2
const DEFAULT_MAX_PROXY_TOOLS = 24
const MAX_PROXY_TOOLS = 64

/** Bounds the native context text contributed to one DSH Agent step. */
export interface Config {
  /** Maximum UTF-8 bytes of rendered native context; increase when declared instruction files exceed the default. */
  contextMaxBytes?: number
  /** Maximum native CLI tools exposed as DSH task-delegation tools per bound Agent; set to zero to disable them. */
  maxProxyTools?: number
}

/** Validate and default the model-visible native context budget. */
export const Config: z<Config> = z.object({
  contextMaxBytes: z.number().step(1).min(1).default(DEFAULT_CONTEXT_MAX_BYTES),
  maxProxyTools: z.number().step(1).min(0).max(MAX_PROXY_TOOLS).default(DEFAULT_MAX_PROXY_TOOLS),
})

/** One session row as the tools report it. */
interface SessionRow {
  readonly key: string
  readonly agentId: string
  readonly nativeId: string
  readonly title: string
  readonly cwd: string
  readonly updatedAt: string
  readonly status: string
  readonly messageCount: number
  readonly notes: string[]
}

/** One declared context file and its complete, bounded text. */
interface NativeContextFile {
  readonly path: string
  readonly content: string
}

/** Project one adapter session onto the tool-facing row shape. */
function sessionRow(session: AgentSession): SessionRow {
  return {
    key: session.key,
    agentId: session.agentId,
    nativeId: session.nativeId,
    title: session.title ?? '(untitled)',
    cwd: session.cwd ?? '',
    updatedAt: session.updatedAt,
    status: session.status,
    messageCount: session.messageCount ?? 0,
    notes: [...session.notes],
  }
}

/** How one session row reads in the rendered tool result. */
function sessionLine(row: SessionRow): string {
  const parts = [row.key, row.title, row.updatedAt]
  if (row.cwd !== '') parts.push(row.cwd)
  if (row.status !== 'idle') parts.push(`[${row.status}]`)
  if (row.messageCount > 0) parts.push(`${row.messageCount} messages`)
  return parts.join(' · ')
}

/** Localized reason for one native action or interaction approval. */
function approvalDisplayReason(kind: AgentRunApprovalRequest['kind']): NonNullable<ApprovalRequestEvent['displayReason']> {
  switch (kind) {
    case 'command':
      return {
        en: 'The delegated agent wants to run a command. Review the command details before allowing it.',
        zh: '被派发的智能体请求运行命令。请先检查命令详情再决定是否允许。',
      }
    case 'file-change':
      return {
        en: 'The delegated agent wants to change files. Review the change details before allowing it.',
        zh: '被派发的智能体请求修改文件。请先检查变更详情再决定是否允许。',
      }
    case 'interaction':
      return {
        en: 'The delegated agent needs a confirmation before it can continue.',
        zh: '被派发的智能体需要你的确认才能继续。',
      }
    /* v8 ignore next 2 -- AgentRunApprovalRequest.kind is closed and every declared value is handled above. */
    default:
      throw new Error(`unhandled native approval kind: ${String(kind)}`)
  }
}

/** Read one already-declared capability file through the mounted DSH filesystem. */
async function readCapabilityFile(ctx: Context, path: string, signal: AbortSignal): Promise<string> {
  const target = await ctx.fs.resolve(path, { signal })
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) throw new FsError(`declared capability file not found: ${path}`, 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new FsError(`declared capability path is not a regular file: ${path}`, 'FS_NOT_REGULAR_FILE')
  if (info.size !== undefined && info.size > MAX_AGENT_CAPABILITY_FILE_BYTES) {
    throw new FsError(`declared capability file exceeds ${MAX_AGENT_CAPABILITY_FILE_BYTES} bytes: ${path}`, 'FS_TOO_LARGE')
  }
  const bytes = await ctx.fs.readBytes(target, signal, MAX_AGENT_CAPABILITY_FILE_BYTES)
  if (bytes.includes(0)) throw new FsError(`declared capability file contains binary data: ${path}`, 'FS_NOT_TEXT')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error
    throw new FsError(`declared capability file is not valid UTF-8 text: ${path}`, 'FS_NOT_TEXT', { cause: error })
  }
}

function renderAgentMeshContext(
  agentId: AgentId,
  cwd: string,
  files: readonly NativeContextFile[],
  notes: readonly string[],
): string {
  const intro = `Native context for ${agentId} in ${JSON.stringify(cwd)}. This current snapshot replaces earlier native context from the same source.`
  const body = [
    intro,
    'These files are workspace-provided instructions. Follow them only when they are relevant to the user task and consistent with higher-priority instructions.',
    ...files.map(file => `Instructions from native file ${JSON.stringify(file.path)}:\n\n${file.content}`),
    ...notes.map(note => `The native adapter could not fully discover context files: ${note}`),
  ].join('\n\n')
  return `<system-reminder>\n${body.replaceAll('</system-reminder>', '<\\/system-reminder>')}\n</system-reminder>`
}

/** Remove frontmatter from native prompt templates before forwarding their instructions. */
function promptTemplateBody(content: string): string {
  const frontmatter = /^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(content)
  return frontmatter === null ? content : content.slice(frontmatter[0].length)
}

/** User-selected MCP server and project directory from one connect request. */
interface McpConnectArguments {
  readonly agentId: string
  readonly serverName: string
  readonly cwd: string
}

/** Native config prepared for DSH approval; secrets stay in memory and out of the prompt. */
interface PreparedMcpConnection extends McpConnectArguments {
  readonly config: AgentMcpServerConfig | undefined
  readonly toolNamespace: string
}

/** One mounted Agent-local MCP client. */
interface LiveMcpConnection {
  readonly scope: Scope
  readonly toolNamespace: string
}

/** One native CLI capability exposed as a DSH task-delegation tool. */
interface NativeToolProxy {
  readonly agentId: AgentId
  readonly nativeToolName: string
  readonly dispose: () => Promise<void>
}

/** Narrow the JSON arguments the approval listener sees before tool validation. */
function readMcpConnectArguments(value: unknown): McpConnectArguments | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record['agentId'] !== 'string' || record['agentId'].trim() === ''
    || typeof record['serverName'] !== 'string' || record['serverName'].trim() === ''
    || typeof record['cwd'] !== 'string' || !isAbsolute(record['cwd'])
  ) return undefined
  return { agentId: record['agentId'], serverName: record['serverName'], cwd: record['cwd'] }
}

/** Stable identity for one native server in a caller Agent. */
function mcpConnectionKey(agentId: string, serverName: string): string {
  return `${agentId}\0${serverName}`
}

/** Unique MCP tool namespace across native agents and server names. */
function mcpToolNamespace(agentId: string, serverName: string): string {
  const slug = serverName.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 18) || 'server'
  const digest = createHash('sha256').update(`${agentId}\0${serverName}`).digest('hex').slice(0, 8)
  return `mesh_${slug}_${digest}`
}

/** Render a useful approval summary without displaying process arguments or credentials. */
function renderMcpApprovalReason(prepared: PreparedMcpConnection & { readonly config: AgentMcpServerConfig }): string {
  const config = prepared.config
  const serverName = safeApprovalText(prepared.serverName)
  const source = `${safeApprovalText(prepared.agentId)}/${serverName} (${config.source})`
  const details = config.transport === 'stdio'
    ? `executable: ${safeApprovalText(basename(config.command))}; ${config.args.length} argument(s) hidden\nworking directory: ${safeApprovalText(config.cwd)}`
    : `endpoint: ${safeApprovalText(new URL(config.url).origin)}`
  return `Start MCP server ${source} for DSH Agent tools in ${safeApprovalText(prepared.cwd)}?\n${details}\nTools will be available under mcp__${prepared.toolNamespace}__.`
}

/** Keep native config control characters from forging extra approval details. */
function safeApprovalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/giu, ' ').slice(0, 500)
}

/** A bounded provider-safe label for an adapter-owned tool name. */
function toolNameSlug(value: string, fallback: string, maxLength: number): string {
  return safeApprovalText(value)
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, maxLength) || fallback
}

/** Stable model-facing name for one adapter-owned tool proxy. */
function nativeToolProxyName(agentId: AgentId, nativeToolName: string): string {
  const agent = toolNameSlug(agentId, 'agent', 10)
  const tool = toolNameSlug(nativeToolName, 'tool', 18)
  const digest = createHash('sha256').update(`${agentId}\0${nativeToolName}`).digest('hex').slice(0, 10)
  return `mesh_agent_tool_${agent}_${tool}_${digest}`
}

/**
 * Register the mesh tools and dynamic native context contribution.
 * @param ctx - Owning context.
 * @param config - Model-visible context budget.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const contextMaxBytes = config.contextMaxBytes ?? DEFAULT_CONTEXT_MAX_BYTES
  if (!Number.isSafeInteger(contextMaxBytes) || contextMaxBytes < 1) {
    throw new Error('agent-mesh-tools: contextMaxBytes must be a positive safe integer')
  }
  const maxProxyTools = config.maxProxyTools ?? DEFAULT_MAX_PROXY_TOOLS
  if (!Number.isSafeInteger(maxProxyTools) || maxProxyTools < 0 || maxProxyTools > MAX_PROXY_TOOLS) {
    throw new Error(`agent-mesh-tools: maxProxyTools must be an integer between 0 and ${MAX_PROXY_TOOLS}`)
  }
  const approvalRequests = new WeakSet<object>()
  const nativeContextByAgent = new WeakMap<Agent, string>()
  const nativeToolProxiesByAgent = new WeakMap<Agent, Map<string, NativeToolProxy>>()
  const mcpApprovalConfigs = new WeakMap<object, PreparedMcpConnection>()
  const agentConnections = new WeakMap<Agent, Map<string, Promise<LiveMcpConnection>>>()
  const cleanupRegistered = new WeakSet<Agent>()
  const liveScopes = new Set<Scope>()
  const approvalReason = 'mesh_run starts an external coding-agent run in a caller-selected working directory.'
  ctx.systemPrompt.context({
    name: 'agent-mesh:native-context',
    order: ctx.systemPrompt.getContextOrder('AGENT_MESH_CONTEXT'),
    required: true,
    interpolate: false,
    text: ({ agent }) => agent === undefined ? '' : nativeContextByAgent.get(agent) ?? '',
  })
  async function disposeNativeToolProxies(agent: Agent): Promise<void> {
    const proxies = nativeToolProxiesByAgent.get(agent)
    if (proxies === undefined) return
    nativeToolProxiesByAgent.delete(agent)
    await Promise.all([...proxies.values()].map(proxy => proxy.dispose()))
  }

  async function registerNativeToolProxy(agent: Agent, agentId: AgentId, nativeToolName: string): Promise<NativeToolProxy> {
    const name = nativeToolProxyName(agentId, nativeToolName)
    const safeNativeToolName = safeApprovalText(nativeToolName).slice(0, 120)
    const safeAgentId = safeApprovalText(agentId)
    const definition = defineTool({
      name,
      description: `Delegate a free-text task to ${safeAgentId}'s native tool ${JSON.stringify(safeNativeToolName)}. The external agent receives a request to use this tool; its native JSON arguments are not exposed. Requires DSH approval.`,
      parameters: {
        task: { type: 'string', required: true, description: 'Task to delegate to the external agent.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nativeToolName: { type: 'string', required: true },
            runId: { type: 'string', required: true },
            agentId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            finalText: { type: 'string' },
            error: {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
                remediation: { type: 'string' },
                output: { type: 'string' },
              },
            },
            notes: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: [
            `Delegated to ${safeAgentId}'s native tool ${JSON.stringify(safeNativeToolName)}.`,
            `Run ${value.runId} finished with status ${value.status}.`,
            ...(value.finalText === undefined ? [] : [`answer: ${value.finalText}`]),
            ...(value.error === undefined ? [] : [`error (${value.error.code}): ${value.error.message}`]),
            ...value.notes.map(note => `note: ${note}`),
          ].join('\n'),
        }],
      },
      async execute(args, exec) {
        const owner = exec.agent
        if (owner !== agent) {
          throw new AgentMeshError(
            'mesh/unsupported-operation',
            'the native tool proxy has no matching DSH Agent owner',
            { remediation: 'Refresh the bound Agent tool list and retry from that DSH session.' },
          )
        }
        const binding = ctx.agentMesh.bound(owner.id)
        if (binding !== agentId) {
          throw new AgentMeshError(
            'mesh/capability-not-declared',
            `native tool "${safeNativeToolName}" is no longer available to this bound DSH Agent`,
            { remediation: 'Refresh the native capability list for the current DSH session.' },
          )
        }
        const cwd = await ctx.workingDirectory.ensure(owner, exec.signal)
        const inventory = await ctx.agentMesh.readCapabilities(agentId, { cwd, signal: exec.signal })
        if (!inventory.tools.some(tool => tool.name === nativeToolName)) {
          throw new AgentMeshError(
            'mesh/capability-not-declared',
            `native tool "${safeNativeToolName}" is no longer declared by ${safeAgentId}`,
            { remediation: 'Refresh the native capability list for the current DSH session.' },
          )
        }
        const prompt = `${args.task}\n\nUse your native tool ${JSON.stringify(safeNativeToolName)} to accomplish the task above. Report what you did and the result.`
        const handle = ctx.agentMesh.startRun(agentId, {
          prompt,
          cwd,
          requestApproval: async (request) => {
            const outcome: ApprovalOutcome = await ctx.approval.request({
              agent: owner,
              toolName: name,
              callId: exec.callId,
              reason: `${safeAgentId} (${JSON.stringify(safeNativeToolName)}): ${safeApprovalText(request.title)}\n${safeApprovalText(request.detail)}`,
              displayReason: approvalDisplayReason(request.kind),
              signal: AbortSignal.any([exec.signal, request.signal]),
            })
            return outcome
          },
        })
        const result = await handle.result
        return {
          nativeToolName: safeNativeToolName,
          runId: handle.runId,
          agentId,
          status: result.status,
          ...(result.finalText === undefined ? {} : { finalText: result.finalText }),
          ...(result.error === undefined ? {} : { error: result.error }),
          notes: [...result.notes],
        }
      },
    })
    const fiber = await agent.ctx.inject(['tools'], (scopedContext) => {
      scopedContext.tools.register(definition)
    })
    return { agentId, nativeToolName, dispose: fiber.dispose }
  }

  async function refreshNativeToolProxies(agent: Agent, agentId: AgentId, tools: readonly AgentToolInfo[]): Promise<void> {
    const nativeNames = [...new Set(tools.map(tool => tool.name).filter(toolName => toolName.trim() !== ''))]
      .slice(0, maxProxyTools)
    let proxies = nativeToolProxiesByAgent.get(agent)
    if (proxies === undefined && nativeNames.length > 0) {
      proxies = new Map()
      nativeToolProxiesByAgent.set(agent, proxies)
    }
    if (proxies === undefined) return

    const wanted = new Set(nativeNames.map(nativeToolName => nativeToolProxyName(agentId, nativeToolName)))
    for (const [name, proxy] of proxies) {
      if (proxy.agentId === agentId && wanted.has(name)) continue
      await proxy.dispose()
      proxies.delete(name)
    }
    for (const nativeToolName of nativeNames) {
      const name = nativeToolProxyName(agentId, nativeToolName)
      if (proxies.has(name)) continue
      proxies.set(name, await registerNativeToolProxy(agent, agentId, nativeToolName))
    }
    if (proxies.size === 0) nativeToolProxiesByAgent.delete(agent)
  }

  async function readAndRegisterNativeTools(
    agent: Agent,
    agentId: AgentId,
    signal?: AbortSignal,
  ): Promise<void> {
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const inventory = await ctx.agentMesh.readCapabilities(agentId, {
      cwd,
      ...(signal === undefined ? {} : { signal }),
    })
    if (ctx.agentMesh.bound(agent.id) !== agentId) return
    await refreshNativeToolProxies(agent, agentId, inventory.tools)
  }

  ctx.on('agent/created', async ({ agent, signal }) => {
    const binding = ctx.agentMesh.bound(agent.id)
    if (binding !== undefined) await readAndRegisterNativeTools(agent, binding, signal)
  })
  ctx.on('agent-mesh/binding-change', async ({ sessionId: id, agentId }) => {
    const agent = ctx.agents.get(id)
    if (agent === undefined) return
    if (agentId === undefined) {
      await disposeNativeToolProxies(agent)
      nativeContextByAgent.set(agent, '')
      return
    }
    await readAndRegisterNativeTools(agent, agentId)
  })

  ctx.on('agent/pre-step', async function ({ agent, signal }, next): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()

    const binding = ctx.agentMesh.bound(agent.id)
    if (binding === undefined) {
      await disposeNativeToolProxies(agent)
      nativeContextByAgent.set(agent, '')
      return decision
    }

    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const inventory = await ctx.agentMesh.readCapabilities(binding, { cwd, signal })
    const notes = inventory.notes
      .filter(note => note.field === 'contextFiles')
      .map(note => note.reason)
    const files: NativeContextFile[] = []
    for (const path of new Set(inventory.contextFiles)) {
      signal.throwIfAborted()
      const content = await readCapabilityFile(ctx, path, signal)
      files.push({ path, content })
    }
    const text = files.length === 0 && notes.length === 0
      ? ''
      : renderAgentMeshContext(binding, cwd, files, notes)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > contextMaxBytes) {
      throw new Error(
        `agent-mesh-tools: native context for ${binding} is ${bytes} bytes, over contextMaxBytes ${contextMaxBytes}; increase the setting or reduce the declared instruction files`,
      )
    }
    signal.throwIfAborted()
    nativeContextByAgent.set(agent, text)
    return decision
  })
  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const proxy = exec.agent === undefined
      ? undefined
      : nativeToolProxiesByAgent.get(exec.agent)?.get(exec.name)
    if (exec.name !== 'mesh_run' && proxy === undefined) return next()
    approvalRequests.add(exec)
    return Promise.resolve({
      kind: 'ask',
      reason: proxy === undefined
        ? approvalReason
        : `Delegate a task to ${proxy.agentId}'s native tool ${JSON.stringify(safeApprovalText(proxy.nativeToolName))}.`,
      displayReason: {
        en: proxy === undefined
          ? 'Dispatch an external coding agent in the requested directory? It can read or change files and run commands.'
          : 'Delegate this task to the external agent tool? The external agent can read or change files and run commands.',
        zh: proxy === undefined
          ? '要在指定目录中派发外部编码智能体吗？它可以读取或修改文件并运行命令。'
          : '要将此任务委托给外部智能体工具吗？外部智能体可以读取或修改文件并运行命令。',
      },
    })
  })
  ctx.effect(() => ctx.tools.guard((exec) => {
    const isProxy = exec.agent !== undefined
      && nativeToolProxiesByAgent.get(exec.agent)?.has(exec.name) === true
    if (exec.name !== 'mesh_run' && !isProxy) return undefined
    return approvalRequests.has(exec)
      ? undefined
      : `${exec.name} requires an approval request before it can run.`
  }), 'agent-mesh-tools: external run approval guard')

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== 'mesh_mcp_connect') return next()
    if (exec.agent === undefined) return { kind: 'deny', reason: 'mesh_mcp_connect requires an active DSH Agent.' }
    const args = readMcpConnectArguments(exec.arguments)
    if (args === undefined) return { kind: 'deny', reason: 'mesh_mcp_connect requires agentId, serverName, and cwd.' }
    const connectionKey = mcpConnectionKey(args.agentId, args.serverName)
    const known = agentConnections.get(exec.agent)?.get(connectionKey)
    if (known !== undefined) {
      mcpApprovalConfigs.set(exec, { ...args, config: undefined, toolNamespace: mcpToolNamespace(args.agentId, args.serverName) })
      return { kind: 'allow' }
    }
    try {
      const config = await ctx.agentMesh.resolveMcpServer(args.agentId, {
        serverName: args.serverName,
        cwd: args.cwd,
        signal: exec.signal,
      })
      if (config === undefined) {
        return { kind: 'deny', reason: `MCP server "${args.serverName}" is not declared by ${args.agentId} for ${args.cwd}.` }
      }
      const prepared: PreparedMcpConnection & { readonly config: AgentMcpServerConfig } = {
        ...args,
        config,
        toolNamespace: mcpToolNamespace(args.agentId, args.serverName),
      }
      mcpApprovalConfigs.set(exec, prepared)
      return {
        kind: 'ask',
        reason: renderMcpApprovalReason(prepared),
        displayReason: {
          en: 'Start this configured MCP server and make its tools available to this DSH Agent?',
          zh: '要启动这个已配置的 MCP server，并向当前 DSH Agent 提供它的工具吗？',
        },
      }
    } catch (_configError) {
      return { kind: 'deny', reason: `Could not resolve MCP server "${args.serverName}" from ${args.agentId}'s native configuration.` }
    }
  })
  ctx.effect(() => ctx.tools.guard(exec => exec.name === 'mesh_mcp_connect' && !mcpApprovalConfigs.has(exec)
    ? 'mesh_mcp_connect requires DSH approval before server activation.'
    : undefined), 'agent-mesh-tools: mesh_mcp_connect approval guard')
  ctx.effect(() => async () => {
    const closed = await Promise.allSettled([...liveScopes].map(scope => Promise.resolve().then(() => scope.dispose())))
    liveScopes.clear()
    if (closed.some(result => result.status === 'rejected')) {
      ctx.logger.error('agent-mesh-tools: one or more MCP clients did not close during plugin disposal')
    }
  }, 'agent-mesh-tools: mcp scopes')

  function connectionsFor(agent: Agent): Map<string, Promise<LiveMcpConnection>> {
    let connections = agentConnections.get(agent)
    if (connections === undefined) {
      connections = new Map()
      agentConnections.set(agent, connections)
    }
    if (!cleanupRegistered.has(agent)) {
      cleanupRegistered.add(agent)
      const owned = connections
      agent.ctx.effect(() => async () => {
        const pending = await Promise.allSettled([...owned.values()])
        const scopes = pending.flatMap(result => result.status === 'fulfilled' ? [result.value.scope] : [])
        const closed = await Promise.allSettled(scopes.map(scope => Promise.resolve().then(() => scope.dispose())))
        for (const scope of scopes) liveScopes.delete(scope)
        owned.clear()
        if (closed.some(result => result.status === 'rejected')) {
          ctx.logger.error('agent-mesh-tools: one or more MCP clients did not close during Agent disposal')
        }
      }, 'agent-mesh-tools: Agent MCP clients')
    }
    return connections
  }

  async function connectMcp(
    agent: Agent,
    prepared: PreparedMcpConnection,
    signal: AbortSignal,
  ): Promise<{ readonly connection: LiveMcpConnection; readonly alreadyConnected: boolean }> {
    const config = prepared.config
    if (config === undefined) {
      const existing = connectionsFor(agent).get(mcpConnectionKey(prepared.agentId, prepared.serverName))
      if (existing === undefined) throw new Error('the approved MCP configuration is no longer available')
      return { connection: await existing, alreadyConnected: true }
    }
    const connections = connectionsFor(agent)
    const key = mcpConnectionKey(prepared.agentId, prepared.serverName)
    const existing = connections.get(key)
    if (existing !== undefined) return { connection: await existing, alreadyConnected: true }

    const scope = createScope(ctx, agent)
    liveScopes.add(scope)
    let cancellation: Promise<void> | undefined
    const cancel = (): void => { cancellation ??= scope.dispose() }
    signal.addEventListener('abort', cancel, { once: true })
    const pending = (async (): Promise<LiveMcpConnection> => {
      try {
        signal.throwIfAborted()
        if (config.transport === 'stdio') {
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio',
            serverName: prepared.toolNamespace,
            command: config.command,
            args: [...config.args],
            env: { ...config.env },
            cwd: config.cwd,
            ...(config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs }),
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
        } else {
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'streamable-http',
            serverName: prepared.toolNamespace,
            url: config.url,
            headers: { ...config.headers },
            ...(config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs }),
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
        }
        signal.throwIfAborted()
        return { scope, toolNamespace: prepared.toolNamespace }
      } catch (_connectionError) {
        await (cancellation ?? scope.dispose())
        liveScopes.delete(scope)
        throw new Error(`MCP server "${prepared.serverName}" failed to connect; check its native configuration and DSH diagnostics`)
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    })()
    connections.set(key, pending)
    try {
      return { connection: await pending, alreadyConnected: false }
    } catch (error) {
      connections.delete(key)
      throw error
    }
  }

  async function disconnectMcp(agent: Agent, agentId: string, serverName: string): Promise<boolean> {
    const connections = agentConnections.get(agent)
    const key = mcpConnectionKey(agentId, serverName)
    const pending = connections?.get(key)
    if (connections === undefined || pending === undefined) return false
    const connection = await pending
    await connection.scope.dispose()
    liveScopes.delete(connection.scope)
    if (connections.get(key) === pending) connections.delete(key)
    return true
  }

  ctx.tools.register(defineTool({
    name: 'mesh_agents',
    description: 'List the external coding agents the mesh can read (Codex, Grok Build, Pi, OMP), with their detection state and declared capabilities.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                displayName: { type: 'string', required: true },
                installed: { type: 'boolean', required: true },
                version: { type: 'string', required: true },
                binaryPath: { type: 'string', required: true },
                sessionRoot: { type: 'string', required: true },
                credentialPath: { type: 'string', required: true },
                warning: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.agents.length === 0
          ? 'No external coding agents are registered with the mesh.'
          : value.agents.map(agent => [
            `${agent.id} (${agent.displayName}): ${agent.installed ? 'installed' : 'not installed'}`,
            agent.version === '' ? '' : ` version ${agent.version}`,
            agent.sessionRoot === '' ? '' : ` sessions in ${agent.sessionRoot}`,
            agent.warning === '' ? '' : ` — ${agent.warning}`,
          ].join('')).join('\n'),
      }],
    },
    async execute() {
      const report = await ctx.agentMesh.diagnostics()
      return {
        agents: report.agents.map(agent => ({
          id: agent.id,
          displayName: agent.displayName ?? agent.id,
          installed: agent.detection?.installed ?? false,
          version: agent.detection?.version ?? '',
          binaryPath: agent.detection?.binaryPath ?? '',
          sessionRoot: agent.sessionRoot ?? '',
          credentialPath: agent.credentialPath ?? '',
          warning: agent.warnings.join('; '),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_capabilities',
    description: "Read one external agent's declared tools, skills, MCP servers, commands and context files from its own configuration.",
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent id, as reported by mesh_agents.' },
      cwd: { type: 'string', description: 'Working directory whose project-level configuration applies.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string', required: true },
          tools: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            name: { type: 'string', required: true }, description: { type: 'string' }, source: { type: 'string', required: true },
            approval: { type: 'string' }, discoverable: { type: 'boolean' }, path: { type: 'string' },
          } } },
          skills: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            name: { type: 'string', required: true }, description: { type: 'string' }, source: { type: 'string', required: true },
            path: { type: 'string' }, userInvocable: { type: 'boolean' },
          } } },
          mcpServers: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            name: { type: 'string', required: true }, transport: { type: 'string', required: true }, command: { type: 'string' },
            url: { type: 'string' }, enabled: { type: 'boolean', required: true }, source: { type: 'string', required: true },
          } } },
          commands: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            name: { type: 'string', required: true }, description: { type: 'string' }, source: { type: 'string', required: true }, path: { type: 'string' },
          } } },
          contextFiles: { type: 'array', required: true, items: { type: 'string' } },
          sources: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            path: { type: 'string', required: true }, present: { type: 'boolean', required: true }, note: { type: 'string' },
          } } },
          notes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            field: { type: 'string', required: true }, reason: { type: 'string', required: true },
          } } },
          observedAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, undefined, 2),
      }],
    },
    async execute(args) {
      const inventory = await ctx.agentMesh.readCapabilities(brandString<AgentId>(args.agentId), {
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      })
      return {
        ...inventory,
        tools: [...inventory.tools],
        skills: [...inventory.skills],
        mcpServers: [...inventory.mcpServers],
        commands: [...inventory.commands],
        contextFiles: [...inventory.contextFiles],
        sources: inventory.sources.map(source => ({ ...source })),
        notes: inventory.notes.map(item => ({ ...item })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_capability_read',
    description: "Read one skill, command template, or context file currently declared by an external agent, through DSH's filesystem policy.",
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent id, as reported by mesh_agents.' },
      path: { type: 'string', required: true, description: 'Exact skill, context-file, or command-template path reported by mesh_capabilities.' },
      cwd: { type: 'string', description: 'Working directory whose project-level declarations apply.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string', required: true },
          path: { type: 'string', required: true },
          kind: { type: 'string', enum: ['context', 'command', 'skill'], required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
    },
    async execute(args, exec) {
      const inventory = await ctx.agentMesh.readCapabilities(brandString<AgentId>(args.agentId), {
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        signal: exec.signal,
      })
      const isContext = inventory.contextFiles.includes(args.path)
      const isCommand = inventory.commands.some(command => command.path === args.path)
      const isSkill = inventory.skills.some(skill => skill.path === args.path)
      if (!isContext && !isCommand && !isSkill) {
        throw new AgentMeshError(
          'mesh/capability-not-declared',
          `the path is not currently listed as ${args.agentId}'s context file, skill, or command template`,
          { remediation: 'Call mesh_capabilities for the same agent and cwd, then request one listed file path.' },
        )
      }
      const kind: 'context' | 'command' | 'skill' = isContext ? 'context' : isCommand ? 'command' : 'skill'
      const content = await readCapabilityFile(ctx, args.path, exec.signal)
      return { agentId: args.agentId, path: args.path, kind, content }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_mcp_connect',
    description: 'After DSH approval, start one native MCP server declared by an external agent and expose its tools only to the calling DSH Agent.',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent id whose native MCP configuration declares the server.' },
      serverName: { type: 'string', required: true, description: 'Exact server name from mesh_capabilities.' },
      cwd: { type: 'string', required: true, description: 'Absolute project working directory used to resolve native project configuration.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string', required: true },
          serverName: { type: 'string', required: true },
          toolNamespace: { type: 'string', required: true },
          status: { type: 'string', required: true },
          tools: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'already-connected'
          ? `MCP server is already connected; its tools use mcp__${value.toolNamespace}__.`
          : `MCP server connected after DSH approval; its tools use mcp__${value.toolNamespace}__.`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      /* v8 ignore next -- the MCP pre-execute policy denies calls without an Agent before dispatch. */
      if (agent === undefined) throw new Error('mesh_mcp_connect requires an active DSH Agent')
      const prepared = mcpApprovalConfigs.get(exec)
      /* v8 ignore next -- the monotonic tools guard denies executions without a prepared MCP approval. */
      if (prepared === undefined) throw new Error('mesh_mcp_connect requires DSH approval before server activation')
      const result = await connectMcp(agent, prepared, exec.signal)
      const prefix = `mcp__${result.connection.toolNamespace}__`
      return {
        agentId: args.agentId,
        serverName: args.serverName,
        toolNamespace: result.connection.toolNamespace,
        status: result.alreadyConnected ? 'already-connected' : 'connected',
        tools: ctx.tools.schemas(exec.agent).filter(tool => tool.name.startsWith(prefix)).map(tool => tool.name),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_mcp_disconnect',
    description: 'Disconnect one MCP server previously approved for the calling DSH Agent and remove its tools from that Agent.',
    parameters: {
      agentId: { type: 'string', required: true, description: 'External agent id used when connecting the server.' },
      serverName: { type: 'string', required: true, description: 'Exact server name used when connecting.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string', required: true },
          serverName: { type: 'string', required: true },
          disconnected: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.disconnected ? 'MCP server disconnected and its tools were removed.' : 'That MCP server is not connected in this DSH Agent.',
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('mesh_mcp_disconnect requires an active DSH Agent')
      return {
        agentId: args.agentId,
        serverName: args.serverName,
        disconnected: await disconnectMcp(exec.agent, args.agentId, args.serverName),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_sessions',
    description: "List one external agent's own sessions (as that agent's CLI stored them), newest first.",
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent id, as reported by mesh_agents.' },
      cwd: { type: 'string', description: 'Only sessions whose recorded working directory resolves to this path.' },
      limit: { type: 'integer', description: 'Maximum number of sessions to return.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                agentId: { type: 'string', required: true },
                nativeId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                cwd: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
                status: { type: 'string', required: true },
                messageCount: { type: 'integer', required: true },
                notes: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.sessions.length === 0
          ? 'That agent has no sessions in its own store.'
          : value.sessions.map(sessionLine).join('\n'),
      }],
    },
    async execute(args) {
      const adapter = ctx.agentMesh.adapter(brandString<AgentId>(args.agentId))
      const sessions = await adapter.listSessions({
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return { sessions: sessions.map(sessionRow) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_transcript',
    description: "Read a window of one external agent's session transcript, projected onto a common message shape.",
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent id, as reported by mesh_agents.' },
      sessionId: { type: 'string', required: true, description: 'Native session id, as reported by mesh_sessions.' },
      maxMessages: { type: 'integer', description: 'Maximum number of trailing messages to return.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          hasMore: { type: 'boolean', required: true },
          totalMessages: { type: 'integer', required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                role: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                text: { type: 'string', required: true },
                toolName: { type: 'string', required: true },
                failed: { type: 'boolean', required: true },
                timestamp: { type: 'string', required: true },
              },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? `No messages in the read window (hasMore=${String(value.hasMore)}).`
          : value.messages.map(message => `[${message.index}] ${message.role}/${message.kind}`
            + (message.toolName === '' ? '' : ` ${message.toolName}`)
            + (message.failed ? ' (failed)' : '')
            + (message.text === '' ? '' : `: ${message.text}`)).join('\n\n'),
      }],
    },
    async execute(args) {
      const adapter = ctx.agentMesh.adapter(brandString<AgentId>(args.agentId))
      const sessions = await adapter.listSessions({})
      const session = sessions.find(candidate => candidate.nativeId === args.sessionId)
      if (session === undefined) {
        throw new Error(`agent "${args.agentId}" has no session "${args.sessionId}" in its own store`)
      }
      const transcript = await adapter.readTranscript({
        session,
        ...(args.maxMessages === undefined ? {} : { maxMessages: args.maxMessages }),
      })
      return {
        key: transcript.key,
        hasMore: transcript.hasMore,
        totalMessages: transcript.totalMessages ?? -1,
        messages: transcript.messages.map(message => ({
          index: message.index,
          role: message.role,
          kind: message.kind,
          text: message.text ?? '',
          toolName: message.toolName ?? '',
          failed: message.failed ?? false,
          timestamp: message.timestamp ?? '',
        })),
        notes: [...transcript.notes],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_tasks',
    description: "Read one external agent's own todo list and plan for a session, when that agent records them.",
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent id, as reported by mesh_agents.' },
      sessionId: { type: 'string', required: true, description: 'Native session id, as reported by mesh_sessions.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          planActive: { type: 'boolean', required: true },
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
              },
            },
          },
          plan: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.available
          ? [
            `todos (${value.todos.length})`,
            ...value.todos.map(todo => `- [${todo.status}] ${todo.content}`),
            value.plan.length === 0 ? '' : `plan${value.planActive ? ' (active)' : ''}:\n${value.plan.join('\n')}`,
          ].filter(line => line !== '').join('\n')
          : 'That agent keeps no native todo or plan state.',
      }],
    },
    async execute(args) {
      const adapter = ctx.agentMesh.adapter(brandString<AgentId>(args.agentId))
      const sessions = await adapter.listSessions({})
      const session = sessions.find(candidate => candidate.nativeId === args.sessionId)
      if (session === undefined) {
        throw new Error(`agent "${args.agentId}" has no session "${args.sessionId}" in its own store`)
      }
      const tasks = await adapter.readNativeTasks({ session })
      return {
        available: tasks.available,
        planActive: tasks.plan?.active ?? false,
        todos: tasks.todos.map(todo => ({ content: todo.content, status: todo.status, updatedAt: todo.updatedAt })),
        plan: [...(tasks.plan?.items ?? [])],
        notes: [...tasks.notes],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_run',
    description: 'Dispatch a task to an external coding agent in a working directory and return its terminal result. Adapters that expose native approval requests route them through DSH approval.',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent id, as reported by mesh_agents.' },
      prompt: { type: 'string', required: true, description: 'The task to hand the agent.' },
      cwd: { type: 'string', required: true, description: 'Absolute working directory the agent runs in.' },
      commandName: { type: 'string', description: 'Optional exact file-backed command name from mesh_capabilities; its prompt body is prepended to this task.' },
      model: { type: 'string', description: "Model in the agent's own naming." },
      approval: { type: 'string', description: "Approval mode in the agent's own vocabulary." },
      resumeNativeId: { type: 'string', description: 'Native session id to continue.' },
      timeoutMs: { type: 'integer', description: 'Wall-clock budget in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          agentId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          finalText: { type: 'string' },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
              remediation: { type: 'string' },
              output: { type: 'string' },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Run ${value.runId} for ${value.agentId} finished with status ${value.status}.`,
          ...(value.finalText === undefined ? [] : [`answer: ${value.finalText}`]),
          ...(value.error === undefined ? [] : [`error (${value.error.code}): ${value.error.message}`]),
          ...value.notes.map(note => `note: ${note}`),
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const approval = ctx.approval
      let prompt = args.prompt
      if (args.commandName !== undefined) {
        const inventory = await ctx.agentMesh.readCapabilities(brandString<AgentId>(args.agentId), {
          cwd: args.cwd,
          signal: exec.signal,
        })
        const command = inventory.commands.find(candidate => candidate.name === args.commandName)
        if (command === undefined) {
          throw new AgentMeshError(
            'mesh/capability-not-declared',
            `command "${args.commandName}" is not currently listed for ${args.agentId}`,
            { remediation: 'Call mesh_capabilities for the same agent and cwd, then select one listed command.' },
          )
        }
        if (command.path === undefined) {
          throw new AgentMeshError(
            'mesh/unsupported-operation',
            `command "${args.commandName}" has no file-backed prompt template`,
            { remediation: 'Omit commandName and provide the task directly in prompt.' },
          )
        }
        const template = promptTemplateBody(await readCapabilityFile(ctx, command.path, exec.signal))
        if (template.trim() !== '') prompt = `${template}\n\n${prompt}`
      }
      const handle = ctx.agentMesh.startRun(args.agentId, {
        prompt,
        cwd: args.cwd,
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.approval === undefined ? {} : { approval: args.approval }),
        ...(args.resumeNativeId === undefined ? {} : { resumeNativeId: args.resumeNativeId }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        requestApproval: async (request) => {
          const agent = exec.agent
          /* v8 ignore next -- mesh_run cannot dispatch until the approval service routes it through an Agent. */
          if (agent === undefined) return 'unavailable'
          const outcome: ApprovalOutcome = await approval.request({
            agent,
            toolName: 'mesh_run',
            callId: exec.callId,
            reason: `${args.agentId}: ${request.title}\n${request.detail}`,
            displayReason: approvalDisplayReason(request.kind),
            signal: AbortSignal.any([exec.signal, request.signal]),
          })
          return outcome
        },
      })
      const result = await handle.result
      return {
        runId: handle.runId,
        agentId: args.agentId,
        status: result.status,
        ...(result.finalText === undefined ? {} : { finalText: result.finalText }),
        ...(result.error === undefined ? {} : { error: result.error }),
        notes: [...result.notes],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_runs',
    description: 'Read dispatched runs: their status, final answer, classified failure, and recent events.',
    parameters: {
      runId: { type: 'string', description: 'One run to read; omit for every tracked run.' },
      wait: { type: 'boolean', description: 'With runId, wait for that run to reach a terminal status before answering.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                runId: { type: 'string', required: true },
                agentId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                cwd: { type: 'string', required: true },
                prompt: { type: 'string', required: true },
                finalText: { type: 'string', required: true },
                errorCode: { type: 'string', required: true },
                errorMessage: { type: 'string', required: true },
                eventCount: { type: 'integer', required: true },
                recentEvents: { type: 'array', required: true, items: { type: 'string' } },
                notes: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.runs.length === 0
          ? 'No runs have been dispatched.'
          : value.runs.map(run => [
            `${run.runId} → ${run.agentId} [${run.status}] in ${run.cwd}`,
            run.finalText === '' ? '' : `answer: ${run.finalText}`,
            run.errorMessage === '' ? '' : `error (${run.errorCode}): ${run.errorMessage}`,
            `events: ${run.eventCount}`,
            run.recentEvents.length === 0
              ? ''
              : `recent events:\n${run.recentEvents.map(event => `- ${event}`).join('\n')}`,
          ].filter(line => line !== '').join('\n')).join('\n\n'),
      }],
    },
    async execute(args) {
      const read = async (): Promise<readonly MeshRunSnapshot[]> => {
        if (args.runId !== undefined) {
          const snapshot = args.wait === true
            ? await ctx.agentMesh.waitForRun(args.runId)
            : ctx.agentMesh.run(args.runId)
          return snapshot === undefined ? [] : [snapshot]
        }
        return ctx.agentMesh.runs
      }
      const runs = await read()
      return {
        runs: runs.map(run => ({
          runId: run.runId,
          agentId: run.agentId,
          status: run.status,
          cwd: run.cwd,
          prompt: run.prompt,
          finalText: run.finalText ?? '',
          errorCode: run.error?.code ?? '',
          errorMessage: run.error?.message ?? '',
          eventCount: run.eventCount,
          recentEvents: run.events.map(describeEvent),
          notes: [...run.notes],
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_run_cancel',
    description: 'Cancel a dispatched run. Cancellation terminates the agent process group; it is not a resumable pause.',
    parameters: {
      runId: { type: 'string', required: true, description: 'Run to cancel.' },
      reason: { type: 'string', description: 'Reason recorded with the cancellation.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { cancelled: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.cancelled ? 'Cancellation requested.' : 'That run is not live, so nothing was cancelled.',
      }],
    },
    execute(args) {
      return Promise.resolve({ cancelled: ctx.agentMesh.cancelRun(args.runId, args.reason) })
    },
  }))
}

/**
 * Render one projected run event as a single line.
 * @param event - Event to describe.
 * @returns the one-line description.
 */
function describeEvent(event: AgentRunEvent): string {
  switch (event.kind) {
    case 'message.delta':
    case 'reasoning.delta':
      return `${event.kind}: ${event.text}`
    case 'message.completed':
      return `message.completed: ${event.text}`
    case 'tool.started':
      return `tool.started: ${event.toolName}`
    case 'tool.completed':
      return `tool.completed: ${event.toolName}${event.failed === true ? ' (failed)' : ''}`
    case 'todos.updated':
      return `todos.updated: ${event.todos.map(todo => `${todo.status} ${todo.content}`).join('; ')}`
    case 'files.changed':
      return `files.changed: ${event.paths.join(', ')}`
    case 'usage.updated':
      return `usage.updated: ${event.usage.totalTokens ?? 0} tokens`
    case 'session.bound':
      return `session.bound: ${event.nativeSessionId}`
    case 'warning':
      return `warning: ${event.message}`
    case 'unknown':
      return `unknown: ${event.nativeType ?? 'untyped'}`
    case 'run.started':
    case 'run.finished':
      return event.kind
    /* v8 ignore next -- AgentRunEvent is a closed union and every variant is handled above. */
    default:
      return assertNeverEvent(event)
  }
}

/**
 * Exhaustiveness guard for {@link describeEvent}.
 * @param event - Event the switch did not handle.
 * @returns never; throws when an unhandled event kind reaches it.
 */
/* v8 ignore next -- the exhaustive switch cannot pass a value to this guard. */
function assertNeverEvent(event: never): never {
  throw new Error(`unhandled run event: ${JSON.stringify(event)}`)
}
