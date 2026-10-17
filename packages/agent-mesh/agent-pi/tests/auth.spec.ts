/**
 * Credential observation and the TUI-only credential operations stated as guidance.
 * @module @deepseek-ai/dsh-agent-pi/tests/auth
 */

import { describe, expect, it, vi } from 'vitest'
import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import {
  PI_LOGIN_INSTRUCTIONS,
  PI_LOGOUT_INSTRUCTIONS,
  PI_PROVIDER_ENV_VARS,
  piLogin,
  piLogout,
  readPiAuthState,
} from '../src/auth.ts'
import type { PiStoreLayout } from '../src/sessions.ts'
import { createFakeHost } from './host.ts'

const AGENT_DIR = '/home/tester/.pi/agent'
const CREDENTIAL_PATH = `${AGENT_DIR}/auth.json`
const NOW = Date.parse('2026-10-16T00:00:00.000Z')

/** A store layout rooted at {@link AGENT_DIR}. */
function layout(agentDir: string = AGENT_DIR): PiStoreLayout {
  return {
    agentDir,
    defaultSessionsRoot: `${agentDir}/sessions`,
    credentialPath: `${agentDir}/auth.json`,
    settingsPath: `${agentDir}/settings.json`,
    modelsPath: `${agentDir}/models.json`,
  }
}

/** A host holding one auth.json body. */
function hostWithAuth(body: string, env: Readonly<Record<string, string | undefined>> = {}): AgentHost {
  return createFakeHost({ files: { [CREDENTIAL_PATH]: body }, env })
}

describe('pi credential state', () => {
  it('reports an absent store as unauthenticated when no provider key is set', async () => {
    const host = createFakeHost({ env: {} })

    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'unauthenticated',
      source: 'none',
      detail: 'auth.json is absent and no provider key is set in the environment',
    })
  })

  it('reports a directory in place of auth.json as misconfigured', async () => {
    const host = createFakeHost({ dirs: [CREDENTIAL_PATH], env: {} })

    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'misconfigured',
      source: 'file',
      detail: 'auth.json could not be read: auth.json is a directory, not a file',
    })
  })

  it('reports a non-empty auth.json that reads back empty as misconfigured', async () => {
    const base = hostWithAuth('{"openai":{"type":"api_key","key":"sk-x"}}')
    const host: AgentHost = { ...base, readHead: async () => '' }

    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'misconfigured',
      source: 'file',
      detail: 'auth.json could not be read: auth.json could not be read',
    })
  })

  it('reports invalid JSON as misconfigured with the parse failure', async () => {
    const host = hostWithAuth('{not json')

    const state = await readPiAuthState({ host, layout: layout(), now: NOW })
    expect(state.status).toBe('misconfigured')
    expect(state.source).toBe('file')
    expect(state.detail?.startsWith('auth.json could not be read: ')).toBe(true)
  })

  it('renders a non-Error parser failure as a string', async () => {
    const host = hostWithAuth('{"openai":{}}')
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'parser stopped'
    })

    let detail: string | undefined = undefined
    try {
      detail = (await readPiAuthState({ host, layout: layout(), now: NOW })).detail
    } finally {
      parse.mockRestore()
    }

    expect(detail).toBe('auth.json could not be read: parser stopped')
  })

  it('treats an empty zero-byte auth file as absent', async () => {
    const host = hostWithAuth('')
    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'unauthenticated',
      source: 'none',
      detail: 'auth.json is absent and no provider key is set in the environment',
    })
  })

  it('reports a JSON document that is not an object as misconfigured', async () => {
    const host = hostWithAuth('["openai"]')

    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'misconfigured',
      source: 'file',
      detail: 'auth.json could not be read: auth.json does not hold a JSON object',
    })
  })

  it('authenticates from a stored api key without carrying the key into the state', async () => {
    const host = hostWithAuth('{"openai":{"type":"api_key","key":"sk-do-not-leak"}}')

    const state = await readPiAuthState({ host, layout: layout(), now: NOW })
    expect(state).toEqual({ status: 'authenticated', source: 'file', method: 'openai(api_key)' })
    expect(JSON.stringify(state)).not.toContain('sk-do-not-leak')
  })

  it('names a `!command` key as a command reference the adapter never runs', async () => {
    const host = hostWithAuth('{"openai":{"type":"api_key","key":"!op read op://vault/key"}}')

    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'authenticated',
      source: 'file',
      method: 'openai(command)',
      detail: 'the stored key is a `!command` reference that pi resolves by running a shell command',
    })
  })

  it('reports an unexpired oauth credential as authenticated with its expiry', async () => {
    const expires = NOW + 60_000
    const host = hostWithAuth(JSON.stringify({ anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires } }))

    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'authenticated',
      source: 'file',
      method: 'anthropic(oauth)',
      expiresAt: new Date(expires).toISOString(),
    })
  })

  it('reports an expired oauth credential as expired, because pi refreshes it on use', async () => {
    const expires = NOW - 1_000
    const host = hostWithAuth(JSON.stringify({ anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires } }))

    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'expired',
      source: 'file',
      method: 'anthropic(oauth)',
      expiresAt: new Date(expires).toISOString(),
      detail: 'a stored OAuth credential expired; pi refreshes it on the next request',
    })
  })

  it('treats an oauth credential with tokens but no expiry as unusable', async () => {
    const host = hostWithAuth('{"anthropic":{"type":"oauth","access":"a","refresh":"r"}}')

    const state = await readPiAuthState({ host, layout: layout(), now: NOW })
    expect(state.status).toBe('expired')
    expect(state.expiresAt).toBeUndefined()
  })

  it('takes the latest expiry among the usable credentials', async () => {
    const host = hostWithAuth(
      JSON.stringify({
        anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: NOW + 10_000 },
        openai: { type: 'oauth', access: 'b', refresh: 'r', expires: NOW + 90_000 },
      }),
    )

    const state = await readPiAuthState({ host, layout: layout(), now: NOW })
    expect(state.status).toBe('authenticated')
    expect(state.method).toBe('anthropic(oauth), openai(oauth)')
    expect(state.expiresAt).toBe(new Date(NOW + 90_000).toISOString())
  })

  it('counts entries that are not recognizable credentials and stays parsed', async () => {
    const host = hostWithAuth(
      JSON.stringify({
        broken: 'not-an-object',
        partial: { type: 'api_key' },
        odd: { type: 'kerberos' },
        oauthless: { type: 'oauth' },
        good: { type: 'api_key', key: 'sk-good' },
      }),
    )

    const state = await readPiAuthState({ host, layout: layout(), now: NOW })
    expect(state.status).toBe('authenticated')
    expect(state.method).toBe('good(api_key)')
  })

  it('reports a parsed store with no usable credential and counts its malformed entries', async () => {
    const withMalformed = hostWithAuth('{"odd":{"type":"kerberos"}}')
    await expect(readPiAuthState({ host: withMalformed, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'unauthenticated',
      source: 'file',
      detail: 'auth.json holds no usable credential, and 1 entries were not recognizable',
    })

    const empty = hostWithAuth('{}')
    await expect(readPiAuthState({ host: empty, layout: layout(), now: NOW })).resolves.toEqual({
      status: 'unauthenticated',
      source: 'file',
      detail: 'auth.json holds no usable credential',
    })
  })

  it('falls back to a provider key in the environment, naming the first one', async () => {
    const host = createFakeHost({ env: { DEEPSEEK_API_KEY: 'from-env', OPENAI_API_KEY: '' } })

    const state = await readPiAuthState({ host, layout: layout(), now: NOW })
    expect(state.status).toBe('authenticated')
    expect(state.source).toBe('env')
    expect(state.method).toBe('api-key(DEEPSEEK_API_KEY)')
    expect(state.detail).toContain("this adapter's `env` configuration")
    expect(JSON.stringify(state)).not.toContain('from-env')
  })

  it('treats an empty environment value as unset, while a whitespace value counts as present', async () => {
    const empty = createFakeHost({ env: { DEEPSEEK_API_KEY: '' } })

    await expect(readPiAuthState({ host: empty, layout: layout(), now: NOW })).resolves.toMatchObject({
      status: 'unauthenticated',
      source: 'none',
    })

    const whitespace = createFakeHost({ env: { DEEPSEEK_API_KEY: '   ' } })
    await expect(readPiAuthState({ host: whitespace, layout: layout(), now: NOW })).resolves.toMatchObject({
      status: 'authenticated',
      source: 'env',
      method: 'api-key(DEEPSEEK_API_KEY)',
    })
  })

  it('prefers a usable stored credential over the environment', async () => {
    const host = hostWithAuth('{"openai":{"type":"api_key","key":"sk-file"}}', { OPENAI_API_KEY: 'from-env' })

    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toMatchObject({
      status: 'authenticated',
      source: 'file',
      method: 'openai(api_key)',
    })
  })

  it('reports an expired stored credential ahead of a usable environment key', async () => {
    const host = hostWithAuth(JSON.stringify({ anthropic: { type: 'oauth', expires: NOW - 1 } }), {
      ANTHROPIC_API_KEY: 'from-env',
    })

    await expect(readPiAuthState({ host, layout: layout(), now: NOW })).resolves.toMatchObject({
      status: 'expired',
      source: 'file',
    })
  })

  it('inspects the injected environment instead of the host environment', async () => {
    const host = createFakeHost({ env: { DEEPSEEK_API_KEY: 'from-host' } })

    await expect(readPiAuthState({ host, layout: layout(), env: {}, now: NOW })).resolves.toMatchObject({
      status: 'unauthenticated',
      source: 'none',
    })
  })

  it('classifies expiry against the injected clock instead of the host clock', async () => {
    const host = createFakeHost({
      env: {},
      startMs: 1_000,
      files: { [CREDENTIAL_PATH]: JSON.stringify({ anthropic: { type: 'oauth', expires: 3_000 } }) },
    })

    await expect(readPiAuthState({ host, layout: layout(), now: 5_000 })).resolves.toMatchObject({
      status: 'expired',
      expiresAt: new Date(3_000).toISOString(),
    })
  })

  it('reads the clock from the host when the caller pins none', async () => {
    const host = createFakeHost({
      env: {},
      startMs: 1_000,
      files: { [CREDENTIAL_PATH]: JSON.stringify({ anthropic: { type: 'oauth', expires: 2_000 } }) },
    })

    await expect(readPiAuthState({ host, layout: layout() })).resolves.toMatchObject({ status: 'authenticated' })
  })

  it('classifies the declared provider environment variables as a non-empty name list', () => {
    expect(PI_PROVIDER_ENV_VARS).toContain('ANTHROPIC_API_KEY')
    expect(PI_PROVIDER_ENV_VARS.every(name => name === name.toUpperCase())).toBe(true)
  })
})

describe('pi credential operations', () => {
  it('reports the interactive flow as unsupported with its own guidance', async () => {
    const host = createFakeHost({ env: {} })

    const result = await piLogin({ host, layout: layout(), now: NOW }, { flow: 'interactive', secret: 'sk-never-used' })

    expect(result).toEqual({
      ok: false,
      action: 'login',
      state: {
        status: 'unauthenticated',
        source: 'none',
        detail: 'auth.json is absent and no provider key is set in the environment',
      },
      instructions: PI_LOGIN_INSTRUCTIONS,
    })
    expect(JSON.stringify(result)).not.toContain('sk-never-used')
  })

  it('names a non-interactive flow in the guidance, because pi implements none of them', async () => {
    const host = createFakeHost({ env: {} })

    const result = await piLogin({ host, layout: layout(), now: NOW }, { flow: 'api-key' })

    expect(result.instructions).toBe(`Pi has no \`api-key\` login flow; ${PI_LOGIN_INSTRUCTIONS}`)
  })

  it('reports logout as unsupported and names the credential file to edit', async () => {
    const host = createFakeHost({ env: {} })

    const result = await piLogout({ host, layout: layout(), now: NOW })

    expect(result).toEqual({
      ok: false,
      action: 'logout',
      state: {
        status: 'unauthenticated',
        source: 'none',
        detail: 'auth.json is absent and no provider key is set in the environment',
      },
      instructions: `${PI_LOGOUT_INSTRUCTIONS} (${CREDENTIAL_PATH})`,
    })
  })
})
