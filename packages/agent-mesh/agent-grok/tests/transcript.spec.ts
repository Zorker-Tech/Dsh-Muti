import { describe, expect, it } from 'vitest'
import type { AgentId, AgentMessage, AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveGrokConfig } from '../src/config.ts'
import { grokAdapter } from '../src/index.ts'
import { MAX_MESSAGE_FIELD_CHARS, readGrokTranscript } from '../src/transcript.ts'
import { MemoryHost } from './support/memory-host.ts'

const DIR = '/home/tester/.grok/sessions/%2Fwork/sess-1'
const KEY = brandString<AgentSessionKey>('grok:sess-1')

/** One ACP session update, as grok persists it into updates.jsonl. */
const update = (sessionUpdate: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ method: 'session/update', params: { update: { sessionUpdate, ...extra } } })

/** A line whose envelope is the update itself, without a method. */
const bareUpdate = (sessionUpdate: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ update: { sessionUpdate, ...extra } })

describe('grok transcript projection', () => {
  it('projects each persisted update family', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: {
        [`${DIR}/updates.jsonl`]: [
          JSON.stringify({
            timestamp: 1_767_225_600,
            method: 'session/update',
            params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } } },
          }),
          JSON.stringify({
            method: '_x.ai/session/update',
            params: { update: { sessionUpdate: 'agent_message_chunk', content: 'world' } },
          }),
          JSON.stringify({
            method: 'session/update',
            params: {
              _meta: { agentTimestampMs: 1_767_225_601_000 },
              update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'thinking' } },
            },
          }),
          update('tool_call', {
            toolCallId: 'c1',
            toolName: 'read_file',
            rawInput: { path: '/a' },
            locations: [{ path: '/a' }],
          }),
          update('tool_call_update', {
            toolCallId: 'c1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
            locations: [{ path: '/a' }, { path: '/a' }],
          }),
          update('plan', { entries: [{ content: 'step one', status: 'in_progress' }, { content: 'step two', status: 'pending' }] }),
          update('current_mode_update', { modeId: 'plan' }),
          bareUpdate('agent_message_chunk', { content: 'legacy' }),
          '',
        ].join('\n'),
      },
    })

    const transcript = await readGrokTranscript({ host, sessionDir: DIR, key: KEY })

    expect(transcript.notes).toEqual([])
    expect(transcript.hasMore).toBe(false)
    expect(transcript.messages).toEqual([
      { index: 0, role: 'user', kind: 'user', nativeType: 'user_message_chunk', text: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      { index: 1, role: 'assistant', kind: 'assistant', nativeType: 'agent_message_chunk', text: 'world' },
      { index: 2, role: 'assistant', kind: 'reasoning', nativeType: 'agent_thought_chunk', text: 'thinking', timestamp: '2026-01-01T00:00:01.000Z' },
      {
        index: 3,
        role: 'assistant',
        kind: 'tool-call',
        nativeType: 'tool_call',
        toolName: 'read_file',
        toolInput: '{"path":"/a"}',
        paths: ['/a'],
      },
      {
        index: 4,
        role: 'tool',
        kind: 'tool-result',
        nativeType: 'tool_call_update',
        toolName: 'read_file',
        toolOutput: 'file body',
        failed: false,
        paths: ['/a'],
      },
      { index: 5, role: 'assistant', kind: 'plan', nativeType: 'plan', text: 'in_progress: step one\npending: step two' },
      { index: 6, role: 'system', kind: 'plan', nativeType: 'current_mode_update', text: 'plan' },
      { index: 7, role: 'assistant', kind: 'assistant', nativeType: 'agent_message_chunk', text: 'legacy' },
    ])
  })

  it('keeps an unknown update type as an unknown message with its native type', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: { [`${DIR}/updates.jsonl`]: update('future_thing', { payload: true }) },
    })

    const transcript = await readGrokTranscript({ host, sessionDir: DIR, key: KEY })

    expect(transcript.messages).toEqual([
      { index: 0, role: 'unknown', kind: 'unknown', nativeType: 'future_thing' },
    ])
  })

  it('declares malformed records in the window instead of dropping the session', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: { [`${DIR}/updates.jsonl`]: ['not json', update('agent_message_chunk', { content: 'ok' })].join('\n') },
    })

    const transcript = await readGrokTranscript({ host, sessionDir: DIR, key: KEY })

    expect(transcript.messages).toEqual([
      { index: 0, role: 'assistant', kind: 'assistant', nativeType: 'agent_message_chunk', text: 'ok' },
    ])
    expect(transcript.hasMore).toBe(true)
    expect(transcript.notes).toEqual(['1 unparsable or unrecognized record(s) in the read window were skipped'])
  })

  it('keeps malformed update gaps and projects missing tool fields and every plan status', async () => {
    const longText = 'x'.repeat(MAX_MESSAGE_FIELD_CHARS + 1)
    const host = new MemoryHost({
      env: { PATH: '' },
      files: {
        [`${DIR}/updates.jsonl`]: [
          'null',
          '{}',
          JSON.stringify({ method: 'session/update', params: {} }),
          JSON.stringify({ update: null }),
          JSON.stringify({ update: {} }),
          JSON.stringify({ method: 'legacy', params: { update: {} }, timestamp: 'bad' }),
          update('tool_call', {
            toolCallId: 'c1',
            toolName: '',
            title: '',
            rawInput: longText,
            locations: [null, {}, { path: '/changed' }, { path: '/changed' }],
          }),
          update('tool_call_update', { toolCallId: 'c1', status: 'failed', content: 'not an array', rawOutput: { ok: true } }),
          update('tool_call_update', { status: 'completed', content: [{ type: 'diff', path: '/diff' }] }),
          update('plan', { entries: [null, {}, { content: '' }, { content: 'done', status: 'completed' }, { content: 'blocked', status: 'blocked' }, { content: 'cancelled', status: 'cancelled' }, { content: 'future', status: 'future' }] }),
          update('current_mode_update', {}),
          update('agent_message_chunk', { content: '' }),
          update('agent_message_chunk', { content: longText }),
        ].join('\n'),
      },
    })

    const transcript = await readGrokTranscript({ host, sessionDir: DIR, key: KEY })

    expect(transcript.hasMore).toBe(true)
    expect(transcript.notes).toEqual(['4 unparsable or unrecognized record(s) in the read window were skipped'])
    expect(transcript.messages.map(message => message.nativeType)).toEqual([
      'unknown',
      'legacy',
      'tool_call',
      'tool_call_update',
      'tool_call_update',
      'plan',
      'current_mode_update',
      'agent_message_chunk',
      'agent_message_chunk',
    ])
    expect(transcript.messages[2]).toMatchObject({
      kind: 'tool-call',
      toolName: 'tool',
      paths: ['/changed'],
      truncated: true,
    })
    expect(transcript.messages[2]?.toolInput).toHaveLength(MAX_MESSAGE_FIELD_CHARS)
    expect(transcript.messages[3]).toMatchObject({ kind: 'tool-result', toolName: 'tool', failed: true, toolOutput: '{"ok":true}' })
    expect(transcript.messages[4]).toMatchObject({ kind: 'tool-result', toolOutput: '[diff] /diff' })
    expect(transcript.messages[5]?.text).toBe('completed: done\nblocked: blocked\ncancelled: cancelled\npending: future')
    expect(transcript.messages[6]?.text).toBeUndefined()
    expect(transcript.messages[7]?.text).toBeUndefined()
  })

  it('handles absent ACP parameters, tool fields and non-array plan entries', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: {
        [`${DIR}/updates.jsonl`]: [
          JSON.stringify({ method: 'session/update' }),
          update('tool_call', { toolName: 'plain-tool' }),
          JSON.stringify({
            timestamp: 1,
            method: 'session/update',
            params: { update: { sessionUpdate: 'tool_call', toolName: 'timed-tool' } },
          }),
          update('tool_call_update', { status: 'completed', content: [null], rawOutput: '' }),
          JSON.stringify({
            timestamp: 2,
            method: 'session/update',
            params: { update: { sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'z'.repeat(MAX_MESSAGE_FIELD_CHARS + 1) } },
          }),
          update('plan', { entries: 'not-an-array' }),
          update('agent_message_chunk', { content: 1 }),
        ].join('\n'),
      },
    })

    const transcript = await readGrokTranscript({ host, sessionDir: DIR, key: KEY })

    expect(transcript.hasMore).toBe(true)
    expect(transcript.notes).toEqual(['1 unparsable or unrecognized record(s) in the read window were skipped'])
    expect(transcript.messages).toEqual([
      { index: 0, role: 'assistant', kind: 'tool-call', nativeType: 'tool_call', toolName: 'plain-tool' },
      { index: 1, role: 'assistant', kind: 'tool-call', nativeType: 'tool_call', toolName: 'timed-tool', timestamp: '1970-01-01T00:00:01.000Z' },
      { index: 2, role: 'tool', kind: 'tool-result', nativeType: 'tool_call_update', toolName: 'tool', failed: false },
      { index: 3, role: 'tool', kind: 'tool-result', nativeType: 'tool_call_update', toolName: 'tool', failed: false, timestamp: '1970-01-01T00:00:02.000Z', toolOutput: 'z'.repeat(MAX_MESSAGE_FIELD_CHARS), truncated: true },
      { index: 4, role: 'assistant', kind: 'plan', nativeType: 'plan' },
      { index: 5, role: 'assistant', kind: 'assistant', nativeType: 'agent_message_chunk' },
    ])
  })

  it('falls back to chat_history.jsonl with the substitution declared', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: {
        [`${DIR}/chat_history.jsonl`]: [
          JSON.stringify({ type: 'system', content: 'system prompt' }),
          JSON.stringify({ type: 'user', content: [{ text: 'hi' }] }),
          JSON.stringify({ type: 'assistant', content: 'ok', tool_calls: [{ name: 'shell', arguments: { cmd: 'ls' } }] }),
          JSON.stringify({ type: 'tool_result', content: 'out' }),
          JSON.stringify({ type: 'reasoning', content: 'because' }),
          JSON.stringify({ type: 'weird' }),
        ].join('\n'),
      },
    })

    const transcript = await readGrokTranscript({ host, sessionDir: DIR, key: KEY })

    expect(transcript.notes).toEqual([
      'updates.jsonl is absent or empty; the transcript was projected from chat_history.jsonl, a derived model-message cache rather than the authoritative ACP stream',
    ])
    expect(transcript.messages).toEqual([
      { index: 0, role: 'system', kind: 'unknown', nativeType: 'system', text: 'system prompt' },
      { index: 1, role: 'user', kind: 'user', nativeType: 'user', text: 'hi' },
      { index: 2, role: 'assistant', kind: 'assistant', nativeType: 'assistant', text: 'ok' },
      { index: 3, role: 'assistant', kind: 'tool-call', nativeType: 'assistant.tool_calls', toolName: 'shell', toolInput: '{"cmd":"ls"}' },
      { index: 4, role: 'tool', kind: 'tool-result', nativeType: 'tool_result', toolName: 'tool', toolOutput: 'out', failed: false },
      { index: 5, role: 'assistant', kind: 'reasoning', nativeType: 'reasoning', text: 'because' },
      { index: 6, role: 'unknown', kind: 'unknown', nativeType: 'weird' },
    ])
  })

  it('counts malformed chat-history values and skips empty projected fields', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: {
        [`${DIR}/chat_history.jsonl`]: [
          'not json',
          '[]',
          JSON.stringify({ type: 'assistant', content: [], tool_calls: [null, {}, { name: 'shell', arguments: '' }, { name: 'long', arguments: 'x'.repeat(MAX_MESSAGE_FIELD_CHARS + 1) }] }),
          JSON.stringify({ type: 'assistant', content: 'no calls' }),
          JSON.stringify({ type: 'tool_result', content: '' }),
          JSON.stringify({ type: 'tool_result', content: 'y'.repeat(MAX_MESSAGE_FIELD_CHARS + 1) }),
          JSON.stringify({ type: 'user', content: [null, { text: '' }, { text: 'piece' }] }),
          JSON.stringify({ type: 'user', content: {} }),
          JSON.stringify({}),
          '',
        ].join('\n'),
      },
    })

    const transcript = await readGrokTranscript({ host, sessionDir: DIR, key: KEY })

    expect(transcript.hasMore).toBe(true)
    expect(transcript.notes).toEqual([
      'updates.jsonl is absent or empty; the transcript was projected from chat_history.jsonl, a derived model-message cache rather than the authoritative ACP stream',
    ])
    expect(transcript.messages).toEqual([
      { index: 0, role: 'assistant', kind: 'assistant', nativeType: 'assistant' },
      { index: 1, role: 'assistant', kind: 'tool-call', nativeType: 'assistant.tool_calls', toolName: 'tool' },
      { index: 2, role: 'assistant', kind: 'tool-call', nativeType: 'assistant.tool_calls', toolName: 'shell' },
      { index: 3, role: 'assistant', kind: 'tool-call', nativeType: 'assistant.tool_calls', toolName: 'long', toolInput: 'x'.repeat(MAX_MESSAGE_FIELD_CHARS), truncated: true },
      { index: 4, role: 'assistant', kind: 'assistant', nativeType: 'assistant', text: 'no calls' },
      { index: 5, role: 'tool', kind: 'tool-result', nativeType: 'tool_result', toolName: 'tool', failed: false },
      { index: 6, role: 'tool', kind: 'tool-result', nativeType: 'tool_result', toolName: 'tool', failed: false, toolOutput: 'y'.repeat(MAX_MESSAGE_FIELD_CHARS), truncated: true },
      { index: 7, role: 'user', kind: 'user', nativeType: 'user', text: 'piece' },
      { index: 8, role: 'user', kind: 'user', nativeType: 'user' },
      { index: 9, role: 'unknown', kind: 'unknown', nativeType: 'unknown' },
    ])
  })

  it('cuts the window to the newest messages and re-indexes it', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: {
        [`${DIR}/updates.jsonl`]: [
          update('agent_message_chunk', { content: 'one' }),
          update('agent_message_chunk', { content: 'two' }),
          update('agent_message_chunk', { content: 'three' }),
        ].join('\n'),
      },
    })

    const transcript = await readGrokTranscript({ host, sessionDir: DIR, key: KEY, maxMessages: 2 })

    expect(transcript.hasMore).toBe(true)
    expect(transcript.messages.map((message: AgentMessage) => message.text)).toEqual(['two', 'three'])
    expect(transcript.messages.map((message: AgentMessage) => message.index)).toEqual([0, 1])
  })

  it('locates the session directory and carries the store message count through the adapter', async () => {
    const sessionDir = '/home/tester/.grok/sessions/%2Fwork/sess-7'
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir}/summary.json`]: JSON.stringify({
          info: { id: 'sess-7', cwd: '/work' },
          num_messages: 7,
          updated_at: '2026-01-02T00:00:00.000Z',
        }),
        [`${sessionDir}/updates.jsonl`]: update('agent_message_chunk', { content: 'ok' }),
      },
    })
    const adapter = grokAdapter(host, resolveGrokConfig())
    const session = (await adapter.listSessions({}))[0]
    if (session === undefined) throw new Error('the fixture session was not listed')

    const transcript = await adapter.readTranscript({ session })

    expect(transcript.key).toBe('grok:sess-7')
    expect(transcript.totalMessages).toBe(7)
    expect(transcript.messages).toHaveLength(1)
  })

  it('passes transcript limits through when the session has no stored message count', async () => {
    const sessionDir = '/home/tester/.grok/sessions/%2Fwork/sess-limited'
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir}/summary.json`]: JSON.stringify({ info: { id: 'sess-limited', cwd: '/work' } }),
        [`${sessionDir}/updates.jsonl`]: [
          update('agent_message_chunk', { content: 'one' }),
          update('agent_message_chunk', { content: 'two' }),
        ].join('\n'),
      },
    })
    const adapter = grokAdapter(host, resolveGrokConfig())
    const session = (await adapter.listSessions({}))[0]
    if (session === undefined) throw new Error('the fixture session was not listed')

    const transcript = await adapter.readTranscript({ session, maxMessages: 1, maxBytes: 1024 })

    expect(transcript.totalMessages).toBeUndefined()
    expect(transcript.messages.map(message => message.text)).toEqual(['two'])
    expect(transcript.hasMore).toBe(true)
  })

  it('reports an unresolvable session directory as an empty window with a note', async () => {
    const host = new MemoryHost({ home: '/home/tester', env: { PATH: '' } })
    const adapter = grokAdapter(host, resolveGrokConfig())

    const transcript = await adapter.readTranscript({
      session: {
        key: KEY,
        agentId: brandString<AgentId>('grok'),
        nativeId: 'sess-gone',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'idle',
        notes: [],
      },
    })

    expect(transcript).toEqual({
      key: KEY,
      messages: [],
      hasMore: false,
      notes: ['the session directory could not be located in the grok store; the transcript window is empty'],
    })
  })
})
