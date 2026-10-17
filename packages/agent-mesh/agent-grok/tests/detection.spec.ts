import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { resolveGrokConfig } from '../src/config.ts'
import { grokAdapter } from '../src/index.ts'
import {
  detectionFrom, expandUserPath, GROK_APPROVAL_MODES, GROK_SANDBOX_PROFILES, probeVersion, resolveBinary,
} from '../src/detect.ts'
import { GROK_CREDENTIAL_ENV_KEYS, GROK_RUNTIME_ENV_KEYS } from '../src/auth.ts'
import { MemoryHost } from './support/memory-host.ts'

const HOME = '/home/tester'

describe('grok detection', () => {
  it('expands a home path and resolves explicit relative candidates before PATH', async () => {
    const relative = join(process.cwd(), 'tools', 'grok')
    const host = new MemoryHost({ home: HOME, env: { PATH: '::tools::' }, files: { [relative]: '' } })
    expect(expandUserPath(host, '~')).toBe(HOME)
    expect(expandUserPath(host, '~/bin/grok')).toBe(`${HOME}/bin/grok`)
    expect(expandUserPath(host, '/opt/grok')).toBe('/opt/grok')
    expect(expandUserPath(host, 'tools/grok')).toBe(resolve('tools/grok'))
    await expect(resolveBinary(host, { candidates: ['', 'tools/grok'] })).resolves.toEqual({
      found: true,
      path: relative,
      source: 'config',
    })
  })

  it('resolves relative PATH entries and an unset PATH', async () => {
    const binary = join(process.cwd(), 'node_modules', '.bin', 'grok')
    const relativePath = new MemoryHost({ home: HOME, env: { PATH: '::node_modules/.bin::' }, files: { [binary]: '' } })
    await expect(resolveBinary(relativePath)).resolves.toMatchObject({ found: true, path: binary, source: 'path' })

    await expect(resolveBinary(new MemoryHost({ home: HOME, env: {} }))).resolves.toMatchObject({
      found: false,
      source: 'none',
    })
  })

  it('uses stderr when stdout is empty and logs non-Error probe failures', async () => {
    const stderr = new MemoryHost({ home: HOME, env: {}, scripts: [{ stderr: 'grok 1.2.3' }] })
    await expect(probeVersion(stderr, '/opt/grok', { cwd: HOME, timeoutMs: 100 })).resolves.toBe('grok 1.2.3')

    const spawnFailure = new MemoryHost({ home: HOME, env: {}, spawnFailure: 'spawn blocked' })
    await expect(probeVersion(spawnFailure, '/opt/grok', { cwd: HOME, timeoutMs: 100 })).resolves.toBeUndefined()
    expect(spawnFailure.logs).toContain('warn: grok --version could not be started: spawn blocked')

    const errorSpawnFailure = new MemoryHost({ home: HOME, env: {}, spawnFailure: new Error('spawn failed') })
    await expect(probeVersion(errorSpawnFailure, '/opt/grok', { cwd: HOME, timeoutMs: 100 })).resolves.toBeUndefined()
    expect(errorSpawnFailure.logs).toContain('warn: grok --version could not be started: spawn failed')

    const outputFailure = new MemoryHost({
      home: HOME,
      env: {},
      scripts: [{ streamFailure: 'stdout blocked', stderrFailure: 'stderr blocked' }],
    })
    await expect(probeVersion(outputFailure, '/opt/grok', { cwd: HOME, timeoutMs: 100 })).resolves.toBeUndefined()
    expect(outputFailure.logs).toContain('warn: grok --version output ended abnormally: stdout blocked')
    expect(outputFailure.logs).toContain('warn: grok --version stderr could not be read: stderr blocked')
  })

  it('projects installed and missing resolutions', () => {
    expect(detectionFrom({ found: true, path: '/opt/grok', source: 'config' }, { version: 'grok 1.2.3' })).toEqual({
      installed: true, binaryPath: '/opt/grok', source: 'config', version: 'grok 1.2.3',
    })
    expect(detectionFrom({ found: true, path: '/opt/grok', source: 'config' })).toEqual({
      installed: true, binaryPath: '/opt/grok', source: 'config',
    })
    expect(detectionFrom({ found: false, source: 'none', reason: 'binary missing' })).toEqual({
      installed: false, source: 'none', reason: 'binary missing',
    })
  })

  it('reports the missing binary with the shared reason string', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '/usr/bin' } })
    const descriptor = await grokAdapter(host, resolveGrokConfig()).describe()
    expect(descriptor.detection).toEqual({
      installed: false,
      source: 'none',
      reason: '`grok` was not found on PATH or in any known install location',
    })
  })

  it('finds the binary on PATH and probes its version', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '/opt/tools' },
      files: { '/opt/tools/grok': '' },
      scripts: [{ stdout: ['grok 0.9.2'], code: 0 }],
    })
    const descriptor = await grokAdapter(host, resolveGrokConfig()).describe()

    expect(descriptor.detection).toEqual({
      installed: true,
      binaryPath: '/opt/tools/grok',
      source: 'path',
      version: 'grok 0.9.2',
    })
    expect(host.spawned[0]).toMatchObject({ command: '/opt/tools/grok', args: ['--version'] })
    expect(descriptor.sessionRoot).toBe(`${HOME}/.grok/sessions`)
    expect(descriptor.credentialPath).toBe(`${HOME}/.grok/auth.json`)
    expect(descriptor.environmentKeys).toEqual([...GROK_RUNTIME_ENV_KEYS, ...GROK_CREDENTIAL_ENV_KEYS])
    expect(descriptor.transports).toEqual([
      { mode: 'headless-exec', mechanism: 'grok -p --output-format streaming-json', available: true },
      {
        mode: 'duplex-protocol',
        mechanism: 'grok agent stdio (ACP JSON-RPC)',
        available: true,
      },
    ])
    expect(descriptor.capabilities).toEqual({
      runModes: ['duplex-protocol'],
      streaming: true,
      resume: true,
      interrupt: true,
      listSessions: true,
      readTranscript: true,
      nativeTodos: true,
      nativePlan: true,
      listModels: false,
      sandboxProfiles: GROK_SANDBOX_PROFILES,
      approvalModes: GROK_APPROVAL_MODES,
      credentials: { status: true, login: ['oauth-loopback', 'device-code', 'interactive'], logout: true },
    })
    expect(descriptor.summary).toContain('Grok Build by xAI')
  })

  it('prefers a configured binary and reports the config source', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '/opt/tools' },
      files: { '/opt/tools/grok': '', '/custom/grok': '' },
      scripts: [{ stdout: ['grok 1.0.0'], code: 0 }],
    })
    const descriptor = await grokAdapter(host, resolveGrokConfig({ binaryPath: '/custom/grok' })).describe()

    expect(descriptor.detection).toMatchObject({ installed: true, binaryPath: '/custom/grok', source: 'config' })
  })

  it('falls back to the well-known install locations a minimal PATH omits', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '/usr/bin' },
      files: { [`${HOME}/.local/bin/grok`]: '' },
      scripts: [{ stdout: ['grok 0.9.2'], code: 0 }],
    })
    const descriptor = await grokAdapter(host, resolveGrokConfig()).describe()

    expect(descriptor.detection).toMatchObject({ installed: true, source: 'well-known' })
  })

  it('reports a probe that printed nothing without a version', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '/opt/tools' },
      files: { '/opt/tools/grok': '' },
      scripts: [{ stdout: [], stderr: '', code: 0 }],
    })
    const descriptor = await grokAdapter(host, resolveGrokConfig()).describe()

    expect(descriptor.detection).toEqual({ installed: true, binaryPath: '/opt/tools/grok', source: 'path' })
  })

  it('resolves $GROK_HOME and $GROK_AUTH_PATH before the defaults', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '', GROK_HOME: '/store/grok', GROK_AUTH_PATH: '/secrets/auth.json' },
    })
    const descriptor = await grokAdapter(host, resolveGrokConfig()).describe()

    expect(descriptor.sessionRoot).toBe('/store/grok/sessions')
    expect(descriptor.credentialPath).toBe('/secrets/auth.json')
  })

  it('lets the configured home override $GROK_HOME and expands a leading ~', async () => {
    const configured = new MemoryHost({ home: HOME, env: { PATH: '', GROK_HOME: '/store/grok' } })
    const configuredDescriptor = await grokAdapter(configured, resolveGrokConfig({ homeDir: '/cfg/grok' })).describe()
    expect(configuredDescriptor.sessionRoot).toBe('/cfg/grok/sessions')

    const tilde = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const tildeDescriptor = await grokAdapter(tilde, resolveGrokConfig({ homeDir: '~/grok' })).describe()
    expect(tildeDescriptor.sessionRoot).toBe(`${HOME}/grok/sessions`)
  })
})
