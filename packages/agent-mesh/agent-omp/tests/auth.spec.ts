import { describe, expect, it } from 'vitest'
import type { HostProcess } from '@deepseek-ai/dsh-agent-mesh'
import {
  OMP_LOGIN_INSTRUCTIONS,
  ompLogin,
  ompLogout,
  readOmpAuthState,
} from '../src/auth.ts'
import { resolveOmpConfig } from '../src/config.ts'
import { resolveOmpStore } from '../src/sessions.ts'
import { FakeHost } from './support/fake-host.ts'

const HOME = '/home/tester'
const AGENT_DIR = '/home/tester/.omp/agent'
const agentDirOmp = `${AGENT_DIR}/agent.db`

/** A host and the layout resolved for a bare HOME. */
function hostFor(env: Readonly<Record<string, string | undefined>> = {}): {
  host: FakeHost
  layout: ReturnType<typeof resolveOmpStore>
} {
  const host = new FakeHost({ env, home: HOME })
  const layout = resolveOmpStore({ host, config: resolveOmpConfig() })
  return { host, layout }
}

describe('reading omp credential state', () => {
  it('falls back to the host environment when the caller supplies none', async () => {
    const { host, layout } = hostFor({ OPENAI_API_KEY: 'sk-test' })
    const state = await readOmpAuthState({ host, layout })
    expect(state).toMatchObject({ status: 'authenticated', source: 'env', method: 'api-key(OPENAI_API_KEY)' })
  })

  it('names the first credential-shaped variable of the catalog order', async () => {
    const { host, layout } = hostFor({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' })
    const state = await readOmpAuthState({ host, layout, env: host.env })
    expect(state.method).toBe('api-key(ANTHROPIC_API_KEY)')
  })
})

describe('delegating a login to omp login', () => {
  it('reports the CLI outcome, a bounded output tail and the refreshed state', async () => {
    const { host, layout } = hostFor()
    host.addDirectory(AGENT_DIR)
    host.script({ stderr: 'y'.repeat(2_500), exit: { code: 1, signal: null, timedOut: false, cancelled: false } })

    const result = await ompLogin({
      host,
      binary: '/opt/omp/bin/omp',
      layout,
      params: { flow: 'interactive' },
      status: async () => await readOmpAuthState({ host, layout }),
      cwd: AGENT_DIR,
      env: {},
      timeoutMs: 30_000,
    })

    expect(result.ok).toBe(false)
    expect(result.action).toBe('login')
    expect(result.state).toEqual({ status: 'unauthenticated', source: 'none' })
    expect(result.instructions).toContain('`omp login` needs a terminal')
    expect(result.instructions).toContain(OMP_LOGIN_INSTRUCTIONS)
    expect(result.output).toHaveLength(2_000)
    expect(result.output?.endsWith('y')).toBe(true)
    expect(host.spawns[0]).toEqual({
      command: '/opt/omp/bin/omp',
      args: ['login'],
      cwd: AGENT_DIR,
      env: {},
      stdin: '',
      timeoutMs: 30_000,
    })
  })

  it('keeps a short output whole and omits an empty one', async () => {
    const { host, layout } = hostFor()
    host.script({ lines: ['omp 18.11.0'], stderr: 'opening browser' })

    const short = await ompLogin({
      host,
      binary: 'omp',
      layout,
      params: { flow: 'interactive' },
      status: async () => ({ status: 'unauthenticated', source: 'none' }),
      cwd: HOME,
      env: {},
      timeoutMs: 30_000,
    })
    expect(short.ok).toBe(true)
    expect(short.output).toBe('omp 18.11.0\nopening browser')

    const silent = hostFor()
    silent.host.script({})
    const empty = await ompLogin({
      host: silent.host,
      binary: 'omp',
      layout: silent.layout,
      params: { flow: 'interactive' },
      status: async () => ({ status: 'unauthenticated', source: 'none' }),
      cwd: HOME,
      env: {},
      timeoutMs: 30_000,
    })
    expect(empty.output).toBeUndefined()
  })

  it('logs an abnormally ended output stream and an unreadable stderr', async () => {
    const brokenStream = hostFor()
    brokenStream.host.script({ linesError: 'stdout ended' })
    const streamed = await ompLogin({
      host: brokenStream.host,
      binary: 'omp',
      layout: brokenStream.layout,
      params: { flow: 'interactive' },
      status: async () => ({ status: 'unauthenticated', source: 'none' }),
      cwd: HOME,
      env: {},
      timeoutMs: 30_000,
    })
    expect(streamed.ok).toBe(true)
    expect(brokenStream.host.logs).toContainEqual({
      level: 'warn',
      message: 'omp cli output ended abnormally: stdout ended',
    })

    const unreadable = hostFor()
    unreadable.host.script({ stderrError: 'pipe closed' })
    const failed = await ompLogin({
      host: unreadable.host,
      binary: 'omp',
      layout: unreadable.layout,
      params: { flow: 'interactive' },
      status: async () => ({ status: 'unauthenticated', source: 'none' }),
      cwd: HOME,
      env: {},
      timeoutMs: 30_000,
    })
    expect(failed.ok).toBe(true)
    expect(unreadable.host.logs).toContainEqual({
      level: 'warn',
      message: 'omp cli stderr could not be read: pipe closed',
    })
  })

  it('renders non-Error stdout and stderr failures as strings', async () => {
    const { host, layout } = hostFor()
    const process: HostProcess = {
      lines: (async function* stream(): AsyncGenerator<string> {
        throw 'stdout blocked'
      })(),
      async stderr(): Promise<string> {
        throw 'stderr blocked'
      },
      exit: Promise.resolve({ code: 0, signal: null, timedOut: false, cancelled: false }),
      cancel(): void {},
    }
    host.spawn = () => process

    const result = await ompLogin({
      host,
      binary: 'omp',
      layout,
      params: { flow: 'interactive' },
      status: async () => ({ status: 'unauthenticated', source: 'none' }),
      cwd: HOME,
      env: {},
      timeoutMs: 30_000,
    })

    expect(result.ok).toBe(true)
    expect(host.logs).toEqual([
      { level: 'info', message: 'delegating omp login' },
      { level: 'warn', message: 'omp cli output ended abnormally: stdout blocked' },
      { level: 'warn', message: 'omp cli stderr could not be read: stderr blocked' },
    ])
  })
})

describe('reporting logout guidance', () => {
  it('names the credential store and the paths that do revoke', async () => {
    const { host, layout } = hostFor({ ANTHROPIC_API_KEY: 'sk-test' })
    const result = await ompLogout({
      layout,
      status: async () => await readOmpAuthState({ host, layout }),
    })
    expect(result.ok).toBe(false)
    expect(result.action).toBe('logout')
    expect(result.state).toMatchObject({ status: 'authenticated', source: 'env' })
    expect(result.instructions).toContain('`omp auth-broker logout <provider>`')
    expect(result.instructions).toContain(agentDirOmp)
  })
})
