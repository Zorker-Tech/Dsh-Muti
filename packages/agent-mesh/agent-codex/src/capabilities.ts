/** Read-only Codex configuration, skill, command, and instruction inventory. */

import { dirname, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  findAgentContextFiles,
  listAgentContextFiles,
  readAgentCapabilityFile,
  readAgentSkillRoot,
} from '@deepseek-ai/dsh-agent-mesh'
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
} from '@deepseek-ai/dsh-agent-mesh'
import {
  mcpRecord,
  mcpEndpointSummary,
  mcpExecutableSummary,
  mcpOptionalBoolean,
  mcpStringArray,
  mcpStringRecord,
  rejectMixedMcpTransports,
  resolveMcpCwd,
  resolveMcpHeaders,
  resolveMcpUrl,
} from '@deepseek-ai/dsh-agent-mesh'
import type { CodexHome } from './sessions.ts'

/** One native config file and its parsed table. */
interface ConfigLayer {
  readonly path: string
  readonly kind: 'user' | 'project'
  readonly table?: Record<string, unknown>
}

/**
 * Read Codex declarations without running the CLI or loading extensions.
 * @param host - Filesystem and clock access.
 * @param agentId - Registered Codex identity.
 * @param home - Resolved Codex home.
 * @param request - Optional project directory and cancellation signal.
 * @returns The inventory and every source read or gap encountered.
 */
export async function readCodexCapabilities(
  host: AgentHost,
  agentId: AgentId,
  home: CodexHome,
  request: AgentCapabilityReadRequest = {},
): Promise<AgentCapabilityInventory> {
  const sources: AgentCapabilitySourceFile[] = []
  const notes: AgentCapabilityNote[] = []
  const layers: ConfigLayer[] = []
  const userConfig = join(home.path, 'config.toml')
  layers.push(await readConfigLayer(host, userConfig, 'user', request.signal, sources, notes))

  if (request.cwd !== undefined) {
    let directory = resolve(request.cwd)
    const projectFiles: string[] = []
    for (let depth = 0; depth < 32; depth += 1) {
      request.signal?.throwIfAborted()
      projectFiles.push(join(directory, '.codex', 'config.toml'))
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
    for (const [name, raw] of Object.entries(record(layer.table?.['mcp_servers']) ?? {})) {
      const entry = record(raw)
      if (entry === undefined) {
        notes.push({ field: 'mcpServers', reason: `${layer.path} declares "${name}" with a non-table value` })
        continue
      }
      const command = nonEmptyString(entry['command'])
      const url = nonEmptyString(entry['url'])
      const index = mcpServers.findIndex(candidate => candidate.name === name)
      const previous = index === -1 ? undefined : mcpServers[index]
      const effectiveCommand = command ?? previous?.command
      const effectiveUrl = url ?? previous?.url
      const server: AgentMcpServerInfo = {
        name,
        transport: effectiveCommand !== undefined ? 'stdio' : effectiveUrl !== undefined ? 'http' : 'unknown',
        enabled: entry['enabled'] === false ? false : entry['enabled'] === true ? true : previous?.enabled ?? true,
        source: layer.kind,
        ...(effectiveCommand === undefined ? {} : { command: mcpExecutableSummary(effectiveCommand) }),
        ...(effectiveUrl === undefined ? {} : { url: mcpEndpointSummary(effectiveUrl) }),
      }
      if (index === -1) mcpServers.push(server)
      else mcpServers[index] = server
    }
  }

  const skills: AgentSkillInfo[] = []
  const homeSkills = await readAgentSkillRoot(host, join(home.path, 'skills'), 'user', request.signal)
  sources.push(homeSkills.source)
  skills.push(...homeSkills.skills)
  if (request.cwd !== undefined) {
    for (const root of [join(request.cwd, '.agents', 'skills'), join(request.cwd, '.codex', 'skills')]) {
      const result = await readAgentSkillRoot(host, root, 'project', request.signal)
      sources.push(result.source)
      skills.push(...result.skills)
    }
  }

  const contextFiles = [
    ...(await listAgentContextFiles(host, home.path, ['AGENTS.override.md', 'AGENTS.md'], request.signal)),
    ...(request.cwd === undefined
      ? []
      : await findAgentContextFiles(host, request.cwd, ['AGENTS.override.md', 'AGENTS.md'], request.signal)),
  ]
  const commands = await readPromptCommands(host, join(home.path, 'prompts'), request.signal, sources)
  notes.push({
    field: 'tools',
    reason: 'Codex built-in tools are defined by the CLI binary and are not exposed through a read-only configuration file.',
  })

  return {
    agentId,
    tools: [],
    skills,
    mcpServers,
    commands,
    contextFiles: [...new Set(contextFiles)],
    sources,
    notes,
    observedAt: new Date(host.now()).toISOString(),
  }
}

/**
 * Resolve one Codex-native MCP server for a later DSH-approved activation.
 * @param host - Agent host used to read native configuration files.
 * @param home - Resolved Codex home directory.
 * @param request - The server name, working directory, and optional signal.
 * @returns The effective server configuration, or `undefined` when it is not declared.
 */
export async function resolveCodexMcpServer(
  host: AgentHost,
  home: CodexHome,
  request: AgentMcpServerResolveRequest,
): Promise<AgentMcpServerConfig | undefined> {
  const layers: ConfigLayer[] = []
  const notes: AgentCapabilityNote[] = []
  layers.push(await readConfigLayer(host, join(home.path, 'config.toml'), 'user', request.signal, [], notes))
  let directory = resolve(request.cwd)
  const projectFiles: string[] = []
  for (let depth = 0; depth < 32; depth += 1) {
    request.signal?.throwIfAborted()
    projectFiles.push(join(directory, '.codex', 'config.toml'))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  for (const path of projectFiles.reverse()) {
    layers.push(await readConfigLayer(host, path, 'project', request.signal, [], notes))
  }
  const readFailure = notes.find(note => note.field === 'configuration')
  if (readFailure !== undefined) throw new Error(readFailure.reason)

  let selected: Record<string, unknown> | undefined
  let source: 'user' | 'project' = 'user'
  for (const layer of layers) {
    const rawServers = layer.table?.['mcp_servers']
    if (rawServers === undefined) continue
    const servers = mcpRecord(rawServers, `${layer.path}.mcp_servers`)
    if (!Object.hasOwn(servers, request.serverName)) continue
    selected = { ...selected, ...mcpRecord(servers[request.serverName], `${layer.path}.mcp_servers.${request.serverName}`) }
    source = layer.kind
  }
  if (selected === undefined) return undefined
  const field = `mcp_servers.${request.serverName}`
  if (mcpOptionalBoolean(selected, 'enabled', field) === false) throw new Error(`${field} is disabled in the effective Codex configuration`)
  if (selected['oauth'] !== undefined || selected['oauth_client_id'] !== undefined) {
    throw new Error(`${field} uses OAuth, which DSH MCP activation does not support yet`)
  }

  const commandValue = optionalString(selected['command'], `${field}.command`)
  const urlValue = optionalString(selected['url'], `${field}.url`)
  rejectMixedMcpTransports(commandValue, urlValue, field)
  if (commandValue !== undefined) {
    const command = commandValue
    const env = mcpStringRecord(selected['env'], `${field}.env`)
    for (const name of mcpStringArray(selected, 'env_vars', field)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(`${field}.env_vars contains an invalid name`)
      const value = host.env[name]
      if (value !== undefined) env[name] = value
    }
    return {
      name: request.serverName,
      source,
      transport: 'stdio',
      command,
      args: mcpStringArray(selected, 'args', field),
      env,
      cwd: resolveMcpCwd(optionalString(selected['cwd'], `${field}.cwd`), request.cwd, host.home),
      ...timeoutConfig(selected['tool_timeout_sec'], field),
    }
  }
  if (urlValue !== undefined) {
    const headers = resolveMcpHeaders(asOptionalRecord(selected['http_headers'], `${field}.http_headers`), {}, `${field}.http_headers`, false)
    const envHeaders = asOptionalRecord(selected['env_http_headers'], `${field}.env_http_headers`)
    if (envHeaders !== undefined) {
      for (const [name, envKey] of Object.entries(envHeaders)) {
        if (typeof envKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envKey)) {
          throw new Error(`${field}.env_http_headers contains an invalid environment reference`)
        }
        const value = host.env[envKey]
        if (value === undefined) throw new Error(`${field}.env_http_headers references unavailable environment variable "${envKey}"`)
        headers[name] = value
      }
    }
    const bearerName = optionalString(selected['bearer_token_env_var'], `${field}.bearer_token_env_var`)
    if (bearerName !== undefined) {
      const token = host.env[bearerName]
      if (token === undefined) throw new Error(`${field}.bearer_token_env_var references unavailable environment variable "${bearerName}"`)
      headers['Authorization'] = `Bearer ${token}`
    }
    const validatedHeaders = resolveMcpHeaders(headers, {}, `${field}.http_headers`, false)
    return {
      name: request.serverName,
      source,
      transport: 'streamable-http',
      url: resolveMcpUrl(urlValue, `${field}.url`),
      headers: validatedHeaders,
      ...timeoutConfig(selected['tool_timeout_sec'], field),
    }
  }
  throw new Error(`${field} must declare a supported stdio command or Streamable HTTP URL`)
}

/** Read one TOML table and retain its source result. */
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

/** Read Codex custom prompt files as slash commands. */
async function readPromptCommands(
  host: AgentHost,
  root: string,
  signal: AbortSignal | undefined,
  sources: AgentCapabilitySourceFile[],
): Promise<AgentCommandInfo[]> {
  signal?.throwIfAborted()
  const stat = await host.stat(root)
  if (stat === undefined || !stat.isDirectory) {
    sources.push({ path: root, present: false, note: stat === undefined ? 'not present' : 'not a directory' })
    return []
  }
  sources.push({ path: root, present: true })
  const commands: AgentCommandInfo[] = []
  for (const entry of await host.listDir(root)) {
    signal?.throwIfAborted()
    if (entry.isDirectory || !entry.name.endsWith('.md')) continue
    const path = join(root, entry.name)
    const file = await readAgentCapabilityFile(host, path, signal)
    if (file.text === undefined) continue
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(file.text)?.[1] ?? ''
    const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim().replace(/^(['"])(.*)\1$/u, '$2')
    commands.push({
      name: entry.name.slice(0, -3),
      source: 'user',
      path,
      ...(description === undefined || description === '' ? {} : { description }),
    })
  }
  return commands
}

/** Whether a decoded configuration value is a table. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a non-empty string field without exposing other configuration values. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read an optional native string without silently discarding a malformed value. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

/** Read an optional native table without silently discarding a malformed value. */
function asOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : mcpRecord(value, field)
}

/** Convert Codex's per-call seconds value into DSH's millisecond timeout. */
function timeoutConfig(value: unknown, field: string): { readonly toolCallTimeoutMs?: number } {
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 2_147_483.647) {
    throw new Error(`${field}.tool_timeout_sec must be a positive finite value`)
  }
  return { toolCallTimeoutMs: Math.ceil(value * 1000) }
}
