/** Read-only OMP tools, skills, MCP servers, commands, and context inventory. */

import { dirname, join, resolve } from 'node:path'
import { findAgentContextFiles, readAgentCapabilityFile, readAgentSkillRoot } from '@deepseek-ai/dsh-agent-mesh'
import type {
  AgentCapabilityInventory,
  AgentCapabilityNote,
  AgentCapabilityReadRequest,
  AgentCapabilitySource,
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
  mcpEndpointSummary,
  mcpExecutableSummary,
  mcpOptionalBoolean,
  mcpRecord,
  mcpStringArray,
  rejectMixedMcpTransports,
  resolveMcpCwd,
  resolveMcpEnv,
  resolveMcpHeaders,
  resolveMcpUrl,
} from '@deepseek-ai/dsh-agent-mesh'
import type { OmpStoreLayout } from './sessions.ts'

/** OMP built-ins from its tool registry, in declaration order. */
const BUILTIN_TOOL_NAMES = [
  'read', 'bash', 'edit', 'ast_grep', 'ast_edit', 'ask', 'debug', 'ida', 'eval', 'github',
  'glob', 'grep', 'find', 'lsp', 'checkpoint', 'rewind', 'context_notes', 'new_context',
  'security_scan', 'task', 'wait', 'todo', 'web_search', 'write', 'memory_edit', 'retain',
  'recall', 'reflect', 'learn', 'manage_skill',
] as const

/** Built-ins OMP always loads before on-demand discovery. */
const ESSENTIAL_TOOL_NAMES = new Set([
  'read', 'write', 'bash', 'edit', 'glob', 'find', 'eval', 'task', 'wait', 'learn',
  'manage_skill', 'context_notes', 'new_context',
])

/** Built-in tools with one fixed approval tier. */
const STATIC_APPROVAL: Readonly<Record<string, string>> = {
  ask: 'read',
  ast_grep: 'read',
  checkpoint: 'read',
  eval: 'exec',
  glob: 'read',
  manage_skill: 'write',
  memory_edit: 'read',
  security_scan: 'exec',
  todo: 'read',
  wait: 'read',
}

/**
 * Read OMP's native capability declarations without importing custom modules.
 * @param host - Filesystem and clock access.
 * @param agentId - Registered OMP identity.
 * @param layout - Resolved OMP agent and user directories.
 * @param request - Optional project directory and cancellation signal.
 * @returns The inventory and every source read or gap encountered.
 */
export async function readOmpCapabilities(
  host: AgentHost,
  agentId: AgentId,
  layout: OmpStoreLayout,
  request: AgentCapabilityReadRequest = {},
): Promise<AgentCapabilityInventory> {
  const sources: AgentCapabilitySourceFile[] = []
  const notes: AgentCapabilityNote[] = []
  const cwd = request.cwd === undefined ? undefined : resolve(request.cwd)
  const project = cwd === undefined ? undefined : await nearestProjectConfig(host, cwd, request.signal)
  const tools: AgentToolInfo[] = BUILTIN_TOOL_NAMES.map(name => ({
    name,
    source: 'builtin',
    discoverable: !ESSENTIAL_TOOL_NAMES.has(name),
    ...(STATIC_APPROVAL[name] === undefined ? {} : { approval: STATIC_APPROVAL[name] }),
  }))
  for (const root of [
    { path: join(layout.agentDir, 'tools'), source: 'config' as const },
    ...(project === undefined ? [] : [{ path: join(project, 'tools'), source: 'project' as const }]),
  ]) {
    const result = await readToolModules(host, root.path, root.source, request.signal)
    sources.push(result.source)
    tools.push(...result.tools)
  }
  notes.push({ field: 'tools', reason: 'built-in tools with per-call approval rules have no fixed tier; custom modules are listed by path without importing their code' })
  notes.push({ field: 'tools', reason: 'hidden built-ins and tools registered by runtime extensions are not listed' })

  const skills: AgentSkillInfo[] = []
  for (const root of [
    ...(cwd === undefined ? [] : ancestorDirectories(cwd, host.home, request.signal).map(directory => ({
      path: join(directory, '.omp', 'skills'),
      source: 'project' as const,
    }))),
    { path: join(layout.agentDir, 'skills'), source: 'user' as const },
    ...(cwd === undefined ? [] : [{ path: join(cwd, '.github', 'skills'), source: 'project' as const }]),
    { path: join(host.home, '.claude', 'skills'), source: 'user' as const },
    { path: join(layout.agentDir, 'managed-skills'), source: 'bundled' as const },
  ]) {
    const result = await readAgentSkillRoot(host, root.path, root.source === 'bundled' ? 'user' : root.source, request.signal)
    sources.push({ ...result.source, ...(root.source === 'bundled' ? { note: 'managed OMP skill directory' } : {}) })
    skills.push(...result.skills.map(skill => root.source === 'bundled' ? { ...skill, source: 'bundled' as const } : skill))
  }
  notes.push({ field: 'skills', reason: 'extension and plugin skill providers require their registries and are not enumerated here' })

  const mcpServers = await readMcpServers(host, layout.agentDir, project, request.signal, sources, notes)
  const commands = await readCommands(host, layout.agentDir, project, request.signal, sources)
  const contextFiles = [
    ...await readContextFiles(host, layout.agentDir, project, request.signal, sources),
    ...(cwd === undefined ? [] : await findAgentContextFiles(host, cwd, ['AGENTS.md', 'RULES.md'], request.signal)),
  ]
  notes.push({ field: 'commands', reason: 'plugin, Claude, and Codex command directories are not scanned' })
  notes.push({ field: 'contextFiles', reason: 'third-party context providers and configured extra paths are not listed; file contents remain unread' })

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

/**
 * Resolve one effective OMP-native MCP server without connecting to it.
 * @param host - Agent host used to read native configuration files.
 * @param layout - Resolved OMP store and configuration paths.
 * @param request - The server name, working directory, and optional signal.
 * @returns The effective server configuration, or `undefined` when it is not declared.
 */
export async function resolveOmpMcpServer(
  host: AgentHost,
  layout: OmpStoreLayout,
  request: AgentMcpServerResolveRequest,
): Promise<AgentMcpServerConfig | undefined> {
  const project = await nearestProjectConfig(host, resolve(request.cwd), request.signal)
  const userPath = join(layout.agentDir, 'mcp.json')
  const projectPath = project === undefined ? undefined : join(project, 'mcp.json')
  const user = await readJsonMcpFile(host, userPath, request.serverName, request.signal)
  const projectConfig = projectPath === undefined
    ? undefined
    : { path: projectPath, ...await readJsonMcpFile(host, projectPath, request.serverName, request.signal) }
  const selected = projectConfig?.entry ?? user.entry
  if (selected === undefined) return undefined
  const field = `mcpServers.${request.serverName}`
  const disabled = new Set([
    ...(user.root === undefined ? [] : mcpStringArray(user.root, 'disabledServers', userPath)),
    ...(projectConfig?.root === undefined ? [] : mcpStringArray(projectConfig.root, 'disabledServers', projectConfig.path)),
  ])
  const enabled = new Set([
    ...(user.root === undefined ? [] : mcpStringArray(user.root, 'enabledServers', userPath)),
    ...(projectConfig?.root === undefined ? [] : mcpStringArray(projectConfig.root, 'enabledServers', projectConfig.path)),
  ])
  if (disabled.has(request.serverName)) throw new Error(`${field} is disabled in the active OMP profile`)
  if (mcpOptionalBoolean(selected, 'enabled', field) === false && !enabled.has(request.serverName)) {
    throw new Error(`${field} is disabled in the effective OMP configuration`)
  }
  if (selected['oauth'] !== undefined || selected['auth'] !== undefined) {
    throw new Error(`${field} uses managed authentication, which DSH MCP activation does not support yet`)
  }
  const type = optionalString(selected['type'], `${field}.type`)
  const command = optionalString(selected['command'], `${field}.command`)
  const url = optionalString(selected['url'], `${field}.url`)
  if (type === 'sse') throw new Error(`${field} uses legacy SSE, which DSH MCP activation does not support`)
  if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
    throw new Error(`${field}.type names an unsupported MCP transport`)
  }
  rejectMixedMcpTransports(command, url, field)
  if (command !== undefined && (type === undefined || type === 'stdio')) {
    const configuredCwd = optionalString(selected['cwd'], `${field}.cwd`)
    return {
      name: request.serverName,
      source: projectConfig?.entry === undefined ? 'user' : 'project',
      transport: 'stdio',
      command,
      args: mcpStringArray(selected, 'args', field),
      env: resolveMcpEnv(asRecord(selected['env']), host.env, `${field}.env`),
      cwd: resolveMcpCwd(configuredCwd, request.cwd, host.home),
      ...timeoutConfig(selected['timeout'], field),
    }
  }
  if (url !== undefined && (type === undefined || type === 'http' || type === 'streamable-http')) {
    return {
      name: request.serverName,
      source: projectConfig?.entry === undefined ? 'user' : 'project',
      transport: 'streamable-http',
      url: resolveMcpUrl(url, `${field}.url`),
      headers: resolveMcpHeaders(asRecord(selected['headers']), host.env, `${field}.headers`),
      ...timeoutConfig(selected['timeout'], field),
    }
  }
  throw new Error(`${field} must declare a supported stdio command or Streamable HTTP URL`)
}

/** Find the nearest non-empty `.omp` directory, stopping at the home directory. */
async function nearestProjectConfig(host: AgentHost, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  for (const directory of ancestorDirectories(cwd, host.home, signal)) {
    signal?.throwIfAborted()
    const candidate = join(directory, '.omp')
    const stat = await host.stat(candidate)
    if (stat === undefined || !stat.isDirectory) continue
    if ((await host.listDir(candidate)).length > 0) return candidate
  }
  return undefined
}

/** List ancestors deepest first, stopping at home or the filesystem root. */
function ancestorDirectories(
  cwd: string,
  home: string,
  signal?: AbortSignal,
): readonly string[] {
  const result: string[] = []
  let directory = resolve(cwd)
  const root = resolve(home)
  for (let depth = 0; depth < 40; depth += 1) {
    signal?.throwIfAborted()
    if (directory === root) break
    result.push(directory)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return result
}

/** List custom OMP tool modules without importing their code. */
async function readToolModules(
  host: AgentHost,
  root: string,
  source: Extract<AgentCapabilitySource, 'config' | 'project'>,
  signal?: AbortSignal,
): Promise<{ readonly source: AgentCapabilitySourceFile; readonly tools: readonly AgentToolInfo[] }> {
  signal?.throwIfAborted()
  const stat = await host.stat(root)
  if (stat === undefined || !stat.isDirectory) {
    return { source: { path: root, present: false, note: stat === undefined ? 'not present' : 'not a directory' }, tools: [] }
  }
  const tools: AgentToolInfo[] = []
  for (const entry of await host.listDir(root)) {
    signal?.throwIfAborted()
    if (entry.isDirectory) {
      const path = join(root, entry.name, 'index.ts')
      const index = await host.stat(path)
      if (index !== undefined && !index.isDirectory) tools.push({ name: entry.name, source, discoverable: true, path })
    } else if (/\.(?:ts|js)$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      tools.push({ name: entry.name.replace(/\.(?:ts|js)$/u, ''), source, discoverable: true, path: join(root, entry.name) })
    }
  }
  return { source: { path: root, present: true }, tools }
}

/** Read project then user MCP declarations, preserving project precedence by name. */
async function readMcpServers(
  host: AgentHost,
  agentDir: string,
  project: string | undefined,
  signal: AbortSignal | undefined,
  sources: AgentCapabilitySourceFile[],
  notes: AgentCapabilityNote[],
): Promise<AgentMcpServerInfo[]> {
  const servers = new Map<string, AgentMcpServerInfo>()
  const disabled = new Set<string>()
  for (const file of [
    ...(project === undefined ? [] : [{ path: join(project, 'mcp.json'), source: 'project' as const }]),
    { path: join(agentDir, 'mcp.json'), source: 'user' as const },
  ]) {
    const read = await readAgentCapabilityFile(host, file.path, signal)
    sources.push(read.source)
    if (read.text === undefined) {
      if (read.source.present) notes.push({ field: 'mcpServers', reason: read.source.note })
      continue
    }
    try {
      const root = asRecord(JSON.parse(read.text))
      for (const name of stringArray(root?.['disabledServers'])) disabled.add(name)
      const entries = asRecord(root?.['mcpServers']) ?? {}
      for (const [name, raw] of Object.entries(entries)) {
        if (servers.has(name)) continue
        const entry = asRecord(raw)
        if (entry === undefined) {
          notes.push({ field: 'mcpServers', reason: `${file.path} declares "${name}" with a non-object value` })
          continue
        }
        const type = nonEmptyString(entry['type'])
        const command = nonEmptyString(entry['command'])
        const url = nonEmptyString(entry['url'])
        servers.set(name, {
          name,
          transport: type === 'stdio' || type === 'http' || type === 'sse' ? type : command !== undefined ? 'stdio' : url !== undefined ? 'http' : 'unknown',
          enabled: entry['enabled'] !== false,
          source: file.source,
          ...(command === undefined ? {} : { command: mcpExecutableSummary(command) }),
          ...(url === undefined ? {} : { url: mcpEndpointSummary(url) }),
        })
      }
    } catch {
      notes.push({ field: 'mcpServers', reason: `${file.path} is not valid JSON` })
    }
  }
  return [...servers.values()].map(server => disabled.has(server.name) ? { ...server, enabled: false } : server)
}

/** List Markdown command files in the OMP user and nearest project directories. */
async function readCommands(
  host: AgentHost,
  agentDir: string,
  project: string | undefined,
  signal: AbortSignal | undefined,
  sources: AgentCapabilitySourceFile[],
): Promise<AgentCommandInfo[]> {
  const commands: AgentCommandInfo[] = []
  for (const root of [
    { path: join(agentDir, 'commands'), source: 'user' as const },
    ...(project === undefined ? [] : [{ path: join(project, 'commands'), source: 'project' as const }]),
  ]) {
    signal?.throwIfAborted()
    const stat = await host.stat(root.path)
    sources.push({
      path: root.path,
      present: stat?.isDirectory === true,
      ...(stat?.isDirectory === true ? {} : { note: stat === undefined ? 'not present' : 'not a directory' }),
    })
    if (stat?.isDirectory !== true) continue
    for (const entry of await host.listDir(root.path)) {
      signal?.throwIfAborted()
      if (!entry.isDirectory && entry.name.endsWith('.md')) {
        commands.push({ name: entry.name.slice(0, -3), source: root.source, path: join(root.path, entry.name) })
      }
    }
  }
  return commands
}

/** List the native OMP instruction and rule files without reading their contents. */
async function readContextFiles(
  host: AgentHost,
  agentDir: string,
  project: string | undefined,
  signal: AbortSignal | undefined,
  sources: AgentCapabilitySourceFile[],
): Promise<string[]> {
  const files: string[] = []
  const fixed = [join(agentDir, 'AGENTS.md'), join(agentDir, 'RULES.md')]
  if (project !== undefined) fixed.push(join(project, 'AGENTS.md'), join(project, 'RULES.md'))
  for (const path of fixed) {
    signal?.throwIfAborted()
    const stat = await host.stat(path)
    if (stat !== undefined && !stat.isDirectory) files.push(path)
  }
  for (const root of [join(agentDir, 'rules'), ...(project === undefined ? [] : [join(project, 'rules')])]) {
    signal?.throwIfAborted()
    const stat = await host.stat(root)
    sources.push({ path: root, present: stat?.isDirectory === true, ...(stat?.isDirectory === true ? {} : { note: stat === undefined ? 'not present' : 'not a directory' }) })
    if (stat?.isDirectory !== true) continue
    for (const entry of await host.listDir(root)) {
      if (!entry.isDirectory && /\.(?:md|mdc)$/u.test(entry.name)) files.push(join(root, entry.name))
    }
  }
  return files
}

/** Whether a JSON value is a record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a non-empty string field. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Collect only non-empty string entries from a JSON array. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
}

/** Read one native MCP JSON file and select one server without returning other entries. */
async function readJsonMcpFile(
  host: AgentHost,
  path: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ readonly root?: Record<string, unknown>; readonly entry?: Record<string, unknown> }> {
  const read = await readAgentCapabilityFile(host, path, signal)
  if (read.text === undefined) {
    if (read.source.present) throw new Error(`${path}: ${read.source.note}`)
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error })
  }
  const root = mcpRecord(parsed, path)
  const rawServers = root['mcpServers']
  if (rawServers === undefined) return { root }
  const servers = mcpRecord(rawServers, `${path}.mcpServers`)
  const rawEntry = servers[name]
  return { root, ...(rawEntry === undefined ? {} : { entry: mcpRecord(rawEntry, `${path}.mcpServers.${name}`) }) }
}

/** Read an optional non-empty native config string, rejecting malformed values. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

/** Pass through OMP's per-call millisecond timeout, including its no-timeout value. */
function timeoutConfig(value: unknown, field: string): { readonly toolCallTimeoutMs?: number } {
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new Error(`${field}.timeout must be a non-negative finite millisecond value`)
  }
  return { toolCallTimeoutMs: value }
}
