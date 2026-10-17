import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId } from '@deepseek-ai/dsh-agent-mesh'
import { ompAdapter } from '../src/index.ts'
import { readOmpCapabilities, resolveOmpMcpServer } from '../src/capabilities.ts'
import type { OmpStoreLayout } from '../src/sessions.ts'
import { FakeHost } from './support/fake-host.ts'

const id = brandString<AgentId>('omp')
const layout: OmpStoreLayout = {
  agentDir: '/home/tester/.omp/agent', configRoot: '/home/tester/.omp',
  defaultSessionsRoot: '/home/tester/.omp/sessions', sessionsDirFromSetting: false, agentDirFromEnv: false,
  credentialPath: '/home/tester/.omp/agent/agent.db', settingsPath: '/home/tester/.omp/agent/config.yml',
  modelsPath: '/home/tester/.omp/agent/models.yml',
}

describe('OMP capability inventory', () => {
  it('reads native tools, skills, MCP, commands and instructions without importing modules', async () => {
    const host = new FakeHost({ home: '/home/tester' })
    host.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: { user: { command: 'user-mcp' } } }))
    host.addFile(`${layout.agentDir}/tools/custom.ts`, 'export default {}')
    host.addFile(`${layout.agentDir}/skills/user/SKILL.md`, '---\ndescription: User\n---\n')
    host.addFile(`${layout.agentDir}/commands/status.md`, '# Status')
    host.addFile(`${layout.agentDir}/AGENTS.md`, 'user rules')
    host.addFile('/repo/.omp/mcp.json', JSON.stringify({
      disabledServers: ['user'],
      mcpServers: { project: { type: 'http', url: 'https://localhost/mcp' } },
    }))
    host.addFile('/repo/.omp/tools/repo/index.ts', 'export default {}')
    host.addFile('/repo/.omp/skills/project/SKILL.md', '---\ndescription: Project\n---\n')
    host.addFile('/repo/.omp/commands/inspect.md', 'Inspect')
    host.addFile('/repo/.omp/rules/security.mdc', 'rules')
    host.addFile('/repo/AGENTS.md', 'project rules')

    const inventory = await readOmpCapabilities(host, id, layout, { cwd: '/repo/src' })
    expect(inventory.tools.map(tool => tool.name)).toContain('custom')
    expect(inventory.tools.find(tool => tool.name === 'repo')).toMatchObject({ source: 'project', path: '/repo/.omp/tools/repo/index.ts' })
    expect(inventory.mcpServers).toEqual([
      { name: 'project', transport: 'http', url: 'https://localhost', enabled: true, source: 'project' },
      { name: 'user', transport: 'stdio', command: 'user-mcp', enabled: false, source: 'user' },
    ])
    expect(inventory.skills.map(skill => skill.name)).toContain('project')
    expect(inventory.commands.map(command => command.name)).toEqual(['status', 'inspect'])
    expect(inventory.commands).toContainEqual({
      name: 'status', source: 'user', path: `${layout.agentDir}/commands/status.md`,
    })
    expect(inventory.commands).toContainEqual({
      name: 'inspect', source: 'project', path: '/repo/.omp/commands/inspect.md',
    })
    expect(inventory.contextFiles).toContain('/repo/AGENTS.md')
    expect(inventory.contextFiles).toContain('/repo/.omp/rules/security.mdc')
    expect(inventory.notes.some(note => note.field === 'tools')).toBe(true)
  })

  it('reports malformed user MCP and absent optional roots, and honors cancellation', async () => {
    const host = new FakeHost({ home: '/home/tester' })
    host.addFile(`${layout.agentDir}/mcp.json`, '{bad json')
    const inventory = await readOmpCapabilities(host, id, layout)
    expect(inventory.mcpServers).toEqual([])
    expectNote(inventory.notes, 'mcpServers', 'not valid JSON')
    expect(inventory.tools.some(tool => tool.name === 'read')).toBe(true)
    expect(inventory.sources.some(source => !source.present)).toBe(true)
    await expect(readOmpCapabilities(host, id, layout, { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('projects precedence, transports, disabled entries, and unsupported directory members', async () => {
    const host = new FakeHost({ home: '/home/tester' })
    host.addFile('/repo/.omp/mcp.json', JSON.stringify({
      disabledServers: ['priority', '', 5],
      mcpServers: {
        priority: { type: 'stdio', command: 'project-command' },
        sse: { type: 'sse', url: 'https://localhost/events' },
        http: { type: 'http', url: 'https://localhost/mcp' },
        command: { command: 'project-command' },
        url: { url: 'https://localhost/fallback' },
        unknown: {},
        disabled: { command: 'disabled-command', enabled: false },
        invalid: [],
      },
    }))
    host.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({
      disabledServers: ['priority', '', 9],
      mcpServers: { priority: { command: 'user-command' }, user: { command: 'user-mcp' } },
    }))
    host.addFile(`${layout.agentDir}/tools/plain.ts`, 'export default {}')
    host.addFile(`${layout.agentDir}/tools/ignored.d.ts`, 'export {}')
    host.addDirectory(`${layout.agentDir}/tools/empty`)
    host.addFile('/repo/.omp/tools/custom.js', 'export default {}')
    host.addDirectory('/repo/.omp/tools/without-index')
    host.addFile(`${layout.agentDir}/commands/status.md`, '# Status')
    host.addFile(`${layout.agentDir}/commands/ignored.txt`, 'not a command')
    host.addDirectory(`${layout.agentDir}/commands/nested`)
    host.addFile(`${layout.agentDir}/rules/notes.txt`, 'not context')
    host.addFile(`${layout.agentDir}/managed-skills/bundled/SKILL.md`, '---\ndescription: Managed\n---\n')
    host.addDirectory('/repo/.omp/RULES.md')

    const inventory = await readOmpCapabilities(host, id, layout, { cwd: '/repo/src' })
    expect(inventory.mcpServers).toEqual([
      { name: 'priority', transport: 'stdio', command: 'project-command', enabled: false, source: 'project' },
      { name: 'sse', transport: 'sse', url: 'https://localhost', enabled: true, source: 'project' },
      { name: 'http', transport: 'http', url: 'https://localhost', enabled: true, source: 'project' },
      { name: 'command', transport: 'stdio', command: 'project-command', enabled: true, source: 'project' },
      { name: 'url', transport: 'http', url: 'https://localhost', enabled: true, source: 'project' },
      { name: 'unknown', transport: 'unknown', enabled: true, source: 'project' },
      { name: 'disabled', transport: 'stdio', command: 'disabled-command', enabled: false, source: 'project' },
      { name: 'user', transport: 'stdio', command: 'user-mcp', enabled: true, source: 'user' },
    ])
    expect(inventory.tools).toContainEqual({ name: 'plain', source: 'config', discoverable: true, path: `${layout.agentDir}/tools/plain.ts` })
    expect(inventory.tools).toContainEqual({ name: 'custom', source: 'project', discoverable: true, path: '/repo/.omp/tools/custom.js' })
    expect(inventory.skills).toContainEqual({ name: 'bundled', source: 'bundled', path: `${layout.agentDir}/managed-skills/bundled/SKILL.md`, description: 'Managed' })
    expectNote(inventory.notes, 'mcpServers', 'non-object')
    expect(inventory.contextFiles).not.toContain(`${layout.agentDir}/rules/notes.txt`)
    expect(inventory.contextFiles).not.toContain('/repo/.omp/RULES.md')
  })

  it('reports unreadable MCP paths, skips project lookup at the home directory, and delegates adapter reads', async () => {
    const unreadable = new FakeHost({ home: '/home/tester' })
    unreadable.addDirectory(`${layout.agentDir}/mcp.json`)
    const blocked = await readOmpCapabilities(unreadable, id, layout)
    expect(blocked.notes).toContainEqual({ field: 'mcpServers', reason: 'expected a file but found a directory' })

    const host = new FakeHost({ home: '/home/tester' })
    const atHome = await readOmpCapabilities(host, id, layout, { cwd: '/home/tester' })
    expect(atHome.mcpServers).toEqual([])
    const adapter = ompAdapter(host, { homeDir: layout.configRoot })
    await expect(adapter.readCapabilities({ cwd: '/repo' })).resolves.toMatchObject({
      agentId: id,
      mcpServers: [],
      commands: [],
    })
  })

  it('skips empty project config directories and reports file paths used as optional roots', async () => {
    const host = new FakeHost({ home: '/home/tester' })
    host.addDirectory('/repo/.omp')
    host.addFile(`${layout.agentDir}/mcp.json`, '{}')
    host.addFile(`${layout.agentDir}/tools`, 'not a directory')
    host.addFile(`${layout.agentDir}/commands`, 'not a directory')
    host.addFile(`${layout.agentDir}/rules`, 'not a directory')

    const inventory = await readOmpCapabilities(host, id, layout, { cwd: '/repo/sub' })
    expect(inventory.mcpServers).toEqual([])
    expect(inventory.sources).toContainEqual({ path: `${layout.agentDir}/tools`, present: false, note: 'not a directory' })
    expect(inventory.sources).toContainEqual({ path: `${layout.agentDir}/commands`, present: false, note: 'not a directory' })
    expect(inventory.sources).toContainEqual({ path: `${layout.agentDir}/rules`, present: false, note: 'not a directory' })
  })

  it('resolves project MCP server values for activation without exposing environment secrets in inventory', async () => {
    const host = new FakeHost({ home: '/home/tester', env: { API_TOKEN: 'sensitive-token' } })
    host.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: {
      docs: { command: 'user-command' },
    } }))
    host.addFile('/repo/.omp/mcp.json', JSON.stringify({ mcpServers: {
      docs: { type: 'http', url: 'https://localhost/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' }, timeout: 2500 },
    } }))
    await expect(resolveOmpMcpServer(host, layout, { serverName: 'docs', cwd: '/repo/src' })).resolves.toEqual({
      name: 'docs', source: 'project', transport: 'streamable-http', url: 'https://localhost/mcp',
      headers: { Authorization: 'Bearer sensitive-token' }, toolCallTimeoutMs: 2500,
    })
    const inventory = await readOmpCapabilities(host, id, layout, { cwd: '/repo/src' })
    expect(JSON.stringify(inventory)).not.toContain('sensitive-token')
  })

  it('resolves stdio servers and honors OMP enabled overrides', async () => {
    const host = new FakeHost({ home: '/home/tester', env: { API_TOKEN: 'sensitive-token' } })
    host.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({
      enabledServers: ['docs'],
      mcpServers: {
        docs: {
          enabled: false,
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'docs-mcp'],
          env: { API_TOKEN: '${API_TOKEN}' },
          cwd: '~/tools',
          timeout: 0,
        },
      },
    }))
    await expect(resolveOmpMcpServer(host, layout, { serverName: 'docs', cwd: '/repo' })).resolves.toEqual({
      name: 'docs', source: 'user', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'],
      env: { API_TOKEN: 'sensitive-token' }, cwd: '/home/tester/tools', toolCallTimeoutMs: 0,
    })
  })

  it('uses user declarations when an empty project file does not override them', async () => {
    const host = new FakeHost({ home: '/home/tester' })
    host.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: { docs: { command: 'user-docs' } } }))
    host.addFile('/repo/.omp/mcp.json', '{}')
    await expect(resolveOmpMcpServer(host, layout, { serverName: 'docs', cwd: '/repo/src' })).resolves.toEqual({
      name: 'docs', source: 'user', transport: 'stdio', command: 'user-docs', args: [], env: {}, cwd: '/repo/src',
    })

    const noTimeoutHttp = new FakeHost({ home: '/home/tester' })
    noTimeoutHttp.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({
      mcpServers: { remote: { url: 'https://docs.example/mcp' } },
    }))
    await expect(resolveOmpMcpServer(noTimeoutHttp, layout, { serverName: 'remote', cwd: '/repo' })).resolves.toEqual({
      name: 'remote', source: 'user', transport: 'streamable-http', url: 'https://docs.example/mcp', headers: {},
    })
  })

  it('handles absent MCP files and project-only server declarations', async () => {
    const absent = new FakeHost({ home: '/home/tester' })
    await expect(resolveOmpMcpServer(absent, layout, { serverName: 'docs', cwd: '/repo' })).resolves.toBeUndefined()

    const empty = new FakeHost({ home: '/home/tester' })
    empty.addFile(`${layout.agentDir}/mcp.json`, '{}')
    await expect(resolveOmpMcpServer(empty, layout, { serverName: 'docs', cwd: '/repo' })).resolves.toBeUndefined()

    const other = new FakeHost({ home: '/home/tester' })
    other.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } } }))
    await expect(resolveOmpMcpServer(other, layout, { serverName: 'docs', cwd: '/repo' })).resolves.toBeUndefined()

    const projectOnly = new FakeHost({ home: '/home/tester' })
    projectOnly.addFile('/repo/.omp/mcp.json', JSON.stringify({ mcpServers: { docs: { command: 'project-docs' } } }))
    await expect(resolveOmpMcpServer(projectOnly, layout, { serverName: 'docs', cwd: '/repo/src' })).resolves.toEqual({
      name: 'docs', source: 'project', transport: 'stdio', command: 'project-docs', args: [], env: {}, cwd: '/repo/src',
    })
  })

  it('rejects mixed transports, malformed enabled values, and disabled declarations', async () => {
    const mixed = new FakeHost({ home: '/home/tester' })
    mixed.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: {
      docs: { command: 'docs-mcp', url: 'https://localhost/mcp' },
    } }))
    await expect(resolveOmpMcpServer(mixed, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('must declare only one MCP transport')

    const malformed = new FakeHost({ home: '/home/tester' })
    malformed.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: {
      docs: { enabled: 'false', command: 'docs-mcp' },
    } }))
    await expect(resolveOmpMcpServer(malformed, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('enabled must be a boolean')

    const disabled = new FakeHost({ home: '/home/tester' })
    disabled.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({
      disabledServers: ['docs'], mcpServers: { docs: { command: 'docs-mcp' } },
    }))
    await expect(resolveOmpMcpServer(disabled, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('disabled in the active OMP profile')
  })

  it('rejects malformed, disabled, managed-auth, and unsupported MCP entries', async () => {
    const cases = [
      { name: 'managed auth', entry: { auth: 'oauth', command: 'docs-mcp' }, message: 'uses managed authentication' },
      { name: 'legacy SSE', entry: { type: 'sse', url: 'https://docs.example/events' }, message: 'uses legacy SSE' },
      { name: 'unknown type', entry: { type: 'websocket', command: 'docs-mcp' }, message: 'names an unsupported MCP transport' },
      { name: 'stdio type with URL', entry: { type: 'stdio', url: 'https://docs.example/mcp' }, message: 'must declare a supported stdio command or Streamable HTTP URL' },
      { name: 'HTTP type with command', entry: { type: 'http', command: 'docs-mcp' }, message: 'must declare a supported stdio command or Streamable HTTP URL' },
      { name: 'invalid command', entry: { command: 3 }, message: 'command must be a non-empty string' },
      { name: 'invalid type', entry: { type: 3, command: 'docs-mcp' }, message: 'type must be a non-empty string' },
      { name: 'disabled entry', entry: { enabled: false, command: 'docs-mcp' }, message: 'disabled in the effective OMP configuration' },
      { name: 'invalid timeout', entry: { command: 'docs-mcp', timeout: -1 }, message: 'timeout must be a non-negative finite millisecond value' },
      { name: 'malformed timeout', entry: { command: 'docs-mcp', timeout: Number.NaN }, message: 'timeout must be a non-negative finite millisecond value' },
      { name: 'unsupported transport', entry: { enabled: true }, message: 'must declare a supported stdio command or Streamable HTTP URL' },
    ]
    for (const item of cases) {
      const host = new FakeHost({ home: '/home/tester' })
      host.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: { docs: item.entry } }))
      await expect(resolveOmpMcpServer(host, layout, { serverName: 'docs', cwd: '/repo' }), item.name)
        .rejects.toThrow(item.message)
    }

    const malformedJson = new FakeHost({ home: '/home/tester' })
    malformedJson.addFile(`${layout.agentDir}/mcp.json`, '{bad json')
    await expect(resolveOmpMcpServer(malformedJson, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('is not valid JSON')

    const unreadable = new FakeHost({ home: '/home/tester' })
    unreadable.addDirectory(`${layout.agentDir}/mcp.json`)
    await expect(resolveOmpMcpServer(unreadable, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('expected a file but found a directory')

    const nonObject = new FakeHost({ home: '/home/tester' })
    nonObject.addFile(`${layout.agentDir}/mcp.json`, '[]')
    await expect(resolveOmpMcpServer(nonObject, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('must be an object')

    const nonObjectServers = new FakeHost({ home: '/home/tester' })
    nonObjectServers.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: [] }))
    await expect(resolveOmpMcpServer(nonObjectServers, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('mcpServers must be an object')

    const nonObjectEntry = new FakeHost({ home: '/home/tester' })
    nonObjectEntry.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: { docs: [] } }))
    await expect(resolveOmpMcpServer(nonObjectEntry, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('mcpServers.docs must be an object')
  })

  it('skips a `.omp` file when searching for the nearest project configuration', async () => {
    const host = new FakeHost({ home: '/home/tester' })
    host.addFile('/repo/.omp', 'not a directory')
    host.addFile(`${layout.agentDir}/mcp.json`, JSON.stringify({ mcpServers: { docs: { command: 'user-docs' } } }))
    await expect(resolveOmpMcpServer(host, layout, { serverName: 'docs', cwd: '/repo/src' })).resolves.toMatchObject({
      source: 'user', command: 'user-docs',
    })
  })
})

function expectNote(
  notes: readonly { readonly field: string; readonly reason: string }[],
  field: string,
  fragment: string,
): void {
  expect(notes.some(note => note.field === field && note.reason.includes(fragment))).toBe(true)
}
