import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OMP_APPROVAL_MODES,
  OMP_BINARY_NAME,
  detectionFrom,
  expandUserPath,
  probeVersion,
  resolveBinary,
  splitOmpModel,
} from '../src/detect.ts'
import { FakeHost } from './support/fake-host.ts'

const HOME = '/home/tester'

/** A host with the given environment and home. */
function hostFor(env: Readonly<Record<string, string | undefined>> = {}): FakeHost {
  return new FakeHost({ env, home: HOME })
}

describe('expanding a configured path', () => {
  it('expands a bare tilde, a tilde prefix, an absolute path and a relative one', () => {
    const host = hostFor()
    expect(expandUserPath(host, '~')).toBe(HOME)
    expect(expandUserPath(host, '~/bin/omp')).toBe(`${HOME}/bin/omp`)
    expect(expandUserPath(host, '/usr/local/bin/omp')).toBe('/usr/local/bin/omp')
    expect(expandUserPath(host, 'bin/omp')).toBe(resolve('bin/omp'))
  })
})

describe('splitting a configured model', () => {
  it('splits only the unambiguous provider/id form and passes everything else verbatim', () => {
    expect(splitOmpModel(' anthropic/claude-sonnet-4 ')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(splitOmpModel('anthropic/claude/4')).toEqual({ provider: 'anthropic', model: 'claude/4' })
    // A trailing slash, a leading slash and a provider with characters OMP does not
    // accept as a provider id are all left whole rather than guessed at.
    expect(splitOmpModel('anthropic/')).toEqual({ model: 'anthropic/' })
    expect(splitOmpModel('/claude')).toEqual({ model: '/claude' })
    expect(splitOmpModel('pro vider/model')).toEqual({ model: 'pro vider/model' })
    expect(splitOmpModel('')).toEqual({ model: '' })
  })
})

describe('resolving the omp binary', () => {
  it('prefers an explicitly configured candidate over PATH', async () => {
    const host = hostFor({ PATH: '/usr/bin' })
    host.addFile('/opt/omp/bin/omp', '#!/bin/sh\n')
    host.addFile('/usr/bin/omp', '#!/bin/sh\n')

    const resolution = await resolveBinary(host, { candidates: ['', '/opt/omp/bin/omp'] })
    expect(resolution).toEqual({ found: true, path: '/opt/omp/bin/omp', source: 'config' })
  })

  it('resolves a relative candidate against the host process directory', async () => {
    const host = hostFor()
    host.addFile(join(process.cwd(), 'tools', OMP_BINARY_NAME), '#!/bin/sh\n')

    const resolution = await resolveBinary(host, { candidates: ['tools/omp'] })
    expect(resolution).toEqual({ found: true, path: join(process.cwd(), 'tools', OMP_BINARY_NAME), source: 'config' })
  })

  it('resolves a relative PATH entry against the host process directory', async () => {
    const host = hostFor({ PATH: `:/opt/bin:${join('node_modules', '.bin')}` })
    host.addFile(join(process.cwd(), 'node_modules', '.bin', OMP_BINARY_NAME), '#!/bin/sh\n')

    const resolution = await resolveBinary(host)
    expect(resolution).toEqual({
      found: true,
      path: join(process.cwd(), 'node_modules', '.bin', OMP_BINARY_NAME),
      source: 'path',
    })
  })

  it('falls back to the install locations a GUI host omits from PATH', async () => {
    const host = hostFor({ PATH: '/usr/bin' })
    host.addFile(`${HOME}/.bun/bin/${OMP_BINARY_NAME}`, '#!/bin/sh\n')

    expect(await resolveBinary(host)).toEqual({
      found: true,
      path: `${HOME}/.bun/bin/${OMP_BINARY_NAME}`,
      source: 'well-known',
    })
  })

  it('reports no installation with the reason a search failed', async () => {
    const host = hostFor()
    expect(await resolveBinary(host)).toEqual({
      found: false,
      source: 'none',
      reason: '`omp` was not found on PATH or in any known install location',
    })
  })

  it('never accepts a directory named like the binary', async () => {
    const host = hostFor()
    host.addDirectory(`/usr/local/bin/${OMP_BINARY_NAME}`)
    expect(await resolveBinary(host)).toMatchObject({ found: false, source: 'none' })
  })
})

describe('probing the binary version', () => {
  it('takes the first non-empty stdout line over stderr', async () => {
    const host = hostFor()
    host.script({ lines: ['', '  omp 18.11.0  ', 'extra'], stderr: 'ignored' })

    expect(await probeVersion(host, '/usr/bin/omp', { cwd: '/work/repo', timeoutMs: 1_000 })).toBe('omp 18.11.0')
    expect(host.spawns[0]).toEqual({
      command: '/usr/bin/omp',
      args: ['--version'],
      cwd: '/work/repo',
      env: {},
      timeoutMs: 1_000,
    })
  })

  it('falls back to stderr when stdout is empty, and reports nothing when neither answers', async () => {
    const host = hostFor()
    host.script({ lines: ['   '], stderr: 'omp: not runnable\n' })
    expect(await probeVersion(host, '/usr/bin/omp', { cwd: HOME, timeoutMs: 1_000 })).toBe('omp: not runnable')

    const silent = hostFor()
    silent.script({ lines: [], stderr: '\n  \n' })
    expect(await probeVersion(silent, '/usr/bin/omp', { cwd: HOME, timeoutMs: 1_000 })).toBeUndefined()
  })

  it('reports a probe that cannot be started, and one whose output ends abnormally', async () => {
    const unstartable = hostFor()
    unstartable.script({ spawnFailure: 'EACCES: permission denied' })
    expect(await probeVersion(unstartable, '/usr/bin/omp', { cwd: HOME, timeoutMs: 1_000 })).toBeUndefined()
    expect(unstartable.logs).toEqual([
      { level: 'warn', message: 'omp --version could not be started: EACCES: permission denied' },
    ])

    const brokenStream = hostFor()
    brokenStream.script({ lines: ['omp 18.11.0'], linesError: 'stdout ended', stderr: 'omp 17.0.0' })
    expect(await probeVersion(brokenStream, '/usr/bin/omp', { cwd: HOME, timeoutMs: 1_000 })).toBe('omp 18.11.0')
    expect(brokenStream.logs).toEqual([
      { level: 'warn', message: 'omp --version output ended abnormally: stdout ended' },
    ])

    const unreadableStderr = hostFor()
    unreadableStderr.script({ lines: ['omp 18.11.0'], stderrError: 'pipe closed' })
    expect(await probeVersion(unreadableStderr, '/usr/bin/omp', { cwd: HOME, timeoutMs: 1_000 })).toBe('omp 18.11.0')
    expect(unreadableStderr.logs).toEqual([
      { level: 'warn', message: 'omp --version stderr could not be read: pipe closed' },
    ])
  })

  it('names a thrown non-Error value in the diagnostic', async () => {
    const host = hostFor()
    host.script({ spawnFailure: 'plain string failure' })
    expect(await probeVersion(host, '/usr/bin/omp', { cwd: HOME, timeoutMs: 1_000 })).toBeUndefined()
    expect(host.logs[0]?.message).toBe('omp --version could not be started: plain string failure')
  })
})

describe('assembling a detection record', () => {
  it('reports an unresolved binary with its reason, and never guesses a missing one', () => {
    expect(detectionFrom({ found: false, source: 'none', reason: 'gone' })).toEqual({
      installed: false,
      source: 'none',
      reason: 'gone',
    })
    expect(detectionFrom({ found: false, source: 'none' })).toEqual({ installed: false, source: 'none' })
    expect(detectionFrom({ found: true, source: 'path' })).toEqual({ installed: false, source: 'none' })
  })

  it('reports the resolved path and the probed version when there is one', () => {
    expect(detectionFrom({ found: true, path: '/usr/bin/omp', source: 'path' })).toEqual({
      installed: true,
      binaryPath: '/usr/bin/omp',
      source: 'path',
    })
    expect(detectionFrom({ found: true, path: '/usr/bin/omp', source: 'well-known' }, { version: 'omp 18.11.0' })).toEqual({
      installed: true,
      binaryPath: '/usr/bin/omp',
      source: 'well-known',
      version: 'omp 18.11.0',
    })
  })

  it('declares exactly the approval vocabulary omp accepts', () => {
    expect(OMP_APPROVAL_MODES).toEqual(['always-ask', 'write', 'yolo'])
  })
})
