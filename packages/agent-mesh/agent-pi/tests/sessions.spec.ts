/**
 * Pi's session store: layout resolution, the header/entry record model, folding,
 * branch walking and read-only discovery.
 * @module @deepseek-ai/dsh-agent-pi/tests/sessions
 */

import { resolve as resolvePath } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentHost, AgentSession, AgentSessionListOptions, AgentId } from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  decodeCwdDirName,
  encodeCwdDirName,
  findPiSessionFile,
  foldPiEntries,
  HEADER_READ_BYTES,
  idFromFileName,
  isRecord,
  isSessionFileName,
  isoOrUndefined,
  listPiSessions,
  MAX_RAW_CHARS,
  messageActivity,
  note,
  parseJsonLine,
  piBranch,
  piScanRoots,
  readArray,
  readBoolean,
  readNumber,
  readPiEntry,
  readPiSessionHeader,
  readPiSessionHeaderAt,
  readPiSessionView,
  readRecord,
  readString,
  resolvePiStore,
  sessionKey,
  type PiNativeEntry,
  type PiStoreLayout,
  type PiSessionView,
} from '../src/sessions.ts'
import { assistantEntry, entryLine, headerLine, sessionFile, userEntry } from './fixtures.ts'
import { createFakeHost } from './host.ts'

const PI: AgentId = brandString<AgentId>('pi')
const HOME = '/home/tester'
const AGENT_DIR = `${HOME}/.pi/agent`
const SESSIONS_ROOT = `${AGENT_DIR}/sessions`
const PROJECT_DIR = '--home-tester-project--'
const PROJECT_PATH = `${SESSIONS_ROOT}/${PROJECT_DIR}`

/** A store layout rooted at the default agent directory, with optional overrides. */
function storeLayout(overrides: Partial<PiStoreLayout> = {}): PiStoreLayout {
  return {
    agentDir: AGENT_DIR,
    defaultSessionsRoot: SESSIONS_ROOT,
    credentialPath: `${AGENT_DIR}/auth.json`,
    settingsPath: `${AGENT_DIR}/settings.json`,
    modelsPath: `${AGENT_DIR}/models.json`,
    ...overrides,
  }
}

/** Parse one entry line, failing the test when it is not an entry. */
function entryOf(line: string): PiNativeEntry {
  const entry = readPiEntry(JSON.parse(line), line)
  if (entry === undefined) throw new Error(`not an entry: ${line}`)
  return entry
}

/** A read window holding exactly the given entries. */
function viewOf(entries: readonly PiNativeEntry[], truncated = false): PiSessionView {
  return { entries, windowTruncated: truncated, droppedPartialLine: false, size: 0, mtimeMs: 0, malformed: 0, missing: false, notes: [] }
}

/** Enumerate sessions with the given options. */
async function list(host: AgentHost, layout: PiStoreLayout, options: AgentSessionListOptions = {}): Promise<readonly AgentSession[]> {
  return await listPiSessions({ host, agentId: PI, layout, options })
}

/** The header-only body of a session file with a minimal native header. */
function headerOnly(id: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: 'session', id, timestamp: '2026-10-16T00:00:00.000Z', cwd: '/home/tester/project', version: 3, ...extra })}\n`
}

describe('progress-note rendering', () => {
  it('prefixes a field-scoped note with the field it belongs to', () => {
    expect(note('cwd', 'unavailable')).toBe('cwd: unavailable')
    expect(note('*', 'the file is absent')).toBe('the file is absent')
  })
})

describe('foreign-JSON field readers', () => {
  it('accepts only plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(3)).toBe(false)
  })

  it('reads each field only when the value has the declared type', () => {
    const source: Record<string, unknown> = {
      text: 'value',
      number: 4,
      infinite: Number.POSITIVE_INFINITY,
      flag: true,
      nested: { a: 1 },
      list: [1, 2],
      wrongText: 7,
      wrongFlag: 'yes',
      wrongRecord: [1],
      wrongList: { 0: 'a' },
    }

    expect(readString(source, 'text')).toBe('value')
    expect(readString(source, 'missing')).toBeUndefined()
    expect(readString(source, 'wrongText')).toBeUndefined()
    expect(readString(undefined, 'text')).toBeUndefined()
    expect(readNumber(source, 'number')).toBe(4)
    expect(readNumber(source, 'infinite')).toBeUndefined()
    expect(readNumber(source, 'missing')).toBeUndefined()
    expect(readBoolean(source, 'flag')).toBe(true)
    expect(readBoolean(source, 'wrongFlag')).toBeUndefined()
    expect(readRecord(source, 'nested')).toEqual({ a: 1 })
    expect(readRecord(source, 'wrongRecord')).toBeUndefined()
    expect(readArray(source, 'list')).toEqual([1, 2])
    expect(readArray(source, 'wrongList')).toBeUndefined()
  })

  it('parses one line as JSON, naming an empty line and a parse failure', () => {
    expect(parseJsonLine('  {"a":1}  ')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonLine('   ')).toEqual({ ok: false, error: 'empty line' })
    const failed = parseJsonLine('{oops')
    expect(failed.ok).toBe(false)
    expect(failed.ok ? '' : failed.error).not.toBe('')
  })

  it('renders a non-Error JSON parser failure as a string', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'parser stopped'
    })
    let result: ReturnType<typeof parseJsonLine> = { ok: false, error: '' }
    try {
      result = parseJsonLine('{broken')
    } finally {
      parse.mockRestore()
    }
    expect(result).toEqual({ ok: false, error: 'parser stopped' })
  })

  it('builds the mesh-wide session key', () => {
    expect(sessionKey(PI, 'abc')).toBe('pi:abc')
  })

  it('renders a native timestamp as ISO only when it parses', () => {
    expect(isoOrUndefined('2026-10-16T00:00:00.000Z')).toBe('2026-10-16T00:00:00.000Z')
    expect(isoOrUndefined('2026-10-16')).toBe('2026-10-16T00:00:00.000Z')
    expect(isoOrUndefined(undefined)).toBeUndefined()
    expect(isoOrUndefined('')).toBeUndefined()
    expect(isoOrUndefined('not a time')).toBeUndefined()
  })
})

describe('session header parsing', () => {
  it('rejects every value that is not a session header', () => {
    expect(readPiSessionHeader(undefined)).toBeUndefined()
    expect(readPiSessionHeader([])).toBeUndefined()
    expect(readPiSessionHeader({ type: 'message' })).toBeUndefined()
    expect(readPiSessionHeader({ type: 'session' })).toBeUndefined()
    expect(readPiSessionHeader({ type: 'session', id: '' })).toBeUndefined()
    expect(readPiSessionHeader({ type: 'session', id: 7 })).toBeUndefined()
  })

  it('defaults absent fields and truncates a fractional version', () => {
    expect(readPiSessionHeader({ type: 'session', id: 's1' })).toEqual({
      id: 's1',
      timestamp: '',
      cwd: '',
    })
    expect(readPiSessionHeader({ type: 'session', id: 's1', version: 3.9, parentSession: '' })).toEqual({
      id: 's1',
      timestamp: '',
      cwd: '',
      version: 3,
    })
    expect(readPiSessionHeader({ type: 'session', id: 's1', parentSession: '/x/y_abc.jsonl' })).toMatchObject({
      parentSession: '/x/y_abc.jsonl',
    })
  })
})

describe('session entry parsing', () => {
  it('rejects every line that is not a named entry', () => {
    expect(readPiEntry(null, 'null')).toBeUndefined()
    expect(readPiEntry({ type: 'message' }, '{}')).toBeUndefined()
    expect(readPiEntry({ id: '', type: 'message' }, '{}')).toBeUndefined()
    expect(readPiEntry({ id: 'a' }, '{}')).toBeUndefined()
    expect(readPiEntry({ id: 'a', type: '' }, '{}')).toBeUndefined()
  })

  it('preserves a non-string parent link as a branch root and defaults the timestamp', () => {
    const entry = entryOf(JSON.stringify({ id: 'a', parentId: 9, type: 'message' }))
    expect(entry).toMatchObject({ id: 'a', parentId: null, timestamp: '', type: 'message' })

    const linked = entryOf(entryLine({ id: 'b', type: 'message', parentId: 'a', timestamp: '2026-01-01T00:00:00.000Z' }))
    expect(linked).toMatchObject({ parentId: 'a', timestamp: '2026-01-01T00:00:00.000Z' })
  })

  it('bounds the raw line it retains for an unknown projection', () => {
    const long = entryLine({ id: 'a', type: 'message', message: { role: 'user', content: 'x'.repeat(5_000) } })
    expect(long.length).toBeGreaterThan(MAX_RAW_CHARS)

    const entry = entryOf(long)
    expect(entry.raw).toHaveLength(MAX_RAW_CHARS)
    expect(long.startsWith(entry.raw)).toBe(true)
  })
})

describe('bounded session reads', () => {
  it('reports an absent file as a missing view with a declared gap', async () => {
    const host = createFakeHost({})
    const view = await readPiSessionView(host, `${PROJECT_PATH}/gone.jsonl`, 64 * 1024)

    expect(view).toEqual({
      entries: [],
      windowTruncated: false,
      droppedPartialLine: false,
      size: -1,
      mtimeMs: 0,
      malformed: 0,
      missing: true,
      notes: ['the session file is absent'],
    })
  })

  it('reads a small file whole and counts the lines that did not parse', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const body = sessionFile({ id: 's1' }, [
      userEntry('a', null, 'hello'),
      '{not json',
      JSON.stringify({ id: 'no-type' }),
      '',
      assistantEntry('b', 'a', [{ type: 'text', text: 'hi' }]),
    ])
    const host = createFakeHost({ files: { [path]: body } })

    const view = await readPiSessionView(host, path, 64 * 1024)
    expect(view.header?.id).toBe('s1')
    expect(view.entries.map(entry => entry.id)).toEqual(['a', 'b'])
    expect(view.malformed).toBe(2)
    expect(view.missing).toBe(false)
    expect(view.windowTruncated).toBe(false)
    expect(view.size).toBeGreaterThan(0)
    expect(view.notes).toEqual([])
  })

  it('counts a first line that is not a header and keeps parsing entries after it', async () => {
    const path = `${PROJECT_PATH}/headless.jsonl`
    const body = `${entryLine({ id: 'a', type: 'message' })}\n${entryLine({ id: 'b', type: 'message', parentId: 'a' })}\n`
    const host = createFakeHost({ files: { [path]: body } })

    const view = await readPiSessionView(host, path, 64 * 1024)
    expect(view.header).toBeUndefined()
    expect(view.malformed).toBe(1)
    expect(view.entries.map(entry => entry.id)).toEqual(['b'])
  })

  it('reports a file that reads back empty as missing rather than empty', async () => {
    const path = `${PROJECT_PATH}/unreadable.jsonl`
    const base = createFakeHost({ files: { [path]: sessionFile({ id: 's1' }, []) } })
    const host: AgentHost = { ...base, readHead: async () => '' }

    const view = await readPiSessionView(host, path, 64 * 1024)
    expect(view).toMatchObject({ missing: true, entries: [], windowTruncated: false })
    expect(view.size).toBeGreaterThan(0)
    expect(view.notes).toEqual(['the session file is absent'])
  })

  it('reads a large file as its header plus a tail window of entries', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_big.jsonl`
    const entries: string[] = []
    for (let index = 0; index < 900; index += 1) {
      entries.push(userEntry(`e${index}`, index === 0 ? null : `e${index - 1}`, 'y'.repeat(100)))
    }
    const body = sessionFile({ id: 'big' }, entries)
    expect(body.length).toBeGreaterThan(64 * 1024)
    const host = createFakeHost({ files: { [path]: body } })

    const view = await readPiSessionView(host, path, 64 * 1024)
    expect(view.header?.id).toBe('big')
    expect(view.windowTruncated).toBe(true)
    expect(view.droppedPartialLine).toBe(true)
    expect(view.entries.length).toBeGreaterThan(0)
    expect(view.entries.length).toBeLessThan(entries.length)
    expect(view.entries.at(-1)?.id).toBe('e899')
  })

  it('counts malformed JSON and non-entry records in the large-file tail', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_malformed-tail.jsonl`
    const body = `${headerLine({ id: 'malformed-tail' })}\n${'x'.repeat(270_000)}\n{not json\n${JSON.stringify({ id: 'not-an-entry' })}\n`
    const host = createFakeHost({ files: { [path]: body } })

    const view = await readPiSessionView(host, path, 256 * 1024)
    expect(view.windowTruncated).toBe(true)
    expect(view.malformed).toBe(2)
  })

  it('declares an unavailable cwd when the header does not fit the head window', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_huge.jsonl`
    const body = `${'x'.repeat(HEADER_READ_BYTES + 10)}\n${userEntry('a', null, 'after the long line')}\n`
    const host = createFakeHost({ files: { [path]: body } })

    const view = await readPiSessionView(host, path, 64 * 1024)
    expect(view.header).toBeUndefined()
    expect(view.windowTruncated).toBe(true)
    expect(view.notes).toEqual([
      `cwd: the session header did not fit in ${HEADER_READ_BYTES} bytes, so the cwd is unavailable`,
    ])
    expect(view.entries.map(entry => entry.id)).toEqual(['a'])
  })

  it('reports a large file whose tail holds no line boundary as missing', async () => {
    const path = `${PROJECT_PATH}/oneline.jsonl`
    const host = createFakeHost({ files: { [path]: 'x'.repeat(70_000) } })

    const view = await readPiSessionView(host, path, 64 * 1024)
    expect(view.missing).toBe(true)
    expect(view.size).toBe(70_000)
  })

  it('reads only the header line for a by-id lookup', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const host = createFakeHost({ files: { [path]: sessionFile({ id: 's1' }, [userEntry('a', null, 'hello')]) } })

    await expect(readPiSessionHeaderAt(host, path)).resolves.toMatchObject({ id: 's1' })
  })

  it('reports no header when the first line is incomplete, unparseable, or not a header', async () => {
    const unterminated = createFakeHost({ files: { '/a.jsonl': '{"type":"session","id":"s1"}' } })
    await expect(readPiSessionHeaderAt(unterminated, '/a.jsonl')).resolves.toBeUndefined()

    const unparseable = createFakeHost({ files: { '/b.jsonl': '{oops\n' } })
    await expect(readPiSessionHeaderAt(unparseable, '/b.jsonl')).resolves.toBeUndefined()

    const notHeader = createFakeHost({ files: { '/c.jsonl': `${JSON.stringify({ id: 'a' })}\n` } })
    await expect(readPiSessionHeaderAt(notHeader, '/c.jsonl')).resolves.toBeUndefined()
  })
})

describe('session folding', () => {
  it('folds titles, models, usage, counts and unmodelled entry types', () => {
    const entries = [
      entryOf(entryLine({ id: 'a', type: 'session_info', name: '  My session  ' })),
      entryOf(assistantEntry('b', 'a', [{ type: 'text', text: 'hi' }, { type: 'image', data: 'x' }], {
        model: 'deepseek-chat',
        timestamp: 1_700_000_000_000,
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 15, cost: { total: 0.25 } },
      })),
      entryOf(
        assistantEntry('l', 'b', [{ type: 'text', text: 'later' }], {
          model: 'deepseek-chat',
          timestamp: 1_800_000_000_000,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        }),
      ),
      entryOf(entryLine({ id: 'c', type: 'model_change', parentId: 'l', modelId: ' deepseek-reasoner ' })),
      entryOf(userEntry('d', 'c', 'again')),
      entryOf(entryLine({ id: 'e', type: 'usage', parentId: 'd', usage: { input: 1, reasoning: 4, cost: { total: 0.5 } } })),
      entryOf(entryLine({ id: 'f', type: 'usage', parentId: 'e', usage: { reasoning: 2, cost: { total: 0.1 } } })),
      entryOf(entryLine({ id: 'g', type: 'context_edit', parentId: 'f' })),
      entryOf(entryLine({ id: 'h', type: 'compaction', parentId: 'g' })),
      entryOf(entryLine({ id: 'i', type: 'branch_summary', parentId: 'h' })),
      entryOf(entryLine({ id: 'j', type: 'custom', parentId: 'i' })),
      entryOf(entryLine({ id: 'k', type: 'future_thing', parentId: 'j' })),
      entryOf(entryLine({ id: 'l', type: 'future_thing', parentId: 'k' })),
    ]

    const fold = foldPiEntries(entries)
    expect(fold.title).toBe('My session')
    expect(fold.model).toBe('deepseek-reasoner')
    expect(fold.usage).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      cachedInputTokens: 2,
      reasoningTokens: 6,
      totalTokens: 15,
      costUsd: 0.85,
    })
    expect(fold.messageCount).toBe(3)
    expect(fold.usageEntries).toBe(2)
    expect(fold.contextEdits).toBe(1)
    expect(fold.compactions).toBe(1)
    expect(fold.images).toBe(1)
    expect(fold.cacheWriteTokens).toBe(3)
    expect(fold.lastMessageAt).toBe(new Date(1_800_000_000_000).toISOString())
    expect(fold.unknownEntryTypes).toEqual(['future_thing'])
  })

  it('leaves absent facts absent and counts a message with no record', () => {
    const fold = foldPiEntries([
      entryOf(entryLine({ id: 'a', type: 'message' })),
      entryOf(entryLine({ id: 'b', type: 'session_info' })),
      entryOf(entryLine({ id: 'c', type: 'model_change' })),
      entryOf(entryLine({ id: 'd', type: 'usage' })),
    ])

    expect(fold).toEqual({
      messageCount: 1,
      images: 0,
      usageEntries: 1,
      contextEdits: 0,
      compactions: 0,
      cacheWriteTokens: 0,
      unknownEntryTypes: [],
    })
  })

  it('projects zero counters when a usage record omits optional totals', () => {
    const fold = foldPiEntries([entryOf(entryLine({ id: 'a', type: 'usage', usage: {} }))])
    expect(fold.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 })
  })

  it('lets the latest session_info win and an empty one clear the title', () => {
    expect(foldPiEntries([entryOf(entryLine({ id: 'a', type: 'session_info', name: 'first' })), entryOf(entryLine({ id: 'b', type: 'session_info', name: 'second' }))]).title).toBe('second')
    expect(foldPiEntries([entryOf(entryLine({ id: 'a', type: 'session_info', name: 'named' })), entryOf(entryLine({ id: 'b', type: 'session_info', name: '   ' }))]).title).toBeUndefined()
  })

  it('takes the assistant model when no model_change names one', () => {
    const fold = foldPiEntries([
      entryOf(assistantEntry('a', null, [{ type: 'text', text: 'hi' }], { model: ' gpt-5 ' })),
      entryOf(assistantEntry('b', 'a', [], { model: '   ' })),
    ])
    expect(fold.model).toBe('gpt-5')
  })

  it('keeps the newest message time across entries without one', () => {
    const older = entryLine({ id: 'a', type: 'message', message: { role: 'user', content: 'x' }, timestamp: '2026-10-16T00:00:00.000Z' })
    const newer = entryLine({ id: 'b', type: 'message', message: { role: 'user', content: 'y' }, timestamp: '2026-10-16T05:00:00.000Z' })
    const undated = entryLine({ id: 'c', type: 'message', message: { role: 'user', content: 'z' }, timestamp: '' })

    expect(foldPiEntries([entryOf(older), entryOf(newer), entryOf(undated)]).lastMessageAt).toBe('2026-10-16T05:00:00.000Z')
  })
})

describe('message activity time', () => {
  it('prefers the native timestamp and falls back to the entry timestamp', () => {
    expect(messageActivity({ role: 'assistant', timestamp: 1_700_000_000_000 }, '2026-10-16T00:00:00.000Z')).toBe(
      new Date(1_700_000_000_000).toISOString(),
    )
    expect(messageActivity({ role: 'user' }, '2026-10-16T00:00:00.000Z')).toBe('2026-10-16T00:00:00.000Z')
  })

  it('reports no time for a role that records none or an unparseable fallback', () => {
    expect(messageActivity({ role: 'toolResult', timestamp: 1_700_000_000_000 }, '2026-10-16T00:00:00.000Z')).toBeUndefined()
    expect(messageActivity({ role: 'user' }, '')).toBeUndefined()
    expect(messageActivity({ role: 'user' }, 'whenever')).toBeUndefined()
    expect(messageActivity({ role: 'assistant', timestamp: Number.MAX_VALUE }, 'whenever')).toBeUndefined()
  })
})

describe('live-branch walking', () => {
  it('returns an empty chain for an empty window', () => {
    expect(piBranch(viewOf([]))).toEqual({ chain: [], abandoned: 0, truncated: false })
    expect(piBranch(viewOf([], true))).toEqual({ chain: [], abandoned: 0, truncated: true })
  })

  it('walks parent links from the last entry and counts abandoned entries', () => {
    const root = entryOf(entryLine({ id: 'a', type: 'message', parentId: null }))
    const abandoned = entryOf(entryLine({ id: 'b', type: 'message', parentId: 'a' }))
    const live = entryOf(entryLine({ id: 'c', type: 'message', parentId: 'a' }))
    const leaf = entryOf(entryLine({ id: 'd', type: 'message', parentId: 'c' }))

    expect(piBranch(viewOf([root, abandoned, live, leaf]))).toEqual({
      chain: [root, live, leaf],
      abandoned: 1,
      truncated: false,
    })
  })

  it('declares a chain whose root still names a parent as truncated', () => {
    const orphan = entryOf(entryLine({ id: 'b', type: 'message', parentId: 'missing' }))
    expect(piBranch(viewOf([orphan]))).toEqual({ chain: [orphan], abandoned: 0, truncated: true })

    const windowed = entryOf(entryLine({ id: 'b', type: 'message', parentId: null }))
    expect(piBranch(viewOf([windowed], true)).truncated).toBe(true)
  })

  it('terminates a corrupt parent cycle and reports it as truncated', () => {
    const first = entryOf(entryLine({ id: 'a', type: 'message', parentId: 'b' }))
    const second = entryOf(entryLine({ id: 'b', type: 'message', parentId: 'a' }))

    expect(piBranch(viewOf([first, second]))).toEqual({ chain: [first, second], abandoned: 0, truncated: true })
  })
})

describe('cwd directory encoding', () => {
  it('encodes an absolute cwd the way pi names its project directory', () => {
    expect(encodeCwdDirName('/home/tester/project')).toBe('--home-tester-project--')
    expect(encodeCwdDirName('/a/b:c')).toBe('--a-b-c--')
  })

  it('decodes only a well-formed flattened name', () => {
    expect(decodeCwdDirName('--home-tester-project--')).toBe('/home/tester/project')
    expect(decodeCwdDirName('--')).toBeUndefined()
    expect(decodeCwdDirName('----')).toBeUndefined()
    expect(decodeCwdDirName('-x--')).toBeUndefined()
    expect(decodeCwdDirName('--x-')).toBeUndefined()
    expect(decodeCwdDirName('plain')).toBeUndefined()
  })
})

describe('store layout resolution', () => {
  it('resolves the whole layout from an injected environment alone', async () => {
    const host = createFakeHost({ home: HOME, env: { PI_CODING_AGENT_DIR: '/ignored/agent' } })
    const layout = await resolvePiStore({
      host,
      env: { PI_CODING_AGENT_DIR: '/injected/agent', PI_CODING_AGENT_SESSION_DIR: '/injected/sessions' },
    })

    expect(layout).toMatchObject({
      agentDir: '/injected/agent',
      defaultSessionsRoot: '/injected/agent/sessions',
      sessionDirOverride: '/injected/sessions',
    })
  })

  it('expands a bare tilde and resolves a relative configured directory', async () => {
    const host = createFakeHost({ home: HOME, env: {} })

    await expect(resolvePiStore({ host, homeDir: '~' })).resolves.toMatchObject({ agentDir: HOME })
    await expect(resolvePiStore({ host, homeDir: 'relative/agent' })).resolves.toMatchObject({
      agentDir: resolvePath('relative/agent'),
    })
  })

  it('ignores a settings file that is not a JSON object and a blank sessionDir', async () => {
    const notObject = createFakeHost({
      home: HOME,
      env: {},
      files: { [`${AGENT_DIR}/settings.json`]: '["sessions"]' },
    })
    expect((await resolvePiStore({ host: notObject })).sessionDirOverride).toBeUndefined()

    const blank = createFakeHost({
      home: HOME,
      env: {},
      files: { [`${AGENT_DIR}/settings.json`]: JSON.stringify({ sessionDir: '   ' }) },
    })
    expect((await resolvePiStore({ host: blank })).sessionDirOverride).toBeUndefined()

    const corrupt = createFakeHost({ home: HOME, env: {}, files: { [`${AGENT_DIR}/settings.json`]: '{oops' } })
    expect((await resolvePiStore({ host: corrupt })).sessionDirOverride).toBeUndefined()
  })
})

describe('scan roots', () => {
  it('reads the override and the default root, deduplicating an override that names the default', () => {
    expect(piScanRoots(storeLayout({ sessionDirOverride: '/flat' }))).toEqual([
      { path: '/flat' },
      { path: SESSIONS_ROOT },
    ])
    expect(piScanRoots(storeLayout())).toEqual([{ path: SESSIONS_ROOT }])
    expect(piScanRoots(storeLayout({ sessionDirOverride: SESSIONS_ROOT }))).toEqual([
      { path: SESSIONS_ROOT },
    ])
  })
})

describe('session discovery', () => {
  it('lists flat session files and project directories, newest first', async () => {
    const files = {
      [`${SESSIONS_ROOT}/stray.jsonl`]: headerOnly('stray', { timestamp: '2026-10-15T00:00:00.000Z' }),
      [`${PROJECT_PATH}/2026-10-16_newer.jsonl`]: sessionFile({ id: 'newer', timestamp: '2026-10-16T04:00:00.000Z' }, [
        userEntry('a', null, 'hello'),
      ]),
      [`${PROJECT_PATH}/2026-10-14_older.jsonl`]: headerOnly('older', { timestamp: '2026-10-14T00:00:00.000Z' }),
      [`${PROJECT_PATH}/notes.txt`]: 'ignored',
    }
    const host = createFakeHost({ home: HOME, env: {}, files })

    const sessions = await list(host, storeLayout())
    expect(sessions.map(session => session.nativeId)).toEqual(['newer', 'stray', 'older'])
    expect(sessions[0]).toMatchObject({
      key: 'pi:newer',
      agentId: 'pi',
      status: 'idle',
      cwd: '/home/tester/project',
      messageCount: 1,
      updatedAt: '2026-10-16T00:00:01.000Z',
      createdAt: '2026-10-16T04:00:00.000Z',
    })
  })

  it('returns an empty listing when neither session root exists', async () => {
    await expect(list(createFakeHost({ dirs: ['/elsewhere'] }), storeLayout())).resolves.toEqual([])
  })

  it('reads a flat override directory, so a switched layout keeps both stores', async () => {
    const host = createFakeHost({
      home: HOME,
      env: {},
      files: {
        '/flat/2026-10-16_flat.jsonl': sessionFile({ id: 'flat' }, [userEntry('a', null, 'hi')]),
        [`${PROJECT_PATH}/2026-10-16_default.jsonl`]: sessionFile({ id: 'default' }, []),
      },
    })

    const sessions = await list(host, storeLayout({ sessionDirOverride: '/flat' }))
    expect(sessions.map(session => session.nativeId).sort()).toEqual(['default', 'flat'])
  })

  it('filters by cwd only when the header records one', async () => {
    const host = createFakeHost({
      home: HOME,
      env: {},
      files: {
        [`${PROJECT_PATH}/2026-10-16_match.jsonl`]: sessionFile({ id: 'match', cwd: '/work/one' }, []),
        [`${PROJECT_PATH}/2026-10-16_other.jsonl`]: sessionFile({ id: 'other', cwd: '/work/two' }, []),
        [`${PROJECT_PATH}/2026-10-16_unknown.jsonl`]: `${JSON.stringify({ type: 'session', id: 'unknown', timestamp: '2026-10-16T00:00:00.000Z' })}\n`,
      },
    })

    const sessions = await list(host, storeLayout(), { cwd: '/work/one' })
    expect(sessions.map(session => session.nativeId).sort()).toEqual(['match', 'unknown'])
  })

  it('honours a limit and reports nothing once the caller aborted', async () => {
    const files: Record<string, string> = {}
    for (const id of ['a', 'b', 'c']) files[`${PROJECT_PATH}/2026-10-16_${id}.jsonl`] = headerOnly(id)

    const limited = await list(createFakeHost({ home: HOME, env: {}, files }), storeLayout(), { limit: 2 })
    expect(limited).toHaveLength(2)

    const controller = new AbortController()
    controller.abort()
    const aborted = await list(createFakeHost({ home: HOME, env: {}, files }), storeLayout(), { signal: controller.signal })
    expect(aborted).toEqual([])
  })

  it('reports an unreadable header as an unreadable session named by its file', async () => {
    const host = createFakeHost({
      home: HOME,
      env: {},
      files: { [`${PROJECT_PATH}/2026-10-16_stub.jsonl`]: '{not json\n' },
    })

    const sessions = await list(host, storeLayout())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      nativeId: 'stub',
      status: 'unreadable',
      cwd: '/home/tester/project',
      notes: ['the session header was unreadable; the id came from the file name and no metadata is available'],
    })
    expect(sessions[0]?.createdAt).toBe('2026-10-16T00:00:00.000Z')
  })

  it('lists a root-level unreadable file without inventing a cwd', async () => {
    const path = `${SESSIONS_ROOT}/2026-10-16_stub.jsonl`
    const host = createFakeHost({ home: HOME, env: {}, files: { [path]: '{not json\n' } })

    const sessions = await list(host, storeLayout())
    expect(sessions).toMatchObject([{ nativeId: 'stub', status: 'unreadable' }])
    expect(sessions[0]).not.toHaveProperty('cwd')
  })

  it('uses file modification time when a root-level header omits metadata', async () => {
    const path = `${SESSIONS_ROOT}/2026-10-16_minimal.jsonl`
    const host = createFakeHost({
      home: HOME,
      env: {},
      files: { [path]: `${JSON.stringify({ type: 'session', id: 'minimal' })}\n` },
    })

    const sessions = await list(host, storeLayout())
    expect(sessions).toMatchObject([
      { nativeId: 'minimal', createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' },
    ])
    expect(sessions[0]).not.toHaveProperty('cwd')
    expect(sessions[0]).not.toHaveProperty('title')
    expect(sessions[0]).not.toHaveProperty('model')
  })

  it('projects title and model changes from a root-level session', async () => {
    const path = `${SESSIONS_ROOT}/2026-10-16_meta.jsonl`
    const body = sessionFile({ id: 'meta', cwd: '' }, [
      entryLine({ id: 'i', type: 'session_info', name: '  title  ' }),
      entryLine({ id: 'm', type: 'model_change', parentId: 'i', modelId: 'provider/model' }),
    ])
    const host = createFakeHost({ home: HOME, env: {}, files: { [path]: body } })

    const sessions = await list(host, storeLayout())
    expect(sessions).toMatchObject([
      { nativeId: 'meta', title: 'title', titleIsNative: true, model: 'provider/model' },
    ])
    expect(sessions[0]).not.toHaveProperty('cwd')
  })

  it('skips an unreadable file whose name carries no session id, and says why', async () => {
    const host = createFakeHost({ home: HOME, env: {}, files: { [`${PROJECT_PATH}/notes.jsonl`]: '{not json\n' } })

    await expect(list(host, storeLayout())).resolves.toEqual([])
    expect(host.logs).toEqual([
      `skipping a Pi session file with no readable header and no id in its name: ${PROJECT_PATH}/notes.jsonl`,
    ])
  })

  it('declares a cwd disagreement between the directory name and the header', async () => {
    const host = createFakeHost({
      home: HOME,
      env: {},
      files: { [`${PROJECT_PATH}/2026-10-16_s1.jsonl`]: sessionFile({ id: 's1', cwd: '/home/tester/other' }, []) },
    })

    const sessions = await list(host, storeLayout())
    expect(sessions[0]?.cwd).toBe('/home/tester/other')
    expect(sessions[0]?.notes[0]).toBe(
      'cwd: the directory name decodes to /home/tester/project but the header records /home/tester/other; ' +
        "pi would name this session's directory --home-tester-other--, so the path likely contains a real dash, " +
        'which the encoding flattens',
    )
  })

  it('falls back to the lossy directory name when the header records no cwd', async () => {
    const host = createFakeHost({
      home: HOME,
      env: {},
      files: {
        [`${PROJECT_PATH}/2026-10-16_s1.jsonl`]: `${JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-10-16T00:00:00.000Z' })}\n`,
      },
    })

    const sessions = await list(host, storeLayout())
    expect(sessions[0]?.cwd).toBe('/home/tester/project')
    expect(sessions[0]?.notes).toContain('cwd: taken from the lossy directory-name encoding; the header recorded no cwd')
  })

  it('records a forked session against its parent', async () => {
    const host = createFakeHost({
      home: HOME,
      env: {},
      files: {
        [`${PROJECT_PATH}/2026-10-16_child.jsonl`]: headerOnly('child', { parentSession: `${PROJECT_PATH}/2026-10-01_parent.jsonl` }),
        [`${PROJECT_PATH}/2026-10-16_bare.jsonl`]: headerOnly('bare', { parentSession: 'a-bare-reference' }),
        [`${PROJECT_PATH}/2026-10-16_nosep.jsonl`]: headerOnly('nosep', { parentSession: '/x/forked.jsonl' }),
        [`${PROJECT_PATH}/2026-10-16_rootless.jsonl`]: headerOnly('rootless', { parentSession: '/' }),
      },
    })

    const byId = new Map((await list(host, storeLayout())).map(session => [session.nativeId, session]))
    expect(byId.get('child')).toMatchObject({ parentNativeId: 'parent', source: 'pi:fork' })
    expect(byId.get('bare')).toMatchObject({ parentNativeId: 'a-bare-reference', source: 'pi:fork' })
    expect(byId.get('nosep')).toMatchObject({ parentNativeId: '/x/forked.jsonl', source: 'pi:fork' })
    expect(byId.get('rootless')?.source).toBe('pi:fork')
    expect(byId.get('rootless')?.parentNativeId).toBeUndefined()
  })

  it('declares abandoned entries, dropped content and unmodelled records as notes', async () => {
    const files = [userEntry('a', null, 'hello')]
    files.push(assistantEntry('b', 'a', [{ type: 'image', data: 'x' }, { type: 'mystery' }], { usage: { input: 1, cacheWrite: 2 } }))
    files.push(entryLine({ id: 'side', type: 'message', parentId: 'a', message: { role: 'user', content: 'side' } }))
    files.push(entryLine({ id: 'c', type: 'context_edit', parentId: 'b' }))
    files.push(entryLine({ id: 'd', type: 'future_thing', parentId: 'c' }))
    files.push('{oops')
    const body = sessionFile({ id: 'notes' }, files)
    const host = createFakeHost({ home: HOME, env: {}, files: { [`${PROJECT_PATH}/2026-10-16_notes.jsonl`]: body } })

    const sessions = await list(host, storeLayout())
    const notes = sessions[0]?.notes ?? []
    expect(notes).toContain('messages: 1 entries on abandoned branches are excluded from the linear reading')
    expect(notes).toContain(
      'messages: 1 context edits are recorded but not applied: the transcript shows the recorded content',
    )
    expect(notes).toContain('usage: token usage is recorded by pi for this session, and the mesh session record has no usage field')
    expect(notes).toContain('usage: cache-write tokens are recorded by pi but have no canonical field')
    expect(notes).toContain('1 lines in the read window did not parse')
    expect(notes).toContain('messages: 1 image blocks have no canonical field and are not represented in this summary')
    expect(notes).toContain('messages: entry types this adapter does not model were left out: future_thing')
  })

  it('declares a window-truncated listing without a message count', async () => {
    const entries: string[] = []
    for (let index = 0; index < 2_200; index += 1) entries.push(userEntry(`e${index}`, index === 0 ? null : `e${index - 1}`, 'y'.repeat(150)))
    const host = createFakeHost({
      home: HOME,
      env: {},
      files: { [`${PROJECT_PATH}/2026-10-16_big.jsonl`]: sessionFile({ id: 'big' }, entries) },
    })

    const sessions = await list(host, storeLayout())
    expect(sessions[0]?.messageCount).toBeUndefined()
    expect(sessions[0]?.notes).toContain(
      'the file exceeded the read window; counts and usage cover only the live branch inside that window',
    )
  })

  it('stops a scan at the global file cap and carries the gap on the newest session', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 1_501; index += 1) files[`/flat/f${index}.jsonl`] = headerOnly(`s${index}`)
    const host = createFakeHost({ home: HOME, env: {}, files })

    const sessions = await list(host, storeLayout({ sessionDirOverride: '/flat' }))
    expect(sessions).toHaveLength(1_500)
    expect(sessions[0]?.notes).toContain('the scan stopped after 1500 session files')
  })

  it('stops before project traversal when root files exhaust the global cap', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 1_500; index += 1) files[`/flat/f${index}.jsonl`] = headerOnly(`s${index}`)
    files['/flat/project/2026-10-16_nested.jsonl'] = headerOnly('nested')
    const host = createFakeHost({ home: HOME, env: {}, files })

    const sessions = await list(host, storeLayout({ sessionDirOverride: '/flat' }))
    expect(sessions).toHaveLength(1_500)
    expect(sessions[0]?.notes).toContain('the scan stopped after 1500 session files')
  })

  it('stops inside project traversal when directories exhaust the global file cap', async () => {
    const files: Record<string, string> = {}
    for (let directory = 0; directory < 4; directory += 1) {
      for (let index = 0; index < 400; index += 1) {
        files[`${SESSIONS_ROOT}/--group-${directory}--/${index}_s${directory}-${index}.jsonl`] = headerOnly(
          `s${directory}-${index}`,
        )
      }
    }
    const host = createFakeHost({ home: HOME, env: {}, files })

    const sessions = await list(host, storeLayout())
    expect(sessions).toHaveLength(1_500)
    expect(sessions[0]?.notes).toContain('the scan stopped after 1500 session files')
  })

  it('stops a project directory at its own file cap', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 401; index += 1) files[`${PROJECT_PATH}/f${index}.jsonl`] = headerOnly(`p${index}`)
    const host = createFakeHost({ home: HOME, env: {}, files })

    const sessions = await list(host, storeLayout())
    expect(sessions).toHaveLength(400)
    expect(sessions[0]?.notes).toContain(`only the 400 most recent files of ${PROJECT_DIR} were scanned`)
  })

  it('stops a scan at the directory cap', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 201; index += 1) {
      files[`${SESSIONS_ROOT}/--project-${index}--/2026-10-16_d${index}.jsonl`] = headerOnly(`d${index}`)
    }
    const host = createFakeHost({ home: HOME, env: {}, files })

    const sessions = await list(host, storeLayout())
    expect(sessions).toHaveLength(200)
    expect(sessions[0]?.notes).toContain('only the 200 most recently touched session directories were scanned')
  })

  it('reports a scan gap even when no session survived it', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 1_501; index += 1) files[`/flat/f${index}.jsonl`] = headerOnly(`s${index}`)
    const base = createFakeHost({ home: HOME, env: {}, files })
    const host: AgentHost = { ...base, readHead: async () => '' }

    await expect(list(host, storeLayout({ sessionDirOverride: '/flat' }))).resolves.toEqual([])
  })
})

describe('session file location', () => {
  const layout = storeLayout()

  it('rejects an empty id', async () => {
    await expect(findPiSessionFile(createFakeHost({}), layout, '   ')).resolves.toBeUndefined()
  })

  it('takes a path-like id verbatim, accepting only a file', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const host = createFakeHost({ home: HOME, files: { [path]: headerOnly('s1') } })
    await expect(findPiSessionFile(host, layout, path)).resolves.toBe(path)
    await expect(findPiSessionFile(host, layout, `/${PROJECT_DIR}`)).resolves.toBeUndefined()
    await expect(findPiSessionFile(host, layout, '/nowhere/x.jsonl')).resolves.toBeUndefined()
    await expect(findPiSessionFile(host, layout, '~/missing.jsonl')).resolves.toBeUndefined()
  })

  it('finds a session by the id embedded in its file name', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const host = createFakeHost({ home: HOME, files: { [path]: headerOnly('s1') } })

    await expect(findPiSessionFile(host, layout, 's1')).resolves.toBe(path)
  })

  it('finds a session file placed directly in a store root', async () => {
    const path = `${SESSIONS_ROOT}/2026-10-16_s1.jsonl`
    const host = createFakeHost({ home: HOME, files: { [path]: headerOnly('s1') } })

    await expect(findPiSessionFile(host, layout, 's1')).resolves.toBe(path)
  })

  it('falls back to probing headers when the file name carries no match', async () => {
    const path = `${PROJECT_PATH}/random-name.jsonl`
    const host = createFakeHost({ home: HOME, files: { [path]: headerOnly('chosen') } })

    await expect(findPiSessionFile(host, layout, 'chosen')).resolves.toBe(path)
    await expect(findPiSessionFile(host, layout, 'absent')).resolves.toBeUndefined()
  })

  it('keeps the first fallback when multiple headers carry the same id', async () => {
    const first = `${PROJECT_PATH}/random-first.jsonl`
    const second = `${PROJECT_PATH}/random-second.jsonl`
    const host = createFakeHost({ home: HOME, files: { [first]: headerOnly('chosen'), [second]: headerOnly('chosen') } })

    await expect(findPiSessionFile(host, layout, 'chosen')).resolves.toBe(first)
  })

  it('skips the store when no root exists', async () => {
    const host = createFakeHost({ home: HOME, dirs: ['/elsewhere'] })

    await expect(findPiSessionFile(host, layout, 's1')).resolves.toBeUndefined()
  })

  it('stops probing headers at its cap and reports the incomplete lookup', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 301; index += 1) files[`${PROJECT_PATH}/f${index}.jsonl`] = headerOnly(`s${index}`)
    const host = createFakeHost({ home: HOME, files })

    await expect(findPiSessionFile(host, layout, 'never')).resolves.toBeUndefined()
    expect(host.logs).toEqual(['the by-id Pi session lookup stopped at its header probe cap: never'])
  })

  it('bounds how many project directories a by-id lookup visits', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 201; index += 1) files[`${SESSIONS_ROOT}/--project-${index}--/f.jsonl`] = headerOnly(`s${index}`)
    const host = createFakeHost({ home: HOME, files })

    await expect(findPiSessionFile(host, layout, 's200')).resolves.toBeUndefined()
  })
})

describe('session file names', () => {
  it('accepts only .jsonl names', () => {
    expect(isSessionFileName('a.jsonl')).toBe(true)
    expect(isSessionFileName('a.json')).toBe(false)
    expect(isSessionFileName('jsonl')).toBe(false)
  })

  it('decodes the id segment after the last underscore', () => {
    expect(idFromFileName('2026-10-16T00-00-00.000Z_abc.jsonl')).toBe('abc')
    expect(idFromFileName('2026-10-16.jsonl')).toBeUndefined()
    expect(idFromFileName('_abc.jsonl')).toBeUndefined()
    expect(idFromFileName('abc_.jsonl')).toBeUndefined()
    expect(idFromFileName('abc.json')).toBeUndefined()
  })
})
