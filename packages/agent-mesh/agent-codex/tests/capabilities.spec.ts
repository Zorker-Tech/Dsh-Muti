import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId } from '@deepseek-ai/dsh-agent-mesh'
import { codexAdapter } from '../src/index.ts'
import { readCodexCapabilities, resolveCodexMcpServer } from '../src/capabilities.ts'
import type { CodexHome } from '../src/sessions.ts'
import { FakeHost } from './fake-host.ts'

const id = brandString<AgentId>('codex')
const home: CodexHome = {
  path: '/home/tester/.codex', sessionsRoot: '/home/tester/.codex/sessions',
  archivedRoot: '/home/tester/.codex/archived_sessions', indexFile: '/home/tester/.codex/session_index.jsonl',
  credentialFile: '/home/tester/.codex/auth.json', fromEnv: false,
}

describe('Codex capability inventory', () => {
  it('projects config layers, skill roots, custom prompts, and instruction files', async () => {
    const host = new FakeHost()
    host.addFile(`${home.path}/config.toml`, '[mcp_servers.docs]\ncommand = "docs-mcp"\n')
    host.addFile('/repo/.codex/config.toml', [
      '[mcp_servers.docs]', 'enabled = false', '[mcp_servers.local]', 'url = "https://localhost/mcp"',
      '[mcp_servers.private]', 'url = "https://user:password@api.example/private/path?token=private-secret"',
    ].join('\n'))
    host.addFile(`${home.path}/skills/review/SKILL.md`, '---\ndescription: Review code\nuser-invocable: true\n---\n')
    host.addFile('/repo/.agents/skills/test/SKILL.md', '---\ndescription: Test\n---\n')
    host.addFile(`${home.path}/prompts/review.md`, '---\ndescription: Review prompt\n---\nbody')
    host.addFile(`${home.path}/AGENTS.md`, 'home')
    host.addFile('/AGENTS.override.md', 'root override')
    host.addFile('/repo/AGENTS.md', 'project')

    const inventory = await readCodexCapabilities(host, id, home, { cwd: '/repo' })
    expect(inventory.tools).toEqual([])
    expect(inventory.mcpServers).toEqual([
      { name: 'docs', transport: 'stdio', command: 'docs-mcp', enabled: false, source: 'project' },
      { name: 'local', transport: 'http', url: 'https://localhost', enabled: true, source: 'project' },
      { name: 'private', transport: 'http', url: 'https://api.example', enabled: true, source: 'project' },
    ])
    expect(inventory.skills.map(skill => skill.name).sort()).toEqual(['review', 'test'])
    expect(inventory.commands).toEqual([{
      name: 'review', source: 'user', path: `${home.path}/prompts/review.md`, description: 'Review prompt',
    }])
    expect(inventory.contextFiles).toEqual([
      `${home.path}/AGENTS.md`, '/repo/AGENTS.md', '/AGENTS.override.md',
    ])
    expectNote(inventory.notes, 'tools', 'not exposed')
    expect(JSON.stringify(inventory)).not.toContain('password')
    expect(JSON.stringify(inventory)).not.toContain('private-secret')
    expect(JSON.stringify(inventory)).not.toContain('/private/path')
  })

  it('reports malformed and non-table sources without losing other declarations', async () => {
    const host = new FakeHost()
    host.addFile(`${home.path}/config.toml`, '[mcp_servers]\nbad = "string"\n')
    host.addFile('/repo/.codex/config.toml', '[not-valid')
    host.addFile(`${home.path}/prompts`, 'not a directory')
    const inventory = await readCodexCapabilities(host, id, home, { cwd: '/repo' })
    expect(inventory.mcpServers).toEqual([])
    expectNote(inventory.notes, 'mcpServers', 'non-table')
    expectNote(inventory.notes, 'configuration', 'not valid TOML')
    expect(inventory.sources).toContainEqual({ path: `${home.path}/prompts`, present: false, note: 'not a directory' })
    expect(inventory.sources.some(source => source.path.endsWith('skills') && !source.present)).toBe(true)
  })

  it('handles absent project scope, unreadable configuration, and unknown MCP declarations', async () => {
    const host = new FakeHost()
    host.addFile(`${home.path}/config.toml`, 'mcp_servers = { empty = { enabled = false }, invalid = [] }\n')
    host.addFile(`${home.path}/prompts`, 'not a directory')
    const inventory = await readCodexCapabilities(host, id, home)
    expect(inventory.mcpServers).toEqual([
      { name: 'empty', transport: 'unknown', enabled: false, source: 'user' },
    ])
    expectNote(inventory.notes, 'mcpServers', 'non-table')
    expect(inventory.sources).toContainEqual({ path: `${home.path}/prompts`, present: false, note: 'not a directory' })

    const unreadable = new FakeHost()
    unreadable.addDir(`${home.path}/config.toml`)
    const blocked = await readCodexCapabilities(unreadable, id, home)
    expect(blocked.notes).toContainEqual({ field: 'configuration', reason: 'expected a file but found a directory' })
    expect(blocked.commands).toEqual([])
  })

  it('lists prompt files without assuming frontmatter or reading oversized entries', async () => {
    const host = new FakeHost()
    host.addFile(`${home.path}/config.toml`, '[mcp_servers.enabled]\nenabled = true\n')
    host.addFile(`${home.path}/prompts/plain.md`, 'No metadata')
    host.addFile(`${home.path}/prompts/quoted.md`, '---\ndescription: "Quoted prompt"\n---\n')
    host.addFile(`${home.path}/prompts/oversized.md`, 'x'.repeat(1024 * 1024 + 1))
    host.addFile(`${home.path}/prompts/ignored.txt`, 'not a prompt')
    host.addFile(`${home.path}/prompts/nested/inside.md`, 'nested prompt')

    const inventory = await readCodexCapabilities(host, id, home)
    expect(inventory.mcpServers).toEqual([
      { name: 'enabled', transport: 'unknown', enabled: true, source: 'user' },
    ])
    expect(inventory.commands).toEqual([
      { name: 'plain', source: 'user', path: `${home.path}/prompts/plain.md` },
      { name: 'quoted', source: 'user', path: `${home.path}/prompts/quoted.md`, description: 'Quoted prompt' },
    ])
  })

  it('delegates the adapter capability read with its resolved home and project request', async () => {
    const host = new FakeHost()
    host.addFile(`${home.path}/config.toml`, '[mcp_servers.docs]\ncommand = "docs-mcp"\n')
    const adapter = codexAdapter(host, { homeDir: home.path })
    await expect(adapter.readCapabilities({ cwd: '/repo' })).resolves.toMatchObject({
      agentId: id,
      mcpServers: [{ name: 'docs', transport: 'stdio', command: 'docs-mcp', enabled: true, source: 'user' }],
    })
  })

  it('propagates cancellation before reading project configuration', async () => {
    await expect(readCodexCapabilities(new FakeHost(), id, home, { cwd: '/repo', signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('resolves native MCP values only for activation and keeps environment values out of inventory', async () => {
    const host = new FakeHost()
    host.env['DOCS_TOKEN'] = 'sensitive-token'
    host.addFile(`${home.path}/config.toml`, [
      '[mcp_servers.docs]',
      'command = "npx"',
      'args = ["-y", "docs-mcp", "--token", "literal-secret"]',
      'env_vars = ["DOCS_TOKEN"]',
      'cwd = "~/project"',
      'tool_timeout_sec = 2',
    ].join('\n'))

    await expect(resolveCodexMcpServer(host, home, { serverName: 'docs', cwd: '/repo' })).resolves.toEqual({
      name: 'docs', source: 'user', transport: 'stdio', command: 'npx',
      args: ['-y', 'docs-mcp', '--token', 'literal-secret'], env: { DOCS_TOKEN: 'sensitive-token' },
      cwd: '/home/tester/project', toolCallTimeoutMs: 2000,
    })
    const inventory = await readCodexCapabilities(host, id, home)
    expect(JSON.stringify(inventory)).not.toContain('sensitive-token')
    expect(JSON.stringify(inventory)).not.toContain('literal-secret')
  })

  it('resolves project overrides and Streamable HTTP declarations only for activation', async () => {
    const host = new FakeHost()
    host.env['DOCS_TOKEN'] = 'header-token'
    host.env['DOCS_BEARER'] = 'bearer-token'
    host.addFile(`${home.path}/config.toml`, '[mcp_servers.docs]\ncommand = "user-docs"\n')
    host.addFile('/repo/.codex/config.toml', [
      '[mcp_servers.docs]',
      'command = "project-docs"',
      'tool_timeout_sec = 1.25',
    ].join('\n'))

    await expect(resolveCodexMcpServer(host, home, { serverName: 'docs', cwd: '/repo' })).resolves.toMatchObject({
      name: 'docs', source: 'project', transport: 'stdio', command: 'project-docs', toolCallTimeoutMs: 1250,
    })

    const http = new FakeHost()
    http.env['DOCS_TOKEN'] = 'header-token'
    http.env['DOCS_BEARER'] = 'bearer-token'
    http.addFile(`${home.path}/config.toml`, [
      '[mcp_servers.remote]',
      'url = "https://docs.example/mcp?token=private"',
      'env_http_headers = { "X-Docs-Token" = "DOCS_TOKEN" }',
      'bearer_token_env_var = "DOCS_BEARER"',
      'tool_timeout_sec = 2',
    ].join('\n'))
    await expect(resolveCodexMcpServer(http, home, { serverName: 'remote', cwd: '/repo' })).resolves.toEqual({
      name: 'remote', source: 'user', transport: 'streamable-http',
      url: 'https://docs.example/mcp?token=private',
      headers: { 'X-Docs-Token': 'header-token', Authorization: 'Bearer bearer-token' },
      toolCallTimeoutMs: 2000,
    })

    const plainHttp = new FakeHost()
    plainHttp.addFile(`${home.path}/config.toml`, '[mcp_servers.remote]\nurl = "https://docs.example/mcp"\n')
    await expect(resolveCodexMcpServer(plainHttp, home, { serverName: 'remote', cwd: '/repo' })).resolves.toEqual({
      name: 'remote', source: 'user', transport: 'streamable-http', url: 'https://docs.example/mcp', headers: {},
    })

    const missingStdioEnvironment = new FakeHost()
    missingStdioEnvironment.addFile(`${home.path}/config.toml`, '[mcp_servers.docs]\ncommand = "docs-mcp"\nenv_vars = ["NOT_SET"]\n')
    await expect(resolveCodexMcpServer(missingStdioEnvironment, home, { serverName: 'docs', cwd: '/repo' }))
      .resolves.toMatchObject({ transport: 'stdio', env: {} })
  })

  it('rejects unusable native MCP declarations before activation', async () => {
    const cases = [
      { name: 'disabled', entry: 'enabled = false\ncommand = "docs-mcp"', message: 'is disabled' },
      { name: 'oauth', entry: 'oauth = true\ncommand = "docs-mcp"', message: 'uses OAuth' },
      { name: 'bad command', entry: 'command = 3', message: 'command must be a non-empty string' },
      { name: 'bad env name', entry: 'command = "docs-mcp"\nenv_vars = ["BAD-NAME"]', message: 'env_vars contains an invalid name' },
      { name: 'bad timeout', entry: 'command = "docs-mcp"\ntool_timeout_sec = 0', message: 'tool_timeout_sec must be a positive finite value' },
      { name: 'missing header env', entry: 'url = "https://docs.example/mcp"\nenv_http_headers = { "X-Token" = "MISSING_TOKEN" }', message: 'references unavailable environment variable "MISSING_TOKEN"' },
      { name: 'missing bearer env', entry: 'url = "https://docs.example/mcp"\nbearer_token_env_var = "MISSING_TOKEN"', message: 'references unavailable environment variable "MISSING_TOKEN"' },
      { name: 'bad header env reference', entry: 'url = "https://docs.example/mcp"\nenv_http_headers = { "X-Token" = "BAD-NAME" }', message: 'env_http_headers contains an invalid environment reference' },
      { name: 'unsupported transport', entry: 'enabled = true', message: 'must declare a supported stdio command or Streamable HTTP URL' },
    ]

    for (const item of cases) {
      const host = new FakeHost()
      host.addFile(`${home.path}/config.toml`, `[mcp_servers.docs]\n${item.entry}\n`)
      await expect(resolveCodexMcpServer(host, home, { serverName: 'docs', cwd: '/repo' }), item.name)
        .rejects.toThrow(item.message)
    }
  })

  it('reports unreadable configuration and leaves unmatched MCP declarations unresolved', async () => {
    const unreadable = new FakeHost()
    unreadable.addDir(`${home.path}/config.toml`)
    await expect(resolveCodexMcpServer(unreadable, home, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('expected a file but found a directory')

    const otherServer = new FakeHost()
    otherServer.addFile(`${home.path}/config.toml`, '[mcp_servers.other]\ncommand = "other-mcp"\n')
    await expect(resolveCodexMcpServer(otherServer, home, { serverName: 'docs', cwd: '/repo' }))
      .resolves.toBeUndefined()
  })

  it('rejects ambiguous transports and malformed enabled values before approval', async () => {
    const mixed = new FakeHost()
    mixed.addFile(`${home.path}/config.toml`, '[mcp_servers.docs]\ncommand = "docs-mcp"\nurl = "https://localhost/mcp"\n')
    await expect(resolveCodexMcpServer(mixed, home, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('must declare only one MCP transport')

    const malformed = new FakeHost()
    malformed.addFile(`${home.path}/config.toml`, '[mcp_servers.docs]\nenabled = "false"\ncommand = "docs-mcp"\n')
    await expect(resolveCodexMcpServer(malformed, home, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('enabled must be a boolean')
  })
})

function expectNote(
  notes: readonly { readonly field: string; readonly reason: string }[],
  field: string,
  fragment: string,
): void {
  expect(notes.some(note => note.field === field && note.reason.includes(fragment))).toBe(true)
}
