import { describe, expect, it } from 'vitest'
import { codexAdapter } from '../src/index.ts'
import { CODEX_BINARY_NAME, detectionFrom, expandUserPath, probeVersion, resolveBinary } from '../src/detect.ts'
import { resolveCodexHome } from '../src/sessions.ts'
import { FakeHost } from './fake-host.ts'

describe('binary resolution', () => {
  it('reports the exact reason when nothing was found', async () => {
    const host = new FakeHost()
    const resolution = await resolveBinary(host)
    expect(resolution).toEqual({
      found: false,
      source: 'none',
      reason: '`codex` was not found on PATH or in any known install location',
    })
    expect(detectionFrom(resolution)).toEqual({
      installed: false,
      source: 'none',
      reason: '`codex` was not found on PATH or in any known install location',
    })
    expect(detectionFrom({ found: false, source: 'none' })).toEqual({ installed: false, source: 'none' })
    expect(detectionFrom({ found: true, path: '/opt/codex', source: 'config' })).toEqual({
      installed: true,
      binaryPath: '/opt/codex',
      source: 'config',
    })
  })

  it('resolves explicit relative candidates and relative PATH entries against cwd', async () => {
    const host = new FakeHost()
    const candidate = `${process.cwd()}/tools/codex`
    host.addFile(candidate)
    expect(await resolveBinary(host, { candidates: ['', 'tools/codex'] })).toMatchObject({
      found: true,
      path: candidate,
      source: 'config',
    })

    const relativePath = new FakeHost()
    relativePath.env['PATH'] = 'relative-bin'
    const pathBinary = `${process.cwd()}/relative-bin/codex`
    relativePath.addFile(pathBinary)
    expect(await resolveBinary(relativePath)).toMatchObject({ found: true, path: pathBinary, source: 'path' })
  })

  it('prefers an explicit candidate and reports it as config', async () => {
    const host = new FakeHost()
    host.env['PATH'] = '/opt/bin'
    host.addDir('/opt')
    host.addDir('/opt/bin')
    host.addFile('/opt/bin/codex')
    host.addFile('/custom/codex')
    const resolution = await resolveBinary(host, { candidates: ['/custom/codex'] })
    expect(resolution.path).toBe('/custom/codex')
    expect(resolution.source).toBe('config')
  })

  it('skips a directory named like the binary and continues down PATH', async () => {
    const host = new FakeHost()
    host.env['PATH'] = '/opt/bin:/other/bin'
    host.addDir('/opt/bin/codex')
    host.addFile('/other/bin/codex')
    const resolution = await resolveBinary(host)
    expect(resolution.path).toBe('/other/bin/codex')
    expect(resolution.source).toBe('path')
  })

  it('falls back to the well-known install directories', async () => {
    const host = new FakeHost()
    host.env['PATH'] = ''
    host.addFile('/home/tester/.local/bin/codex')
    const resolution = await resolveBinary(host)
    expect(resolution.path).toBe('/home/tester/.local/bin/codex')
    expect(resolution.source).toBe('well-known')
  })

  it('reads the first version line from stdout, then stderr', async () => {
    const host = new FakeHost()
    host.enqueue({ lines: ['', 'codex-cli 0.50.0', 'extra'] })
    expect(await probeVersion(host, '/bin/codex', { cwd: '/home/tester', timeoutMs: 1000 })).toBe('codex-cli 0.50.0')

    host.enqueue({ lines: [], stderr: 'codex 1.2.3\n' })
    expect(await probeVersion(host, '/bin/codex', { cwd: '/home/tester', timeoutMs: 1000 })).toBe('codex 1.2.3')

    host.enqueue({ lines: [], stderr: '' })
    expect(await probeVersion(host, '/bin/codex', { cwd: '/home/tester', timeoutMs: 1000 })).toBeUndefined()
  })

  it('answers undefined when the probe cannot start', async () => {
    const host = new FakeHost()
    host.spawn = () => {
      throw new Error('ENOENT')
    }
    expect(await probeVersion(host, '/bin/codex', { cwd: '/home/tester', timeoutMs: 1000 })).toBeUndefined()

    host.spawn = () => { throw 'spawn unavailable' }
    expect(await probeVersion(host, '/bin/codex', { cwd: '/home/tester', timeoutMs: 1000 })).toBeUndefined()
    expect(host.logs.at(-1)?.message).toContain('spawn unavailable')
  })

  it('uses stderr after stdout and logs stream read failures', async () => {
    const host = new FakeHost()
    host.spawn = () => ({
      lines: (async function* (): AsyncGenerator<string> {
        throw 'stdout unavailable'
      })(),
      stderr: async () => { throw new Error('stderr unavailable') },
      exit: Promise.resolve({ code: 0, signal: null, timedOut: false, cancelled: false }),
      cancel: () => undefined,
    })
    expect(await probeVersion(host, '/bin/codex', { cwd: '/home/tester', timeoutMs: 1000 })).toBeUndefined()
    expect(host.logs.map(entry => entry.message)).toEqual([
      'codex --version output ended abnormally: stdout unavailable',
      'codex --version stderr could not be read: stderr unavailable',
    ])
  })

  it('expands home paths and resolves other relative paths', () => {
    const host = new FakeHost()
    expect(expandUserPath(host, '~')).toBe('/home/tester')
    expect(expandUserPath(host, '~/bin/codex')).toBe('/home/tester/bin/codex')
    expect(expandUserPath(host, '/opt/codex')).toBe('/opt/codex')
    expect(expandUserPath(host, 'bin/codex')).toBe(`${process.cwd()}/bin/codex`)
  })

  it('names the binary it looks for', () => {
    expect(CODEX_BINARY_NAME).toBe('codex')
  })
})

describe('home resolution', () => {
  it('prefers the configured home over the environment', async () => {
    const host = new FakeHost()
    host.env['CODEX_HOME'] = '/env/codex'
    host.addDir('/env/codex')
    host.addDir('/configured')
    const home = await resolveCodexHome(host, '/configured')
    expect(home.path).toBe('/configured')
    expect(home.fromEnv).toBe(false)
    expect(home.sessionsRoot).toBe('/configured/sessions')
    expect(home.archivedRoot).toBe('/configured/archived_sessions')
    expect(home.indexFile).toBe('/configured/session_index.jsonl')
    expect(home.credentialFile).toBe('/configured/auth.json')
  })

  it('uses $CODEX_HOME only when it names a directory', async () => {
    const host = new FakeHost()
    host.env['CODEX_HOME'] = '/env/codex'
    const home = await resolveCodexHome(host)
    expect(home.path).toBe('/home/tester/.codex')
    expect(home.fromEnv).toBe(false)
    expect(home.fallbackReason).toBe('CODEX_HOME is set to /env/codex, which is not a directory; using /home/tester/.codex')
  })

  it('honours a real $CODEX_HOME', async () => {
    const host = new FakeHost()
    host.env['CODEX_HOME'] = '/env/codex'
    host.addDir('/env/codex')
    const home = await resolveCodexHome(host)
    expect(home.path).toBe('/env/codex')
    expect(home.fromEnv).toBe(true)
    expect(home.fallbackReason).toBeUndefined()
  })

  it('expands a leading tilde', async () => {
    const host = new FakeHost()
    host.addDir('/home/tester/custom-codex')
    const home = await resolveCodexHome(host, '~/custom-codex')
    expect(home.path).toBe('/home/tester/custom-codex')
  })
})

describe('adapter descriptor', () => {
  it('describes identity, capabilities and paths without spawning anything', async () => {
    const host = new FakeHost()
    host.env['PATH'] = '/opt/bin'
    host.addFile('/opt/bin/codex')
    host.addDir('/home/tester/.codex')
    host.enqueue({ lines: ['codex-cli 0.50.0'] })
    const adapter = codexAdapter(host)
    const descriptor = await adapter.describe()
    expect(adapter.id).toBe('codex')
    expect(descriptor.displayName).toBe('Codex')
    expect(descriptor.detection).toEqual({
      installed: true,
      binaryPath: '/opt/bin/codex',
      source: 'path',
      version: 'codex-cli 0.50.0',
    })
    expect(descriptor.sessionRoot).toBe('/home/tester/.codex/sessions')
    expect(descriptor.credentialPath).toBe('/home/tester/.codex/auth.json')
    expect(descriptor.environmentKeys).toEqual(['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'OPENAI_API_KEY'])
    expect(descriptor.capabilities).toMatchObject({
      runModes: ['duplex-protocol'],
      streaming: true,
      resume: true,
      interrupt: true,
      listSessions: true,
      readTranscript: true,
      nativeTodos: true,
      nativePlan: true,
      sandboxProfiles: ['read-only', 'workspace-write', 'danger-full-access'],
      approvalModes: ['on-request', 'never'],
      credentials: { status: true, login: ['oauth-loopback', 'device-code', 'api-key'], logout: true },
    })
    expect(descriptor.transports).toEqual([
      { mode: 'headless-exec', mechanism: 'codex exec --json', available: true },
      { mode: 'duplex-protocol', mechanism: 'codex app-server --stdio', available: true },
    ])
    // One spawn: the version probe. Reading the store never spawns Codex.
    expect(host.spawns).toHaveLength(1)
    expect(host.spawns[0]?.spec.args).toEqual(['--version'])
  })

  it('resolves detection once and reports a missing binary with its reason', async () => {
    const host = new FakeHost()
    host.env['PATH'] = '/usr/bin'
    const adapter = codexAdapter(host)
    const first = await adapter.describe()
    const second = await adapter.describe()
    expect(first).toBe(second)
    expect(first.detection.installed).toBe(false)
    expect(first.detection.reason).toBe('`codex` was not found on PATH or in any known install location')
    expect(host.spawns).toHaveLength(0)
  })

  it('clears a rejected detection promise so a later lookup can recover', async () => {
    const host = new FakeHost()
    host.env['PATH'] = '/opt/bin'
    host.addFile('/opt/bin/codex')
    host.enqueue({ lines: ['codex-cli 0.50.0'] })
    const stat = host.stat.bind(host)
    let failing = true
    host.stat = async (path) => {
      if (failing && path === '/opt/bin/codex') throw new Error('stat unavailable')
      return await stat(path)
    }
    const adapter = codexAdapter(host)
    await expect(adapter.describe()).rejects.toThrow('stat unavailable')
    failing = false
    const descriptor = await adapter.describe()
    expect(descriptor.detection).toMatchObject({ installed: true, version: 'codex-cli 0.50.0' })
    expect(await adapter.describe()).toBe(descriptor)
  })

  it('uses a configured binary path and the existing Codex home as the CLI cwd', async () => {
    const host = new FakeHost()
    host.addFile('/home/tester/custom-codex')
    host.addDir('/home/tester/.codex')
    host.enqueue({ lines: ['codex-cli 0.50.0'] })
    host.enqueue({ lines: ['login started'] })
    const adapter = codexAdapter(host, { binaryPath: '~/custom-codex' })
    const descriptor = await adapter.describe()
    expect(descriptor.detection).toMatchObject({ installed: true, binaryPath: '/home/tester/custom-codex', source: 'config' })
    await adapter.login({ flow: 'oauth-loopback' })
    expect(host.spawns.at(-1)?.spec.cwd).toBe('/home/tester/.codex')
  })
})
