import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentAdapter, AgentRunRequest } from '@deepseek-ai/dsh-agent-mesh'
import { OMP_ID, OMP_RUN_ENVIRONMENT_KEYS, apply, ompAdapter } from '../src/index.ts'
import { entry, messageEntry, sessionFile, sessionHeader } from './support/fixtures.ts'
import { FakeHost } from './support/fake-host.ts'
import { OmpRpcHost } from './support/rpc-host.ts'

const HOME = '/home/tester'
const AGENT_DIR = '/home/tester/.omp/agent'
const BUCKET = `${AGENT_DIR}/sessions/-work-repo`
const SESSION_PATH = `${BUCKET}/1750000000000_sess-1.jsonl`

/** A host holding one session file with a todo snapshot and one user message. */
function sessionHost(): OmpRpcHost {
  const host = new OmpRpcHost({ env: { PATH: '/usr/bin' }, home: HOME })
  host.addFile(
    SESSION_PATH,
    sessionFile({
      title: 'Session',
      header: sessionHeader({ id: 'sess-1', cwd: '/work/repo' }),
      entries: [
        messageEntry('e1', null, { role: 'user', content: 'hello' }),
        entry('e2', 'e1', 'custom', {
          customType: 'user_todo_edit',
          data: { phases: [{ name: 'Build', tasks: [{ content: 'Ship it', status: 'in_progress' }] }] },
        }),
      ],
    }),
  )
  return host
}

/** A request with every optional field absent. */
function request(): AgentRunRequest {
  return { prompt: 'do the work', cwd: '/work/repo' }
}

describe('the adapter read surface', () => {
  it('returns the OMP native resume command without starting the CLI', async () => {
    const host = new FakeHost({ env: { PATH: '/usr/bin' }, home: HOME })
    const adapter = ompAdapter(host)
    if (adapter.nativeLaunchCommand === undefined) throw new Error('OMP adapter has no native TUI launcher')
    await expect(adapter.nativeLaunchCommand('sess-1')).resolves.toEqual([
      'omp', '--session-dir', `${AGENT_DIR}/sessions`, '--resume', 'sess-1',
    ])
    expect(host.spawns).toEqual([])
  })

  it('returns no native MCP server when OMP has no matching declaration', async () => {
    await expect(ompAdapter(new FakeHost()).resolveMcpServer({ serverName: 'docs', cwd: '/work' }))
      .resolves.toBeUndefined()
  })

  it('lists sessions, reads a transcript and reads native tasks through one store layout', async () => {
    const host = sessionHost()
    const adapter = ompAdapter(host)

    const sessions = await adapter.listSessions({})
    expect(sessions.map(session => session.nativeId)).toEqual(['sess-1'])
    const session = sessions[0]
    if (session === undefined) expect.unreachable('the store holds one session')

    const transcript = await adapter.readTranscript({ session })
    expect(transcript.messages.map(message => message.text)).toEqual(['hello'])
    const tasks = await adapter.readNativeTasks({ session })
    expect(tasks.todos.map(todo => todo.content)).toEqual(['Ship it'])
    expect(tasks.notes).toContain("todos: omp's todo model carries no dependency edges, so every item has an empty blockedBy")
  })

  it('passes the caller message and byte bounds into the transcript read', async () => {
    const host = sessionHost()
    host.addFile(
      SESSION_PATH,
      sessionFile({
        header: sessionHeader({ id: 'sess-1', cwd: '/work/repo' }),
        entries: [
          messageEntry('e1', null, { role: 'user', content: 'one' }),
          messageEntry('e2', 'e1', { role: 'user', content: 'two' }),
          messageEntry('e3', 'e2', { role: 'user', content: 'three' }),
        ],
      }),
    )
    const adapter = ompAdapter(host)
    const sessions = await adapter.listSessions({})
    const session = sessions[0]
    if (session === undefined) expect.unreachable('the store holds one session')

    const capped = await adapter.readTranscript({ session, maxMessages: 1, maxBytes: 64 * 1024 })
    expect(capped.messages.map(message => message.text)).toEqual(['three'])
    expect(capped.hasMore).toBe(true)
  })

  it('resolves every store path against the configured agent directory', async () => {
    const host = sessionHost()
    const adapter = ompAdapter(host, { homeDir: '/opt/omp' })
    expect(await adapter.listSessions({})).toEqual([])
    expect((await adapter.describe()).sessionRoot).toBe('/opt/omp/sessions')
    expect((await adapter.describe()).credentialPath).toBe('/opt/omp/agent.db')
    expect(await adapter.readAuthState()).toEqual({ status: 'unauthenticated', source: 'none' })
  })
})

describe('the adapter run surface', () => {
  it('dispatches one numbered run per request and echoes the run id', async () => {
    const host = sessionHost()
    host.scriptRpc({ sessionId: 'sess-1' })
    host.scriptRpc({ sessionId: '' })
    const adapter = ompAdapter(host)

    const first = adapter.startRun(request())
    const second = adapter.startRun(request())
    expect(String(first.id)).toBe(`omp-${String(host.now())}-1`)
    expect(String(second.id)).toBe(`omp-${String(host.now())}-2`)
    expect(first.id).not.toBe(second.id)

    const firstResult = await first.result
    const secondResult = await second.result
    expect(firstResult.nativeSessionKey).toBe('omp:sess-1')
    expect(secondResult.status).toBe('failed')
    expect(host.spawns[0]?.args).toEqual(['--mode', 'rpc-ui'])
  })
})

describe('the adapter description', () => {
  it('expands the configured binary path, probes it once and caches the descriptor', async () => {
    const host = new FakeHost({ env: { PATH: '/usr/bin' }, home: HOME })
    host.addFile(`${HOME}/bin/omp`, '#!/bin/sh\n')
    host.script({ lines: ['omp 18.11.0'] })
    const adapter = ompAdapter(host, { binaryPath: '~/bin/omp' })

    const first = await adapter.describe()
    const second = await adapter.describe()
    expect(first.id).toBe(OMP_ID)
    expect(first.detection).toEqual({
      installed: true,
      binaryPath: `${HOME}/bin/omp`,
      source: 'config',
      version: 'omp 18.11.0',
    })
    expect(second).toBe(first)
    expect(host.spawns).toHaveLength(1)
    expect(host.spawns[0]).toMatchObject({ command: `${HOME}/bin/omp`, args: ['--version'], cwd: HOME })
    expect(first.environmentKeys).toEqual(OMP_RUN_ENVIRONMENT_KEYS)
  })

  it('reports an installed binary without a version when the probe answers nothing', async () => {
    const host = new FakeHost({ env: { PATH: '/usr/bin' }, home: HOME })
    host.addFile('/usr/bin/omp', '#!/bin/sh\n')
    host.script({})
    const descriptor = await ompAdapter(host).describe()
    expect(descriptor.detection).toEqual({ installed: true, binaryPath: '/usr/bin/omp', source: 'path' })
  })

  it('does not cache a detection failure as a permanent verdict', async () => {
    const host = new FakeHost({ env: { PATH: '/usr/bin' }, home: HOME })
    host.addFile('/opt/omp/bin/omp', '#!/bin/sh\n')
    host.failNextStat('/opt/omp/bin/omp', 'EACCES: permission denied')
    host.script({ lines: ['omp 18.11.0'] })
    const adapter = ompAdapter(host, { binaryPath: '/opt/omp/bin/omp' })

    await expect(adapter.describe()).rejects.toThrow('EACCES: permission denied')
    expect((await adapter.describe()).detection).toMatchObject({
      installed: true,
      binaryPath: '/opt/omp/bin/omp',
      source: 'config',
    })
  })
})

describe('mounting on a cordis context', () => {
  /** Mount `apply` on a fresh context with a recording mesh registry. */
  function mount(config?: Parameters<typeof apply>[1]): {
    ctx: Context
    registered: AgentAdapter[]
    unregistered: AgentAdapter[]
    llmProviders: string[][]
  } {
    const ctx = new Context()
    const registered: AgentAdapter[] = []
    const unregistered: AgentAdapter[] = []
    const llmProviders: string[][] = []
    ctx.provide('agentMesh', {
      register: (adapter: AgentAdapter) => {
        registered.push(adapter)
        return () => unregistered.push(adapter)
      },
    })
    ctx.provide('llm', {
      registerAdapter: (providers: readonly string[]) => {
        llmProviders.push([...providers])
        return () => undefined
      },
    } as never)
    if (config === undefined) apply(ctx)
    else apply(ctx, config)
    return { ctx, registered, unregistered, llmProviders }
  }

  it('resolves the store from the environment it layers over the harness process environment', async () => {
    const { ctx, registered, unregistered, llmProviders } = mount({ env: { HOME: '/staged/home' } })
    expect(llmProviders).toEqual([['agent-omp']])
    const adapter = registered[0]
    if (adapter === undefined) expect.unreachable('apply must register one adapter')

    const descriptor = await adapter.describe()
    expect(descriptor.sessionRoot).toBe('/staged/home/.omp/agent/sessions')
    const dispose = ctx.agentMesh.register(adapter)
    expect(dispose).toBeTypeOf('function')
    dispose()
    expect(unregistered).toEqual([adapter])
  })

  it('reports an unsupported native model route through the Cordis logger', async () => {
    const ctx = new Context()
    const modelsPath = '/opt/omp/models.yml'
    const content = [
      'providers:',
      '  unsupported:',
      '    auth: none',
      '    api: not-a-supported-api',
      '    models:',
      '      - id: model',
    ].join('\n')
    const bytes = Buffer.from(content)
    let llmAdapter: { listModels(provider: string): Promise<readonly unknown[]> } | undefined
    ctx.provide('agentMesh', { register: () => () => undefined } as never)
    ctx.provide('fs', {
      resolve: async (path: string) => path,
      stat: async (path: string) => path === modelsPath ? { type: 'file', size: bytes.length } : undefined,
      readByteRange: async (_path: string, range: { offset: number; length: number }) =>
        bytes.subarray(range.offset, range.offset + range.length),
    } as never)
    ctx.provide('llm', {
      registerAdapter: (_providers: readonly string[], adapter: { listModels(provider: string): Promise<readonly unknown[]> }) => {
        llmAdapter = adapter
        return () => undefined
      },
    } as never)

    apply(ctx, { homeDir: '/opt/omp' })
    if (llmAdapter === undefined) expect.unreachable('apply must register the native LLM adapter')
    await expect(llmAdapter.listModels('agent-omp')).resolves.toEqual([])
  })

  it('falls back to USERPROFILE for the home directory', async () => {
    const savedHome = process.env['HOME']
    const savedProfile = process.env['USERPROFILE']
    delete process.env['HOME']
    process.env['USERPROFILE'] = '/win/home'
    try {
      const { registered } = mount()
      const adapter = registered[0]
      if (adapter === undefined) expect.unreachable('apply must register one adapter')
      expect((await adapter.describe()).sessionRoot).toBe('/win/home/.omp/agent/sessions')
    } finally {
      restore('HOME', savedHome)
      restore('USERPROFILE', savedProfile)
    }
  })

  it('leaves the home directory to the host when neither variable is set', async () => {
    const savedHome = process.env['HOME']
    const savedProfile = process.env['USERPROFILE']
    delete process.env['HOME']
    delete process.env['USERPROFILE']
    try {
      const { registered } = mount()
      delete process.env['HOME']
      const adapter = registered[0]
      if (adapter === undefined) expect.unreachable('apply must register one adapter')
      expect((await adapter.describe()).sessionRoot).toBe(join(homedir(), '.omp', 'agent', 'sessions'))
    } finally {
      restore('HOME', savedHome)
      restore('USERPROFILE', savedProfile)
    }
  })
})

/** Put one process environment variable back the way it was. */
function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}
