import { describe, expect, it } from 'vitest'
import { codexAdapter } from '../src/index.ts'
import {
  applySessionIndexEntry,
  type CodexTitleEntry,
  isRolloutFileName,
  listRolloutFiles,
  locateRollout,
  parseRolloutHead,
  readSessionIndex,
  renderSessionSource,
  resolveCodexHome,
  threadIdFromFileName,
} from '../src/sessions.ts'
import { FakeHost } from './fake-host.ts'

const THREAD_A = '01920000-aaaa-bbbb-cccc-ddddeeeeffff'
const THREAD_B = '01920000-aaaa-bbbb-cccc-ddddeeee0002'
const THREAD_C = '01920000-aaaa-bbbb-cccc-ddddeeee0003'
const SESSIONS = '/home/tester/.codex/sessions/2026/10/16'
const ARCHIVED = '/home/tester/.codex/archived_sessions'

/** Build one `session_meta` rollout line. */
function sessionMeta(threadId: string, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    timestamp: '2026-10-16T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: threadId,
      timestamp: '2026-10-16T10:00:00.000Z',
      cwd: '/repo',
      originator: 'exec',
      cli_version: '0.50.0',
      source: 'cli',
      git: { branch: 'main', commit_hash: 'abc1234', repository_url: 'https://example.test/repo.git' },
      ...extra,
    },
  })
}

/** Build one `turn_context` rollout line. */
function turnContext(model: string): string {
  return JSON.stringify({ timestamp: '2026-10-16T10:00:01.000Z', type: 'turn_context', payload: { model } })
}

/** A rollout file with a usable header and one turn context. */
function readableRollout(threadId: string, extra: Readonly<Record<string, unknown>> = {}): string {
  return `${sessionMeta(threadId, extra)}\n${turnContext('gpt-5-codex')}\n`
}

describe('rollout file names', () => {
  it('recognizes plain and compressed rollouts', () => {
    expect(isRolloutFileName(`rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl`)).toBe(true)
    expect(isRolloutFileName(`rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl.zst`)).toBe(true)
    expect(isRolloutFileName('session_index.jsonl')).toBe(false)
  })

  it('extracts the thread id and ignores a reverted-thread suffix', () => {
    expect(threadIdFromFileName(`rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl`)).toBe(THREAD_A)
    expect(threadIdFromFileName(`rollout-2026-10-16T10-00-00-${THREAD_A}_rollout-2.jsonl.zst`)).toBe(THREAD_A)
    expect(threadIdFromFileName('notes.jsonl')).toBeUndefined()
    expect(threadIdFromFileName('rollout-short.jsonl')).toBeUndefined()
    expect(threadIdFromFileName('rollout-1234567890123456789-_x.jsonl')).toBeUndefined()
  })

  it('renders nested native sources and ignores empty or unsupported values', () => {
    expect(renderSessionSource({ sub_agent: { thread_spawn: 'worker' } })).toBe('sub_agent:thread_spawn:worker')
    expect(renderSessionSource('')).toBeUndefined()
    expect(renderSessionSource({})).toBeUndefined()
    expect(renderSessionSource({ empty: {} })).toBe('empty')
    expect(renderSessionSource(42)).toBeUndefined()
    expect(renderSessionSource({ a: { b: { c: { d: 'too deep' } } } })).toBe('a:b:c')
  })

  it('reads identity, git state and the model from a head', () => {
    const parsed = parseRolloutHead(readableRollout(THREAD_A), 'fallback')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.meta.threadId).toBe(THREAD_A)
    expect(parsed.meta.cwd).toBe('/repo')
    expect(parsed.meta.gitBranch).toBe('main')
    expect(parsed.meta.cliVersion).toBe('0.50.0')
    expect(parsed.meta.model).toBe('gpt-5-codex')
  })

  it('reports why a head has no usable metadata', () => {
    expect(parseRolloutHead('not json\n', 'fallback')).toEqual({
      ok: false,
      error: 'no parsable session_meta line in the head read (1 unparsable line(s))',
    })
    expect(parseRolloutHead('', 'fallback')).toEqual({ ok: false, error: 'no session_meta line in the head read' })
    expect(parseRolloutHead('null\n{"type":"session_meta"}', 'fallback')).toEqual({
      ok: false,
      error: 'no session_meta line in the head read',
    })
    expect(parseRolloutHead(`${JSON.stringify({ type: 'session_meta', payload: 5 })}\n`, 'fallback')).toEqual({
      ok: false,
      error: 'no session_meta line in the head read',
    })
  })

  it('reads nested metadata and uses its payload git fallback', () => {
    const parsed = parseRolloutHead(
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          meta: {
            session_id: 'root-thread',
            forked_from_id: 'fork-parent',
            parent_thread_id: 'parent-thread',
            timestamp: '2026-10-16T10:00:00.000Z',
            cwd: '/repo',
            originator: 'cli',
            cli_version: '0.50.0',
            source: { sub_agent: { thread_spawn: 'worker' } },
            thread_source: 'sub-agent',
            agent_nickname: 'reviewer',
            agent_role: 'assistant',
            model_provider: 'openai',
          },
          git: { branch: 'feature', commit_hash: 'deadbeef', repository_url: 'https://example.test/project.git' },
        },
      })}\n${turnContext('gpt-5-codex')}\n`,
      'fallback',
    )
    expect(parsed).toMatchObject({
      ok: true,
      meta: {
        threadId: 'root-thread',
        sessionId: 'root-thread',
        forkedFromId: 'fork-parent',
        parentThreadId: 'parent-thread',
        source: 'sub_agent:thread_spawn:worker',
        threadSource: 'sub-agent',
        agentNickname: 'reviewer',
        agentRole: 'assistant',
        modelProvider: 'openai',
        gitBranch: 'feature',
        gitCommit: 'deadbeef',
        gitOriginUrl: 'https://example.test/project.git',
        model: 'gpt-5-codex',
      },
    })
    const withoutId = parseRolloutHead(`${JSON.stringify({ type: 'session_meta', payload: { session_id: 'root-only' } })}\n`, 'fallback')
    expect(withoutId).toMatchObject({ ok: true, meta: { threadId: 'root-only' } })
    expect(parseRolloutHead(`${JSON.stringify({ type: 'session_meta', payload: {} })}\n`, 'fallback')).toMatchObject({
      ok: true,
      meta: { threadId: 'fallback' },
    })
    expect(parseRolloutHead(`${turnContext('first')}\n${turnContext('later')}\n${sessionMeta(THREAD_A)}\n`, 'fallback')).toMatchObject({
      ok: true,
      meta: { threadId: THREAD_A, model: 'first' },
    })
  })
})

describe('session listing', () => {
  it('projects a readable rollout with its indexed title', async () => {
    const host = new FakeHost()
    host.addFile(`${SESSIONS}/rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl`, readableRollout(THREAD_A), Date.parse('2026-10-16T10:05:00.000Z'))
    host.addFile(
      '/home/tester/.codex/session_index.jsonl',
      `${JSON.stringify({ id: THREAD_A, thread_name: 'Fix the parser', updated_at: '2026-10-16T10:06:00.000Z' })}\n`,
    )
    const sessions = await codexAdapter(host).listSessions({})
    expect(sessions).toHaveLength(1)
    const session = sessions[0]
    expect(session?.key).toBe(`codex:${THREAD_A}`)
    expect(session?.agentId).toBe('codex')
    expect(session?.nativeId).toBe(THREAD_A)
    expect(session?.nativePath).toBe(`${SESSIONS}/rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl`)
    expect(session?.title).toBe('Fix the parser')
    expect(session?.titleIsNative).toBe(true)
    expect(session?.cwd).toBe('/repo')
    expect(session?.branch).toBe('main')
    expect(session?.model).toBe('gpt-5-codex')
    expect(session?.createdAt).toBe('2026-10-16T10:00:00.000Z')
    expect(session?.updatedAt).toBe('2026-10-16T10:06:00.000Z')
    expect(session?.status).toBe('idle')
    expect(session?.notes).toContain('usage: token usage lives in the rollout tail, which listing does not read')
    expect(session?.notes).toContain('messageCount: Codex records no message count for a rollout; counting would require a full read')
    expect(session?.notes).toContain('repoRoot: the repository root is not resolved during listing, which would cost one git spawn per session')
    expect(session?.notes.join('\n')).toContain('updatedAt: the session index timestamp is preferred over the rollout file modification time')
    expect(session?.notes.join('\n')).toContain('the session header also records a commit sha and a remote url')
  })

  it('falls back to the rollout mtime for listed fields it cannot know', async () => {
    const host = new FakeHost()
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: THREAD_B } })
    host.addFile(`${SESSIONS}/rollout-2026-10-16T09-00-00-${THREAD_B}.jsonl`, `${meta}\n`, Date.parse('2026-10-16T09:30:00.000Z'))
    const sessions = await codexAdapter(host).listSessions({})
    const session = sessions[0]
    expect(session?.createdAt).toBe('2026-10-16T09:30:00.000Z')
    expect(session?.updatedAt).toBe('2026-10-16T09:30:00.000Z')
    expect(session?.notes).toContain('title: no entry for this thread in session_index.jsonl, and the first user message is not read during listing')
    expect(session?.notes).toContain('createdAt: the session header carries no timestamp, so the rollout file modification time stands in')
    expect(session?.notes).toContain('cwd: the session header carries no working directory')
    expect(session?.notes).toContain('model: no turn_context line appeared in the bounded head read')
    expect(session?.notes).toContain('source: the session header carries no session source')
  })

  it('marks archived rollouts and their source', async () => {
    const host = new FakeHost()
    host.addFile(`${ARCHIVED}/rollout-2026-10-15T09-00-00-${THREAD_B}.jsonl`, readableRollout(THREAD_B), Date.parse('2026-10-15T09:10:00.000Z'))
    const sessions = await codexAdapter(host).listSessions({})
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.source).toBe('cli (archived)')
    expect(sessions[0]?.notes).toContain('source: the rollout lives under archived_sessions rather than sessions')
  })

  it('uses archived source and fork metadata when the header omits a source token', async () => {
    const host = new FakeHost()
    host.addFile(
      `${ARCHIVED}/rollout-2026-10-15T08-00-00-${THREAD_C}.jsonl`,
      readableRollout(THREAD_C, { source: null, forked_from_id: THREAD_B }),
    )
    host.addFile(`${SESSIONS}/rollout-2026-10-15T07-00-00-${THREAD_A}.jsonl`, readableRollout(THREAD_A, { parent_thread_id: THREAD_B }))
    const sessions = await codexAdapter(host).listSessions({})
    const archived = sessions.find(session => session.nativeId === THREAD_C)
    const parented = sessions.find(session => session.nativeId === THREAD_A)
    expect(archived?.source).toBe('archived')
    expect(archived?.parentNativeId).toBe(THREAD_B)
    expect(archived?.notes).toContain('parentNativeId: taken from the header field forked_from_id')
    expect(parented?.parentNativeId).toBe(THREAD_B)
  })

  it('reports an unparsable rollout as unreadable without losing the listing', async () => {
    const host = new FakeHost()
    host.addFile(`${SESSIONS}/rollout-2026-10-16T08-00-00-${THREAD_C}.jsonl`, 'not a rollout line\n', Date.parse('2026-10-16T08:05:00.000Z'))
    host.addFile(`${SESSIONS}/rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl`, readableRollout(THREAD_A), Date.parse('2026-10-16T10:05:00.000Z'))
    const sessions = await codexAdapter(host).listSessions({})
    expect(sessions.map(session => session.status)).toEqual(['idle', 'unreadable'])
    const unreadable = sessions[1]
    expect(unreadable?.nativeId).toBe(THREAD_C)
    expect(unreadable?.notes).toEqual(['the rollout head could not be parsed: no parsable session_meta line in the head read (1 unparsable line(s))'])
    expect(host.logs.some(entry => entry.message.includes('codex rollout head is unusable'))).toBe(true)
  })

  it('keeps the filename as identity when a rollout filename or header has no id', async () => {
    const host = new FakeHost()
    host.addFile(`${SESSIONS}/rollout-short.jsonl`, `${JSON.stringify({ type: 'session_meta', payload: {} })}\n`)
    const session = (await codexAdapter(host).listSessions({}))[0]
    expect(session?.nativeId).toBe('rollout-short.jsonl')
  })

  it('records session header fields that do not have mesh session fields', async () => {
    const host = new FakeHost()
    host.addFile(
      `${SESSIONS}/rollout-2026-10-16T06-00-00-${THREAD_A}.jsonl`,
      readableRollout(THREAD_A, {
        session_id: THREAD_B,
        thread_source: 'sub-agent',
        agent_nickname: 'reviewer',
        agent_role: 'assistant',
        model_provider: 'openai',
      }),
    )
    const session = (await codexAdapter(host).listSessions({}))[0]
    expect(session?.notes.join('\n')).toContain('the session header also carries session_id, originator, cli_version, thread_source, agent_nickname, agent_role, model_provider')
  })

  it('reports a zstd-compressed rollout as unreadable with the plugin note', async () => {
    const host = new FakeHost()
    host.addFile(`${SESSIONS}/rollout-2026-10-16T07-00-00-${THREAD_C}.jsonl.zst`, 'binary', Date.parse('2026-10-16T07:05:00.000Z'))
    const sessions = await codexAdapter(host).listSessions({})
    expect(sessions[0]?.status).toBe('unreadable')
    expect(sessions[0]?.nativeId).toBe(THREAD_C)
    expect(sessions[0]?.notes[0]).toContain('zstd-compressed (rollout-*.jsonl.zst)')
    expect(host.logs.some(entry => entry.level === 'warn' && entry.message.includes('zstd-compressed'))).toBe(true)
  })

  it('keeps the readable record when a thread has both a plain and a compressed rollout', async () => {
    const host = new FakeHost()
    host.addFile(`${SESSIONS}/rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl`, readableRollout(THREAD_A), Date.parse('2026-10-16T10:05:00.000Z'))
    host.addFile(`${ARCHIVED}/rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl.zst`, 'binary', Date.parse('2026-10-16T11:05:00.000Z'))
    host.addFile(`${ARCHIVED}/rollout-2026-10-16T09-00-00-${THREAD_A}.jsonl`, readableRollout(THREAD_A), Date.parse('2026-10-16T09:05:00.000Z'))
    const sessions = await codexAdapter(host).listSessions({})
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.status).toBe('idle')
    expect(sessions[0]?.nativePath).toContain('/sessions/')
  })

  it('filters by cwd and caps the result', async () => {
    const host = new FakeHost()
    host.addFile(`${SESSIONS}/rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl`, readableRollout(THREAD_A), Date.parse('2026-10-16T10:05:00.000Z'))
    host.addFile(
      `${SESSIONS}/rollout-2026-10-16T11-00-00-${THREAD_B}.jsonl`,
      readableRollout(THREAD_B, { cwd: '/other' }),
      Date.parse('2026-10-16T11:05:00.000Z'),
    )
    const adapter = codexAdapter(host)
    expect((await adapter.listSessions({ cwd: '/repo' })).map(session => session.cwd)).toEqual(['/repo'])
    expect(await adapter.listSessions({ cwd: '/nowhere' })).toEqual([])
    expect((await adapter.listSessions({ limit: 1 })).map(session => session.nativeId)).toEqual([THREAD_B])
    expect(await adapter.listSessions({ limit: 1, signal: AbortSignal.abort() })).toEqual([])
  })

  it('resolves default and relative home settings', async () => {
    const emptySettings = new FakeHost()
    emptySettings.env['CODEX_HOME'] = ''
    expect(await resolveCodexHome(emptySettings, '')).toMatchObject({ path: '/home/tester/.codex', fromEnv: false })
    expect(await resolveCodexHome(emptySettings, '~/custom-codex')).toMatchObject({ path: '/home/tester/custom-codex', fromEnv: false })

    const invalidEnvironment = new FakeHost()
    invalidEnvironment.env['CODEX_HOME'] = '/missing/codex'
    expect(await resolveCodexHome(invalidEnvironment)).toMatchObject({
      path: '/home/tester/.codex',
      fromEnv: false,
      fallbackReason: 'CODEX_HOME is set to /missing/codex, which is not a directory; using /home/tester/.codex',
    })

    const relativeEnvironment = new FakeHost()
    relativeEnvironment.env['CODEX_HOME'] = 'relative-codex'
    relativeEnvironment.addDir('relative-codex')
    expect(await resolveCodexHome(relativeEnvironment)).toMatchObject({ path: '/home/tester/.codex', fromEnv: true })
  })

  it('folds valid title rows, ignores malformed rows, and allows index updates without timestamps', async () => {
    const host = new FakeHost()
    host.addFile(
      '/home/tester/.codex/session_index.jsonl',
      [
        'not json',
        'null',
        JSON.stringify({ id: 'missing-title' }),
        JSON.stringify({ id: 'thread', thread_name: 'Native title' }),
      ].join('\n'),
    )
    const home = await resolveCodexHome(host)
    const index = await readSessionIndex(host, home)
    expect(index.get('thread')).toEqual({ title: 'Native title' })
    const updated = new Map<string, CodexTitleEntry>()
    applySessionIndexEntry(updated, { id: 'thread', thread_name: 'Updated title' })
    applySessionIndexEntry(updated, { id: 'missing-title' })
    expect(updated.get('thread')).toEqual({ title: 'Updated title' })
    expect(updated.size).toBe(1)
  })

  it('bounds directory depth and rollout count', async () => {
    const deep = new FakeHost()
    deep.addFile('/home/tester/.codex/sessions/a/b/c/d/e/f/rollout-2026-10-16T10-00-00-deep.jsonl', readableRollout(THREAD_A))
    deep.addFile('/home/tester/.codex/sessions/readme.md')
    const home = await resolveCodexHome(deep)
    expect(await listRolloutFiles(deep, home)).toEqual([])

    const crowded = new FakeHost()
    crowded.listDir = async (path) => {
      if (path !== home.sessionsRoot) return []
      return Array.from({ length: 5001 }, (_, index) => ({
        name: `rollout-2026-10-16T10-00-00-${String(index).padStart(4, '0')}.jsonl`,
        isDirectory: false,
        mtimeMs: index,
      }))
    }
    const crowdedHome = await resolveCodexHome(crowded)
    expect((await listRolloutFiles(crowded, crowdedHome))).toHaveLength(5000)
  })

  it('locates the best matching rollout and returns no result for an empty id', async () => {
    const host = new FakeHost()
    host.addFile(`${SESSIONS}/rollout-2026-10-16T08-00-00-${THREAD_A}.jsonl`, readableRollout(THREAD_A), 1)
    host.addFile(`${SESSIONS}/rollout-2026-10-16T09-00-00-${THREAD_A}.jsonl`, readableRollout(THREAD_A), 3)
    host.addFile(`${SESSIONS}/rollout-2026-10-16T10-00-00-${THREAD_A}.jsonl.zst`, 'binary', 2)
    const home = await resolveCodexHome(host)
    expect(await locateRollout(host, home, '')).toBeUndefined()
    expect((await locateRollout(host, home, THREAD_A))?.compressed).toBe(false)
    expect(await locateRollout(new FakeHost(), home, THREAD_A)).toBeUndefined()
  })
})
