import { describe, expect, it, vi } from 'vitest'
import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import {
  GROK_CREDENTIAL_ENV_KEYS,
  grokMethodLabel,
  loginGrok,
  parseGrokAuthStore,
  readGrokAuthState,
  readGrokAuthStore,
  redactGrokOutput,
  selectGrokAuthEntry,
} from '../src/auth.ts'
import type { GrokAuthContext } from '../src/auth.ts'
import { resolveGrokConfig } from '../src/config.ts'
import { grokAdapter } from '../src/index.ts'
import { MemoryHost } from './support/memory-host.ts'

const HOME = '/home/tester'
const AUTH_PATH = `${HOME}/.grok/auth.json`

/** An adapter over a host that already holds one credential file. */
function adapterWith(authJson: string): ReturnType<typeof grokAdapter> {
  const host = new MemoryHost({
    home: HOME,
    env: { PATH: '' },
    files: { [AUTH_PATH]: authJson },
  })
  return grokAdapter(host, resolveGrokConfig())
}

/** Build the credential helpers' ports around a scripted host. */
function authContext(host: AgentHost, resolveBinary: () => Promise<string | undefined> = async () => '/opt/tools/grok'): GrokAuthContext {
  return {
    host,
    credentialPath: AUTH_PATH,
    home: `${HOME}/.grok`,
    env: host.env,
    resolveBinary,
    loginTimeoutMs: 100,
    logoutTimeoutMs: 100,
  }
}

describe('grok credential state', () => {
  it('reports an environment credential ahead of the store', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '', XAI_API_KEY: 'xai-abcdefghijklmnop', GROK_DEPLOYMENT_KEY: 'deployment' },
      files: { [AUTH_PATH]: JSON.stringify({ 'xai::oidc': { auth_mode: 'oidc', key: 'k' } }) },
    })

    const state = await grokAdapter(host, resolveGrokConfig()).readAuthState()

    expect(state).toEqual({
      status: 'authenticated',
      source: 'env',
      method: 'api-key',
      detail: 'api-key credential comes from the environment; this adapter cannot log it out or rotate it',
    })
  })

  it('reports a usable account login from the store', async () => {
    const state = await adapterWith(JSON.stringify({
      'xai::oidc': {
        auth_mode: 'oidc',
        key: 'k',
        refresh_token: 'r',
        expires_at: '2099-01-01T00:00:00.000Z',
        email: 'person@x.ai',
        team_name: 'xai',
      },
    })).readAuthState()

    expect(state).toEqual({
      status: 'authenticated',
      source: 'file',
      method: 'oidc',
      expiresAt: '2099-01-01T00:00:00.000Z',
      detail: 'signed in as person@x.ai; team xai',
    })
  })

  it('names the legacy web-login scope and a credential without an expiry', async () => {
    const state = await adapterWith(JSON.stringify({
      'https://accounts.x.ai/sign-in': { auth_mode: 'web_login', key: 'k' },
    })).readAuthState()

    expect(state).toEqual({
      status: 'authenticated',
      source: 'file',
      method: 'web-login',
      detail: 'grok stores no expiry for this credential; this is the legacy web-login scope, which grok re-validates per request',
    })
  })

  it('reports every stored credential past expiry as expired', async () => {
    const state = await adapterWith(JSON.stringify({
      'xai::oidc': { auth_mode: 'oidc', key: 'k', expires_at: '2000-01-01T00:00:00.000Z' },
    })).readAuthState()

    expect(state.status).toBe('expired')
    expect(state.source).toBe('file')
    expect(state.method).toBe('oidc')
    expect(state.expiresAt).toBe('2000-01-01T00:00:00.000Z')
    expect(state.detail).toBe('every stored credential is past its expiry and none can be refreshed; run `grok login` again')
  })

  it('prefers a usable login over an expired one and an API-key entry', async () => {
    const state = await adapterWith(JSON.stringify({
      'xai::api_key': { auth_mode: 'api_key', key: 'k' },
      'xai::stale': { auth_mode: 'oidc', key: 'k', expires_at: '2000-01-01T00:00:00.000Z' },
      'xai::live': { auth_mode: 'external', key: 'k', expires_at: '2099-01-01T00:00:00.000Z' },
    })).readAuthState()

    expect(state.method).toBe('external')
    expect(state.status).toBe('authenticated')
  })

  it('reports an unreadable store as misconfigured', async () => {
    const state = await adapterWith('not json at all').readAuthState()

    expect(state.status).toBe('misconfigured')
    expect(state.source).toBe('file')
    expect(state.detail).toMatch(/^the credential store could not be read: /)
  })

  it('reports an entry without credential material as misconfigured', async () => {
    const state = await adapterWith(JSON.stringify({ 'xai::api_key': { auth_mode: 'api_key' } })).readAuthState()

    expect(state).toEqual({
      status: 'misconfigured',
      source: 'file',
      method: 'api-key',
      detail: 'the xai::api_key entry carries no credential material',
    })
  })

  it('reports the signed-out state without any credential source', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const state = await grokAdapter(host, resolveGrokConfig()).readAuthState()

    expect(state).toEqual({
      status: 'unauthenticated',
      source: 'file',
      detail: 'no credential file, no credential environment variable, and no CLI confirmation is available',
    })
  })

  it('refuses a non-interactive api-key login with the guidance a human needs', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const result = await grokAdapter(host, resolveGrokConfig()).login({ flow: 'api-key', secret: 'xai-should-never-be-recorded' })

    expect(host.spawned).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.action).toBe('login')
    expect(result.instructions).toBe(
      'Grok Build has no `--api-key` login flag, so a pasted key cannot be delegated. Set XAI_API_KEY in the adapter environment, or run `grok login` in a terminal.',
    )
    expect(result.state.status).toBe('unauthenticated')
    expect(JSON.stringify(result)).not.toContain('xai-should-never-be-recorded')
  })

  it('refuses an interactive login flow and points at a terminal', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const result = await grokAdapter(host, resolveGrokConfig()).login({ flow: 'interactive' })

    expect(result.ok).toBe(false)
    expect(result.instructions).toBe(
      'Run `grok login` in a terminal; the loopback flow needs a browser and a TTY-less child cannot host it.',
    )
  })

  it('runs the device-code flow through the native CLI and reports the observed post-state', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '/opt/tools' },
      files: { '/opt/tools/grok': '' },
      scripts: [
        { stdout: ['grok 0.9.2'], code: 0 },
        { stdout: ['Open https://accounts.x.ai/device and confirm ABCD-EFGH'], code: 0 },
      ],
    })
    const result = await grokAdapter(host, resolveGrokConfig()).login({ flow: 'device-code' })

    expect(host.spawned[1]).toMatchObject({ command: '/opt/tools/grok', args: ['login', '--device-auth'], cwd: `${HOME}/.grok` })
    expect(host.spawned[1]?.env['GROK_HOME']).toBe(`${HOME}/.grok`)
    expect(result.ok).toBe(true)
    expect(result.instructions).toBe(
      'Open the URL in a browser and confirm the code shown there matches the code below. URL: https://accounts.x.ai/device code: ABCD-EFGH',
    )
    expect(result.output).toContain('ABCD-EFGH')
  })

  it('runs logout through the native CLI', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '/opt/tools' },
      files: { '/opt/tools/grok': '' },
      scripts: [{ stdout: ['grok 0.9.2'], code: 0 }, { stdout: ['signed out'], code: 0 }],
    })
    const result = await grokAdapter(host, resolveGrokConfig()).logout()

    expect(host.spawned[1]).toMatchObject({ args: ['logout'] })
    expect(result).toMatchObject({ ok: true, action: 'logout', output: 'signed out' })
  })

  it('redacts a key the CLI echoed back', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '/opt/tools' },
      files: { '/opt/tools/grok': '' },
      scripts: [
        { stdout: ['grok 0.9.2'], code: 0 },
        { stdout: ['logged in with xai-abcdefghijklmnop'], code: 0 },
      ],
    })
    const result = await grokAdapter(host, resolveGrokConfig()).login({ flow: 'oauth-loopback' })

    expect(result.output).toBe('logged in with <redacted:key>')
  })

  it('explains a logout it cannot run without a binary', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const result = await grokAdapter(host, resolveGrokConfig()).logout()

    expect(result.ok).toBe(false)
    expect(result.instructions).toContain('Install Grok Build')
  })

  it('maps every supported credential environment variable to its method', async () => {
    const methods = ['api-key', 'api-key-legacy', 'legacy-token', 'deployment-key']
    for (const [index, name] of GROK_CREDENTIAL_ENV_KEYS.entries()) {
      const host = new MemoryHost({ home: HOME, env: { PATH: '', [name]: 'present' } })
      await expect(readGrokAuthState(authContext(host))).resolves.toMatchObject({
        status: 'authenticated',
        source: 'env',
        method: methods[index],
      })
    }
  })

  it('keeps empty, unreadable and oversized credential stores distinct', async () => {
    const empty = new MemoryHost({ home: HOME, env: {}, files: { [AUTH_PATH]: '  ' } })
    await expect(readGrokAuthStore(empty, AUTH_PATH, 16)).resolves.toEqual({ present: true, entries: [] })

    const oversized = new MemoryHost({ home: HOME, env: {}, files: { [AUTH_PATH]: '{"a":1}' } })
    await expect(readGrokAuthStore(oversized, AUTH_PATH, 2)).resolves.toEqual({
      present: true,
      entries: [],
      error: 'the credential store is larger than a single bounded read',
    })

    expect(parseGrokAuthStore(null, 0)).toEqual([])
    expect(parseGrokAuthStore({ bad: null, 'xai::api_key': { auth_mode: 2, key: '', refresh_token: 4, expires_at: 'bad', email: '', team_name: '' } }, 0)).toEqual([
      {
        scope: 'xai::api_key',
        authMode: '',
        hasKey: false,
        hasRefreshToken: false,
        expired: false,
        hasExpiry: false,
        accountLogin: false,
      },
    ])

    const parseFailure = new MemoryHost({ home: HOME, env: {}, files: { [AUTH_PATH]: '{}' } })
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw 'invalid store' })
    try {
      await expect(readGrokAuthStore(parseFailure, AUTH_PATH, 16)).resolves.toEqual({
        present: true,
        entries: [],
        error: 'invalid store',
      })
    } finally {
      parse.mockRestore()
    }
  })

  it('selects fallback key entries and labels unknown or empty modes', () => {
    const entries = parseGrokAuthStore({
      'other-key': { auth_mode: 'api_key', key: 'key' },
      'empty-key': { auth_mode: 'api_key' },
    }, 0)
    expect(selectGrokAuthEntry(entries)?.scope).toBe('other-key')
    expect(selectGrokAuthEntry([])).toBeUndefined()
    expect(grokMethodLabel('')).toBe('unknown')
    expect(grokMethodLabel('future_mode')).toBe('future_mode')
    expect(parseGrokAuthStore({ 'xai::api_key': { auth_mode: 'future_mode', key: 'key' } }, 0)[0]?.accountLogin).toBe(false)
  })

  it('omits empty account details and carries a file expiry alongside an environment credential', async () => {
    const account = adapterWith(JSON.stringify({
      'xai::oidc': { auth_mode: 'oidc', key: 'key', expires_at: '2099-01-01T00:00:00.000Z' },
    }))
    await expect(account.readAuthState()).resolves.toEqual({
      status: 'authenticated',
      source: 'file',
      method: 'oidc',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })

    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '', XAI_API_KEY: 'present' },
      files: { [AUTH_PATH]: JSON.stringify({ 'xai::oidc': { auth_mode: 'oidc', key: 'key', expires_at: '2099-01-01T00:00:00.000Z' } }) },
    })
    await expect(readGrokAuthState(authContext(host))).resolves.toMatchObject({
      source: 'env',
      method: 'api-key',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })

    const refreshable = adapterWith(JSON.stringify({
      'xai::oidc': {
        auth_mode: 'oidc',
        key: 'key',
        refresh_token: 'refresh',
        expires_at: '2000-01-01T00:00:00.000Z',
      },
    }))
    await expect(refreshable.readAuthState()).resolves.toMatchObject({ status: 'authenticated', method: 'oidc' })
  })

  it('reports a missing binary before starting a delegated login', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const result = await loginGrok(authContext(host, async () => undefined), { flow: 'oauth-loopback' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('missing-binary login unexpectedly succeeded')
    expect(result.instructions).toContain('Install Grok Build')
    expect(host.spawned).toEqual([])
  })

  it('reports failed loopback login and absorbs spawn and stream output failures', async () => {
    const failed = new MemoryHost({
      home: HOME,
      env: { PATH: '' },
      scripts: [{ stdout: ['login did not finish'], code: 1 }],
    })
    const failure = await loginGrok(authContext(failed), { flow: 'oauth-loopback' })
    expect(failure.ok).toBe(false)
    expect(failure.instructions).toContain('Complete the sign-in in the browser that was opened')

    const failedWithUrl = new MemoryHost({
      home: HOME,
      env: {},
      scripts: [{ stdout: ['open https://accounts.x.ai/sign-in'], code: 1 }],
    })
    const urlFailure = await loginGrok(authContext(failedWithUrl), { flow: 'oauth-loopback' })
    expect(urlFailure.instructions).toContain('(https://accounts.x.ai/sign-in)')

    const spawnError = new MemoryHost({ home: HOME, env: {}, spawnFailure: new Error('spawn refused') })
    const spawnResult = await loginGrok(authContext(spawnError), { flow: 'oauth-loopback' })
    expect(spawnResult.output).toBeUndefined()
    expect(spawnError.logs).toContain('warn: grok login --oauth could not be started: spawn refused')

    const streamErrors = new MemoryHost({
      home: HOME,
      env: {},
      scripts: [{ streamFailure: new Error('stdout failed'), stderrFailure: 'stderr failed', code: 1 }],
    })
    await loginGrok(authContext(streamErrors), { flow: 'oauth-loopback' })
    expect(streamErrors.logs).toContain('warn: grok login --oauth output ended abnormally: stdout failed')
    expect(streamErrors.logs).toContain('warn: grok login --oauth stderr could not be read: stderr failed')
  })

  it('captures device-code output without a URL or code and caps long output', async () => {
    const noCode = new MemoryHost({ home: HOME, env: {}, scripts: [{ stdout: ['waiting'], code: 1 }] })
    const noCodeResult = await loginGrok(authContext(noCode), { flow: 'device-code' })
    expect(noCodeResult.instructions).toBe('Open the URL in a browser and confirm the code shown there matches the code below.')

    const longOutput = 'x'.repeat(9_000)
    const longHost = new MemoryHost({ home: HOME, env: {}, scripts: [{ stdout: [longOutput], code: 0 }] })
    const longResult = await loginGrok(authContext(longHost), { flow: 'oauth-loopback' })
    expect(longResult.output).toHaveLength(8_192)
    expect(longResult.output).toBe(longOutput.slice(-8_192))
  })

  it('redacts the supported key, bearer, JWT and JSON secret forms', () => {
    expect(redactGrokOutput([
      'xai-abcdefghijklmnop',
      'Bearer abcdefghijklmnop',
      'eyJabcdefghijk.abcdefghijk.abcdefghijk',
      '{"refresh_token":"sensitive-value"}',
    ].join(' '))).toBe('<redacted:key> Bearer <redacted:token> <redacted:jwt> {"refresh_token":"<redacted>"}')
    expect(redactGrokOutput('ordinary output')).toBe('ordinary output')
  })

  it('omits empty logout output', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '/opt/tools' },
      files: { '/opt/tools/grok': '' },
      scripts: [{ stdout: ['grok 1.0.0'] }, { stdout: [] }],
    })
    const result = await grokAdapter(host, resolveGrokConfig()).logout()
    expect(result).toEqual({
      ok: true,
      action: 'logout',
      state: {
        status: 'unauthenticated',
        source: 'file',
        detail: 'no credential file, no credential environment variable, and no CLI confirmation is available',
      },
    })
  })
})
