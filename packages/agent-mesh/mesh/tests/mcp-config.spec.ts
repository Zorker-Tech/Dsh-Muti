import { describe, expect, it } from 'vitest'
import {
  expandMcpEnvValue,
  mcpEndpointSummary,
  mcpExecutableSummary,
  mcpOptionalBoolean,
  mcpRecord,
  mcpRequiredString,
  mcpStringArray,
  mcpStringRecord,
  rejectMixedMcpTransports,
  resolveMcpCwd,
  resolveMcpEnv,
  resolveMcpHeaders,
  resolveMcpUrl,
} from '../src/mcp-config.ts'

describe('native MCP config readers', () => {
  it('narrows records, required strings, string arrays, and string maps', () => {
    expect(mcpRecord({ name: 'docs' }, 'server')).toEqual({ name: 'docs' })
    for (const invalid of [null, [], 'server']) {
      expect(() => mcpRecord(invalid, 'server')).toThrow('server must be an object')
    }

    expect(mcpRequiredString({ command: '  node  ' }, 'command', 'server')).toBe('node')
    for (const invalid of [undefined, '', '   ', 3]) {
      expect(() => mcpRequiredString({ command: invalid }, 'command', 'server'))
        .toThrow('server.command must be a non-empty string')
    }

    expect(mcpStringArray({}, 'args', 'server')).toEqual([])
    const originalArgs = ['--stdio']
    const args = mcpStringArray({ args: originalArgs }, 'args', 'server')
    expect(args).toEqual(['--stdio'])
    expect(args).not.toBe(originalArgs)
    for (const invalid of ['--stdio', [1]]) {
      expect(() => mcpStringArray({ args: invalid }, 'args', 'server'))
        .toThrow('server.args must be an array of strings')
    }

    const absent = mcpStringRecord(undefined, 'env')
    expect(Object.getPrototypeOf(absent)).toBeNull()
    expect(mcpStringRecord({ DOCS_TOKEN: 'secret' }, 'env')).toEqual({ DOCS_TOKEN: 'secret' })
    for (const invalid of [null, [], 'env']) {
      expect(() => mcpStringRecord(invalid, 'env')).toThrow('env must be an object')
    }
    expect(() => mcpStringRecord({ DOCS_TOKEN: 1 }, 'env')).toThrow('env must contain only string values')
  })

  it('resolves environment references and rejects invalid or missing entries', () => {
    expect(Object.getPrototypeOf(resolveMcpEnv(undefined, {}, 'env'))).toBeNull()
    expect(resolveMcpEnv(
      { DOCS_TOKEN: '${TOKEN}', DOCS_REGION: '${REGION:-west}' },
      { TOKEN: 'abc' },
      'env',
    )).toEqual({ DOCS_TOKEN: 'abc', DOCS_REGION: 'west' })
    expect(resolveMcpEnv({ PLAIN: 'value' }, {}, 'env')).toEqual({ PLAIN: 'value' })
    expect(() => resolveMcpEnv({ 'BAD-KEY': 'value' }, {}, 'env'))
      .toThrow('env contains an invalid environment entry')
    expect(() => resolveMcpEnv({ DOCS_TOKEN: 1 }, {}, 'env'))
      .toThrow('env contains an invalid environment entry')
    expect(() => expandMcpEnvValue('!secret', {}, 'env.DOCS_TOKEN'))
      .toThrow('env.DOCS_TOKEN uses command expansion, which DSH does not execute from MCP config')
    expect(() => expandMcpEnvValue('${MISSING}', {}, 'env.DOCS_TOKEN'))
      .toThrow('env.DOCS_TOKEN references unavailable environment variable "MISSING"')
  })

  it('validates HTTP headers and detects duplicate names without exposing secrets', () => {
    expect(Object.getPrototypeOf(resolveMcpHeaders(undefined, {}, 'headers'))).toBeNull()
    expect(resolveMcpHeaders({ Authorization: 'Bearer ${TOKEN}', Accept: 'application/json' }, { TOKEN: 'abc' }, 'headers'))
      .toEqual({ Authorization: 'Bearer abc', Accept: 'application/json' })
    expect(resolveMcpHeaders({ Authorization: 'Bearer ${TOKEN}' }, {}, 'headers', false))
      .toEqual({ Authorization: 'Bearer ${TOKEN}' })
    expect(() => resolveMcpHeaders({ Authorization: 1 }, {}, 'headers'))
      .toThrow('headers contains an invalid header entry')
    expect(() => resolveMcpHeaders({ 'Bad Header': 'value' }, {}, 'headers'))
      .toThrow('headers contains an invalid header entry')
    expect(() => resolveMcpHeaders({ Authorization: 'bad\nvalue' }, {}, 'headers'))
      .toThrow('headers contains an invalid header entry')
    expect(() => resolveMcpHeaders({ Authorization: 'one', authorization: 'two' }, {}, 'headers'))
      .toThrow('headers contains duplicate header names')
  })

  it('normalizes endpoints and working directories while keeping summaries private', () => {
    expect(resolveMcpUrl('https://docs.example/mcp?token=secret', 'url'))
      .toBe('https://docs.example/mcp?token=secret')
    expect(() => resolveMcpUrl('not a url', 'url')).toThrow('url must be an absolute HTTP(S) URL')
    for (const invalid of [
      'file:///tmp/server',
      'https://user@docs.example/mcp',
      'https://:secret@docs.example/mcp',
    ]) {
      expect(() => resolveMcpUrl(invalid, 'url'))
        .toThrow('url must be an absolute HTTP(S) URL without embedded credentials')
    }

    expect(resolveMcpCwd(undefined, '/repo', '/home/me')).toBe('/repo')
    expect(resolveMcpCwd('subdir', '/repo', '/home/me')).toBe('/repo/subdir')
    expect(resolveMcpCwd('~/project', '/repo', '/home/me')).toBe('/home/me/project')
    expect(resolveMcpCwd('~', '/repo', '/home/me')).toBe('/home/me')
    expect(resolveMcpCwd('~other', '/repo', '/home/me')).toBe('/repo/~other')
    expect(resolveMcpCwd('/tmp/docs', '/repo', '/home/me')).toBe('/tmp/docs')

    expect(mcpExecutableSummary('/usr/local/bin/docs-mcp')).toBe('docs-mcp')
    expect(mcpExecutableSummary('C:\\tools\\docs.exe')).toBe('docs.exe')
    expect(mcpExecutableSummary('docs-mcp')).toBe('docs-mcp')
    expect(mcpExecutableSummary('node run server.js')).toBe('configured executable')
    expect(mcpExecutableSummary('')).toBe('configured executable')
    expect(mcpExecutableSummary('/')).toBe('configured executable')
    expect(mcpEndpointSummary('http://docs.example/private')).toBe('http://docs.example')
    expect(mcpEndpointSummary('https://docs.example/private?key=secret')).toBe('https://docs.example')
    expect(mcpEndpointSummary('file:///tmp/mcp')).toBe('configured endpoint')
    expect(mcpEndpointSummary('not a url')).toBe('configured endpoint')
  })

  it('reads optional booleans and rejects mixed transports', () => {
    expect(mcpOptionalBoolean({}, 'enabled', 'server')).toBeUndefined()
    expect(mcpOptionalBoolean({ enabled: true }, 'enabled', 'server')).toBe(true)
    expect(mcpOptionalBoolean({ enabled: false }, 'enabled', 'server')).toBe(false)
    expect(() => mcpOptionalBoolean({ enabled: 'true' }, 'enabled', 'server'))
      .toThrow('server.enabled must be a boolean')

    expect(() =>{  rejectMixedMcpTransports('node', 'https://docs.example', 'server') })
      .toThrow('server must declare only one MCP transport')
    expect(() =>{  rejectMixedMcpTransports('node', undefined, 'server') }).not.toThrow()
    expect(() =>{  rejectMixedMcpTransports(undefined, 'https://docs.example', 'server') }).not.toThrow()
    expect(() =>{  rejectMixedMcpTransports(undefined, undefined, 'server') }).not.toThrow()
  })
})
