import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId } from '@deepseek-ai/dsh-agent-mesh'
import { grokAdapter } from '../src/index.ts'
import { resolveGrokConfig } from '../src/config.ts'
import { readGrokCapabilities, resolveGrokMcpServer } from '../src/capabilities.ts'
import type { GrokPaths } from '../src/sessions.ts'
import { MemoryHost } from './support/memory-host.ts'

const id = brandString<AgentId>('grok')
const paths: GrokPaths = {
  home: '/home/tester/.grok', homeFromEnv: false,
  sessionRoot: '/home/tester/.grok/sessions', credentialPath: '/home/tester/.grok/auth.json',
}

describe('Grok capability inventory', () => {
  it('projects MCP precedence, native tools, skills, and context files', async () => {
    const host = new MemoryHost({ files: {
      [`${paths.home}/config.toml`]: '[mcp_servers.shared]\ncommand = "user"\n',
      '/repo/.grok/config.toml': '[mcp_servers.shared]\ncommand = "repo"\n',
      '/repo/sub/.grok/config.toml': '[mcp_servers.shared]\ncommand = "sub"\n[mcp_servers.remote]\ntype = "sse"\nurl = "https://localhost/events"\n',
      [`${paths.home}/skills/user/SKILL.md`]: '---\ndescription: User skill\n---\n',
      '/repo/sub/.grok/skills/project/SKILL.md': '---\nuser-invocable: false\n---\n',
      [`${paths.home}/rules/Agents.md`]: 'user rules',
      '/AGENTS.md': 'root rules',
      '/repo/sub/CLAUDE.md': 'project rules',
    } })
    const inventory = await readGrokCapabilities(host, id, paths, { cwd: '/repo/sub' })
    expect(inventory.tools[0]).toEqual({ name: 'read_file', source: 'builtin' })
    expect(inventory.mcpServers).toEqual([
      { name: 'shared', transport: 'stdio', command: 'sub', enabled: true, source: 'project' },
      { name: 'remote', transport: 'sse', url: 'https://localhost', enabled: true, source: 'project' },
    ])
    expect(inventory.skills.map(skill => skill.name).sort()).toEqual(['project', 'user'])
    expect(inventory.contextFiles).toContain(`${paths.home}/rules/Agents.md`)
    expect(inventory.contextFiles).toContain('/repo/sub/CLAUDE.md')
    expect(inventory.contextFiles).toContain('/AGENTS.md')
    expect(inventory.notes.map(note => note.field)).toContain('commands')
  })

  it('keeps malformed configuration visible and respects cancellation', async () => {
    const host = new MemoryHost({ files: { [`${paths.home}/config.toml`]: '[mcp_servers]\nbroken = "table expected"\n' } })
    const inventory = await readGrokCapabilities(host, id, paths)
    expect(inventory.mcpServers).toEqual([])
    expectNote(inventory.notes, 'mcpServers', 'non-table')
    const malformed = new MemoryHost({ files: { [`${paths.home}/config.toml`]: '[not valid' } })
    const invalid = await readGrokCapabilities(malformed, id, paths)
    expectNote(invalid.notes, 'configuration', 'not valid TOML')
    await expect(readGrokCapabilities(host, id, paths, { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports unknown MCP transports and malformed configuration directories', async () => {
    const host = new MemoryHost({ files: {
      [`${paths.home}/config.toml`]: 'mcp_servers = { empty = { enabled = false }, array = [], sse = { type = "sse" }, http = { type = "http", url = "https://localhost/mcp" }, enabled = { enabled = true } }\n',
    } })
    const inventory = await readGrokCapabilities(host, id, paths)
    expect(inventory.mcpServers).toEqual([
      { name: 'empty', transport: 'unknown', enabled: false, source: 'user' },
      { name: 'sse', transport: 'sse', enabled: true, source: 'user' },
      { name: 'http', transport: 'http', url: 'https://localhost', enabled: true, source: 'user' },
      { name: 'enabled', transport: 'unknown', enabled: true, source: 'user' },
    ])
    expectNote(inventory.notes, 'mcpServers', 'non-table')

    const unreadable = new MemoryHost({ dirs: [`${paths.home}/config.toml`] })
    const blocked = await readGrokCapabilities(unreadable, id, paths)
    expect(blocked.notes).toContainEqual({ field: 'configuration', reason: 'expected a file but found a directory' })
  })

  it('delegates the adapter capability read through its resolved project paths', async () => {
    const host = new MemoryHost({ files: {
      [`${paths.home}/config.toml`]: '[mcp_servers.docs]\ncommand = "docs-mcp"\n',
    } })
    const adapter = grokAdapter(host, resolveGrokConfig({ homeDir: paths.home }))
    await expect(adapter.readCapabilities({ cwd: '/repo' })).resolves.toMatchObject({
      agentId: id,
      mcpServers: [{ name: 'docs', transport: 'stdio', command: 'docs-mcp', enabled: true, source: 'user' }],
    })
  })

  it('resolves the effective project MCP declaration and environment values only for activation', async () => {
    const host = new MemoryHost({ home: '/home/tester', env: { DOCS_TOKEN: 'sensitive-token' }, files: {
      [`${paths.home}/config.toml`]: '[mcp_servers.docs]\ncommand = "user-command"\n',
      '/repo/.grok/config.toml': [
        '[mcp_servers.docs]',
        'command = "npx"',
        'args = ["-y", "docs-mcp", "${DOCS_TOKEN}"]',
        'env = { DOCS_TOKEN = "${DOCS_TOKEN}" }',
        'cwd = "~/project"',
      ].join('\n'),
    } })
    await expect(resolveGrokMcpServer(host, paths, { serverName: 'docs', cwd: '/repo/src' })).resolves.toEqual({
      name: 'docs', source: 'project', transport: 'stdio', command: 'npx',
      args: ['-y', 'docs-mcp', 'sensitive-token'], env: { DOCS_TOKEN: 'sensitive-token' }, cwd: '/home/tester/project',
    })
    const inventory = await readGrokCapabilities(host, id, paths, { cwd: '/repo/src' })
    expect(JSON.stringify(inventory)).not.toContain('sensitive-token')
  })

  it('resolves native HTTP and typed stdio MCP declarations', async () => {
    const host = new MemoryHost({ env: {
      DOCS_URL: 'https://docs.example/mcp',
      DOCS_TOKEN: 'sensitive-token',
    }, files: {
      [`${paths.home}/config.toml`]: [
        '[mcp_servers.remote]',
        'type = "http"',
        'url = "${DOCS_URL}"',
        'headers = { "X-Docs-Token" = "${DOCS_TOKEN}" }',
        '',
        '[mcp_servers.local]',
        'type = "stdio"',
        'command = "docs-mcp"',
      ].join('\n'),
    } })
    await expect(resolveGrokMcpServer(host, paths, { serverName: 'remote', cwd: '/repo' })).resolves.toEqual({
      name: 'remote', source: 'user', transport: 'streamable-http',
      url: 'https://docs.example/mcp', headers: { 'X-Docs-Token': 'sensitive-token' },
    })
    await expect(resolveGrokMcpServer(host, paths, { serverName: 'local', cwd: '/repo' })).resolves.toEqual({
      name: 'local', source: 'user', transport: 'stdio', command: 'docs-mcp', args: [], env: {}, cwd: '/repo',
    })
  })

  it('rejects disabled, managed-auth, legacy, malformed, and unsupported MCP declarations', async () => {
    const cases = [
      { name: 'disabled', config: 'disabled_mcp_servers = ["docs"]\n[mcp_servers.docs]\ncommand = "docs-mcp"', message: 'is disabled' },
      { name: 'oauth', config: '[mcp_servers.docs]\noauth = true\ncommand = "docs-mcp"', message: 'uses managed authentication' },
      { name: 'legacy sse', config: '[mcp_servers.docs]\ntype = "sse"\nurl = "https://docs.example/events"', message: 'uses legacy SSE' },
      { name: 'unknown type', config: '[mcp_servers.docs]\ntype = "websocket"\ncommand = "docs-mcp"', message: 'names an unsupported MCP transport' },
      { name: 'command with http type', config: '[mcp_servers.docs]\ntype = "http"\ncommand = "docs-mcp"', message: 'must declare a supported stdio command or Streamable HTTP URL' },
      { name: 'url with stdio type', config: '[mcp_servers.docs]\ntype = "stdio"\nurl = "https://docs.example/mcp"', message: 'must declare a supported stdio command or Streamable HTTP URL' },
      { name: 'malformed type', config: '[mcp_servers.docs]\ntype = 3', message: 'type must be a non-empty string' },
      { name: 'non-table server', config: 'mcp_servers = { docs = [] }', message: 'must be an object' },
    ]

    for (const item of cases) {
      const host = new MemoryHost({ files: { [`${paths.home}/config.toml`]: item.config } })
      await expect(resolveGrokMcpServer(host, paths, { serverName: 'docs', cwd: '/repo' }), item.name)
        .rejects.toThrow(item.message)
    }

    const unreadable = new MemoryHost({ dirs: [`${paths.home}/config.toml`] })
    await expect(resolveGrokMcpServer(unreadable, paths, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('expected a file but found a directory')

    const unmatched = new MemoryHost({ files: { [`${paths.home}/config.toml`]: '[mcp_servers.other]\ncommand = "other"\n' } })
    await expect(resolveGrokMcpServer(unmatched, paths, { serverName: 'docs', cwd: '/repo' })).resolves.toBeUndefined()
  })

  it('rejects ambiguous transports, invalid enabled values, and missing environment references', async () => {
    const mixed = new MemoryHost({ files: {
      [`${paths.home}/config.toml`]: '[mcp_servers.docs]\ncommand = "docs-mcp"\nurl = "https://localhost/mcp"\n',
    } })
    await expect(resolveGrokMcpServer(mixed, paths, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('must declare only one MCP transport')

    const malformed = new MemoryHost({ files: {
      [`${paths.home}/config.toml`]: '[mcp_servers.docs]\nenabled = "false"\ncommand = "docs-mcp"\n',
    } })
    await expect(resolveGrokMcpServer(malformed, paths, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('enabled must be a boolean')

    const missing = new MemoryHost({ files: {
      [`${paths.home}/config.toml`]: '[mcp_servers.docs]\ncommand = "${MISSING_TOKEN}"\n',
    } })
    await expect(resolveGrokMcpServer(missing, paths, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('references unavailable environment variable "MISSING_TOKEN"')
  })
})

function expectNote(
  notes: readonly { readonly field: string; readonly reason: string }[],
  field: string,
  fragment: string,
): void {
  expect(notes.some(note => note.field === field && note.reason.includes(fragment))).toBe(true)
}
