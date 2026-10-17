/**
 * Detection and store-layout resolution.
 * @module @deepseek-ai/dsh-agent-pi/tests/detect
 */

import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { detectionFrom, probePiVersion, resolvePiBinary, expandUserPath } from '../src/detect.ts'
import { PI_AGENT_DIR_ENV, PI_SESSION_DIR_ENV, resolvePiStore } from '../src/sessions.ts'
import { createFakeHost, processWith } from './host.ts'

describe('pi binary resolution', () => {
  it('reports why detection failed when nothing is on PATH or in a known location', async () => {
    const host = createFakeHost({ env: { PATH: '/usr/bin' } })
    const resolution = await resolvePiBinary(host)

    expect(resolution.found).toBe(false)
    expect(resolution.source).toBe('none')
    expect(resolution.reason).toBe('`pi` was not found on PATH or in any known install location')
    expect(detectionFrom(resolution)).toEqual({
      installed: false,
      source: 'none',
      reason: '`pi` was not found on PATH or in any known install location',
    })
  })

  it('prefers the configured path, then PATH, then the well-known directories', async () => {
    const configured = createFakeHost({
      files: { '/opt/pi/bin/pi': 'binary', '/usr/bin/pi': 'binary' },
      dirs: ['/opt/pi/bin', '/usr/bin'],
      env: { PATH: '/usr/bin' },
    })
    await expect(resolvePiBinary(configured, { candidates: ['/opt/pi/bin/pi'] })).resolves.toEqual({
      found: true,
      path: '/opt/pi/bin/pi',
      source: 'config',
    })

    const onPath = createFakeHost({
      files: { '/usr/bin/pi': 'binary', '/home/tester/.local/bin/pi': 'binary' },
      dirs: ['/usr/bin', '/home/tester/.local/bin'],
      env: { PATH: '/usr/bin' },
    })
    await expect(resolvePiBinary(onPath)).resolves.toEqual({
      found: true,
      path: '/usr/bin/pi',
      source: 'path',
    })

    const wellKnown = createFakeHost({
      files: { '/home/tester/.local/bin/pi': 'binary' },
      dirs: ['/home/tester/.local/bin'],
      env: { PATH: '/usr/bin' },
    })
    await expect(resolvePiBinary(wellKnown)).resolves.toEqual({
      found: true,
      path: '/home/tester/.local/bin/pi',
      source: 'well-known',
    })
  })

  it('ignores a configured directory', async () => {
    const host = createFakeHost({ dirs: ['/opt/pi'], env: { PATH: '' } })
    const resolved = await resolvePiBinary(host, { candidates: ['/opt/pi'] })
    expect(resolved.found).toBe(false)
  })

  it('skips empty candidates and resolves configured relative paths from the host cwd', async () => {
    const path = resolve('relative/pi')
    const pathBinary = join(process.cwd(), 'node_modules', '.bin', 'pi')
    const host = createFakeHost({ files: { [path]: 'binary' }, env: { PATH: '::node_modules/.bin::' } })

    await expect(resolvePiBinary(host, { candidates: ['', 'relative/pi'] })).resolves.toEqual({
      found: true,
      path,
      source: 'config',
    })

    const onPath = createFakeHost({ files: { [pathBinary]: 'binary' }, env: { PATH: '::node_modules/.bin::' } })
    await expect(resolvePiBinary(onPath)).resolves.toEqual({ found: true, path: pathBinary, source: 'path' })

    const emptyPath = createFakeHost({ env: { PATH: '::' } })
    await expect(resolvePiBinary(emptyPath)).resolves.toMatchObject({ found: false, source: 'none' })
    await expect(resolvePiBinary(createFakeHost({}))).resolves.toMatchObject({ found: false, source: 'none' })
  })

  it('expands a leading tilde', () => {
    const host = createFakeHost({ home: '/home/tester' })
    expect(expandUserPath(host, '~')).toBe('/home/tester')
    expect(expandUserPath(host, '~/pi')).toBe('/home/tester/pi')
    expect(expandUserPath(host, 'relative/pi')).toBe(resolve('relative/pi'))
    expect(expandUserPath(host, '/opt/pi')).toBe('/opt/pi')
  })
})

describe('pi version probe', () => {
  it('takes the first stdout line verbatim', async () => {
    const host = createFakeHost({})
    host.queue(() => processWith(['', 'pi 1.2.0', 'extra']))

    await expect(probePiVersion(host, '/usr/bin/pi', { cwd: '/tmp', timeoutMs: 10 })).resolves.toBe('pi 1.2.0')
    expect(host.spawns[0]?.spec).toMatchObject({
      command: '/usr/bin/pi',
      args: ['--version'],
      cwd: '/tmp',
      timeoutMs: 10,
    })
  })

  it('falls back to stderr when stdout is empty', async () => {
    const host = createFakeHost({})
    host.queue(() => processWith([], { stderr: 'pi 1.2.0-stderr' }))
    await expect(probePiVersion(host, '/usr/bin/pi', { cwd: '/tmp', timeoutMs: 10 })).resolves.toBe('pi 1.2.0-stderr')
  })

  it('reports no version when the probe cannot start', async () => {
    const host = createFakeHost({})
    host.failNextSpawn('ENOENT')
    await expect(probePiVersion(host, '/usr/bin/pi', { cwd: '/tmp', timeoutMs: 10 })).resolves.toBeUndefined()
    expect(host.logs.join('\n')).toContain('pi --version could not be started: ENOENT')
  })

  it('renders a non-Error spawn failure as a string', async () => {
    const host = createFakeHost({})
    host.spawn = () => {
      throw 'spawn blocked'
    }

    await expect(probePiVersion(host, '/usr/bin/pi', { cwd: '/tmp', timeoutMs: 10 })).resolves.toBeUndefined()
    expect(host.logs).toContain('pi --version could not be started: spawn blocked')
  })

  it('keeps a probe alive when stdout iteration and stderr reading fail', async () => {
    const host = createFakeHost({})
    const base = processWith([])
    host.queue(() => ({
      ...base,
      lines: (async function* stream(): AsyncGenerator<string> {
        throw new Error('stdout failed')
      })(),
      async stderr(): Promise<string> {
        throw new Error('stderr failed')
      },
    }))

    await expect(probePiVersion(host, '/usr/bin/pi', { cwd: '/tmp', timeoutMs: 10 })).resolves.toBeUndefined()
    expect(host.logs).toEqual([
      'pi --version output ended abnormally: stdout failed',
      'pi --version stderr could not be read: stderr failed',
    ])
  })

  it('returns no version when both output streams are empty', async () => {
    const host = createFakeHost({})
    host.queue(() => processWith([]))
    await expect(probePiVersion(host, '/usr/bin/pi', { cwd: '/tmp', timeoutMs: 10 })).resolves.toBeUndefined()
  })

  it('projects an installed binary with and without a reported version', () => {
    const resolution = { found: true, path: '/usr/bin/pi', source: 'config' as const }
    expect(detectionFrom(resolution, { version: 'pi 1.2.0' })).toEqual({
      installed: true,
      binaryPath: '/usr/bin/pi',
      source: 'config',
      version: 'pi 1.2.0',
    })
    expect(detectionFrom(resolution)).toEqual({
      installed: true,
      binaryPath: '/usr/bin/pi',
      source: 'config',
    })
    expect(detectionFrom({ found: true, source: 'config' })).toEqual({ installed: false, source: 'none' })
  })
})

describe('store layout resolution', () => {
  it('defaults the agent directory to ~/.pi/agent', async () => {
    const host = createFakeHost({ home: '/home/tester', env: {} })
    const layout = await resolvePiStore({ host })

    expect(layout.agentDir).toBe('/home/tester/.pi/agent')
    expect(layout.defaultSessionsRoot).toBe('/home/tester/.pi/agent/sessions')
    expect(layout.credentialPath).toBe('/home/tester/.pi/agent/auth.json')
    expect(layout.settingsPath).toBe('/home/tester/.pi/agent/settings.json')
    expect(layout.modelsPath).toBe('/home/tester/.pi/agent/models.json')
    expect(layout.sessionDirOverride).toBeUndefined()
  })

  it('prefers the configured agent directory over the environment, and the environment over the default', async () => {
    const host = createFakeHost({
      home: '/home/tester',
      env: { [PI_AGENT_DIR_ENV]: '/env/agent' },
    })
    await expect(resolvePiStore({ host })).resolves.toMatchObject({ agentDir: '/env/agent' })
    await expect(resolvePiStore({ host, homeDir: '~/configured' })).resolves.toMatchObject({
      agentDir: '/home/tester/configured',
    })
  })

  it('resolves the session directory override in the documented precedence order', async () => {
    const host = createFakeHost({
      home: '/home/tester',
      env: { [PI_SESSION_DIR_ENV]: '/env/sessions' },
      files: { '/home/tester/.pi/agent/settings.json': JSON.stringify({ sessionDir: '/settings/sessions' }) },
    })

    await expect(resolvePiStore({ host })).resolves.toMatchObject({ sessionDirOverride: '/env/sessions' })
    await expect(resolvePiStore({ host, sessionDir: '~/flat' })).resolves.toMatchObject({
      sessionDirOverride: '/home/tester/flat',
    })

    const fromSettings = createFakeHost({
      home: '/home/tester',
      env: {},
      files: { '/home/tester/.pi/agent/settings.json': JSON.stringify({ sessionDir: '/settings/sessions' }) },
    })
    await expect(resolvePiStore({ host: fromSettings })).resolves.toMatchObject({
      sessionDirOverride: '/settings/sessions',
    })
  })
})
