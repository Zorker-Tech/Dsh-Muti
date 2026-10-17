import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentSession } from '@deepseek-ai/dsh-agent-mesh'
import { resolveOmpConfig } from '../src/config.ts'
import { resolveOmpStore, sessionKey } from '../src/sessions.ts'
import { MAX_MESSAGE_TEXT_BYTES, ompProjectionCounters, projectOmpEntry, readOmpTranscript } from '../src/transcript.ts'
import { assistantMessage, entry, messageEntry, sessionFile, sessionHeader } from './support/fixtures.ts'
import { FakeHost } from './support/fake-host.ts'

const HOME = '/home/tester'
const BUCKET = '/home/tester/.omp/agent/sessions/-work-repo'
const agentId = brandString<AgentId>('omp')

/** A host, the resolved layout, and a session row for one file. */
async function fixtureOf(content: string): Promise<{
  host: FakeHost
  layout: ReturnType<typeof resolveOmpStore>
  session: AgentSession
}> {
  const host = new FakeHost({ env: {}, home: HOME })
  const layout = resolveOmpStore({ host, config: resolveOmpConfig() })
  const path = `${BUCKET}/1750000000000_sess-1.jsonl`
  host.addFile(path, content)
  const session: AgentSession = {
    key: sessionKey(agentId, 'sess-1'),
    agentId,
    nativeId: 'sess-1',
    nativePath: path,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:01.000Z',
    status: 'idle',
    notes: [],
  }
  return { host, layout, session }
}

/** Project the entries of one session file. */
async function project(content: string): Promise<Awaited<ReturnType<typeof readOmpTranscript>>> {
  const { host, layout, session } = await fixtureOf(content)
  return readOmpTranscript({ host, layout, session })
}

describe('OMP transcript projection', () => {
  it('expands an assistant message into one message per content block', async () => {
    const transcript = await project(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, {
            role: 'assistant',
            provider: 'anthropic',
            model: 'claude-sonnet-4',
            content: [
              { type: 'text', text: 'Looking into it.' },
              { type: 'thinking', thinking: 'Consider the parser.' },
              { type: 'toolCall', name: 'read_file', arguments: { path: 'src/index.ts' } },
              { type: 'image', data: 'base64' },
            ],
          }),
        ],
      }),
    )

    expect(transcript.messages).toHaveLength(3)
    expect(transcript.messages[0]).toMatchObject({
      index: 0,
      role: 'assistant',
      kind: 'assistant',
      text: 'Looking into it.',
      nativeType: 'message',
    })
    expect(transcript.messages[1]).toMatchObject({ index: 1, role: 'assistant', kind: 'reasoning', text: 'Consider the parser.' })
    expect(transcript.messages[2]).toMatchObject({
      index: 2,
      role: 'assistant',
      kind: 'tool-call',
      toolName: 'read_file',
      toolInput: '{"path":"src/index.ts"}',
    })
    expect(transcript.notes).toContain('messages: 1 image blocks were omitted; the mesh message has no image field')
    expect(transcript.hasMore).toBe(false)
    expect(transcript.totalMessages).toBe(1)
  })

  it('projects a user message, a tool result and a parallel tool call', async () => {
    const transcript = await project(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, { role: 'user', content: 'Read the file.' }),
          messageEntry('e2', 'e1', {
            role: 'toolResult',
            toolName: 'read_file',
            toolCallId: 'call-1',
            isError: true,
            content: [{ type: 'text', text: 'ENOENT' }],
          }),
          messageEntry('e3', 'e2', { role: 'bashExecution', command: 'npm test', output: 'ok', exitCode: 1 }),
        ],
      }),
    )

    expect(transcript.messages.map(message => [message.role, message.kind])).toEqual([
      ['user', 'user'],
      ['tool', 'tool-result'],
      ['tool', 'tool-result'],
    ])
    expect(transcript.messages[1]).toMatchObject({ toolName: 'read_file', toolOutput: 'ENOENT', failed: true })
    expect(transcript.messages[2]).toMatchObject({ toolName: 'bash', toolInput: 'npm test', toolOutput: 'ok', failed: true })
  })

  it('projects a fileMention as a user message carrying its paths', async () => {
    const transcript = await project(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, {
            role: 'fileMention',
            content: 'inlined src/index.ts',
            paths: ['src/index.ts', 'src/run.ts'],
          }),
        ],
      }),
    )

    expect(transcript.messages[0]).toMatchObject({
      role: 'user',
      kind: 'user',
      text: 'inlined src/index.ts',
      paths: ['src/index.ts', 'src/run.ts'],
    })
    expect(transcript.notes.some(note => note.includes('no file-change kind'))).toBe(true)
  })

  it('projects an unknown role and notes an unknown entry type', async () => {
    const transcript = await project(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, { role: 'quantum-briefing', content: 'unmodelled' }),
          entry('e2', 'e1', 'teleport_log', { destination: 'mars' }),
        ],
      }),
    )

    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0]).toEqual({
      index: 0,
      role: 'unknown',
      kind: 'unknown',
      text: 'unmodelled',
      nativeType: 'message',
    })
    expect(transcript.notes.some(note => note.includes('entry types this adapter does not model were left out: teleport_log'))).toBe(true)
    expect(transcript.notes.some(note => note.includes('1 messages had a role this adapter does not model'))).toBe(true)
  })

  it('projects compaction and branch summaries as system summaries', async () => {
    const transcript = await project(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          entry('e1', null, 'compaction', { summary: 'compacted earlier turns' }),
          messageEntry('e2', 'e1', { role: 'branchSummary', summary: 'a branch was left behind' }),
          entry('e3', 'e2', 'custom_message', { customType: 'notice', content: 'a hook spoke', display: true }),
        ],
      }),
    )

    expect(transcript.messages.map(message => [message.role, message.kind, message.text])).toEqual([
      ['system', 'summary', 'compacted earlier turns'],
      ['system', 'summary', 'a branch was left behind'],
      ['user', 'user', 'a hook spoke'],
    ])
  })

  it('caps the window at the trailing messages the caller asked for', async () => {
    const transcript = await project(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, { role: 'user', content: 'one' }),
          messageEntry('e2', 'e1', { role: 'user', content: 'two' }),
          messageEntry('e3', 'e2', { role: 'user', content: 'three' }),
        ],
      }),
    )
    expect(transcript.messages.map(message => message.text)).toEqual(['one', 'two', 'three'])

    const { host, layout, session } = await fixtureOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, { role: 'user', content: 'one' }),
          messageEntry('e2', 'e1', { role: 'user', content: 'two' }),
          messageEntry('e3', 'e2', { role: 'user', content: 'three' }),
        ],
      }),
    )
    const capped = await readOmpTranscript({ host, layout, session, maxMessages: 2 })
    expect(capped.messages.map(message => message.text)).toEqual(['two', 'three'])
    expect(capped.messages.map(message => message.index)).toEqual([0, 1])
    expect(capped.hasMore).toBe(true)
    expect(capped.notes.some(note => note.includes('the window was capped at 2 of 3 projected items'))).toBe(true)
  })

  it('reports a missing session file instead of throwing', async () => {
    const transcript = await project(sessionFile({ header: sessionHeader({ id: 'sess-1' }) }))
    expect(transcript.messages).toEqual([])

    const { host, layout } = await fixtureOf('')
    const missing: AgentSession = {
      key: sessionKey(agentId, 'gone'),
      agentId,
      nativeId: 'gone',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
      status: 'idle',
      notes: [],
    }
    const result = await readOmpTranscript({ host, layout, session: missing })
    expect(result.messages).toEqual([])
    expect(result.notes).toEqual(['no session file was found for gone'])
  })

  it('counts what the projection dropped without inventing content', () => {
    const counters = ompProjectionCounters()
    const messages = projectOmpEntry(
      {
        id: 'e1',
        parentId: null,
        timestamp: '2026-10-16T00:00:01.000Z',
        type: 'message',
        raw: '{}',
        record: {
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'kept' },
              { type: 'audio', data: 'x' },
              'not-a-block',
            ],
          },
        },
      },
      counters,
    )
    expect(messages.map(message => message.text)).toEqual(['kept'])
    expect(counters.unknownBlocks).toBe(2)
  })

  it('projects native role and content variants without inventing fields', () => {
    const counters = ompProjectionCounters()
    const projectEntry = (type: string, record: Record<string, unknown>, timestamp = '') => projectOmpEntry(
      { id: type, parentId: null, timestamp, type, raw: '', record },
      counters,
    )

    expect(projectEntry('message', {})).toEqual([])
    const assistantText = projectEntry('message', { message: { role: 'assistant', content: 'plain assistant text', timestamp: 1 } })[0]
    expect(assistantText).toMatchObject({ kind: 'assistant', text: 'plain assistant text', timestamp: new Date(1).toISOString() })
    expect(projectEntry('message', { message: { role: 'assistant' } })).toEqual([])
    expect(projectEntry('message', { message: { content: 'role omitted' } })[0]?.role).toBe('unknown')
    expect(projectEntry('message', { message: { role: 'developer', content: 'developer note' } })[0]).toMatchObject({
      role: 'user',
      nativeType: 'developer',
    })
    expect(projectEntry('message', { message: { role: 'compactionSummary', summary: 'legacy compaction' } })[0]).toMatchObject({
      kind: 'summary',
      nativeType: 'compaction',
    })

    const userBlocks = projectEntry('message', {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text' },
          { type: 'image' },
          { type: 'other' },
          null,
        ],
      },
    })[0]
    expect(userBlocks?.text).toBe('first')

    const toolResult = projectEntry('message', { message: { role: 'toolResult', content: 'plain output' } })[0]
    expect(toolResult).toMatchObject({ kind: 'tool-result', toolName: 'tool', toolOutput: 'plain output' })
    expect(toolResult?.failed).toBeUndefined()
    expect(projectEntry('message', {
      message: { role: 'toolResult', content: [{ type: 'image' }, { type: 'unknown' }] },
    })[0]?.toolOutput).toBeUndefined()

    expect(projectEntry('message', { message: { role: 'bashExecution', code: 'print(1)', exitCode: 0 } })[0]).toMatchObject({
      toolName: 'bash',
      toolInput: 'print(1)',
      nativeType: 'bash',
    })
    expect(projectEntry('message', { message: { role: 'pythonExecution', command: 'run()', exitCode: 2 } })[0]).toMatchObject({
      toolName: 'python',
      toolInput: 'run()',
      failed: true,
    })

    const fileMention = projectEntry('message', {
      message: { role: 'fileMention', content: [{ type: 'text', text: 'mentioned' }], paths: ['a.ts', 2, 'b.ts'] },
    })[0]
    expect(fileMention).toMatchObject({ text: 'mentioned', paths: ['a.ts', 'b.ts'] })
    expect(projectEntry('message', { message: { role: 'fileMention', content: 'no paths' } })[0]?.paths).toEqual([])
    expect(projectEntry('message', { message: { role: 'custom', content: 'hidden notice' } })[0]).toMatchObject({
      role: 'system',
      kind: 'unknown',
      nativeType: 'custom_message',
    })
    expect(projectEntry('message', { message: { role: 'hookMessage', content: 'legacy notice', display: true } })[0]).toMatchObject({
      role: 'user',
      nativeType: 'custom_message',
    })
    expect(projectEntry('custom_message', { content: '' })).toEqual([])
    expect(projectEntry('custom_message', { content: 'bad timestamp', display: false }, 'not a timestamp')[0]?.timestamp).toBeUndefined()
    expect(projectEntry('message', { message: { role: 'custom' } })).toEqual([])
    expect(projectEntry('message', { message: { role: 'unknown-role', content: 4 } })[0]?.kind).toBe('unknown')
    expect(projectEntry('compaction', {})).toEqual([])
    expect(projectEntry('branch_summary', { summary: 'branch context' })[0]).toMatchObject({
      kind: 'summary',
      nativeType: 'branch_summary',
    })
    expect(projectEntry('mode_change', { mode: 'plan' })).toEqual([])

    const long = 'z'.repeat(MAX_MESSAGE_TEXT_BYTES + 20)
    expect(projectEntry('message', { message: { role: 'toolResult', content: long } })[0]?.truncated).toBe(true)
    const largeExecution = projectEntry('message', { message: { role: 'bashExecution', command: long, output: long } })[0]
    expect(largeExecution?.toolInput?.length).toBeGreaterThan(MAX_MESSAGE_TEXT_BYTES)
    expect(largeExecution?.toolOutput?.length).toBeGreaterThan(MAX_MESSAGE_TEXT_BYTES)

    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const assistantBlocks = projectEntry('message', {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'thinking' },
          { type: 'toolCall' },
          { type: 'toolCall', arguments: circular },
          { type: 'toolCall', arguments: () => undefined },
          { type: 'toolCall', arguments: 'x'.repeat(4_100) },
          { type: 'image' },
          'not a block',
        ],
      },
    })
    expect(assistantBlocks[0]?.toolName).toBe('tool')
    expect(assistantBlocks[0]?.toolInput).toBeUndefined()
    expect(assistantBlocks[1]?.toolInput).toBe('<unserializable>')
    expect(assistantBlocks[2]?.toolInput).toContain('undefined')
    expect(assistantBlocks[3]?.toolInput?.length).toBe(4_000)
    expect(counters.images).toBe(3)
    expect(counters.unknownBlocks).toBeGreaterThan(0)
    expect(counters.fileMentions).toBe(2)
    expect(counters.unknownRoles).toBe(3)
  })

  it('truncates a text field at the message cap and flags it', () => {
    const counters = ompProjectionCounters()
    const long = 'x'.repeat(20_000)
    const messages = projectOmpEntry(
      {
        id: 'e1',
        parentId: null,
        timestamp: '',
        type: 'message',
        raw: '{}',
        record: { message: { role: 'user', content: long } },
      },
      counters,
    )
    expect(messages[0]?.truncated).toBe(true)
    expect(messages[0]?.text?.startsWith('x'.repeat(100))).toBe(true)
    expect(messages[0]?.text).toContain('[truncated by dsh-agent-omp')
  })

  it('reads the live branch of a forked session and timestamps from the native clock', async () => {
    const transcript = await project(
      sessionFile({
        title: 'Forked',
        header: sessionHeader({ id: 'sess-1', parentSession: '/tmp/1750000000000_parent.jsonl' }),
        entries: [
          messageEntry('e1', null, assistantMessage([{ type: 'text', text: 'hi' }])),
        ],
      }),
    )
    expect(transcript.key).toBe('omp:sess-1')
    expect(transcript.messages[0]?.timestamp).toBe('2026-10-16T00:00:01.000Z')
  })

  it('reports disappeared and malformed files, abandoned branches and bounded tails', async () => {
    const { host, layout, session } = await fixtureOf('')
    const disappeared = await readOmpTranscript({
      host,
      layout,
      session: { ...session, nativePath: `${BUCKET}/disappeared.jsonl` },
    })
    expect(disappeared.notes).toEqual(['the session file disappeared during the read'])

    const malformed = await project('not a session line\n')
    expect(malformed.notes.some(note => note.includes('lines in the read window did not parse'))).toBe(true)

    const abandoned = await project(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('root', null, { role: 'user', content: 'root' }),
          messageEntry('old', 'root', { role: 'user', content: 'old branch' }),
          messageEntry('live', 'root', { role: 'user', content: 'live branch' }),
        ],
      }),
    )
    expect(abandoned.messages.map(message => message.text)).toEqual(['root', 'live branch'])
    expect(abandoned.notes.some(note => note.includes('abandoned branches'))).toBe(true)

    const { host: largeHost, layout: largeLayout, session: largeSession } = await fixtureOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          entry('large', null, 'custom', { padding: 'x'.repeat(70_000) }),
          messageEntry('tail', 'large', { role: 'user', content: 'tail remains' }),
        ],
      }),
    )
    const bounded = await readOmpTranscript({ host: largeHost, layout: largeLayout, session: largeSession, maxBytes: 64 * 1024 })
    expect(bounded.messages.map(message => message.text)).toEqual(['tail remains'])
    expect(bounded.hasMore).toBe(true)
    expect(bounded.totalMessages).toBeUndefined()
    expect(bounded.notes.some(note => note.includes('live branch extends past the read window'))).toBe(true)
  })

  it('finds a session by id when the row has no native path and notes omitted content blocks', async () => {
    const { host, layout, session } = await fixtureOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [messageEntry('assistant', null, { role: 'assistant', content: [{ type: 'audio', data: 'ignored' }] })],
      }),
    )
    const { nativePath: _nativePath, ...withoutPath } = session
    const transcript = await readOmpTranscript({ host, layout, session: withoutPath })
    expect(transcript.notes.some(note => note.includes('content blocks have no canonical kind'))).toBe(true)
  })
})
