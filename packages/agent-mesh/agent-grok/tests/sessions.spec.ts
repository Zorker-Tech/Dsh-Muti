import { describe, expect, it, vi } from 'vitest'
import { resolveGrokConfig } from '../src/config.ts'
import { grokAdapter } from '../src/index.ts'
import { decodeCwdDirName, findGrokSessionDir, listGrokSessions, parseGrokSummary, readStoreJson, resolveGrokPaths } from '../src/sessions.ts'
import { MemoryHost } from './support/memory-host.ts'

const ROOT = '/home/tester/.grok/sessions'

/** The cwd-level directory grok encodes a working directory into. */
const cwdDir = (cwd: string): string => `${ROOT}/${encodeURIComponent(cwd)}`

/** One session directory under an encoded cwd. */
const sessionDir = (cwd: string, id: string): string => `${cwdDir(cwd)}/${id}`

/** A summary.json body with grok's own field names. */
const SUMMARY = {
  info: { id: 'sess-a', cwd: '/work/alpha' },
  session_summary: 'a plain summary',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  num_messages: 7,
  num_chat_messages: 9,
  current_model_id: 'grok-4',
  parent_session_id: 'sess-parent',
  session_kind: 'primary',
  git_root_dir: '/work/alpha',
  head_branch: 'main',
  sandbox_profile: 'workspace',
  worktree_label: 'grok-wt',
  source_workspace_dir: '/work/alpha-src',
  title_is_manual: true,
  generated_title: 'Generated title',
}

describe('grok session listing', () => {
  it('projects a readable summary onto the mesh session row', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: { [`${sessionDir('/work/alpha', 'sess-a')}/summary.json`]: JSON.stringify(SUMMARY) },
    })
    const sessions = await grokAdapter(host, resolveGrokConfig()).listSessions({})

    expect(sessions).toEqual([{
      key: 'grok:sess-a',
      agentId: 'grok',
      nativeId: 'sess-a',
      title: 'Generated title',
      titleIsNative: true,
      cwd: '/work/alpha',
      repoRoot: '/work/alpha',
      branch: 'main',
      model: 'grok-4',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      status: 'idle',
      messageCount: 7,
      parentNativeId: 'sess-parent',
      source: 'primary',
      notes: [
        'sandboxProfile: grok created this session with sandbox profile "workspace" and refuses to resume it under a different explicit profile; no canonical session field carries it',
        'source: grok labels this its own worktree "grok-wt"; this adapter always creates the worktree itself and passes --cwd instead',
        'cwd: grok recorded a source workspace of /work/alpha-src for this worktree session',
        'title: the title was set by a manual rename, not by automatic titling',
      ],
    }])
  })

  it('degrades a malformed summary to an unreadable session with its reason declared', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: { [`${sessionDir('/work/beta', 'sess-b')}/summary.json`]: '{"info":' },
      mtimes: { [sessionDir('/work/beta', 'sess-b')]: Date.parse('2026-04-02T00:00:00.000Z') },
    })
    const sessions = await grokAdapter(host, resolveGrokConfig()).listSessions({})
    const session = sessions[0]

    expect(session?.status).toBe('unreadable')
    expect(session?.nativeId).toBe('sess-b')
    expect(session?.cwd).toBe('/work/beta')
    expect(session?.createdAt).toBe('2026-04-02T00:00:00.000Z')
    expect(session?.updatedAt).toBe('2026-04-02T00:00:00.000Z')
    expect(session?.notes[0]).toMatch(/^summary\.json could not be parsed: /)
    expect(session?.notes.slice(1)).toEqual([
      'cwd: cwd recovered from the session directory name or its .cwd marker; summary.json did not carry info.cwd',
      'the session is readable only as a directory; its summary was not parsable',
      'summary.json recorded no usable timestamp, so the session directory modification time stands in for createdAt/updatedAt',
    ])
  })

  it('recovers a cwd from the .cwd marker when the directory name is a slug', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${ROOT}/my-slug-9f2a/.cwd`]: '/work/slug\n',
        [`${ROOT}/my-slug-9f2a/sess-slug/summary.json`]: JSON.stringify({
          info: { id: 'sess-slug' },
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-01T00:00:00.000Z',
        }),
      },
    })
    const sessions = await grokAdapter(host, resolveGrokConfig()).listSessions({})

    expect(sessions[0]?.cwd).toBe('/work/slug')
    expect(sessions[0]?.notes).toEqual([
      'cwd: cwd recovered from the session directory name or its .cwd marker; summary.json did not carry info.cwd',
    ])
  })

  it('notes a session grok marks hidden', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir('/work/alpha', 'sess-h')}/summary.json`]: JSON.stringify({
          info: { id: 'sess-h', cwd: '/work/alpha' },
          hidden: true,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        }),
      },
    })
    const sessions = await grokAdapter(host, resolveGrokConfig()).listSessions({})

    expect(sessions[0]?.notes).toEqual([
      'grok marks this session hidden (hidden: true); it is listed here but is normally not shown',
    ])
  })

  it('falls back to the session summary for a title, and to the directory name for an id', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir('/work/alpha', 'sess-title')}/summary.json`]: JSON.stringify({
          info: { id: 'sess-title', cwd: '/work/alpha' },
          session_summary: 'what happened',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        }),
      },
    })
    const sessions = await grokAdapter(host, resolveGrokConfig()).listSessions({})

    expect(sessions[0]?.title).toBe('what happened')
    expect(sessions[0]?.titleIsNative).toBe(true)
  })

  it('orders newest first and applies the limit', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir('/work/alpha', 'sess-old')}/summary.json`]: JSON.stringify({
          info: { id: 'sess-old' },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        }),
        [`${sessionDir('/work/alpha', 'sess-new')}/summary.json`]: JSON.stringify({
          info: { id: 'sess-new' },
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        }),
      },
    })
    const adapter = grokAdapter(host, resolveGrokConfig())

    expect((await adapter.listSessions({})).map(session => session.nativeId)).toEqual(['sess-new', 'sess-old'])
    expect((await adapter.listSessions({ limit: 1 })).map(session => session.nativeId)).toEqual(['sess-new'])
  })

  it('filters by recorded working directory', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir('/work/alpha', 'sess-a')}/summary.json`]: JSON.stringify({
          info: { id: 'sess-a', cwd: '/work/alpha' },
          updated_at: '2026-01-02T00:00:00.000Z',
        }),
        [`${sessionDir('/work/beta', 'sess-b')}/summary.json`]: JSON.stringify({
          info: { id: 'sess-b', cwd: '/work/beta' },
          updated_at: '2026-01-03T00:00:00.000Z',
        }),
      },
    })
    const adapter = grokAdapter(host, resolveGrokConfig())

    expect((await adapter.listSessions({ cwd: '/work/alpha' })).map(session => session.nativeId)).toEqual(['sess-a'])
    expect(await adapter.listSessions({ cwd: '/work/gamma' })).toEqual([])
  })

  it('returns nothing for an absent root and ignores stray files', async () => {
    const absent = new MemoryHost({ home: '/home/tester', env: { PATH: '' } })
    expect(await grokAdapter(absent, resolveGrokConfig()).listSessions({})).toEqual([])

    const stray = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: { [`${ROOT}/README`]: 'not a session' },
    })
    expect(await grokAdapter(stray, resolveGrokConfig()).listSessions({})).toEqual([])
  })

  it('stops on an aborted signal', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir('/work/alpha', 'sess-a')}/summary.json`]: JSON.stringify({ info: { id: 'sess-a' } }),
      },
    })
    const sessions = await grokAdapter(host, resolveGrokConfig()).listSessions({ signal: AbortSignal.abort() })

    expect(sessions).toEqual([])
  })

  it('stops between listing cwd directories and their session entries', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: { [`${sessionDir('/work/alpha', 'sess-a')}/summary.json`]: JSON.stringify({ info: { id: 'sess-a' } }) },
    })
    const controller = new AbortController()
    const listDir = host.listDir.bind(host)
    host.listDir = async (path) => {
      const entries = await listDir(path)
      if (path === cwdDir('/work/alpha')) controller.abort()
      return entries
    }

    expect(await listGrokSessions({
      host,
      paths: resolveGrokPaths(host),
      options: { signal: controller.signal },
    })).toEqual([])
  })

  it('orders sessions with equal activity timestamps by native id', async () => {
    const summary = (id: string): string => JSON.stringify({
      info: { id, cwd: '/work/alpha' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    })
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir('/work/alpha', 'sess-z')}/summary.json`]: summary('sess-z'),
        [`${sessionDir('/work/alpha', 'sess-a')}/summary.json`]: summary('sess-a'),
      },
    })

    expect((await grokAdapter(host, resolveGrokConfig()).listSessions({})).map(session => session.nativeId)).toEqual([
      'sess-a',
      'sess-z',
    ])

    const ascending = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir('/work/alpha', 'sess-a')}/summary.json`]: summary('sess-a'),
        [`${sessionDir('/work/alpha', 'sess-z')}/summary.json`]: summary('sess-z'),
      },
    })
    expect((await grokAdapter(ascending, resolveGrokConfig()).listSessions({})).map(session => session.nativeId)).toEqual([
      'sess-a',
      'sess-z',
    ])
  })

  it('reports bounded and empty JSON stores and decodes malformed cwd names from their marker', async () => {
    const oversized = new MemoryHost({ home: '/home/tester', env: {}, files: { '/store/large.json': '{"a":1}' } })
    await expect(readStoreJson(oversized, '/store/large.json', 2)).resolves.toMatchObject({
      present: true,
      ok: false,
      error: 'the file is larger than the 2-byte read cap',
    })

    const empty = new MemoryHost({ home: '/home/tester', env: {}, files: { '/store/empty.json': '' } })
    await expect(readStoreJson(empty, '/store/empty.json', 16)).resolves.toEqual({
      present: true,
      ok: false,
      error: 'the file is empty',
    })

    expect(parseGrokSummary(null)).toEqual({})
    expect(parseGrokSummary({ created_at: 'not-a-time' })).toEqual({})
    const cwdDirWithBadEncoding = `${ROOT}/bad%ZZ`
    const marker = new MemoryHost({
      home: '/home/tester',
      env: {},
      files: { [`${cwdDirWithBadEncoding}/.cwd`]: '/work/from-marker\n' },
    })
    await expect(decodeCwdDirName(marker, cwdDirWithBadEncoding)).resolves.toBe('/work/from-marker')
    await expect(decodeCwdDirName(marker, `${ROOT}/still%ZZ`)).resolves.toBeUndefined()
    await expect(findGrokSessionDir(marker, resolveGrokPaths(marker), '')).resolves.toBeUndefined()

    const parseFailure = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw 'invalid summary' })
    try {
      await expect(readStoreJson(new MemoryHost({
        home: '/home/tester', env: {}, files: { '/store/read-error.json': '{}' },
      }), '/store/read-error.json', 16)).resolves.toMatchObject({ present: true, ok: false, error: 'invalid summary' })
    } finally {
      parseFailure.mockRestore()
    }

    const emptyOverrides = new MemoryHost({ home: '/home/tester', env: { GROK_HOME: '', GROK_AUTH_PATH: '' } })
    expect(resolveGrokPaths(emptyOverrides, '')).toEqual({
      home: '/home/tester/.grok',
      homeFromEnv: false,
      sessionRoot: '/home/tester/.grok/sessions',
      credentialPath: '/home/tester/.grok/auth.json',
    })
    expect(resolveGrokPaths(emptyOverrides, '~/configured').home).toBe('/home/tester/configured')

    const environmentOverrides = new MemoryHost({
      home: '/home/tester',
      env: { GROK_HOME: '/store/grok', GROK_AUTH_PATH: '/secrets/auth.json' },
    })
    expect(resolveGrokPaths(environmentOverrides)).toEqual({
      home: '/store/grok',
      homeFromEnv: true,
      sessionRoot: '/store/grok/sessions',
      credentialPath: '/secrets/auth.json',
    })
  })

  it('skips non-directory cwd entries and missing session directories', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: {},
      files: {
        [`${ROOT}/README`]: 'not a cwd directory',
        [`${sessionDir('/work/alpha', 'sess-present')}/summary.json`]: JSON.stringify({ info: { id: 'sess-present' } }),
      },
    })

    await expect(findGrokSessionDir(host, resolveGrokPaths(host), 'missing')).resolves.toBeUndefined()
  })

  it('keeps a session with no summary or recoverable cwd as an unreadable row', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${ROOT}/opaque-slug/sess-no-cwd/summary.json`]: JSON.stringify({
          info: { id: 'sess-no-cwd' },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        }),
      },
    })
    host.addDir(`${ROOT}/plain-slug/sess-no-summary`)

    const sessions = await grokAdapter(host, resolveGrokConfig()).listSessions({})
    expect(sessions.map(session => [session.nativeId, session.cwd, session.status])).toEqual([
      ['sess-no-cwd', undefined, 'idle'],
      ['sess-no-summary', undefined, 'unreadable'],
    ])
    expect(sessions[1]?.notes).toContain('summary.json is absent; only the directory name and its timestamps are projected')
    expect(sessions[1]?.notes).toContain('the session is readable only as a directory; its summary was not parsable')
  })
})
