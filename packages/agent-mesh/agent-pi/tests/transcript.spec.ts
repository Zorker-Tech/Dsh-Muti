/**
 * Projection of one Pi session file into mesh transcript messages.
 * @module @deepseek-ai/dsh-agent-pi/tests/transcript
 */

import { describe, expect, it } from 'vitest'
import type { AgentId, AgentSession, AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  MAX_MESSAGE_TEXT_BYTES,
  projectPiEntry,
  projectionCounters,
  readPiTranscript,
  type PiMessageDraft,
} from '../src/transcript.ts'
import {
  HEADER_READ_BYTES,
  MAX_RAW_CHARS,
  MIN_TRANSCRIPT_BYTES,
  readPiEntry,
  type PiNativeEntry,
  type PiStoreLayout,
} from '../src/sessions.ts'
import { assistantEntry, entryLine, sessionFile, userEntry } from './fixtures.ts'
import { createFakeHost } from './host.ts'

const PI: AgentId = brandString<AgentId>('pi')
const KEY: AgentSessionKey = brandString<AgentSessionKey>('pi:s1')
const AGENT_DIR = '/home/tester/.pi/agent'
const PROJECT_PATH = `${AGENT_DIR}/sessions/--home-tester-project--`

/** A store layout rooted at the default agent directory. */
function storeLayout(): PiStoreLayout {
  return {
    agentDir: AGENT_DIR,
    defaultSessionsRoot: `${AGENT_DIR}/sessions`,
    credentialPath: `${AGENT_DIR}/auth.json`,
    settingsPath: `${AGENT_DIR}/settings.json`,
    modelsPath: `${AGENT_DIR}/models.json`,
  }
}

/** Parse one raw line as a session entry. */
function entryOf(line: string): PiNativeEntry {
  const entry = readPiEntry(JSON.parse(line), line)
  if (entry === undefined) throw new Error(`not an entry: ${line}`)
  return entry
}

/** Project one line and return the drafts. */
function project(line: string): readonly PiMessageDraft[] {
  return projectPiEntry(entryOf(line), projectionCounters())
}

/** Project one line and return the drafts with the counters the run accumulated. */
function projectWithCounters(
  line: string,
  counters = projectionCounters(),
): { drafts: readonly PiMessageDraft[]; counters: ReturnType<typeof projectionCounters> } {
  return { drafts: projectPiEntry(entryOf(line), counters), counters }
}

/** A mesh session record pointing at one store file. */
function sessionAt(
  path: string,
  overrides: Omit<Partial<AgentSession>, 'nativePath'> & { readonly nativePath?: string | undefined } = {},
): AgentSession {
  const { nativePath: overrideNativePath, ...fields } = overrides
  const nativePath = Object.hasOwn(overrides, 'nativePath') ? overrideNativePath : path
  return {
    key: KEY,
    agentId: PI,
    nativeId: 's1',
    ...(nativePath === undefined ? {} : { nativePath }),
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:01.000Z',
    status: 'idle',
    notes: [],
    ...fields,
  }
}

describe('entry projection', () => {
  it('produces nothing for entries that carry state rather than conversation', () => {
    for (const type of ['session_info', 'model_change', 'thinking_level_change', 'usage', 'context_edit', 'label', 'future_thing']) {
      expect(project(entryLine({ id: 'a', type }))).toEqual([])
    }
  })

  it('projects a user message with its text and native type', () => {
    expect(project(userEntry('a', null, 'hello there'))).toEqual([
      { role: 'user', kind: 'user', text: 'hello there', timestamp: '2026-10-16T00:00:01.000Z', nativeType: 'message' },
    ])
  })

  it('joins the text blocks of a user content array and declares a message with no text', () => {
    const blocks = entryLine({
      id: 'a',
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'one' }, { type: 'text' }, { type: 'text', text: 'two' }],
      },
    })
    expect(project(blocks)).toEqual([
      { role: 'user', kind: 'user', text: 'one\ntwo', timestamp: '2026-10-16T00:00:01.000Z', nativeType: 'message' },
    ])

    const empty = entryLine({ id: 'b', type: 'message', message: { role: 'user', content: [] } })
    expect(project(empty)).toEqual([
      { role: 'user', kind: 'user', timestamp: '2026-10-16T00:00:01.000Z', nativeType: 'message' },
    ])

    const none = entryLine({ id: 'c', type: 'message', message: { role: 'user' } })
    expect(project(none)).toEqual([
      { role: 'user', kind: 'user', timestamp: '2026-10-16T00:00:01.000Z', nativeType: 'message' },
    ])
  })

  it('projects an assistant block per content block and counts what it cannot carry', () => {
    const line = assistantEntry(
      'a',
      null,
      [
        { type: 'text', text: 'answer' },
        { type: 'text', text: '' },
        { type: 'thinking', thinking: 'thought' },
        { type: 'thinking', thinking: '' },
        { type: 'toolCall', name: 'read', arguments: { path: '/tmp/x' } },
        { type: 'toolCall' },
        { type: 'image', data: 'x' },
        { type: 'mystery' },
        'not-a-block',
      ],
      { timestamp: 1_700_000_000_000 },
    )

    const { drafts, counters } = projectWithCounters(line)
    expect(drafts).toEqual([
      { role: 'assistant', kind: 'assistant', text: 'answer', timestamp: new Date(1_700_000_000_000).toISOString(), nativeType: 'message' },
      { role: 'assistant', kind: 'reasoning', text: 'thought', timestamp: new Date(1_700_000_000_000).toISOString(), nativeType: 'message' },
      { role: 'assistant', kind: 'tool-call', toolName: 'read', toolInput: '{"path":"/tmp/x"}', timestamp: new Date(1_700_000_000_000).toISOString(), nativeType: 'message' },
      { role: 'assistant', kind: 'tool-call', toolName: 'tool', timestamp: new Date(1_700_000_000_000).toISOString(), nativeType: 'message' },
    ])
    expect(drafts.every(draft => draft.timestamp === new Date(1_700_000_000_000).toISOString())).toBe(true)
    expect(counters).toEqual({ images: 1, unknownBlocks: 2, unknownRoles: 0 })
  })

  it('projects an assistant whose content is one string', () => {
    const line = entryLine({ id: 'a', type: 'message', message: { role: 'assistant', content: 'plain' } })

    expect(project(line)).toEqual([
      { role: 'assistant', kind: 'assistant', text: 'plain', timestamp: '2026-10-16T00:00:01.000Z', nativeType: 'message' },
    ])
  })

  it('omits an invalid native timestamp', () => {
    const line = entryLine({
      id: 'a',
      type: 'message',
      timestamp: 'not-a-time',
      message: { role: 'assistant', content: 'answer' },
    })
    expect(project(line)).toEqual([{ role: 'assistant', kind: 'assistant', text: 'answer', nativeType: 'message' }])
  })

  it('produces nothing for an assistant message with no content at all or no message record', () => {
    expect(project(entryLine({ id: 'a', type: 'message', message: { role: 'assistant' } }))).toEqual([])
    expect(project(entryLine({ id: 'b', type: 'message' }))).toEqual([])
  })

  it('projects a tool result with its output, failure flag and tool name', () => {
    const ok = entryLine({
      id: 'a',
      type: 'message',
      message: { role: 'toolResult', toolName: 'read', content: 'file body' },
    })
    expect(project(ok)).toEqual([
      {
        role: 'tool',
        kind: 'tool-result',
        toolName: 'read',
        toolOutput: 'file body',
        timestamp: '2026-10-16T00:00:01.000Z',
        nativeType: 'message',
      },
    ])

    const failed = entryLine({
      id: 'b',
      type: 'message',
      message: { role: 'toolResult', isError: true, content: [{ type: 'text', text: 'boom' }, { type: 'image' }, { type: 'x' }] },
    })
    expect(project(failed)).toEqual([
      {
        role: 'tool',
        kind: 'tool-result',
        toolName: 'tool',
        toolOutput: 'boom',
        failed: true,
        timestamp: '2026-10-16T00:00:01.000Z',
        nativeType: 'message',
      },
    ])
  })

  it('projects a bash execution with its command and a failure only for a non-zero exit', () => {
    const line = entryLine({
      id: 'a',
      type: 'message',
      message: { role: 'bashExecution', command: 'ls -la', output: 'files', exitCode: 2 },
    })
    expect(project(line)).toEqual([
      {
        role: 'tool',
        kind: 'tool-result',
        toolName: 'bash',
        toolInput: 'ls -la',
        toolOutput: 'files',
        failed: true,
        timestamp: '2026-10-16T00:00:01.000Z',
        nativeType: 'message',
      },
    ])

    const succeeded = entryLine({
      id: 'b',
      type: 'message',
      message: { role: 'bashExecution', command: 'true', output: '', exitCode: 0 },
    })
    expect(project(succeeded)).toEqual([
      {
        role: 'tool',
        kind: 'tool-result',
        toolName: 'bash',
        toolInput: 'true',
        toolOutput: '',
        timestamp: '2026-10-16T00:00:01.000Z',
        nativeType: 'message',
      },
    ])

    const bare = entryLine({ id: 'c', type: 'message', message: { role: 'bashExecution' } })
    expect(project(bare)).toEqual([
      { role: 'tool', kind: 'tool-result', toolName: 'bash', timestamp: '2026-10-16T00:00:01.000Z', nativeType: 'message' },
    ])
  })

  it('projects a custom message by its display flag and native custom type', () => {
    const displayed = entryLine({
      id: 'a',
      type: 'message',
      message: { role: 'custom', content: 'injected', display: true, customType: 'hook' },
    })
    expect(project(displayed)).toEqual([
      { role: 'user', kind: 'user', text: 'injected', nativeType: 'hook', timestamp: '2026-10-16T00:00:01.000Z' },
    ])

    const hidden = entryLine({
      id: 'b',
      type: 'message',
      message: { role: 'custom', content: 'quiet' },
    })
    expect(project(hidden)).toEqual([
      { role: 'system', kind: 'unknown', text: 'quiet', nativeType: 'custom_message', timestamp: '2026-10-16T00:00:01.000Z' },
    ])

    const empty = entryLine({ id: 'c', type: 'message', message: { role: 'custom', content: '' } })
    expect(project(empty)).toEqual([])

    const nonText = entryLine({ id: 'd', type: 'message', message: { role: 'custom', content: 42 } })
    expect(project(nonText)).toEqual([])

    const arrayContent = entryLine({
      id: 'e',
      type: 'message',
      message: { role: 'custom', content: [{ type: 'text', text: 'block' }], display: true },
    })
    expect(project(arrayContent)).toEqual([
      { role: 'user', kind: 'user', text: 'block', nativeType: 'custom_message', timestamp: '2026-10-16T00:00:01.000Z' },
    ])
  })

  it('projects the message-level summary roles onto the summary kind', () => {
    const branch = entryLine({ id: 'a', type: 'message', message: { role: 'branchSummary', summary: 'other branch' } })
    expect(project(branch)).toEqual([
      { role: 'system', kind: 'summary', text: 'other branch', nativeType: 'branch_summary', timestamp: '2026-10-16T00:00:01.000Z' },
    ])

    const compaction = entryLine({ id: 'b', type: 'message', message: { role: 'compactionSummary', summary: 'compacted' } })
    expect(project(compaction)).toEqual([
      { role: 'system', kind: 'summary', text: 'compacted', nativeType: 'compaction', timestamp: '2026-10-16T00:00:01.000Z' },
    ])
  })

  it('projects a message role this adapter does not model as an unknown message', () => {
    const line = entryLine({ id: 'a', type: 'message', message: { role: 'mystery', content: 'what' } })

    const { drafts, counters } = projectWithCounters(line)
    expect(drafts).toEqual([
      { role: 'unknown', kind: 'unknown', text: 'what', timestamp: '2026-10-16T00:00:01.000Z', nativeType: 'message' },
    ])
    expect(counters.unknownRoles).toBe(1)

    const noText = entryLine({ id: 'b', type: 'message', message: { content: 7 } })
    expect(project(noText)).toEqual([
      { role: 'unknown', kind: 'unknown', timestamp: '2026-10-16T00:00:01.000Z', nativeType: 'message' },
    ])
  })

  it('projects top-level custom and summary entries', () => {
    expect(project(entryLine({ id: 'a', type: 'custom_message', content: 'notice', customType: 'hook' }))).toEqual([
      { role: 'system', kind: 'unknown', text: 'notice', nativeType: 'hook', timestamp: '2026-10-16T00:00:01.000Z' },
    ])
    expect(project(entryLine({ id: 'b', type: 'custom', content: 'shown', display: true }))).toEqual([
      { role: 'user', kind: 'user', text: 'shown', nativeType: 'custom_message', timestamp: '2026-10-16T00:00:01.000Z' },
    ])
    expect(project(entryLine({ id: 'c', type: 'compaction', summary: 'squashed' }))).toEqual([
      { role: 'system', kind: 'summary', text: 'squashed', nativeType: 'compaction', timestamp: '2026-10-16T00:00:01.000Z' },
    ])
    expect(project(entryLine({ id: 'd', type: 'branch_summary', summary: 'left behind' }))).toEqual([
      { role: 'system', kind: 'summary', text: 'left behind', nativeType: 'branch_summary', timestamp: '2026-10-16T00:00:01.000Z' },
    ])
  })

  it('counts a summary entry that carries no text as an unmodelled block', () => {
    const { drafts, counters } = projectWithCounters(entryLine({ id: 'a', type: 'compaction' }))
    expect(drafts).toEqual([])
    expect(counters.unknownBlocks).toBe(1)

    expect(project(entryLine({ id: 'b', type: 'compaction', summary: '' }))).toEqual([])
  })
})

describe('text field caps', () => {
  it('marks text cut at the per-field cap', () => {
    const long = 'x'.repeat(MAX_MESSAGE_TEXT_BYTES + 10)

    const user = project(userEntry('a', null, long))
    expect(user[0]?.truncated).toBe(true)
    expect(user[0]?.text).toHaveLength(MAX_MESSAGE_TEXT_BYTES)
  })

  it('bounds tool input and tool output fields', () => {
    const args = { body: 'y'.repeat(MAX_RAW_CHARS + 100) }
    const call = project(assistantEntry('a', null, [{ type: 'toolCall', name: 'write', arguments: args }]))
    expect(call[0]?.toolInput).toHaveLength(MAX_RAW_CHARS)

    const output = project(
      entryLine({ id: 'b', type: 'message', message: { role: 'toolResult', content: 'z'.repeat(MAX_MESSAGE_TEXT_BYTES + 1) } }),
    )
    expect(output[0]?.truncated).toBe(true)
    expect(output[0]?.toolOutput).toHaveLength(MAX_MESSAGE_TEXT_BYTES)
  })

  it('preserves an unserializable tool argument as a declared placeholder', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    const entry: PiNativeEntry = {
      id: 'a',
      parentId: null,
      timestamp: '2026-10-16T00:00:01.000Z',
      type: 'message',
      raw: '',
      record: {
        message: { role: 'assistant', content: [{ type: 'toolCall', name: 'weird', arguments: circular }] },
      },
    }
    const call = projectPiEntry(entry, projectionCounters())
    expect(call[0]?.toolInput).toBe('<unserializable>')
  })

  it('uses the string fallback when native JSON serialization returns undefined', () => {
    const entry: PiNativeEntry = {
      id: 'a',
      parentId: null,
      timestamp: '2026-10-16T00:00:01.000Z',
      type: 'message',
      raw: '',
      record: {
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'read', arguments: { toJSON: () => undefined } }],
        },
      },
    }
    const input = projectPiEntry(entry, projectionCounters())[0]?.toolInput
    expect(input).toBe('[object Object]')
  })
})

describe('transcript reads', () => {
  it('projects the live branch oldest first with its exact message count', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const body = sessionFile({ id: 's1' }, [
      userEntry('a', null, 'hello'),
      assistantEntry('b', 'a', [{ type: 'text', text: 'hi' }]),
    ])
    const host = createFakeHost({ files: { [path]: body } })

    const transcript = await readPiTranscript({ host, layout: storeLayout(), session: sessionAt(path) })

    expect(transcript.key).toBe(KEY)
    expect(transcript.messages.map(message => [message.index, message.role, message.kind])).toEqual([
      [0, 'user', 'user'],
      [1, 'assistant', 'assistant'],
    ])
    expect(transcript.totalMessages).toBe(2)
    expect(transcript.hasMore).toBe(false)
    expect(transcript.notes).toEqual([
      'the mesh message kinds have no `system` member: pi summaries are reported as kind `summary`, and injected messages keep role `system` with kind `unknown`',
      "pi's entry ids and tool-call ids are not carried: the mesh message record has no id field",
    ])
  })

  it('finds the session file when the listing recorded no path', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const host = createFakeHost({ files: { [path]: sessionFile({ id: 's1' }, [userEntry('a', null, 'hello')]) } })

    const transcript = await readPiTranscript({ host, layout: storeLayout(), session: sessionAt(path, { nativePath: undefined }) })
    expect(transcript.messages).toHaveLength(1)
  })

  it('reports a session file it cannot find as an empty window with a note', async () => {
    const host = createFakeHost({})

    await expect(
      readPiTranscript({ host, layout: storeLayout(), session: sessionAt('/gone.jsonl', { nativePath: undefined }) }),
    ).resolves.toEqual({
      key: KEY,
      messages: [],
      hasMore: false,
      notes: ['no session file was found for s1'],
    })
  })

  it('reports a session file that disappeared during the read', async () => {
    const host = createFakeHost({})

    await expect(readPiTranscript({ host, layout: storeLayout(), session: sessionAt('/gone.jsonl') })).resolves.toEqual({
      key: KEY,
      messages: [],
      hasMore: false,
      notes: ['the session file disappeared during the read'],
    })
  })

  it('declares abandoned entries, dropped content and unmodelled records', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const body = sessionFile({ id: 's1' }, [
      userEntry('a', null, 'hello'),
      entryLine({ id: 'side', type: 'message', parentId: 'a', message: { role: 'user', content: 'abandoned' } }),
      entryLine({ id: 'b', type: 'message', parentId: 'a', message: { role: 'user', content: [{ type: 'image' }, 'x', { type: 'other' }] } }),
      entryLine({ id: 'c', type: 'message', parentId: 'b', message: { role: 'mystery' } }),
      entryLine({ id: 'd', type: 'future_thing', parentId: 'c' }),
      '{not json',
    ])
    const host = createFakeHost({ files: { [path]: body } })

    const { notes } = await readPiTranscript({ host, layout: storeLayout(), session: sessionAt(path) })
    expect(notes).toEqual(
      expect.arrayContaining([
        '1 lines in the read window did not parse',
        'messages: 1 entries on abandoned branches are excluded from the linear reading',
        'messages: entry types this adapter does not model were left out: future_thing',
        'messages: 1 image blocks were omitted; the canonical message has no image field',
        'messages: 2 content blocks have no canonical kind',
        'messages: 1 messages had a role this adapter does not model',
      ]),
    )
  })

  it('caps the window to the trailing messages the caller asked for', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const entries = ['a', 'b', 'c'].map((id, index) => userEntry(id, index === 0 ? null : ['a', 'b', 'c'][index - 1] ?? null, `message ${id}`))
    const host = createFakeHost({ files: { [path]: sessionFile({ id: 's1' }, entries) } })

    const transcript = await readPiTranscript({ host, layout: storeLayout(), session: sessionAt(path), maxMessages: 2 })

    expect(transcript.messages.map(message => message.text)).toEqual(['message b', 'message c'])
    expect(transcript.messages.map(message => message.index)).toEqual([0, 1])
    expect(transcript.hasMore).toBe(true)
    expect(transcript.totalMessages).toBe(3)
    expect(transcript.notes).toContain('messages: the window was capped at 2 of 3 projected items')
  })

  it('returns the whole window when the caller asks for no cap or a non-positive one', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const host = createFakeHost({ files: { [path]: sessionFile({ id: 's1' }, [userEntry('a', null, 'one'), userEntry('b', 'a', 'two')]) } })

    for (const maxMessages of [0, -1, 5]) {
      const transcript = await readPiTranscript({ host, layout: storeLayout(), session: sessionAt(path), maxMessages })
      expect(transcript.messages).toHaveLength(2)
      expect(transcript.hasMore).toBe(false)
    }
  })

  it('projects only the window when the byte budget is smaller than the file', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const entries: string[] = []
    for (let index = 0; index < 900; index += 1) entries.push(userEntry(`e${index}`, index === 0 ? null : `e${index - 1}`, 'y'.repeat(100)))
    const body = sessionFile({ id: 's1' }, entries)
    expect(body.length).toBeGreaterThan(64 * 1024)
    const host = createFakeHost({ files: { [path]: body } })

    const transcript = await readPiTranscript({ host, layout: storeLayout(), session: sessionAt(path), maxBytes: 64 * 1024 })

    expect(transcript.messages.length).toBeGreaterThan(0)
    expect(transcript.messages.length).toBeLessThan(900)
    expect(transcript.totalMessages).toBeUndefined()
    expect(transcript.hasMore).toBe(true)
    expect(transcript.notes).toContain(
      'messages: the live branch extends past the read window, so older messages were not read',
    )
  })

  it('declares a header that did not fit its read window', async () => {
    const path = `${PROJECT_PATH}/2026-10-16_s1.jsonl`
    const body = `${'x'.repeat(HEADER_READ_BYTES + 10)}\n${userEntry('a', null, 'after the long line')}\n`
    const host = createFakeHost({ files: { [path]: body } })

    const transcript = await readPiTranscript({ host, layout: storeLayout(), session: sessionAt(path), maxBytes: MIN_TRANSCRIPT_BYTES })
    expect(transcript.notes).toContain(
      `cwd: the session header did not fit in ${HEADER_READ_BYTES} bytes, so the cwd is unavailable`,
    )
  })
})
