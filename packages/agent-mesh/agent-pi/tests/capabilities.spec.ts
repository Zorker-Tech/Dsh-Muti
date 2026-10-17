import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId } from '@deepseek-ai/dsh-agent-mesh'
import { createPiAdapter } from '../src/index.ts'
import { readPiCapabilities, resolvePiMcpServer } from '../src/capabilities.ts'
import type { PiStoreLayout } from '../src/sessions.ts'
import { createFakeHost } from './host.ts'

const id = brandString<AgentId>('pi')
const layout: PiStoreLayout = {
  agentDir: '/home/tester/.pi/agent', defaultSessionsRoot: '/home/tester/.pi/agent/sessions',
  credentialPath: '/home/tester/.pi/agent/auth.json', settingsPath: '/home/tester/.pi/agent/settings.json',
  modelsPath: '/home/tester/.pi/agent/models.json',
}

describe('Pi capability inventory', () => {
  it('reads configured MCP, skills, prompt commands, and instructions', async () => {
    const host = createFakeHost({ home: '/home/tester', files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ mcpServers: {
        docs: { command: 'docs-mcp' }, remote: { url: 'https://localhost/mcp', enabled: false },
      } }),
      '/repo/.pi/mcp.json': JSON.stringify({
        disabledServers: ['remote'],
        mcpServers: {
          docs: { enabled: true, exposure: 'workspace', toolExposure: 'read', ignored: 'not projected' },
          project: { type: 'sse', url: 'https://localhost/events' },
        },
      }),
      [`${layout.agentDir}/prompts/review.md`]: '# Review changes\nUse tests',
      [`${layout.agentDir}/skills/review/SKILL.md`]: '---\ndescription: Review\n---\n',
      [`${layout.agentDir}/SYSTEM.md`]: 'system',
      '/repo/.pi/skills/build/SKILL.md': '---\nuser-invocable: true\n---\n',
      '/repo/AGENTS.md': 'project',
    } })
    const inventory = await readPiCapabilities(host, id, layout, { cwd: '/repo' })
    expect(inventory.tools.map(tool => tool.name)).toContain('read')
    expect(inventory.mcpServers).toEqual([
      { name: 'docs', transport: 'stdio', command: 'docs-mcp', enabled: true, source: 'project' },
      { name: 'remote', transport: 'http', url: 'https://localhost', enabled: false, source: 'config' },
      { name: 'project', transport: 'sse', url: 'https://localhost', enabled: true, source: 'project' },
    ])
    expect(inventory.skills.map(skill => skill.name).sort()).toEqual(['build', 'review'])
    expect(inventory.commands).toEqual([{
      name: 'review', source: 'user', path: `${layout.agentDir}/prompts/review.md`, description: 'Review changes',
    }])
    expect(inventory.contextFiles).toContain(`${layout.agentDir}/SYSTEM.md`)
    expect(inventory.contextFiles).toContain('/repo/AGENTS.md')
  })

  it('reports malformed files and missing roots without guessing', async () => {
    const host = createFakeHost({ files: {
      [`${layout.agentDir}/mcp.json`]: '{bad json',
      [`${layout.agentDir}/prompts`]: 'file instead of directory',
    } })
    const inventory = await readPiCapabilities(host, id, layout)
    expect(inventory.mcpServers).toEqual([])
    expectNote(inventory.notes, 'mcpServers', 'not valid JSON')
    expect(inventory.sources).toContainEqual({ path: `${layout.agentDir}/prompts`, present: false, note: 'not a directory' })
    await expect(readPiCapabilities(host, id, layout, { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' })

    const malformedDisabled = createFakeHost({ home: '/home/tester', files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ disabledServers: 'docs', mcpServers: { docs: { command: 'docs-mcp' } } }),
    } })
    const disabledInventory = await readPiCapabilities(malformedDisabled, id, layout)
    expectNote(disabledInventory.notes, 'mcpServers', 'disabledServers must be an array')
  })

  it('keeps sparse MCP and prompt declarations visible without inventing metadata', async () => {
    const host = createFakeHost({ home: '/home/tester', files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ mcpServers: {
        empty: {}, disabled: { enabled: false }, invalid: [],
      } }),
      [`${layout.agentDir}/prompts/empty.md`]: '',
      [`${layout.agentDir}/prompts/ignored.txt`]: 'not a command',
      [`${layout.agentDir}/prompts/oversized.md`]: 'x'.repeat(1024 * 1024 + 1),
    }, dirs: [`${layout.agentDir}/SYSTEM.md`, `${layout.agentDir}/prompts/subdir`] })
    const inventory = await readPiCapabilities(host, id, layout)
    expect(inventory.mcpServers).toEqual([
      { name: 'empty', transport: 'unknown', enabled: true, source: 'config' },
      { name: 'disabled', transport: 'unknown', enabled: false, source: 'config' },
    ])
    expect(inventory.commands).toEqual([{ name: 'empty', source: 'user', path: `${layout.agentDir}/prompts/empty.md` }])
    expectNote(inventory.notes, 'mcpServers', 'non-object')
    expect(inventory.contextFiles).not.toContain(`${layout.agentDir}/SYSTEM.md`)

    const nonObject = createFakeHost({ home: '/home/tester', files: { [`${layout.agentDir}/mcp.json`]: '[]' } })
    await expect(readPiCapabilities(nonObject, id, layout)).resolves.toMatchObject({ mcpServers: [] })
  })

  it('delegates the adapter capability read with a resolved store layout', async () => {
    const host = createFakeHost({ home: '/home/tester', files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }),
    } })
    const adapter = createPiAdapter(host, { homeDir: layout.agentDir })
    await expect(adapter.readCapabilities({ cwd: '/repo' })).resolves.toMatchObject({
      agentId: id,
      mcpServers: [{ name: 'docs', transport: 'stdio', command: 'docs-mcp', enabled: true, source: 'config' }],
    })
  })

  it('treats an absent MCP file as an undisclosed optional source', async () => {
    const inventory = await readPiCapabilities(createFakeHost({ home: '/home/tester' }), id, layout)
    expect(inventory.mcpServers).toEqual([])
    expect(inventory.notes).not.toContainEqual(expect.objectContaining({ field: 'mcpServers' }))
    expect(inventory.sources).toContainEqual({ path: `${layout.agentDir}/mcp.json`, present: false, note: 'not present' })

    const unreadable = await readPiCapabilities(createFakeHost({ dirs: [`${layout.agentDir}/mcp.json`] }), id, layout)
    expect(unreadable.notes).toContainEqual({ field: 'mcpServers', reason: 'expected a file but found a directory' })
  })

  it('resolves native MCP headers and timeouts without exposing them in the inventory', async () => {
    const host = createFakeHost({ home: '/home/tester', env: { API_TOKEN: 'sensitive-token' }, files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ mcpServers: {
        docs: { type: 'http', url: 'https://localhost/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' }, timeout: 4 },
        streamable: { type: 'streamable-http', url: 'https://localhost/streamable' },
      } }),
    } })
    await expect(resolvePiMcpServer(host, layout, { serverName: 'docs', cwd: '/repo' })).resolves.toEqual({
      name: 'docs', source: 'user', transport: 'streamable-http', url: 'https://localhost/mcp',
      headers: { Authorization: 'Bearer sensitive-token' }, toolCallTimeoutMs: 4000,
    })
    await expect(resolvePiMcpServer(host, layout, { serverName: 'streamable', cwd: '/repo' })).resolves.toEqual({
      name: 'streamable', source: 'user', transport: 'streamable-http', url: 'https://localhost/streamable', headers: {},
    })
    const inventory = await readPiCapabilities(host, id, layout)
    expect(JSON.stringify(inventory)).not.toContain('sensitive-token')
  })

  it('applies project disable declarations and rejects mixed transports or malformed enabled values', async () => {
    const disabled = createFakeHost({ home: '/home/tester', files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }),
      '/repo/.pi/mcp.json': JSON.stringify({ disabledServers: ['docs'] }),
    } })
    await expect(resolvePiMcpServer(disabled, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('disabled in the effective Pi configuration')

    const mixed = createFakeHost({ home: '/home/tester', files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ mcpServers: {
        docs: { command: 'docs-mcp', url: 'https://localhost/mcp' },
      } }),
    } })
    await expect(resolvePiMcpServer(mixed, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('must declare only one MCP transport')

    const malformed = createFakeHost({ home: '/home/tester', files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ mcpServers: { docs: { enabled: 'false', command: 'docs-mcp' } } }),
    } })
    await expect(resolvePiMcpServer(malformed, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('enabled must be a boolean')
  })

  it('resolves stdio values, expands home prefixes, and applies project metadata overrides', async () => {
    const host = createFakeHost({ home: '/home/tester', env: { API_TOKEN: 'sensitive-token' }, files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ disabledServers: ['other'], mcpServers: {
        typed: { type: 'stdio', command: '~/bin/docs', args: ['~/docs.json'], cwd: '~/project', env: { API_TOKEN: '${API_TOKEN}' }, timeout: 2 },
        implicit: { command: 'docs-mcp' },
      } }),
      '/repo/.pi/mcp.json': JSON.stringify({ mcpServers: {
        typed: { enabled: true, exposure: 'project', toolExposure: 'read', ignored: 'not projected' },
      } }),
    } })
    await expect(resolvePiMcpServer(host, layout, { serverName: 'typed', cwd: '/repo' })).resolves.toEqual({
      name: 'typed', source: 'project', transport: 'stdio', command: '/home/tester/bin/docs',
      args: ['/home/tester/docs.json'], env: { API_TOKEN: 'sensitive-token' }, cwd: '/home/tester/project',
      toolCallTimeoutMs: 2000,
    })
    await expect(resolvePiMcpServer(host, layout, { serverName: 'implicit', cwd: '/repo' })).resolves.toEqual({
      name: 'implicit', source: 'user', transport: 'stdio', command: 'docs-mcp', args: [], env: {}, cwd: '/repo',
    })
  })

  it('handles missing layers and rejects malformed native MCP entries before activation', async () => {
    const absent = createFakeHost({ home: '/home/tester' })
    await expect(resolvePiMcpServer(absent, layout, { serverName: 'docs', cwd: '/repo' })).resolves.toBeUndefined()

    const unmatched = createFakeHost({ home: '/home/tester', files: {
      [`${layout.agentDir}/mcp.json`]: JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
    } })
    await expect(resolvePiMcpServer(unmatched, layout, { serverName: 'docs', cwd: '/repo' })).resolves.toBeUndefined()

    const userUnreadable = createFakeHost({ home: '/home/tester', dirs: [`${layout.agentDir}/mcp.json`] })
    await expect(resolvePiMcpServer(userUnreadable, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('expected a file but found a directory')

    const projectUnreadable = createFakeHost({ home: '/home/tester', dirs: ['/repo/.pi/mcp.json'] })
    await expect(resolvePiMcpServer(projectUnreadable, layout, { serverName: 'docs', cwd: '/repo' }))
      .rejects.toThrow('expected a file but found a directory')

    const projectOnly = createFakeHost({ home: '/home/tester', files: {
      '/repo/.pi/mcp.json': JSON.stringify({ mcpServers: { docs: { command: 'project-docs' } } }),
    } })
    await expect(resolvePiMcpServer(projectOnly, layout, { serverName: 'docs', cwd: '/repo' })).resolves.toMatchObject({
      source: 'project', command: 'project-docs',
    })

    const invalid = [
      { entry: { oauth: true, command: 'docs-mcp' }, message: 'uses managed authentication' },
      { entry: { type: 'sse', url: 'https://docs.example/events' }, message: 'uses legacy SSE' },
      { entry: { type: 'websocket', command: 'docs-mcp' }, message: 'names an unsupported MCP transport' },
      { entry: { type: 3, command: 'docs-mcp' }, message: 'type must be a non-empty string' },
      { entry: { enabled: false, command: 'docs-mcp' }, message: 'disabled in the effective Pi configuration' },
      { entry: { command: 'docs-mcp', env: [] }, message: 'env must be an object' },
      { entry: { url: 'https://docs.example/mcp', headers: [] }, message: 'headers must be an object' },
      { entry: { command: 'docs-mcp', timeout: 0 }, message: 'timeout must be a positive finite number of seconds' },
      { entry: { type: 'stdio', url: 'https://docs.example/mcp' }, message: 'must declare a supported stdio command or Streamable HTTP URL' },
      { entry: { enabled: true }, message: 'must declare a supported stdio command or Streamable HTTP URL' },
    ]
    for (const item of invalid) {
      const host = createFakeHost({ home: '/home/tester', files: {
        [`${layout.agentDir}/mcp.json`]: JSON.stringify({ mcpServers: { docs: item.entry } }),
      } })
      await expect(resolvePiMcpServer(host, layout, { serverName: 'docs', cwd: '/repo' }), item.message)
        .rejects.toThrow(item.message)
    }

    for (const content of ['{bad json', '[]', JSON.stringify({ mcpServers: [] }), JSON.stringify({ mcpServers: { docs: [] } })]) {
      const host = createFakeHost({ home: '/home/tester', files: { [`${layout.agentDir}/mcp.json`]: content } })
      await expect(resolvePiMcpServer(host, layout, { serverName: 'docs', cwd: '/repo' })).rejects.toThrow()
    }
  })
})

function expectNote(
  notes: readonly { readonly field: string; readonly reason: string }[],
  field: string,
  fragment: string,
): void {
  expect(notes.some(note => note.field === field && note.reason.includes(fragment))).toBe(true)
}
