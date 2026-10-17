/** Read-only Pi configuration, skill, command, MCP, and instruction inventory. */

import { dirname, join, resolve } from 'node:path'
import { findAgentContextFiles, readAgentCapabilityFile, readAgentSkillRoot } from '@deepseek-ai/dsh-agent-mesh'
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
import {
  expandMcpEnvValue,
  mcpEndpointSummary,
  mcpExecutableSummary,
  mcpRecord,
  mcpOptionalBoolean,
  mcpStringArray,
  resolveMcpCwd,
  resolveMcpEnv,
  resolveMcpHeaders,
  resolveMcpUrl,
  rejectMixedMcpTransports,
} from '@deepseek-ai/dsh-agent-mesh'
import type { PiStoreLayout } from './sessions.ts'

/** Pi built-in tools named by its CLI documentation. */
const BUILTIN_TOOLS: readonly { readonly name: string; readonly discoverable?: true }[] = [
  { name: 'read' },
  { name: 'bash' },
  { name: 'powershell' },
  { name: 'edit' },
  { name: 'write' },
  { name: 'grep' },
  { name: 'find' },
  { name: 'ls' },
  { name: 'codemode', discoverable: true },
  { name: 'tool_search', discoverable: true },
]

/** Pi rule filenames checked in its native order. */
const CONTEXT_FILE_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'] as const

/**
 * Read Pi's declared capabilities without running it or loading extensions.
 * @param host - Filesystem and clock access.
 * @param agentId - Registered Pi identity.
 * @param layout - Resolved Pi configuration directories.
 * @param request - Optional project directory and cancellation signal.
 * @returns The inventory and every source read or gap encountered.
 */
export async function readPiCapabilities(
  host: AgentHost,
  agentId: AgentId,
  layout: PiStoreLayout,
  request: AgentCapabilityReadRequest = {},
): Promise<AgentCapabilityInventory> {
  const sources: AgentCapabilitySourceFile[] = []
  const notes: AgentCapabilityNote[] = []
  const tools: AgentToolInfo[] = BUILTIN_TOOLS.map(tool => ({
    name: tool.name,
    source: 'builtin',
    ...(tool.discoverable === true ? { discoverable: true } : {}),
  }))
  notes.push({ field: 'tools', reason: 'tools registered dynamically by Pi extensions cannot be listed without executing those extensions' })

  const skills: AgentSkillInfo[] = []
  const skillRoots = [
    { path: join(layout.agentDir, 'skills'), source: 'user' as const },
    ...(request.cwd === undefined ? [] : [
      { path: join(request.cwd, '.pi', 'skills'), source: 'project' as const },
      { path: join(request.cwd, '.agents', 'skills'), source: 'project' as const },
    ]),
  ]
  for (const root of skillRoots) {
    const result = await readAgentSkillRoot(host, root.path, root.source, request.signal)
    sources.push(result.source)
    skills.push(...result.skills)
  }

  const commandRoot = join(layout.agentDir, 'prompts')
  const commandRootStat = await host.stat(commandRoot)
  request.signal?.throwIfAborted()
  const commands: AgentCommandInfo[] = []
  sources.push({
    path: commandRoot,
    present: commandRootStat?.isDirectory === true,
    ...(commandRootStat?.isDirectory === true ? {} : { note: commandRootStat === undefined ? 'not present' : 'not a directory' }),
  })
  if (commandRootStat?.isDirectory === true) {
    for (const entry of await host.listDir(commandRoot)) {
      request.signal?.throwIfAborted()
      if (entry.isDirectory || !entry.name.endsWith('.md')) continue
      const path = join(commandRoot, entry.name)
      const file = await readAgentCapabilityFile(host, path, request.signal)
      if (file.text === undefined) continue
      const description = file.text.split(/\r?\n/u).find(line => line.trim() !== '' && line.trim() !== '---')?.replace(/^#+\s*/u, '').trim()
      commands.push({
        name: entry.name.slice(0, -3),
        source: 'user',
        path,
        ...(description === undefined || description === '' ? {} : { description }),
      })
    }
  }
  notes.push({ field: 'commands', reason: 'Pi built-in slash commands are defined by the CLI and are not declared in files' })

  const mcpServers = await readPiMcpServers(host, layout.agentDir, request.cwd, request.signal, sources, notes)

  const contextFiles: string[] = []
  for (const name of [...CONTEXT_FILE_NAMES, 'SYSTEM.md', 'APPEND_SYSTEM.md']) {
    const path = join(layout.agentDir, name)
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
    commands,
    contextFiles: [...new Set(contextFiles)],
    sources,
    notes,
    observedAt: new Date(host.now()).toISOString(),
  }
}

/** Read effective user and project MCP declarations without starting their servers. */
async function readPiMcpServers(
  host: AgentHost,
  agentDir: string,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  sources: AgentCapabilitySourceFile[],
  notes: AgentCapabilityNote[],
): Promise<AgentMcpServerInfo[]> {
  const files: { readonly path: string; readonly source: 'user' | 'project' }[] = [
    { path: join(agentDir, 'mcp.json'), source: 'user' },
  ]
  if (cwd !== undefined) {
    let directory = resolve(cwd)
    const projectFiles: string[] = []
    for (let depth = 0; depth < 32; depth += 1) {
      signal?.throwIfAborted()
      projectFiles.push(join(directory, '.pi', 'mcp.json'))
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    files.push(...projectFiles.reverse().map(path => ({ path, source: 'project' as const })))
  }
  const effective = new Map<string, { readonly entry: Record<string, unknown>; readonly source: 'user' | 'project' }>()
  const disabled = new Set<string>()
  for (const file of files) {
    const read = await readAgentCapabilityFile(host, file.path, signal)
    sources.push(read.source)
    if (read.text === undefined) {
      if (read.source.present) notes.push({ field: 'mcpServers', reason: read.source.note })
      continue
    }
    try {
      const parsed = parseMcpFile(read.text, file.path)
      try {
        for (const name of mcpStringArray(parsed.root, 'disabledServers', file.path)) disabled.add(name)
      } catch (error) {
        notes.push({ field: 'mcpServers', reason: errorMessage(error) })
      }
      for (const [name, raw] of Object.entries(parsed.servers)) {
        let entry: Record<string, unknown>
        try {
          entry = mcpRecord(raw, `${file.path}.mcpServers.${name}`)
        } catch (_invalidEntry) {
          notes.push({ field: 'mcpServers', reason: `${file.path} declares "${name}" with a non-object value` })
          continue
        }
        const previous = effective.get(name)
        const hasTransport = entry['command'] !== undefined || entry['url'] !== undefined || entry['type'] !== undefined
        const merged = hasTransport || previous === undefined
          ? entry
          : { ...previous.entry, ...pickProjectOverrides(entry) }
        effective.set(name, { entry: merged, source: file.source })
      }
    } catch (error) {
      notes.push({ field: 'mcpServers', reason: errorMessage(error) })
    }
  }
  return [...effective].map(([name, value]) => {
    const commandValue = nonEmptyString(value.entry['command'])
    const urlValue = nonEmptyString(value.entry['url'])
    const type = nonEmptyString(value.entry['type'])
    const command = commandValue === undefined ? undefined : mcpExecutableSummary(commandValue)
    const url = urlValue === undefined ? undefined : mcpEndpointSummary(urlValue)
    return {
      name,
      transport: type === 'sse' ? 'sse' : command !== undefined ? 'stdio' : url !== undefined ? 'http' : 'unknown',
      enabled: value.entry['enabled'] !== false && !disabled.has(name),
      source: value.source === 'user' ? 'config' : 'project',
      ...(command === undefined ? {} : { command }),
      ...(url === undefined ? {} : { url }),
    }
  })
}

/**
 * Resolve one native Pi MCP server without connecting to it.
 * @param host - Agent host used to read native configuration files.
 * @param layout - Resolved Pi store and configuration paths.
 * @param request - The server name, working directory, and optional signal.
 * @returns The effective server configuration, or `undefined` when it is not declared.
 */
export async function resolvePiMcpServer(
  host: AgentHost,
  layout: PiStoreLayout,
  request: AgentMcpServerResolveRequest,
): Promise<AgentMcpServerConfig | undefined> {
  const userPath = join(layout.agentDir, 'mcp.json')
  const userFile = await readAgentCapabilityFile(host, userPath, request.signal)
  if (userFile.text === undefined && userFile.source.present) throw new Error(`${userPath}: ${userFile.source.note}`)
  let selected: Record<string, unknown> | undefined
  const disabled = new Set<string>()
  if (userFile.text !== undefined) {
    const parsed = parseMcpFile(userFile.text, userPath)
    for (const name of mcpStringArray(parsed.root, 'disabledServers', userPath)) disabled.add(name)
    const raw = parsed.servers[request.serverName]
    if (raw !== undefined) selected = mcpRecord(raw, `${userPath}.mcpServers.${request.serverName}`)
  }
  let source: 'user' | 'project' = 'user'
  const projectFiles: string[] = []
  let directory = resolve(request.cwd)
  for (let depth = 0; depth < 32; depth += 1) {
    request.signal?.throwIfAborted()
    projectFiles.push(join(directory, '.pi', 'mcp.json'))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  for (const path of projectFiles.reverse()) {
    const file = await readAgentCapabilityFile(host, path, request.signal)
    if (file.text === undefined) {
      if (file.source.present) throw new Error(`${path}: ${file.source.note}`)
      continue
    }
    const parsed = parseMcpFile(file.text, path)
    for (const name of mcpStringArray(parsed.root, 'disabledServers', path)) disabled.add(name)
    const raw = parsed.servers[request.serverName]
    if (raw === undefined) continue
    const projectEntry = mcpRecord(raw, `${path}.mcpServers.${request.serverName}`)
    const hasTransport = projectEntry['command'] !== undefined || projectEntry['url'] !== undefined || projectEntry['type'] !== undefined
    selected = hasTransport || selected === undefined
      ? projectEntry
      : { ...selected, ...pickProjectOverrides(projectEntry) }
    source = 'project'
  }
  if (selected === undefined) return undefined
  const field = `mcpServers.${request.serverName}`
  if (disabled.has(request.serverName) || mcpOptionalBoolean(selected, 'enabled', field) === false) {
    throw new Error(`${field} is disabled in the effective Pi configuration`)
  }
  if (selected['oauth'] !== undefined || selected['auth'] !== undefined) {
    throw new Error(`${field} uses managed authentication, which DSH MCP activation does not support yet`)
  }
  const command = optionalString(selected['command'], `${field}.command`)
  const url = optionalString(selected['url'], `${field}.url`)
  const type = optionalString(selected['type'], `${field}.type`)
  if (type === 'sse') throw new Error(`${field} uses legacy SSE, which DSH MCP activation does not support`)
  if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
    throw new Error(`${field}.type names an unsupported MCP transport`)
  }
  rejectMixedMcpTransports(command, url, field)
  if (command !== undefined && (type === undefined || type === 'stdio')) {
    const configuredCwd = optionalString(selected['cwd'], `${field}.cwd`)
    return {
      name: request.serverName,
      source,
      transport: 'stdio',
      command: expandHomePrefix(command, host.home),
      args: mcpStringArray(selected, 'args', field).map(value => expandHomePrefix(value, host.home)),
      env: resolveMcpEnv(asOptionalRecord(selected['env'], `${field}.env`), host.env, `${field}.env`),
      cwd: resolveMcpCwd(configuredCwd, request.cwd, host.home),
      ...timeoutConfig(selected['timeout'], field),
    }
  }
  if (url !== undefined && (type === undefined || type === 'http' || type === 'streamable-http')) {
    return {
      name: request.serverName,
      source,
      transport: 'streamable-http',
      url: resolveMcpUrl(expandMcpEnvValue(url, host.env, `${field}.url`), `${field}.url`),
      headers: resolveMcpHeaders(asOptionalRecord(selected['headers'], `${field}.headers`), host.env, `${field}.headers`),
      ...timeoutConfig(selected['timeout'], field),
    }
  }
  throw new Error(`${field} must declare a supported stdio command or Streamable HTTP URL`)
}

/** Whether a parsed value is a JSON object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read one non-empty config string. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Parse one Pi-native MCP file while keeping the JSON parser failure generic. */
function parseMcpFile(text: string, path: string): { readonly root: Record<string, unknown>; readonly servers: Record<string, unknown> } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error })
  }
  const root = asRecord(parsed)
  if (root === undefined) throw new Error(`${path} must contain an object`)
  const rawServers = root['mcpServers']
  if (rawServers === undefined) return { root, servers: {} }
  return { root, servers: mcpRecord(rawServers, `${path}.mcpServers`) }
}

/** Preserve only fields Pi permits a project file to override on a user server. */
function pickProjectOverrides(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => ['enabled', 'exposure', 'toolExposure'].includes(key)))
}

/** Read an optional non-empty config string, rejecting malformed values. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

/** Read an optional nested config object, rejecting malformed values. */
function asOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : mcpRecord(value, field)
}

/** Expand only the documented leading home marker in Pi process fields. */
function expandHomePrefix(value: string, home: string): string {
  return value.replace(/^~(?=\/|$)/u, home)
}

/** Convert Pi's per-request seconds value into DSH's millisecond timeout. */
function timeoutConfig(value: unknown, field: string): { readonly toolCallTimeoutMs?: number } {
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value * 1000 > 2_147_483_647) {
    throw new Error(`${field}.timeout must be a positive finite number of seconds`)
  }
  return { toolCallTimeoutMs: Math.ceil(value * 1000) }
}

/** Render a parser failure without including native config contents. */
function errorMessage(error: unknown): string {
  return String(error).replace(/^\w*Error:\s*/u, '')
}
