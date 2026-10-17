/** Read-only Grok Build configuration, skill, tool, and instruction inventory. */

import { dirname, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { findAgentContextFiles, listAgentContextFiles, readAgentCapabilityFile, readAgentSkillRoot } from '@deepseek-ai/dsh-agent-mesh'
import type {
  AgentCapabilityInventory,
  AgentCapabilityNote,
  AgentCapabilityReadRequest,
  AgentCapabilitySourceFile,
  AgentCommandInfo,
  AgentHost,
  AgentId,
  AgentMcpServerConfig,
  AgentMcpServerResolveRequest,
  AgentMcpServerInfo,
  AgentSkillInfo,
  AgentToolInfo,
} from '@deepseek-ai/dsh-agent-mesh'
import type { GrokPaths } from './sessions.ts'
import {
  expandMcpEnvValue,
  mcpRecord,
  mcpEndpointSummary,
  mcpExecutableSummary,
  mcpOptionalBoolean,
  mcpStringArray,
  resolveMcpCwd,
  resolveMcpEnv,
  resolveMcpHeaders,
  resolveMcpUrl,
  rejectMixedMcpTransports,
} from '@deepseek-ai/dsh-agent-mesh'

/** Grok's built-in tools, as named by its current tool registry and aliases. */
const BUILTIN_TOOLS = [
  'read_file', 'write', 'search_replace', 'hashline_read', 'hashline_edit', 'hashline_grep',
  'grep', 'list_dir', 'run_terminal_cmd', 'web_search', 'web_fetch', 'todo_write',
  'spawn_subagent', 'get_command_or_subagent_output', 'kill_command_or_subagent',
  'ask_user_question', 'enter_plan_mode', 'exit_plan_mode', 'search_tool', 'use_tool',
  'lsp', 'image_gen', 'image_edit', 'video_gen', 'deploy_app',
] as const

/** Native Grok rule names, in the order checked within one directory. */
const CONTEXT_FILE_NAMES = ['Agents.md', 'Claude.md', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENT.md', 'AGENTS.md'] as const

interface ConfigLayer {
  readonly path: string
  readonly kind: 'user' | 'project'
  readonly table?: Record<string, unknown>
}

/**
 * Read Grok's declared capabilities without starting the CLI.
 * @param host - Filesystem and clock access.
 * @param agentId - Registered Grok identity.
 * @param paths - Resolved Grok directories.
 * @param request - Optional project directory and cancellation signal.
 * @returns The inventory and every source read or gap encountered.
 */
export async function readGrokCapabilities(
  host: AgentHost,
  agentId: AgentId,
  paths: GrokPaths,
  request: AgentCapabilityReadRequest = {},
): Promise<AgentCapabilityInventory> {
  const sources: AgentCapabilitySourceFile[] = []
  const notes: AgentCapabilityNote[] = []
  const layers: ConfigLayer[] = []
  layers.push(await readConfigLayer(host, join(paths.home, 'config.toml'), 'user', request.signal, sources, notes))
  if (request.cwd !== undefined) {
    let directory = resolve(request.cwd)
    const projectFiles: string[] = []
    for (let depth = 0; depth < 32; depth += 1) {
      request.signal?.throwIfAborted()
      projectFiles.push(join(directory, '.grok', 'config.toml'))
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    for (const path of projectFiles.reverse()) {
      layers.push(await readConfigLayer(host, path, 'project', request.signal, sources, notes))
    }
  }

  const mcpServers: AgentMcpServerInfo[] = []
  for (const layer of layers) {
    for (const [name, raw] of Object.entries(asRecord(layer.table?.['mcp_servers']) ?? {})) {
      const entry = asRecord(raw)
      if (entry === undefined) {
        notes.push({ field: 'mcpServers', reason: `${layer.path} declares "${name}" with a non-table value` })
        continue
      }
      const command = nonEmptyString(entry['command'])
      const url = nonEmptyString(entry['url'])
      const type = nonEmptyString(entry['type'])
      const index = mcpServers.findIndex(candidate => candidate.name === name)
      const previous = index === -1 ? undefined : mcpServers[index]
      const effectiveCommand = command ?? previous?.command
      const effectiveUrl = url ?? previous?.url
      const server: AgentMcpServerInfo = {
        name,
        transport: effectiveCommand !== undefined ? 'stdio' : type === 'sse' ? 'sse' : effectiveUrl !== undefined ? 'http' : 'unknown',
        enabled: entry['enabled'] === false ? false : entry['enabled'] === true ? true : previous?.enabled ?? true,
        source: layer.kind,
        ...(effectiveCommand === undefined ? {} : { command: mcpExecutableSummary(effectiveCommand) }),
        ...(effectiveUrl === undefined ? {} : { url: mcpEndpointSummary(effectiveUrl) }),
      }
      if (index === -1) mcpServers.push(server)
      else mcpServers[index] = server
    }
  }

  const tools: AgentToolInfo[] = BUILTIN_TOOLS.map(name => ({ name, source: 'builtin' }))
  notes.push({ field: 'tools', reason: 'built-in tool permission tiers and tools supplied by remote MCP servers are not projected' })
  notes.push({ field: 'skills', reason: 'configured extra skill paths, ignored names, and disabled names are not applied to this inventory' })

  const skills: AgentSkillInfo[] = []
  for (const root of [
    { path: join(paths.home, 'skills'), source: 'user' as const },
    ...(request.cwd === undefined ? [] : [
      { path: join(request.cwd, '.grok', 'skills'), source: 'project' as const },
      { path: join(request.cwd, '.agents', 'skills'), source: 'project' as const },
      { path: join(request.cwd, '.claude', 'skills'), source: 'project' as const },
      { path: join(request.cwd, '.cursor', 'skills'), source: 'project' as const },
    ]),
  ]) {
    const result = await readAgentSkillRoot(host, root.path, root.source, request.signal)
    sources.push(result.source)
    skills.push(...result.skills)
  }

  const contextFiles: string[] = [
    ...(await listAgentContextFiles(host, join(paths.home, 'rules'), CONTEXT_FILE_NAMES, request.signal)),
  ]
  for (const name of CONTEXT_FILE_NAMES) {
    const path = join(paths.home, 'rules', name)
    const file = await readAgentCapabilityFile(host, path, request.signal)
    sources.push(file.source)
    if (file.source.present && file.text !== undefined) contextFiles.push(path)
  }
  if (request.cwd !== undefined) {
    contextFiles.push(...await findAgentContextFiles(host, request.cwd, CONTEXT_FILE_NAMES, request.signal))
  }

  return {
    agentId,
    tools,
    skills,
    mcpServers,
    commands: [] as AgentCommandInfo[],
    contextFiles: [...new Set(contextFiles)],
    sources,
    notes: [
      ...notes,
      { field: 'commands', reason: 'Grok slash commands are declared by the CLI interface rather than native configuration files' },
      { field: 'contextFiles', reason: 'configured extra rule directories and project `.grok/rules` files are not scanned' },
    ],
    observedAt: new Date(host.now()).toISOString(),
  }
}

/**
 * Resolve one effective Grok-native MCP server without connecting to it.
 * @param host - Agent host used to read native configuration files.
 * @param paths - Resolved Grok home and configuration paths.
 * @param request - The server name, working directory, and optional signal.
 * @returns The effective server configuration, or `undefined` when it is not declared.
 */
export async function resolveGrokMcpServer(
  host: AgentHost,
  paths: GrokPaths,
  request: AgentMcpServerResolveRequest,
): Promise<AgentMcpServerConfig | undefined> {
  const sources: AgentCapabilitySourceFile[] = []
  const notes: AgentCapabilityNote[] = []
  const layers: ConfigLayer[] = [
    await readConfigLayer(host, join(paths.home, 'config.toml'), 'user', request.signal, sources, notes),
  ]
  let directory = resolve(request.cwd)
  const projectFiles: string[] = []
  for (let depth = 0; depth < 32; depth += 1) {
    request.signal?.throwIfAborted()
    projectFiles.push(join(directory, '.grok', 'config.toml'))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  for (const path of projectFiles.reverse()) {
    layers.push(await readConfigLayer(host, path, 'project', request.signal, sources, notes))
  }
  const readFailure = notes.find(note => note.field === 'configuration')
  if (readFailure !== undefined) throw new Error(readFailure.reason)

  let selected: Record<string, unknown> | undefined
  let source: 'user' | 'project' = 'user'
  const disabled = new Set<string>()
  for (const layer of layers) {
    if (layer.table !== undefined) {
      for (const name of mcpStringArray(layer.table, 'disabled_mcp_servers', layer.path)) disabled.add(name)
    }
    const rawServers = layer.table?.['mcp_servers']
    if (rawServers === undefined) continue
    const servers = mcpRecord(rawServers, `${layer.path}.mcp_servers`)
    if (!Object.hasOwn(servers, request.serverName)) continue
    selected = mcpRecord(servers[request.serverName], `${layer.path}.mcp_servers.${request.serverName}`)
    source = layer.kind
  }
  if (selected === undefined) return undefined
  const field = `mcp_servers.${request.serverName}`
  if (disabled.has(request.serverName) || mcpOptionalBoolean(selected, 'enabled', field) === false) {
    throw new Error(`${field} is disabled in the effective Grok configuration`)
  }
  if (selected['oauth'] !== undefined || selected['auth'] !== undefined) {
    throw new Error(`${field} uses managed authentication, which DSH MCP activation does not support yet`)
  }

  const environment = host.env
  const type = optionalString(selected['type'], `${field}.type`)
  const commandValue = optionalString(selected['command'], `${field}.command`)
  const urlValue = optionalString(selected['url'], `${field}.url`)
  if (type === 'sse') throw new Error(`${field} uses legacy SSE, which DSH MCP activation does not support`)
  if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
    throw new Error(`${field}.type names an unsupported MCP transport`)
  }
  rejectMixedMcpTransports(commandValue, urlValue, field)
  if (commandValue !== undefined && (type === undefined || type === 'stdio')) {
    const command = expandMcpEnvValue(commandValue, environment, `${field}.command`)
    const args = mcpStringArray(selected, 'args', field)
      .map((value, index) => expandMcpEnvValue(value, environment, `${field}.args[${index}]`))
    const env = resolveMcpEnv(asRecord(selected['env']), environment, `${field}.env`)
    const configuredCwd = optionalString(selected['cwd'], `${field}.cwd`)
    const cwd = configuredCwd === undefined
      ? request.cwd
      : expandMcpEnvValue(configuredCwd, environment, `${field}.cwd`)
    return {
      name: request.serverName,
      source,
      transport: 'stdio',
      command,
      args,
      env,
      cwd: resolveMcpCwd(cwd, request.cwd, host.home),
    }
  }
  if (urlValue !== undefined && (type === undefined || type === 'http')) {
    const url = expandMcpEnvValue(urlValue, environment, `${field}.url`)
    const headers = resolveMcpHeaders(asRecord(selected['headers']), environment, `${field}.headers`)
    return {
      name: request.serverName,
      source,
      transport: 'streamable-http',
      url: resolveMcpUrl(url, `${field}.url`),
      headers,
    }
  }
  throw new Error(`${field} must declare a supported stdio command or Streamable HTTP URL`)
}

/** Read and parse one TOML config layer. */
async function readConfigLayer(
  host: AgentHost,
  path: string,
  kind: ConfigLayer['kind'],
  signal: AbortSignal | undefined,
  sources: AgentCapabilitySourceFile[],
  notes: AgentCapabilityNote[],
): Promise<ConfigLayer> {
  const file = await readAgentCapabilityFile(host, path, signal)
  sources.push(file.source)
  if (file.text === undefined) {
    if (file.source.present) notes.push({ field: 'configuration', reason: file.source.note })
    return { path, kind }
  }
  try {
    const table = parseToml(file.text)
    return { path, kind, table }
  } catch {
    notes.push({ field: 'configuration', reason: `${path} is not valid TOML` })
    return { path, kind }
  }
}

/** Whether a parsed value is a TOML table. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read one non-empty TOML string. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read an optional native non-empty string, rejecting malformed values. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}
