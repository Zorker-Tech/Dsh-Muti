import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentSession } from '@deepseek-ai/dsh-agent-mesh'
import {
  OMP_TITLE_SLOT_BYTES,
  activeProfile,
  decodeCwdDirName,
  encodeCwdDirName,
  findOmpSessionFile,
  foldOmpEntries,
  isoOrUndefined,
  isRecord,
  listOmpSessions,
  ompBranch,
  readArray,
  readBoolean,
  readNumber,
  readOmpEntry,
  readOmpSessionHeader,
  readOmpSessionLeadAt,
  readOmpSessionView,
  readOmpTitleSlot,
  readRecord,
  readString,
  resolveOmpStore,
} from '../src/sessions.ts'
import type { OmpNativeEntry, OmpSessionView } from '../src/sessions.ts'
import { readOmpTranscript } from '../src/transcript.ts'
import { resolveOmpConfig } from '../src/config.ts'
import { assistantMessage, entry, messageEntry, sessionFile, sessionHeader, titleSlot } from './support/fixtures.ts'
import { FakeHost } from './support/fake-host.ts'

const HOME = '/home/tester'
const AGENT_DIR = '/home/tester/.omp/agent'
const SESSIONS_DIR = `${AGENT_DIR}/sessions`
const BUCKET = `${SESSIONS_DIR}/-work-repo`
const agentId = brandString<AgentId>('omp')

/** Build one already-narrowed native entry for direct fold and branch cases. */
function nativeEntry(
  id: string,
  type: string,
  record: Record<string, unknown> = {},
  parentId: string | null = null,
  timestamp = '',
): OmpNativeEntry {
  return { id, type, record, parentId, timestamp, raw: '' }
}

/** Build one read window for direct branch cases. */
function sessionView(entries: readonly OmpNativeEntry[], windowTruncated = false): OmpSessionView {
  return {
    entries,
    windowTruncated,
    droppedPartialLine: false,
    size: 0,
    mtimeMs: 0,
    malformed: 0,
    missing: false,
    notes: [],
  }
}

/** A host with the layout resolved for a bare HOME. */
function hostFor(env: Readonly<Record<string, string | undefined>> = {}): { host: FakeHost; layout: ReturnType<typeof resolveOmpStore> } {
  const host = new FakeHost({ env, home: HOME })
  const layout = resolveOmpStore({ host, config: resolveOmpConfig() })
  return { host, layout }
}

/** A file that disappears after stat but before its bounded reads. */
class VanishingHost extends FakeHost {
  private readonly vanishedPaths = new Set<string>()

  vanishAfterStat(path: string): void {
    this.vanishedPaths.add(path)
  }

  override async readHead(path: string, maxBytes: number): Promise<string> {
    return this.vanishedPaths.has(path) ? '' : super.readHead(path, maxBytes)
  }

  override async readTail(path: string, maxBytes: number): Promise<{ text: string; droppedPartialLine: boolean }> {
    return this.vanishedPaths.has(path) ? { text: '', droppedPartialLine: false } : super.readTail(path, maxBytes)
  }
}

/** List sessions with the default options. */
async function list(
  host: FakeHost,
  layout: ReturnType<typeof resolveOmpStore>,
  options: { cwd?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<readonly AgentSession[]> {
  return listOmpSessions({ host, agentId, layout, options })
}

describe('OMP session file records', () => {
  it('reads the padded title slot and the header from the head of a file', async () => {
    const { host } = hostFor()
    const path = `${BUCKET}/1750000000000_sess-1.jsonl`
    host.addFile(
      path,
      sessionFile({
        title: 'Fix the parser',
        header: sessionHeader({ id: 'sess-1', cwd: '/work/repo', version: 3, title: 'folded title', extra: { additionalDirectories: ['/work/other'] } }),
        entries: [entry('e1', null, 'label', { label: 'start' })],
      }),
    )

    const lead = await readOmpSessionLeadAt(host, path)
    expect(lead.titleSlot).toEqual({ title: 'Fix the parser' })
    expect(lead.header).toMatchObject({
      id: 'sess-1',
      cwd: '/work/repo',
      version: 3,
      title: 'folded title',
      additionalDirectories: 1,
      previousSessionFiles: 0,
      hasProviderPromptCacheKey: false,
    })
  })

  it('parses the slot and header independently of their position', () => {
    expect(readOmpTitleSlot({ type: 'title', title: 'T', source: 'auto', updatedAt: 'now' }))
      .toEqual({ title: 'T', source: 'auto', updatedAt: 'now' })
    expect(readOmpTitleSlot({ type: 'session', id: 'x' })).toBeUndefined()
    expect(readOmpSessionHeader({ type: 'session', id: '' })).toBeUndefined()
    expect(readOmpSessionHeader({ type: 'session', id: 's1' })).toMatchObject({ id: 's1', cwd: '', timestamp: '' })
  })

  it('pads the slot to the fixed width OMP writes', () => {
    const slot = titleSlot('T')
    expect(Buffer.byteLength(slot, 'utf8')).toBe(OMP_TITLE_SLOT_BYTES)
  })

  it('narrows decoded JSON values and rejects malformed native records', () => {
    const object = { text: 'value', number: 3, infinity: Number.POSITIVE_INFINITY, flag: true, nested: { ok: true }, list: [1] }
    expect(isRecord(object)).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([1])).toBe(false)
    expect(isRecord('value')).toBe(false)
    expect(readString(object, 'text')).toBe('value')
    expect(readString(object, 'number')).toBeUndefined()
    expect(readNumber(object, 'number')).toBe(3)
    expect(readNumber(object, 'infinity')).toBeUndefined()
    expect(readNumber(object, 'text')).toBeUndefined()
    expect(readBoolean(object, 'flag')).toBe(true)
    expect(readBoolean(object, 'text')).toBeUndefined()
    expect(readRecord(object, 'nested')).toEqual({ ok: true })
    expect(readRecord(object, 'list')).toBeUndefined()
    expect(readArray(object, 'list')).toEqual([1])
    expect(readArray(object, 'nested')).toBeUndefined()

    expect(readOmpTitleSlot({ type: 'title' })).toBeUndefined()
    expect(readOmpEntry(null, 'null')).toBeUndefined()
    expect(readOmpEntry({ id: '', type: 'message' }, '{}')).toBeUndefined()
    expect(readOmpEntry({ id: 'e1', type: '' }, '{}')).toBeUndefined()
    const entry = readOmpEntry({ id: 'e1', type: 'message', parentId: 4 }, 'x'.repeat(4_001))
    expect(entry).toMatchObject({ id: 'e1', parentId: null, timestamp: '', raw: 'x'.repeat(4_000) })
    expect(readOmpEntry({ id: 'e2', type: 'message', parentId: 'e1', timestamp: 'now' }, '{}'))
      .toMatchObject({ parentId: 'e1', timestamp: 'now' })
  })

  it('uses only valid header fields and normalizes optional strings and counters', () => {
    expect(readOmpSessionHeader({ type: 'session', id: 's1', version: 2.9, parentSession: '', title: '', titleSource: '' }))
      .toMatchObject({ version: 2, additionalDirectories: 0, previousSessionFiles: 0, hasProviderPromptCacheKey: false })
    expect(readOmpSessionHeader({
      type: 'session', id: 's2', version: Number.NaN, parentSession: 'parent', title: 'T', titleSource: 'user',
      providerPromptCacheKey: '', additionalDirectories: ['a'], previousSessionFiles: ['b', 'c'],
    })).toMatchObject({
      id: 's2', parentSession: 'parent', title: 'T', titleSource: 'user', additionalDirectories: 1,
      previousSessionFiles: 2, hasProviderPromptCacheKey: true,
    })
  })

  it('reads whole, missing and bounded large session views', async () => {
    const { host } = hostFor()
    const missing = await readOmpSessionView(host, `${BUCKET}/missing.jsonl`, 1)
    expect(missing).toMatchObject({ missing: true, size: -1, windowTruncated: false })

    const emptyPath = `${BUCKET}/empty.jsonl`
    host.addFile(emptyPath, '')
    expect(await readOmpSessionView(host, emptyPath, 1)).toMatchObject({ missing: true, size: 0 })

    const smallPath = `${BUCKET}/small.jsonl`
    host.addFile(smallPath, `not-json\n${sessionHeader({ id: 's1' })}{"id":"","type":"label"}\nnot-an-entry\n`)
    const small = await readOmpSessionView(host, smallPath, 100_000)
    expect(small).toMatchObject({ missing: false, windowTruncated: false, malformed: 3 })
    expect(small.header?.id).toBe('s1')

    const largePath = `${BUCKET}/large.jsonl`
    const manyEntries = `${Array.from({ length: 4_000 }, (_, index) => entry(`e${String(index)}`, null, 'label')).join('')}not-json\n{"id":"","type":"label"}\n`
    host.addFile(largePath, `${titleSlot('large')}${sessionHeader({ id: 'large' })}${manyEntries}`)
    const large = await readOmpSessionView(host, largePath, 1)
    expect(large).toMatchObject({ missing: false, windowTruncated: true, droppedPartialLine: true })
    expect(large.header?.id).toBe('large')
    expect(large.entries.length).toBeGreaterThan(0)
    const projectedLarge = (await list(host, resolveOmpStore({ host, config: resolveOmpConfig() })))
      .find(session => session.nativeId === 'large')
    expect(projectedLarge?.notes).toContain('usage: the file exceeded the read window; counts and usage cover only the live branch inside that window')
    expect(projectedLarge).not.toHaveProperty('messageCount')

    const incompleteLeadPath = `${BUCKET}/incomplete-lead.jsonl`
    host.addFile(incompleteLeadPath, `${titleSlot('only-title')}${'x'.repeat(300_000)}`)
    const incomplete = await readOmpSessionView(host, incompleteLeadPath, 1)
    expect(incomplete.notes).toContain('cwd: the title slot and session header did not both fit in 65536 bytes, so the cwd is unavailable')
    expect(incomplete.header).toBeUndefined()

    const vanishing = new VanishingHost({ home: HOME })
    vanishing.addFile(largePath, `${titleSlot('large')}${sessionHeader({ id: 'large' })}${manyEntries}`)
    vanishing.vanishAfterStat(largePath)
    expect(await readOmpSessionView(vanishing, largePath, 1)).toMatchObject({ missing: true, windowTruncated: false })
  })

  it('returns an empty lead when a file disappears or has no complete lead lines', async () => {
    const vanishing = new VanishingHost({ home: HOME })
    expect(await readOmpSessionLeadAt(vanishing, `${BUCKET}/gone.jsonl`)).toEqual({})

    const { host } = hostFor()
    const path = `${BUCKET}/one-line.jsonl`
    host.addFile(path, 'not-json')
    expect(await readOmpSessionLeadAt(host, path)).toEqual({})
  })
})

describe('OMP session layout helpers', () => {
  it('selects and normalizes the active profile', () => {
    expect(activeProfile({})).toBeUndefined()
    expect(activeProfile({ OMP_PROFILE: '  ' })).toBeUndefined()
    expect(activeProfile({ PI_PROFILE: 'default' })).toBeUndefined()
    expect(activeProfile({ PI_PROFILE: ' old ', OMP_PROFILE: ' named ' })).toBe('named')
    expect(activeProfile({ PI_PROFILE: ' legacy ' })).toBe('legacy')
  })

  it('encodes and decodes home, temp and absolute cwd buckets', () => {
    const options = { home: '/home/tester', tempRoot: '/tmp' }
    expect(encodeCwdDirName('/home/tester', options)).toBe('-')
    expect(encodeCwdDirName('/home/tester/work/repo', options)).toBe('-work-repo')
    expect(encodeCwdDirName('/tmp/job-1', options)).toBe('-tmp-job-1')
    expect(encodeCwdDirName('/Volumes/Net/repo', options)).toBe('--Volumes-Net-repo--')
    expect(encodeCwdDirName('/workspace', { home: '/', tempRoot: '/tmp' })).toBe('-workspace')
    expect(encodeCwdDirName('/tmp/defaults')).toBe('--tmp-defaults--')
    expect(decodeCwdDirName('-', options)).toBeUndefined()
    expect(decodeCwdDirName('--', options)).toBeUndefined()
    expect(decodeCwdDirName('plain', options)).toBeUndefined()
    expect(decodeCwdDirName('-tmp-', options)).toBeUndefined()
    expect(decodeCwdDirName('--Volumes-Net-repo--', options)).toBe('/Volumes/Net/repo')
    expect(decodeCwdDirName('-tmp-job-1', options)).toBe('/tmp/job/1')
    expect(decodeCwdDirName('-work-repo', options)).toBe('/home/tester/work/repo')
    expect(decodeCwdDirName('--Volumes-Net-Repo--', options)).toBe('/Volumes/Net/Repo')
    expect(decodeCwdDirName('--absolute--')).toBe('/absolute')
    expect(decodeCwdDirName('-workspace')).toBe(`${process.env['HOME']}/workspace`)
  })

  it('normalizes valid timestamps and declines empty or invalid values', () => {
    expect(isoOrUndefined(undefined)).toBeUndefined()
    expect(isoOrUndefined('')).toBeUndefined()
    expect(isoOrUndefined('not a timestamp')).toBeUndefined()
    expect(isoOrUndefined('2026-10-16T00:00:00Z')).toBe('2026-10-16T00:00:00.000Z')
  })

  it('expands the configured home sentinel to the host home', () => {
    const { host } = hostFor()
    const layout = resolveOmpStore({ host, config: resolveOmpConfig({ homeDir: '~' }) })
    expect(layout.agentDir).toBe(HOME)
    const childLayout = resolveOmpStore({ host, config: resolveOmpConfig({ homeDir: '~/omp' }) })
    expect(childLayout.agentDir).toBe(`${HOME}/omp`)
  })

  it('resolves named profile and environment overrides', () => {
    const { host } = hostFor({ OMP_PROFILE: 'staging', PI_CODING_AGENT_DIR: '/ignored', PI_CONFIG_DIR: '  ' })
    const layout = resolveOmpStore({ host, config: resolveOmpConfig() })
    expect(layout).toMatchObject({
      profile: 'staging', configRoot: `${HOME}/.omp`, agentDir: `${HOME}/.omp/profiles/staging/agent`,
      agentDirFromEnv: false,
    })
    const envLayout = resolveOmpStore({
      host,
      config: resolveOmpConfig(),
      env: { PI_CODING_AGENT_DIR: '~/custom', PI_CODING_AGENT_SESSION_DIR: '~/sessions' },
    })
    expect(envLayout).toMatchObject({
      agentDir: `${HOME}/custom`, sessionDirOverride: `${HOME}/sessions`, agentDirFromEnv: true,
      sessionsDirFromSetting: false,
    })
  })

  it('uses the current directory when the process has no HOME setting', () => {
    vi.stubEnv('HOME', undefined)
    try {
      expect(encodeCwdDirName('/tmp/defaults')).toBe('--tmp-defaults--')
      expect(decodeCwdDirName('-workspace')).toBe(`${process.cwd()}/workspace`)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('OMP session listing', () => {
  it('projects a session row from the header, the slot and the live branch', async () => {
    const { host, layout } = hostFor()
    host.addFile(
      `${BUCKET}/1750000000000_sess-1.jsonl`,
      sessionFile({
        title: 'Slot title',
        header: sessionHeader({ id: 'sess-1', cwd: '/work/repo', version: 3, timestamp: '2026-10-16T00:00:00.000Z' }),
        entries: [
          messageEntry('e1', null, { role: 'user', content: 'hello', timestamp: 1_760_000_000_000 }),
          messageEntry('e2', 'e1', assistantMessage([{ type: 'text', text: 'hi' }])),
        ],
      }),
    )

    const sessions = await list(host, layout)
    const [session] = sessions
    if (session === undefined) expect.unreachable('the listing should have returned one session')
    expect(session).toMatchObject({
      agentId,
      nativeId: 'sess-1',
      nativePath: `${BUCKET}/1750000000000_sess-1.jsonl`,
      title: 'Slot title',
      titleIsNative: true,
      cwd: '/work/repo',
      model: 'anthropic/claude-sonnet-4',
      status: 'idle',
      messageCount: 2,
      source: 'omp',
    })
    expect(session.key).toBe('omp:sess-1')
    expect(session.createdAt).toBe('2026-10-16T00:00:00.000Z')
    expect(session.updatedAt).toBe('2026-10-16T00:00:01.000Z')
  })

  it('marks a session whose header is unreadable and derives its id from the file name', async () => {
    const { host, layout } = hostFor()
    host.addFile(`${BUCKET}/1750000000000_sess-9.jsonl`, '{"type":"nonsense"}\n')

    const sessions = await list(host, layout)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ nativeId: 'sess-9', status: 'unreadable' })
    expect(sessions[0]?.notes.some(note => note.includes('the session header was unreadable'))).toBe(true)
    expect(sessions[0]?.notes.some(note => note.startsWith('createdAt:'))).toBe(true)
  })

  it('keeps a readable title slot when the session header is malformed', async () => {
    const { host, layout } = hostFor()
    host.addFile(`${BUCKET}/1750000000000_recovered.jsonl`, sessionFile({ title: 'Recovered title', header: '{"type":"bad"}\n' }))
    host.addFile(`${BUCKET}/1750000000001_empty-title.jsonl`, sessionFile({ title: '', header: '{"type":"bad"}\n' }))
    host.addFile(`${SESSIONS_DIR}/1750000000002_root-unreadable.jsonl`, 'not-json\n')
    const sessions = await list(host, layout)
    expect(sessions.find(session => session.nativeId === 'recovered')).toMatchObject({ title: 'Recovered title', titleIsNative: true })
    expect(sessions.find(session => session.nativeId === 'empty-title')).not.toHaveProperty('title')
    expect(sessions.find(session => session.nativeId === 'root-unreadable')).not.toHaveProperty('cwd')
  })

  it('projects declared metadata gaps and reads the lossy cwd hint when the header has none', async () => {
    const { host, layout } = hostFor()
    const projectedPath = `${BUCKET}/1750000000000_projected.jsonl`
    host.addFile(projectedPath, sessionFile({
      title: '   ',
      header: sessionHeader({
        id: 'projected', cwd: '/work/different', version: 1, timestamp: 'invalid',
        parentSession: 'C:\\archive\\session_parent-7.jsonl', title: 'Header title',
        extra: {
          additionalDirectories: ['/work/extra'], previousSessionFiles: ['/old/session.jsonl'],
          providerPromptCacheKey: 'local-only',
        },
      }),
      entries: [
        messageEntry('e1', null, { role: 'user', timestamp: 10_000, content: [{ type: 'image' }] }),
        entry('e2', 'e1', 'model_usage', { usage: { input: 1, cacheWrite: 2 } }),
        entry('e3', 'e2', 'session_init'),
        entry('e4', 'e3', 'reset_boundary'),
        entry('e5', 'e4', 'compaction'),
        entry('e6', 'e5', 'ttsr_injection'),
        entry('e7', 'e6', 'credential_pin'),
        entry('e8', 'e7', 'future_projection_event'),
        entry('e9', 'e8', 'title_change', { title: 'Entry title' }),
      ].concat(['not-json\n']),
    }))

    const pathlessPath = `${BUCKET}/1750000000001_pathless.jsonl`
    host.addFile(pathlessPath, sessionFile({ header: sessionHeader({ id: 'pathless', cwd: '', timestamp: '' }) }))
    const rootEmptyCwdPath = `${SESSIONS_DIR}/1750000000000_root-empty-cwd.jsonl`
    host.addFile(rootEmptyCwdPath, sessionFile({ header: sessionHeader({ id: 'root-empty-cwd', cwd: '' }) }))
    host.addFile(`${BUCKET}/1750000000002_plain-parent.jsonl`, sessionFile({
      header: sessionHeader({ id: 'plain-parent', parentSession: 'parent-id' }),
    }))
    host.addFile(`${BUCKET}/1750000000003_bad-parent.jsonl`, sessionFile({
      header: sessionHeader({ id: 'bad-parent', parentSession: 'folder/session.jsonl' }),
    }))
    host.addFile(`${BUCKET}/1750000000004_empty-parent.jsonl`, sessionFile({
      header: sessionHeader({ id: 'empty-parent', parentSession: 'folder/' }),
    }))
    const sessions = await list(host, layout)
    const projected = sessions.find(session => session.nativeId === 'projected')
    const pathless = sessions.find(session => session.nativeId === 'pathless')
    expect(projected).toMatchObject({
      title: 'Entry title', titleIsNative: true, cwd: '/work/different', parentNativeId: 'parent-7', source: 'omp:fork',
      updatedAt: '1970-01-01T00:00:10.000Z',
    })
    expect(projected?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(projected?.notes).toEqual(expect.arrayContaining([
      expect.stringContaining('directory name decodes to'),
      expect.stringContaining('additional workspace directories'),
      expect.stringContaining('previous session file locations'),
      expect.stringContaining('provider prompt-cache identity'),
      expect.stringContaining('session format v1'),
      expect.stringContaining('cache-write tokens'),
      expect.stringContaining('lines in the read window did not parse'),
      expect.stringContaining('image blocks'),
      expect.stringContaining('model_usage entries'),
      expect.stringContaining('session_init entries'),
      expect.stringContaining('reset boundaries'),
      expect.stringContaining('time-traveling rules'),
      expect.stringContaining('credential_pin entries'),
      expect.stringContaining('future_projection_event'),
    ]))
    expect(pathless).toMatchObject({ cwd: '/home/tester/work/repo', source: 'omp' })
    expect(pathless).not.toHaveProperty('title')
    expect(pathless?.notes).toContain('cwd: taken from the lossy directory-name encoding; the header recorded no cwd')
    expect(pathless?.parentNativeId).toBeUndefined()
    expect(sessions.find(session => session.nativeId === 'root-empty-cwd')).not.toHaveProperty('cwd')
    expect(sessions.find(session => session.nativeId === 'plain-parent')).toMatchObject({ parentNativeId: 'parent-id', source: 'omp:fork' })
    expect(sessions.find(session => session.nativeId === 'bad-parent')).toMatchObject({
      parentNativeId: 'folder/session.jsonl', source: 'omp:fork',
    })
    expect(sessions.find(session => session.nativeId === 'empty-parent')).toMatchObject({ source: 'omp:fork' })
    expect(sessions.find(session => session.nativeId === 'empty-parent')).not.toHaveProperty('parentNativeId')
    expect((await list(host, layout, { cwd: '/wanted/filter' })).map(session => session.nativeId))
      .toEqual(['root-empty-cwd', 'pathless'])
  })

  it('skips unreadable files without a filename id and omits rows for files that disappear', async () => {
    const host = new VanishingHost({ home: HOME })
    const layout = resolveOmpStore({ host, config: resolveOmpConfig() })
    host.addFile(`${SESSIONS_DIR}/bucket\\name/bad.jsonl`, 'not-json\n')
    host.addFile(`${SESSIONS_DIR}/-work-repo/1750000000000_vanished.jsonl`, sessionFile({
      header: sessionHeader({ id: 'vanished' }),
    }))
    host.vanishAfterStat(`${SESSIONS_DIR}/-work-repo/1750000000000_vanished.jsonl`)
    host.addFile(`${SESSIONS_DIR}/1750000000000_root-vanished.jsonl`, sessionFile({
      header: sessionHeader({ id: 'root-vanished' }),
    }))
    host.vanishAfterStat(`${SESSIONS_DIR}/1750000000000_root-vanished.jsonl`)
    expect(await list(host, layout)).toEqual([])
    expect(host.logs.some(log => log.message.includes('no id in its name'))).toBe(true)
  })

  it('applies limits, abort signals and a deduplicated session root override', async () => {
    const { host, layout } = hostFor()
    host.addFile(`${SESSIONS_DIR}/1750000000000_first.jsonl`, sessionFile({ header: sessionHeader({ id: 'first' }) }), 1)
    host.addFile(`${SESSIONS_DIR}/1750000000001_second.jsonl`, sessionFile({ header: sessionHeader({ id: 'second' }) }), 2)
    host.addFile(`${SESSIONS_DIR}/notes.txt`, 'not a session')
    expect(await list(host, layout, { limit: 1 })).toHaveLength(1)
    expect(await list(host, layout, { limit: 0 })).toHaveLength(2)
    const controller = new AbortController()
    controller.abort()
    expect(await list(host, layout, { signal: controller.signal })).toEqual([])

    const sameRoot = resolveOmpStore({ host, config: resolveOmpConfig({ sessionDir: layout.defaultSessionsRoot }) })
    expect(await list(host, sameRoot)).toHaveLength(2)

    const secondRootHost = hostFor()
    secondRootHost.host.addFile('/override/1750000000000_override.jsonl', sessionFile({
      header: sessionHeader({ id: 'override' }),
    }))
    secondRootHost.host.addFile(`${SESSIONS_DIR}/1750000000000_default.jsonl`, sessionFile({
      header: sessionHeader({ id: 'default' }),
    }))
    const twoRoots = resolveOmpStore({
      host: secondRootHost.host,
      config: resolveOmpConfig({ sessionDir: '/override' }),
    })
    expect((await list(secondRootHost.host, twoRoots, { limit: 1 })).map(session => session.nativeId)).toEqual(['override'])
  })

  it('declares global file caps reached before a directory or inside its file scan', async () => {
    const direct = hostFor()
    for (let index = 0; index < 1_500; index += 1) {
      direct.host.addFile(
        `${SESSIONS_DIR}/a-${String(index).padStart(4, '0')}.jsonl`,
        sessionFile({ header: sessionHeader({ id: `direct-${String(index)}` }) }),
      )
    }
    direct.host.addDirectory(`${SESSIONS_DIR}/z-bucket`)
    const directRows = await list(direct.host, direct.layout)
    expect(directRows).toHaveLength(1_500)
    expect(directRows[0]?.notes).toContain('sessions: the scan stopped after 1500 session files')

    const nested = hostFor()
    for (let directory = 0; directory < 4; directory += 1) {
      for (let index = 0; index < 400; index += 1) {
        nested.host.addFile(
          `${SESSIONS_DIR}/bucket-${String(directory)}/${String(index).padStart(4, '0')}_nested-${String(directory)}-${String(index)}.jsonl`,
          sessionFile({ header: sessionHeader({ id: `nested-${String(directory)}-${String(index)}` }) }),
        )
      }
    }
    const nestedRows = await list(nested.host, nested.layout)
    expect(nestedRows).toHaveLength(1_500)
    expect(nestedRows[0]?.notes).toContain('sessions: the scan stopped after 1500 session files')

    const nestedLimit = hostFor()
    for (let index = 0; index < 2; index += 1) {
      nestedLimit.host.addFile(
        `${SESSIONS_DIR}/bucket/${String(index)}_limited-${String(index)}.jsonl`,
        sessionFile({ header: sessionHeader({ id: `limited-${String(index)}` }) }),
      )
    }
    const activeSignal = new AbortController()
    expect(await list(nestedLimit.host, nestedLimit.layout, { signal: activeSignal.signal })).toHaveLength(2)
    expect(await list(nestedLimit.host, nestedLimit.layout, { limit: 1 })).toHaveLength(1)
  })

  it('records the per-directory file cap as a note on the first row', async () => {
    const { host, layout } = hostFor()
    for (let index = 0; index < 401; index += 1) {
      host.addFile(
        `${BUCKET}/1750000000000_sess-${String(index)}.jsonl`,
        sessionFile({ header: sessionHeader({ id: `sess-${String(index)}` }) }),
      )
    }

    const sessions = await list(host, layout)
    expect(sessions).toHaveLength(400)
    const notes = sessions.flatMap(session => [...session.notes])
    expect(notes).toContain('sessions: only the 400 most recent files of -work-repo were scanned')
  })

  it('records the global file cap and the directory cap as notes', async () => {
    const { host, layout } = hostFor()
    for (let index = 0; index < 1_501; index += 1) {
      host.addFile(
        `${SESSIONS_DIR}/1750000000000_sess-${String(index)}.jsonl`,
        sessionFile({ header: sessionHeader({ id: `sess-${String(index)}` }) }),
      )
    }
    const capped = await list(host, layout)
    expect(capped).toHaveLength(1_500)
    expect(capped.flatMap(session => [...session.notes])).toContain('sessions: the scan stopped after 1500 session files')

    const other = hostFor()
    for (let index = 0; index < 201; index += 1) {
      other.host.addFile(
        `${SESSIONS_DIR}/bucket-${String(index)}/1750000000000_sess-${String(index)}.jsonl`,
        sessionFile({ header: sessionHeader({ id: `sess-${String(index)}`, cwd: `/work/repo-${String(index)}` }) }),
      )
    }
    const directories = await list(other.host, other.layout)
    expect(directories).toHaveLength(200)
    expect(directories.flatMap(session => [...session.notes])).toContain(
      'sessions: only the 200 most recently touched session directories were scanned',
    )
  })

  it('filters by the cwd the header records, not the directory name', async () => {
    const { host, layout } = hostFor()
    host.addFile(
      `${BUCKET}/1750000000000_sess-1.jsonl`,
      sessionFile({ header: sessionHeader({ id: 'sess-1', cwd: '/work/repo' }) }),
    )
    host.addFile(
      `${BUCKET}/1750000000001_sess-2.jsonl`,
      sessionFile({ header: sessionHeader({ id: 'sess-2', cwd: '/work/other' }) }),
    )
    const sessions = await list(host, layout, { cwd: '/work/other' })
    expect(sessions.map(session => session.nativeId)).toEqual(['sess-2'])
  })

  it('reads a flat session-directory override as one directory', async () => {
    const { host, layout } = hostFor({ PI_CODING_AGENT_SESSION_DIR: '/flat/sessions' })
    host.addFile(
      '/flat/sessions/1750000000000_sess-1.jsonl',
      sessionFile({ header: sessionHeader({ id: 'sess-1', cwd: '/work/repo' }) }),
    )
    const sessions = await list(host, layout)
    expect(sessions.map(session => session.nativeId)).toEqual(['sess-1'])
    expect(layout.sessionDirOverride).toBe('/flat/sessions')
  })

  it('locates a session file by id convention and by an explicit path', async () => {
    const { host, layout } = hostFor()
    const path = `${BUCKET}/1750000000000_sess-1.jsonl`
    host.addFile(path, sessionFile({ header: sessionHeader({ id: 'sess-1' }) }))
    expect(await findOmpSessionFile(host, layout, 'sess-1')).toBe(path)
    expect(await findOmpSessionFile(host, layout, path)).toBe(path)
    expect(await findOmpSessionFile(host, layout, 'missing')).toBeUndefined()
  })

  it('probes headers after filename misses and accepts only explicit files', async () => {
    const { host, layout } = hostFor()
    const first = `${SESSIONS_DIR}/first-strange.jsonl`
    const second = `${BUCKET}/second-strange.jsonl`
    host.addFile(first, sessionFile({ header: sessionHeader({ id: 'fallback-id' }) }))
    host.addFile(second, sessionFile({ header: sessionHeader({ id: 'fallback-id' }) }))
    host.addDirectory(`${SESSIONS_DIR}/directory`)

    expect(await findOmpSessionFile(host, layout, '')).toBeUndefined()
    expect(await findOmpSessionFile(host, layout, 'fallback-id')).toBe(first)
    expect(await findOmpSessionFile(host, layout, second)).toBe(second)
    expect(await findOmpSessionFile(host, layout, `${SESSIONS_DIR}/directory`)).toBeUndefined()
    expect(await findOmpSessionFile(host, layout, 'missing.jsonl')).toBeUndefined()
    expect(await findOmpSessionFile(host, layout, 'C:\\missing\\session.jsonl')).toBeUndefined()
  })

  it('stops header probes and directory discovery at their independent caps', async () => {
    const probeHost = hostFor()
    for (let index = 0; index < 301; index += 1) {
      probeHost.host.addFile(
        `${SESSIONS_DIR}/candidate-${String(index)}.jsonl`,
        sessionFile({ header: sessionHeader({ id: 'different' }) }),
      )
    }
    expect(await findOmpSessionFile(probeHost.host, probeHost.layout, 'wanted')).toBeUndefined()
    expect(probeHost.host.logs.some(log => log.message.includes('header probe cap'))).toBe(true)

    const directoryHost = hostFor()
    for (let index = 0; index < 201; index += 1) {
      directoryHost.host.addDirectory(`${SESSIONS_DIR}/bucket-${String(index)}`, index)
    }
    expect(await findOmpSessionFile(directoryHost.host, directoryHost.layout, 'missing')).toBeUndefined()
  })
})

describe('the live branch', () => {
  it('follows parentId links to the leaf named by a trailing model_usage entry', async () => {
    const { host, layout } = hostFor()
    const path = `${BUCKET}/1750000000000_sess-1.jsonl`
    host.addFile(
      path,
      sessionFile({
        title: 'Branched',
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, { role: 'user', content: 'first' }),
          messageEntry('e2', 'e1', assistantMessage([{ type: 'text', text: 'live answer' }])),
          messageEntry('e3', 'e1', { role: 'user', content: 'abandoned question' }),
          entry('e4', 'e3', 'model_usage', {
            activeLeafId: 'e2',
            usage: { input: 10, output: 5, totalTokens: 15 },
          }),
        ],
      }),
    )

    const view = await readOmpSessionView(host, path, 256 * 1024)
    const branch = ompBranch(view)
    expect(branch.chain.map(item => item.id)).toEqual(['e1', 'e2'])
    expect(branch.abandoned).toBe(2)
    expect(branch.truncated).toBe(false)

    const session = (await list(host, layout))[0]
    if (session === undefined) expect.unreachable('the listing should have returned one session')
    expect(session.notes.some(note => note.includes('2 entries on abandoned branches'))).toBe(true)
    expect(session.notes.some(note => note.includes('1 model_usage entries count out-of-transcript'))).toBe(true)

    const transcript = await readOmpTranscript({ host, layout, session })
    expect(transcript.messages.map(message => message.text)).toEqual(['first', 'live answer'])
    expect(transcript.totalMessages).toBe(2)
  })

  it('treats the last entry as the leaf when it is not a usage marker', async () => {
    const { host } = hostFor()
    const path = `${BUCKET}/1750000000000_sess-1.jsonl`
    host.addFile(
      path,
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, { role: 'user', content: 'q' }),
          messageEntry('e2', 'e1', { role: 'user', content: 'follow-up' }),
        ],
      }),
    )
    const view = await readOmpSessionView(host, path, 256 * 1024)
    expect(ompBranch(view).chain.map(item => item.id)).toEqual(['e1', 'e2'])
    expect(ompBranch(view).abandoned).toBe(0)
  })

  it('handles empty, truncated, missing-parent and cyclic branch windows', () => {
    expect(ompBranch(sessionView([]))).toEqual({ chain: [], abandoned: 0, truncated: false })
    expect(ompBranch(sessionView([], true))).toEqual({ chain: [], abandoned: 0, truncated: true })

    const missingParent = ompBranch(sessionView([
      nativeEntry('root', 'message'),
      nativeEntry('leaf', 'message', {}, 'outside-window'),
    ]))
    expect(missingParent).toMatchObject({ chain: [{ id: 'leaf' }], abandoned: 1, truncated: true })

    const cycle = ompBranch(sessionView([
      nativeEntry('first', 'message', {}, 'last'),
      nativeEntry('last', 'message', {}, 'first'),
    ]))
    expect(cycle.chain.map(item => item.id)).toEqual(['first', 'last'])
    expect(cycle.truncated).toBe(true)

    const usageWithoutLeaf = ompBranch(sessionView([
      nativeEntry('first', 'message'),
      nativeEntry('usage-empty', 'model_usage', { activeLeafId: '' }, 'first'),
    ]))
    expect(usageWithoutLeaf.chain.map(item => item.id)).toEqual(['first', 'usage-empty'])
    const usageWithMissingLeaf = ompBranch(sessionView([
      nativeEntry('usage-missing', 'model_usage', { activeLeafId: 'unknown' }),
    ]))
    expect(usageWithMissingLeaf.chain.map(item => item.id)).toEqual(['usage-missing'])
  })
})

describe('OMP entry folding', () => {
  it('folds conversation, model, title, mode and usage data from the live branch', () => {
    const entries = [
      nativeEntry('no-message', 'message'),
      nativeEntry('user', 'message', {
        message: { role: 'user', timestamp: 1_000, content: [{ type: 'image' }, { type: 'text' }, null] },
      }, null, 'invalid-time'),
      nativeEntry('assistant-old', 'message', {
        message: {
          role: 'assistant', usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14,
            reasoningTokens: 6, cost: { total: 0.25 } },
          model: 'old-model',
        },
      }, 'user', '2026-10-16T00:00:01Z'),
      nativeEntry('assistant-no-provider', 'message', {
        message: { role: 'assistant', model: 'bare-model', timestamp: 1_500 },
      }, 'user', '2026-10-16T00:00:01.500Z'),
      nativeEntry('assistant-current', 'message', {
        message: { role: 'assistant', model: 'new-model', provider: 'provider', content: 'plain' },
      }, 'assistant-no-provider', '2026-10-16T00:00:02Z'),
      nativeEntry('assistant-invalid', 'message', {
        message: { role: 'assistant', usage: { input: 'bad', reasoningTokens: Number.NaN, cost: { total: 'bad' } },
          model: '', provider: 42 },
      }, 'assistant-current', 'invalid-time'),
      nativeEntry('tool', 'message', { message: { role: 'tool', content: null } }, 'assistant-invalid', 'bad-time'),
      nativeEntry('model-usage', 'model_usage', {
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.5 } },
      }),
      nativeEntry('model-usage-empty', 'model_usage'),
      nativeEntry('model-change-empty', 'model_change', { model: '' }, 'tool'),
      nativeEntry('model-change-live', 'model_change', { model: 'provider/final' }, 'model-change-empty'),
      nativeEntry('model-change-abandoned', 'model_change', { model: 'ignored/model' }),
      nativeEntry('title-change-abandoned', 'title_change', { title: 'abandoned' }),
      nativeEntry('title-clear', 'title_change', { title: '  ' }, 'model-change-live'),
      nativeEntry('title-final', 'title_change', { title: ' Final title ' }, 'title-clear'),
      nativeEntry('title-missing', 'title_change', {}, 'title-final'),
      nativeEntry('mode-abandoned', 'mode_change', { mode: 'plan', data: { planFilePath: 'old.md' } }),
      nativeEntry('mode-empty', 'mode_change', { mode: '', data: {} }, 'title-missing'),
      nativeEntry('mode-no-data', 'mode_change', { mode: 'plan' }, 'mode-empty'),
      nativeEntry('mode-final', 'mode_change', { mode: 'plan_paused', data: { planFilePath: 'plan.md' } }, 'mode-no-data'),
      nativeEntry('init', 'session_init'),
      nativeEntry('reset', 'reset_boundary'),
      nativeEntry('compact', 'compaction'),
      nativeEntry('rules', 'ttsr_injection'),
      nativeEntry('credential', 'credential_pin'),
      nativeEntry('known-default', 'label'),
      nativeEntry('unknown-one', 'future_event'),
      nativeEntry('unknown-two', 'future_event'),
      nativeEntry('unknown-other', 'future_other'),
      nativeEntry('model-usage-minimal', 'model_usage', { usage: { input: 1 } }),
    ]
    const live = entries.filter(item => ![
      'assistant-old', 'model-change-abandoned', 'title-change-abandoned', 'mode-abandoned', 'model-usage-minimal',
    ].includes(item.id))
    const fold = foldOmpEntries(entries, readOmpSessionHeader({ type: 'session', id: 's1', title: 'Header title' }), live)

    expect(fold).toMatchObject({
      title: 'Final title',
      model: 'provider/final',
      usage: {
        inputTokens: 4, outputTokens: 5, cachedInputTokens: 7, reasoningTokens: 6,
        totalTokens: 24, costUsd: 0.75,
      },
      messageCount: 7,
      lastMessageAt: '2026-10-16T00:00:02.000Z',
      mode: 'plan_paused',
      planFilePath: 'plan.md',
      images: 1,
      modelUsageEntries: 3,
      sessionInitEntries: 1,
      resetBoundaries: 1,
      compactions: 1,
      ttsrInjections: 1,
      credentialPins: 1,
      cacheWriteTokens: 9,
      unknownEntryTypes: ['future_event', 'future_other'],
    })
  })

  it('uses the header title when no live title change survives and leaves usage absent', () => {
    const fold = foldOmpEntries([
      nativeEntry('known', 'thinking_level_change'),
      nativeEntry('title-clear', 'title_change', { title: ' ' }),
    ], readOmpSessionHeader({ type: 'session', id: 's1', title: 'Header title' }))
    expect(fold.title).toBeUndefined()
    expect(fold.usage).toBeUndefined()
    expect(fold.unknownEntryTypes).toEqual([])

    expect(foldOmpEntries([], undefined)).toMatchObject({ messageCount: 0, images: 0, unknownEntryTypes: [] })
    expect(foldOmpEntries([nativeEntry('partial-usage', 'model_usage', { usage: { input: 1 } })]).usage)
      .toEqual({ inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 })
  })
})
