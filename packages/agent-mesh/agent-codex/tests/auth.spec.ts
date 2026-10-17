import { describe, expect, it, vi } from 'vitest'
import { codexAdapter } from '../src/index.ts'
import { classifyAuthFile, decodeIdTokenClaims, redactText } from '../src/auth.ts'
import { FakeHost } from './fake-host.ts'

const AUTH_FILE = '/home/tester/.codex/auth.json'
const CONFIG_FILE = '/home/tester/.codex/config.toml'

/** Build an unsigned JWT whose payload carries the given claims. */
function idToken(claims: Readonly<Record<string, unknown>>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `header.${payload}.signature`
}

/** A host with the codex binary on PATH and the version probe queued. */
function hostWithBinary(): FakeHost {
  const host = new FakeHost()
  host.env['PATH'] = '/opt/bin'
  host.addFile('/opt/bin/codex')
  host.enqueue({ lines: ['codex-cli 0.50.0'] })
  return host
}

describe('credential classification', () => {
  it('decodes JWT claims without verifying them', () => {
    const token = idToken({ exp: 4102444800, email: 'dev@example.test' })
    expect(decodeIdTokenClaims(token)).toEqual({ exp: 4102444800, email: 'dev@example.test' })
    expect(decodeIdTokenClaims('not-a-jwt')).toBeUndefined()
    expect(decodeIdTokenClaims('a.!!!.c')).toBeUndefined()
  })

  it('classifies an api-key file', () => {
    expect(classifyAuthFile({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-secret' })).toEqual({
      status: 'authenticated',
      method: 'api-key',
      detail: 'an API key is stored in auth.json',
    })
    expect(classifyAuthFile({ OPENAI_API_KEY: 'sk-secret' })).toMatchObject({
      status: 'authenticated',
      method: 'api-key',
    })
  })

  it('classifies ChatGPT tokens with the account, the plan and the expiry', () => {
    const classified = classifyAuthFile({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: idToken({ exp: 4102444800, email: 'dev@example.test', chatgpt_plan_type: 'plus' }),
        access_token: 'access',
      },
    })
    expect(classified).toEqual({
      status: 'authenticated',
      method: 'chatgpt-oauth',
      account: 'dev@example.test',
      plan: 'plus',
      expiresAt: new Date(4102444800 * 1000).toISOString(),
    })
  })

  it('reports an expired token and an undecodable one', () => {
    expect(classifyAuthFile({ tokens: { access_token: 'a', id_token: idToken({ exp: 1_000_000_000 }) } })).toMatchObject({
      status: 'expired',
      method: 'chatgpt-oauth',
      detail: 'the stored ChatGPT token is past its expiry; codex refreshes it on next use',
    })
    expect(classifyAuthFile({ tokens: { id_token: idToken({ email: 'x@y.z' }) } })).toMatchObject({
      status: 'authenticated',
      detail: 'the id_token carries no exp claim, so no expiry can be reported',
    })
    expect(classifyAuthFile({ tokens: { id_token: 'broken' } })).toMatchObject({
      status: 'authenticated',
      detail: 'the stored id_token could not be decoded, so the account and plan are unknown',
    })
  })

  it('classifies the other native credential kinds', () => {
    expect(classifyAuthFile({ personal_access_token: 'p' })).toMatchObject({ status: 'authenticated', method: 'personal-access-token' })
    expect(classifyAuthFile({ agent_identity: {} })).toMatchObject({ status: 'authenticated', method: 'agent-identity' })
    expect(classifyAuthFile({ bedrock_api_key: 'b' })).toMatchObject({ status: 'authenticated', method: 'bedrock-api-key' })
    expect(classifyAuthFile({ auth_mode: 'headroom' })).toMatchObject({ status: 'unknown', method: 'headroom' })
    expect(classifyAuthFile({ auth_mode: 'headers' })).toMatchObject({ status: 'unknown', method: 'headers' })
    expect(classifyAuthFile({ auth_mode: 'chatgpt' })).toMatchObject({
      status: 'unauthenticated',
      method: 'chatgpt-oauth',
      detail: 'auth_mode is "chatgpt" but no credential material is present',
    })
    expect(classifyAuthFile({})).toEqual({ status: 'unauthenticated', detail: 'auth.json carries no auth_mode and no credential material' })
    expect(classifyAuthFile('nope')).toEqual({ status: 'misconfigured', detail: 'auth.json is not a JSON object' })
  })

  it('uses native auth modes when token metadata is incomplete', () => {
    expect(classifyAuthFile({ auth_mode: 'CHATGPT-AUTH-TOKENS', tokens: { access_token: 'access' } })).toMatchObject({
      status: 'authenticated',
      method: 'chatgpt-auth-tokens',
    })
    expect(classifyAuthFile({ auth_mode: 'custom', tokens: { access_token: 'access' } })).toMatchObject({
      status: 'authenticated',
      method: 'chatgpt-oauth',
    })
  })
})

describe('observed credential state', () => {
  it('reports an environment credential first', async () => {
    const host = new FakeHost()
    host.env['OPENAI_API_KEY'] = 'sk-live'
    const state = await codexAdapter(host).readAuthState()
    expect(state).toEqual({
      status: 'authenticated',
      source: 'env',
      method: 'api-key',
      detail:
        'a credential is supplied through OPENAI_API_KEY, which takes precedence over the stored one; an environment credential cannot be logged out',
    })

    const access = new FakeHost()
    access.env['CODEX_ACCESS_TOKEN'] = 'token'
    expect((await codexAdapter(access).readAuthState()).method).toBe('access-token')
  })

  it('reports a stored API key and folds the account into the detail', async () => {
    const host = new FakeHost()
    host.addFile(AUTH_FILE, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken({ exp: 4102444800, email: 'dev@example.test', chatgpt_plan_type: 'pro' }) } }))
    const state = await codexAdapter(host).readAuthState()
    expect(state).toEqual({
      status: 'authenticated',
      source: 'file',
      method: 'chatgpt-oauth',
      expiresAt: new Date(4102444800 * 1000).toISOString(),
      detail: 'account dev@example.test; plan pro',
    })

    const minimal = new FakeHost()
    minimal.addFile(AUTH_FILE, JSON.stringify({ tokens: { access_token: 'access' } }))
    expect(await codexAdapter(minimal).readAuthState()).toEqual({
      status: 'authenticated',
      source: 'file',
      method: 'chatgpt-oauth',
    })

    const noMethod = new FakeHost()
    noMethod.addFile(AUTH_FILE, '{}')
    expect(await codexAdapter(noMethod).readAuthState()).toEqual({
      status: 'unauthenticated',
      source: 'file',
      detail: 'auth.json carries no auth_mode and no credential material',
    })
  })

  it('reports the keyring store as unknown rather than logged out', async () => {
    const host = new FakeHost()
    host.addFile(CONFIG_FILE, 'cli_auth_credentials_store = "keyring"\n')
    expect(await codexAdapter(host).readAuthState()).toEqual({
      status: 'unknown',
      source: 'keyring',
      method: 'keyring',
      detail:
        'Codex is configured with cli_auth_credentials_store = "keyring", which this adapter cannot read; runs may still be authenticated',
    })
  })

  it('distinguishes an absent store from a broken one', async () => {
    const absent = new FakeHost()
    expect(await codexAdapter(absent).readAuthState()).toEqual({
      status: 'unauthenticated',
      source: 'none',
      detail: 'auth.json is absent from /home/tester/.codex',
    })

    const configured = new FakeHost()
    configured.addFile(CONFIG_FILE, 'cli_auth_credentials_store = "ephemeral"\n')
    expect((await codexAdapter(configured).readAuthState()).detail).toBe('auth.json is absent and the configured credential store is "ephemeral"')

    const broken = new FakeHost()
    broken.addFile(AUTH_FILE, '{ not json')
    const state = await codexAdapter(broken).readAuthState()
    expect(state.status).toBe('misconfigured')
    expect(state.source).toBe('file')
    expect(state.detail).toContain('auth.json could not be parsed')

    const thrownValue = new FakeHost()
    thrownValue.addFile(AUTH_FILE, '{ invalid')
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw 'parser failed' })
    const nonError = await codexAdapter(thrownValue).readAuthState()
    expect(nonError.detail).toContain('auth.json could not be parsed: parser failed')
  })
})

describe('login and logout delegation', () => {
  it('drives the device-code flow and reports the code from the CLI output', async () => {
    const host = hostWithBinary()
    host.enqueue({ lines: ['Open https://example.test/device and enter the code ABCD-EFGH'] })
    const result = await codexAdapter(host).login({ flow: 'device-code' })
    expect(host.spawns.at(-1)?.spec.args).toEqual(['login', '--device-auth'])
    expect(result.ok).toBe(true)
    expect(result.action).toBe('login')
    expect(result.instructions).toBe('open https://example.test/device and enter the code ABCD-EFGH to finish the login.')
    expect(result.state.status).toBe('unauthenticated')
    expect(result.output).toContain('ABCD-EFGH')
  })

  it('passes an API key on stdin and redacts the CLI output', async () => {
    const host = hostWithBinary()
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz'
    host.enqueue({ lines: [`stored ${secret}`], stderr: `key ${secret}` })
    const result = await codexAdapter(host).login({ flow: 'api-key', secret })
    const spawn = host.spawns.at(-1)
    expect(spawn?.spec.args).toEqual(['login', '--with-api-key'])
    expect(spawn?.spec.stdin).toBe(secret)
    expect(result.ok).toBe(true)
    expect(result.instructions).toBe('the API key was passed to `codex login --with-api-key` on stdin and is now stored by Codex.')
    expect(result.output).not.toContain(secret)
    expect(result.output).toContain('<redacted')
  })

  it('explains an unsupported flow and a missing secret instead of throwing', async () => {
    const host = hostWithBinary()
    const unsupported = await codexAdapter(host).login({ flow: 'interactive' })
    expect(unsupported.ok).toBe(false)
    expect(unsupported.instructions).toContain('Supported flows: oauth-loopback, device-code, api-key')
    expect(host.spawns).toHaveLength(1)

    const missing = await codexAdapter(hostWithBinary()).login({ flow: 'api-key' })
    expect(missing.ok).toBe(false)
    expect(missing.instructions).toBe('provide the API key in the request; this adapter passes it to `codex login --with-api-key` on stdin.')
  })

  it('explains a missing binary instead of throwing', async () => {
    const host = new FakeHost()
    host.env['PATH'] = '/usr/bin'
    const login = await codexAdapter(host).login({ flow: 'oauth-loopback' })
    expect(login).toMatchObject({ ok: false, action: 'login' })
    expect(login.instructions).toContain('install Codex')
    const logout = await codexAdapter(host).logout()
    expect(logout).toMatchObject({ ok: false, action: 'logout' })
    expect(logout.instructions).toContain('install Codex')
  })

  it('delegates logout and reports a failed exit as ok: false', async () => {
    const host = hostWithBinary()
    host.enqueue({ lines: ['Logged out'] })
    const ok = await codexAdapter(host).logout()
    expect(host.spawns.at(-1)?.spec.args).toEqual(['logout'])
    expect(ok).toMatchObject({ ok: true, action: 'logout' })
    expect(ok.output).toBe('Logged out\n')

    const failing = hostWithBinary()
    failing.enqueue({ lines: [], stderr: 'not logged in', exit: { code: 1, signal: null, timedOut: false, cancelled: false } })
    const failed = await codexAdapter(failing).logout()
    expect(failed).toMatchObject({ ok: false, action: 'logout' })
    expect(failed.output).toContain('not logged in')

    const empty = hostWithBinary()
    const noOutput = await codexAdapter(empty).logout()
    expect(noOutput).toMatchObject({ ok: true, action: 'logout' })
    expect(noOutput.output).toBeUndefined()
  })

  it('handles loopback login output with and without an authorization URL', async () => {
    const withUrl = hostWithBinary()
    withUrl.enqueue({ lines: ['Listening on http://127.0.0.1:1455', 'Open https://auth.example.test/authorize'] })
    const completed = await codexAdapter(withUrl).login({ flow: 'oauth-loopback' })
    expect(withUrl.spawns.at(-1)?.spec.args).toEqual(['login'])
    expect(completed.instructions).toBe('finish the login at https://auth.example.test/authorize; codex completes it through its loopback listener.')

    const withoutUrl = hostWithBinary()
    withoutUrl.enqueue({ lines: ['The browser should open automatically'] })
    const pending = await codexAdapter(withoutUrl).login({ flow: 'oauth-loopback' })
    expect(pending.instructions).toBe('Codex opened a browser window (or printed an authorization URL) to finish the login.')

    const deviceWithoutCode = hostWithBinary()
    deviceWithoutCode.enqueue({ lines: ['Open https://example.test/device', 'code pending'] })
    const device = await codexAdapter(deviceWithoutCode).login({ flow: 'device-code' })
    expect(device.instructions).toBe('open https://example.test/device to finish the login.')

    const longOutput = hostWithBinary()
    longOutput.enqueue({ lines: ['x'.repeat(4100)] })
    const tailed = await codexAdapter(longOutput).login({ flow: 'oauth-loopback' })
    expect(tailed.output?.startsWith('…')).toBe(true)
  })

  it('keeps login and logout results when subprocess output streams fail', async () => {
    const host = hostWithBinary()
    const spawn = host.spawn.bind(host)
    let calls = 0
    host.spawn = (spec) => {
      calls += 1
      if (calls === 1) return spawn(spec)
      return {
        lines: (async function* (): AsyncGenerator<string> {
          throw new Error('stdout closed')
        })(),
        stderr: async () => { throw 'stderr closed' },
        exit: Promise.resolve({ code: 0, signal: null, timedOut: false, cancelled: false }),
        cancel: () => undefined,
      }
    }
    const result = await codexAdapter(host).login({ flow: 'device-code' })
    expect(result.ok).toBe(true)
    expect(result.instructions).toBe('Codex is waiting for a device login; complete it in a browser, then re-check the status here.')
    expect(host.logs.filter(entry => entry.level === 'warn').map(entry => entry.message)).toEqual([
      'codex cli output ended abnormally: stdout closed',
      'codex cli stderr could not be read: stderr closed',
    ])

    const otherErrors = hostWithBinary()
    const originalSpawn = otherErrors.spawn.bind(otherErrors)
    let spawnCount = 0
    otherErrors.spawn = (spec) => {
      spawnCount += 1
      if (spawnCount === 1) return originalSpawn(spec)
      return {
        lines: (async function* (): AsyncGenerator<string> { throw 'stdout lost' })(),
        stderr: async () => { throw new Error('stderr lost') },
        exit: Promise.resolve({ code: 0, signal: null, timedOut: false, cancelled: false }),
        cancel: () => undefined,
      }
    }
    await codexAdapter(otherErrors).logout()
    expect(otherErrors.logs.filter(entry => entry.level === 'warn').map(entry => entry.message)).toEqual([
      'codex cli output ended abnormally: stdout lost',
      'codex cli stderr could not be read: stderr lost',
    ])

    const signalled = hostWithBinary()
    signalled.enqueue({ lines: [], exit: { code: null, signal: 'SIGTERM', timedOut: false, cancelled: true } })
    const signalResult = await codexAdapter(signalled).login({ flow: 'oauth-loopback' })
    expect(signalResult.ok).toBe(false)
    expect(signalled.logs.at(-1)?.message).toContain('exit signal')
  })

  it('redacts credential-shaped text', () => {
    expect(redactText('token sk-proj-abcdefghijklmnopqrstuvwxyz')).toBe('token <redacted:key>')
    expect(redactText('Authorization: Bearer abcdefghijklmnopqrst')).toBe('Authorization: Bearer <redacted:token>')
    expect(redactText('used secret-value-1234567890', ['secret-value-1234567890'])).toBe('used <redacted:provided>')
    expect(redactText('short', ['tiny'])).toBe('short')
    expect(redactText('{"api_key":"abcdef123456"}')).toBe('{"api_key":"<redacted>"}')
    expect(redactText('nothing to hide')).toBe('nothing to hide')
  })
})
