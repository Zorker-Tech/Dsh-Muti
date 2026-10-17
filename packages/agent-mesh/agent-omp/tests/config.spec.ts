import { describe, expect, it } from 'vitest'
import { readOmpAuthState, OMP_LOGIN_INSTRUCTIONS, OMP_LOGOUT_INSTRUCTIONS } from '../src/auth.ts'
import { resolveOmpConfig } from '../src/config.ts'
import { OMP_APPROVAL_MODES, splitOmpModel } from '../src/detect.ts'
import { OMP_ID, ompAdapter } from '../src/index.ts'
import { activeProfile, resolveOmpStore } from '../src/sessions.ts'
import { FakeHost } from './support/fake-host.ts'

const HOME = '/home/tester'

/** Resolve the layout for one environment and configuration. */
function layout(
  env: Readonly<Record<string, string | undefined>>,
  config: Parameters<typeof resolveOmpConfig>[0] = {},
): ReturnType<typeof resolveOmpStore> {
  const host = new FakeHost({ env, home: HOME })
  return resolveOmpStore({ host, config: resolveOmpConfig(config) })
}

describe('OMP profile and agent-directory precedence', () => {
  it('resolves the default profile under a bare HOME', () => {
    const resolved = layout({})
    expect(resolved.agentDir).toBe('/home/tester/.omp/agent')
    expect(resolved.configRoot).toBe('/home/tester/.omp')
    expect(resolved.profile).toBeUndefined()
    expect(resolved.defaultSessionsRoot).toBe('/home/tester/.omp/agent/sessions')
    expect(resolved.credentialPath).toBe('/home/tester/.omp/agent/agent.db')
    expect(resolved.settingsPath).toBe('/home/tester/.omp/agent/config.yml')
    expect(resolved.modelsPath).toBe('/home/tester/.omp/agent/models.yml')
    expect(resolved.agentDirFromEnv).toBe(false)
  })

  it('renames the config root with PI_CONFIG_DIR', () => {
    const resolved = layout({ PI_CONFIG_DIR: '.omp-staging' })
    expect(resolved.configRoot).toBe('/home/tester/.omp-staging')
    expect(resolved.agentDir).toBe('/home/tester/.omp-staging/agent')
  })

  it('uses PI_CODING_AGENT_DIR for the default profile and reports it as an override', () => {
    const resolved = layout({ PI_CODING_AGENT_DIR: '/srv/omp-agent' })
    expect(resolved.agentDir).toBe('/srv/omp-agent')
    expect(resolved.agentDirFromEnv).toBe(true)
  })

  it('prefers OMP_PROFILE over the legacy PI_PROFILE and ignores PI_CODING_AGENT_DIR', () => {
    const resolved = layout({
      OMP_PROFILE: 'staging',
      PI_PROFILE: 'legacy',
      PI_CODING_AGENT_DIR: '/srv/omp-agent',
    })
    expect(resolved.profile).toBe('staging')
    expect(resolved.agentDir).toBe('/home/tester/.omp/profiles/staging/agent')
    expect(resolved.agentDirFromEnv).toBe(false)
  })

  it('falls back to PI_PROFILE when OMP_PROFILE is absent', () => {
    expect(activeProfile({ PI_PROFILE: 'legacy' })).toBe('legacy')
    expect(layout({ PI_PROFILE: 'legacy' }).agentDir).toBe('/home/tester/.omp/profiles/legacy/agent')
  })

  it('treats an empty or explicit "default" profile as the default profile', () => {
    expect(activeProfile({ OMP_PROFILE: '' })).toBeUndefined()
    expect(activeProfile({ OMP_PROFILE: 'default' })).toBeUndefined()
    expect(activeProfile({ OMP_PROFILE: '  ' })).toBeUndefined()
    expect(layout({ OMP_PROFILE: 'default' }).agentDir).toBe('/home/tester/.omp/agent')
  })

  it('lets the configured homeDir override every environment source', () => {
    const resolved = layout(
      { OMP_PROFILE: 'staging', PI_CODING_AGENT_DIR: '/srv/omp-agent' },
      { homeDir: '/opt/omp' },
    )
    expect(resolved.agentDir).toBe('/opt/omp')
    expect(resolved.profile).toBe('staging')
    expect(resolved.agentDirFromEnv).toBe(true)
  })

  it('resolves the session-directory override from the setting before the environment', () => {
    const fromEnv = layout({ PI_CODING_AGENT_SESSION_DIR: '~/flat-sessions' })
    expect(fromEnv.sessionDirOverride).toBe('/home/tester/flat-sessions')
    expect(fromEnv.sessionsDirFromSetting).toBe(false)

    const fromSetting = layout(
      { PI_CODING_AGENT_SESSION_DIR: '/from/env' },
      { sessionDir: '/from/setting' },
    )
    expect(fromSetting.sessionDirOverride).toBe('/from/setting')
    expect(fromSetting.sessionsDirFromSetting).toBe(true)
  })
})

describe('OMP adapter configuration', () => {
  it('resolves empty, whitespace-only and configured values explicitly', () => {
    expect(resolveOmpConfig()).toEqual({ binaryPath: undefined, homeDir: undefined, sessionDir: undefined, env: {} })
    expect(resolveOmpConfig({
      binaryPath: '  /opt/omp  ', homeDir: '   ', sessionDir: '', env: { OMP_PROFILE: 'staging' },
    })).toEqual({
      binaryPath: '/opt/omp', homeDir: undefined, sessionDir: undefined, env: { OMP_PROFILE: 'staging' },
    })
  })
})

describe('OMP credential state', () => {
  it('reports an environment credential before the store', async () => {
    const host = new FakeHost({ env: { DEEPSEEK_API_KEY: 'sk-test' }, home: HOME })
    host.addFile('/home/tester/.omp/agent/agent.db', 'sqlite bytes')
    const state = await readOmpAuthState({ host, layout: layout({}), env: host.env })
    expect(state.status).toBe('authenticated')
    expect(state.source).toBe('env')
    expect(state.method).toBe('api-key(DEEPSEEK_API_KEY)')
    expect(state.detail).toMatch(/cannot log out/)
  })

  it('reports an existing credential store as unknown, never guessed at', async () => {
    const host = new FakeHost({ env: { ANTHROPIC_API_KEY: '' }, home: HOME })
    host.addFile('/home/tester/.omp/agent/agent.db', 'sqlite bytes')
    const state = await readOmpAuthState({ host, layout: layout({}), env: host.env })
    expect(state).toEqual({
      status: 'unknown',
      source: 'file',
      detail: 'the credential store is a SQLite database, which this adapter does not read',
    })
  })

  it('reports an absent store and no environment key as unauthenticated', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    const state = await readOmpAuthState({ host, layout: layout({}), env: host.env })
    expect(state).toEqual({ status: 'unauthenticated', source: 'none' })
  })
})

describe('the mounted adapter', () => {
  const env = { PATH: '/usr/bin', HOME, DEEPSEEK_API_KEY: 'sk-test' }

  it('detects the binary on PATH and reports the resolved store', async () => {
    const host = new FakeHost({ env, home: HOME })
    host.addFile('/usr/bin/omp', '#!/bin/sh\n')
    host.script({ lines: ['omp 18.11.0'] })
    const adapter = ompAdapter(host)
    const descriptor = await adapter.describe()

    expect(descriptor.id).toBe(OMP_ID)
    expect(descriptor.displayName).toBe('OMP')
    expect(descriptor.detection).toEqual({ installed: true, binaryPath: '/usr/bin/omp', source: 'path', version: 'omp 18.11.0' })
    expect(descriptor.sessionRoot).toBe('/home/tester/.omp/agent/sessions')
    expect(descriptor.credentialPath).toBe('/home/tester/.omp/agent/agent.db')
    expect(descriptor.environmentKeys).toContain('OMP_PROFILE')
    expect(descriptor.transports).toEqual([
      { mode: 'headless-exec', mechanism: 'omp --mode json', available: false },
      {
        mode: 'duplex-protocol',
        mechanism: 'omp --mode rpc-ui (JSON commands on stdin, events and approval requests on stdout)',
        available: true,
      },
    ])
    expect(host.spawns[0]?.args).toEqual(['--version'])
  })

  it('declares no models and returns none', async () => {
    const host = new FakeHost({ env, home: HOME })
    const adapter = ompAdapter(host)
    expect(await adapter.listModels()).toEqual([])
  })

  it('declares streams, resume, native todos and plan, and no sandbox', async () => {
    const adapter = ompAdapter(new FakeHost({ env, home: HOME }))
    const descriptor = await adapter.describe()
    expect(descriptor.capabilities).toMatchObject({
      runModes: ['duplex-protocol'],
      streaming: true,
      resume: true,
      interrupt: true,
      nativeTodos: true,
      nativePlan: true,
      listModels: false,
      sandboxProfiles: [],
      approvalModes: OMP_APPROVAL_MODES,
      credentials: { status: true, login: ['interactive'], logout: false },
    })
  })

  it('explains a login flow with no CLI counterpart', async () => {
    const host = new FakeHost({ env, home: HOME })
    const adapter = ompAdapter(host)
    const result = await adapter.login({ flow: 'device-code' })
    expect(result.ok).toBe(false)
    expect(result.action).toBe('login')
    expect(result.instructions).toBe(`OMP has no \`device-code\` login; ${OMP_LOGIN_INSTRUCTIONS}`)
    expect(host.spawns).toEqual([])
  })

  it('runs `omp login` for the interactive flow', async () => {
    const host = new FakeHost({ env, home: HOME })
    host.addDirectory('/home/tester/.omp/agent')
    host.script({ exit: { code: 0, signal: null, timedOut: false, cancelled: false } })
    const adapter = ompAdapter(host)
    const result = await adapter.login({ flow: 'interactive' })
    expect(result.ok).toBe(true)
    expect(result.instructions).toBe(OMP_LOGIN_INSTRUCTIONS)
    expect(host.spawns[0]?.command).toBe('omp')
    expect(host.spawns[0]?.args).toEqual(['login'])
    expect(host.spawns[0]?.cwd).toBe('/home/tester/.omp/agent')
    expect(host.spawns[0]?.stdin).toBe('')
    expect(host.spawns[0]?.timeoutMs).toBe(30_000)
  })

  it('always reports logout as unavailable, with the paths that do revoke', async () => {
    const host = new FakeHost({ env, home: HOME })
    const adapter = ompAdapter(host)
    const result = await adapter.logout()
    expect(result.ok).toBe(false)
    expect(result.action).toBe('logout')
    expect(result.instructions).toBe(`${OMP_LOGOUT_INSTRUCTIONS} (/home/tester/.omp/agent/agent.db)`)
  })

  it('splits a provider/id model at the first slash and leaves aliases alone', () => {
    expect(splitOmpModel('anthropic/claude-sonnet-4')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(splitOmpModel('@slow')).toEqual({ model: '@slow' })
    expect(splitOmpModel('bare-model')).toEqual({ model: 'bare-model' })
  })
})
