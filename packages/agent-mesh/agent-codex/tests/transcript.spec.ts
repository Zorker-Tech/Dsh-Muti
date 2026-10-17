import { describe, expect, it } from 'vitest'
import type { AgentId, AgentSession, AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { codexAdapter } from '../src/index.ts'
import { MAX_MESSAGE_TEXT_BYTES, projectRolloutLine } from '../src/transcript.ts'
import { FakeHost } from './fake-host.ts'

const THREAD = '01920000-aaaa-bbbb-cccc-ddddeeeeffff'
const ROLLOUT = `/home/tester/.codex/sessions/2026/10/16/rollout-2026-10-16T10-00-00-${THREAD}.jsonl`

/** Build a session row pointing at the fixture rollout. */
function sessionFixture(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    key: brandString<AgentSessionKey>(`codex:${THREAD}`),
    agentId: brandString<AgentId>('codex'),
    nativeId: THREAD,
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
    status: 'idle',
    notes: [],
    ...overrides,
  }
}

/** Build one rollout line. */
function line(type: string, payload: unknown, timestamp = '2026-10-16T10:00:00.000Z'): string {
  return JSON.stringify({ timestamp, type, payload })
}

/** Every record family the projection knows, plus one unknown and one broken line. */
const FAMILY_LINES = [
  line('session_meta', { id: THREAD, cwd: '/repo', originator: 'exec', cli_version: '0.50.0' }),
  line('turn_context', { model: 'gpt-5-codex', sandbox_policy: 'workspace-write', approval_policy: 'never', effort: 'high' }),
  line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please fix it' }] }),
  line('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking hard' }] }),
  line('response_item', { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' }),
  line('response_item', { type: 'function_call_output', name: 'shell', output: { content_items: [{ type: 'output_text', text: 'a.txt\nb.txt' }] } }),
  line('event_msg', { type: 'plan_update', plan: [{ step: 'inspect', status: 'in_progress' }, { step: 'fix', completed: true }] }),
  line('event_msg', { type: 'item_completed', item: { type: 'command_execution', status: 'failed', aggregated_output: 'boom' } }),
  line('event_msg', { type: 'item_completed', item: { type: 'file_change', changes: [{ path: '/repo/a.txt' }] } }),
  line('event_msg', { type: 'agent_message', message: 'done' }),
  line('event_msg', { type: 'error', message: 'something went wrong' }),
  line('compacted', { message: 'earlier context' }),
  line('token_usage', { input_tokens: 10 }),
  line('future_record', { note: 'unknown to this adapter' }),
  'this line is not json',
].join('\n')

describe('rollout line projection', () => {
  it('projects the session header and the turn context as system records', () => {
    const meta = projectRolloutLine(JSON.parse(line('session_meta', { id: THREAD, cwd: '/repo', originator: 'exec', cli_version: '0.50.0' })))
    expect(meta.messages[0]).toMatchObject({
      role: 'system',
      kind: 'unknown',
      nativeType: 'session_meta',
      text: `Codex session ${THREAD} started (cwd /repo, originator exec, codex 0.50.0)`,
    })
    const turn = projectRolloutLine(JSON.parse(line('turn_context', { model: 'gpt-5-codex', sandbox_policy: 'workspace-write' })))
    expect(turn.messages[0]).toMatchObject({
      role: 'system',
      kind: 'unknown',
      nativeType: 'turn_context',
      text: 'Codex turn context: model gpt-5-codex, sandbox workspace-write',
    })
  })

  it('projects user, reasoning and tool records', () => {
    const user = projectRolloutLine(JSON.parse(line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] })))
    expect(user.messages[0]).toMatchObject({ role: 'user', kind: 'user', text: 'hi', nativeType: 'response_item:message' })

    const reasoning = projectRolloutLine(JSON.parse(line('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'hmm' }] })))
    expect(reasoning.messages[0]).toMatchObject({ role: 'assistant', kind: 'reasoning', text: 'hmm' })

    const call = projectRolloutLine(JSON.parse(line('response_item', { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' })))
    expect(call.messages[0]).toMatchObject({ role: 'assistant', kind: 'tool-call', toolName: 'shell', toolInput: '{"cmd":"ls"}' })

    const result = projectRolloutLine(JSON.parse(line('response_item', { type: 'function_call_output', name: 'shell', output: { content_items: [{ type: 'output_text', text: 'ok' }] } })))
    expect(result.messages[0]).toMatchObject({ role: 'tool', kind: 'tool-result', toolName: 'shell', toolOutput: 'ok' })
  })

  it('projects a failed shell item and a file change', () => {
    const failed = projectRolloutLine(JSON.parse(line('event_msg', { type: 'item_completed', item: { type: 'command_execution', status: 'failed', aggregated_output: 'boom' } })))
    expect(failed.messages[0]).toMatchObject({
      role: 'tool',
      kind: 'tool-result',
      toolName: 'shell',
      toolOutput: 'boom',
      failed: true,
      nativeType: 'event_msg:item_completed:command_execution',
    })

    const changed = projectRolloutLine(JSON.parse(line('event_msg', { type: 'item_completed', item: { type: 'file_change', changes: [{ path: '/repo/a.txt' }, '/repo/b.txt'] } })))
    expect(changed.messages[0]).toMatchObject({ role: 'tool', kind: 'tool-result', paths: ['/repo/a.txt', '/repo/b.txt'] })
  })

  it('projects a plan, an error and a compaction marker', () => {
    const plan = projectRolloutLine(JSON.parse(line('event_msg', { type: 'plan_update', plan: [{ step: 'inspect', status: 'in_progress' }, { step: 'fix', completed: true }] })))
    expect(plan.messages[0]).toMatchObject({ role: 'assistant', kind: 'plan', text: '- [in_progress] inspect\n- [completed] fix' })

    const error = projectRolloutLine(JSON.parse(line('event_msg', { type: 'error', message: 'bad' })))
    expect(error.messages[0]).toMatchObject({ role: 'system', kind: 'error', text: 'bad' })

    const compacted = projectRolloutLine(JSON.parse(line('compacted', { message: 'earlier context' })))
    expect(compacted.messages[0]).toMatchObject({ role: 'system', kind: 'summary', text: 'Codex compacted the session context:\nearlier context' })
  })

  it('preserves an unknown record and skips records known to carry no conversation', () => {
    const unknown = projectRolloutLine(JSON.parse(line('future_record', { note: 'x' })))
    expect(unknown.messages[0]).toMatchObject({ role: 'unknown', kind: 'unknown', nativeType: 'rollout:future_record' })
    expect(unknown.messages[0]?.text).toBe('{"note":"x"}')

    const skipped = projectRolloutLine(JSON.parse(line('token_usage', { input_tokens: 10 })))
    expect(skipped).toEqual({ messages: [], skipped: 'token_usage' })

    const unknownItem = projectRolloutLine(JSON.parse(line('event_msg', { type: 'future_event', value: 1 })))
    expect(unknownItem).toEqual({ messages: [], skipped: 'event_msg:future_event' })
  })

  it('covers rollout fallbacks and every native conversation record family', () => {
    const project = (type: string, payload?: unknown) => projectRolloutLine({
      type,
      ...(payload === undefined ? {} : { payload }),
    })
    expect(projectRolloutLine(null)).toMatchObject({ messages: [{ nativeType: 'rollout:non-object' }] })
    expect(projectRolloutLine({ type: 'future_record' })).toMatchObject({
      messages: [{ nativeType: 'rollout:future_record', text: '{"type":"future_record"}' }],
    })
    expect(projectRolloutLine({})).toMatchObject({ messages: [{ nativeType: 'rollout:untyped' }] })
    expect(project('inter_agent_communication', { sender: 'codex', text: 'handoff' }))
      .toMatchObject({ messages: [{ role: 'system', nativeType: 'inter_agent_communication' }] })
    for (const type of [
      'token_usage', 'token_usage_record', 'world_state', 'retained_context', 'security_risk_score',
      'realtime_item', 'inter_agent_communication_metadata',
    ]) {
      expect(project(type, {})).toEqual({ messages: [], skipped: type })
    }

    expect(project('session_meta', null)).toMatchObject({ messages: [{ nativeType: 'session_meta', text: 'null' }] })
    expect(project('session_meta', { meta: { session_id: 'session-2' } }))
      .toMatchObject({ messages: [{ text: 'Codex session session-2 started' }] })
    expect(project('session_meta', {})).toMatchObject({ messages: [{ text: 'Codex session started' }] })
    expect(project('turn_context', null)).toEqual({ messages: [], skipped: 'turn_context(no payload)' })
    expect(project('turn_context', {
      model: 'm', sandbox_policy: { type: 'workspace' }, approval_policy: { kind: 'never' }, effort: { mode: 'high' },
    })).toMatchObject({ messages: [{ text: 'Codex turn context: model m, sandbox workspace, approvals never, reasoning high' }] })
    expect(project('turn_context', {
      sandbox_policy: {}, approval_policy: { custom: true }, effort: 3,
    })).toMatchObject({ messages: [{ text: 'Codex turn context: approvals custom, reasoning 3' }] })
    expect(project('turn_context', {})).toMatchObject({ messages: [{ text: 'Codex turn context' }] })
    expect(project('turn_context', { sandbox_policy: '', approval_policy: false, effort: [] }))
      .toMatchObject({ messages: [{ text: 'Codex turn context: approvals false' }] })
    expect(project('compacted', {})).toMatchObject({ messages: [{ text: 'Codex compacted the session context' }] })

    const response = (payload: unknown) => project('response_item', payload)
    expect(response(null)).toMatchObject({ messages: [{ nativeType: 'response_item' }] })
    expect(response({})).toMatchObject({ messages: [{ nativeType: 'response_item:unknown' }] })
    for (const [role, expectedRole, expectedKind] of [
      ['user', 'user', 'user'],
      ['assistant', 'assistant', 'assistant'],
      ['system', 'system', 'unknown'],
      ['developer', 'system', 'unknown'],
      ['tool', 'tool', 'tool-result'],
      ['custom', 'unknown', 'unknown'],
    ]) {
      expect(response({ type: 'message', role, text: `from ${role}` }))
        .toMatchObject({ messages: [{ role: expectedRole, kind: expectedKind, text: `from ${role}` }] })
    }
    expect(response({ type: 'message', role: 'user' })).toEqual({ messages: [], skipped: 'response_item:message' })
    expect(response({ type: 'message', role: 'user', content: [], text: 'fallback text' }))
      .toMatchObject({ messages: [{ text: 'fallback text' }] })
    expect(response({ type: 'message', role: '', text: 'role missing' }))
      .toMatchObject({ messages: [{ role: 'unknown', kind: 'unknown' }] })
    expect(response({ type: 'message', role: 'assistant', content: [
      'prefix', 1, { type: 'text' }, { type: 'image' }, { type: 'input_image' }, { type: 'local_image' },
      { type: 'audio' }, { type: 'input_audio' }, { type: 'local_audio' }, { type: 'unknown', text: 'ignored' },
      { type: 'output_text', text: 'tail' },
    ] })).toMatchObject({ messages: [{ text: 'prefix\n[image]\n[image]\n[image]\n[audio]\n[audio]\n[audio]\ntail' }] })
    expect(response({ type: 'agent_message', text: 'assistant text' })).toMatchObject({
      messages: [{ role: 'assistant', kind: 'assistant', text: 'assistant text' }],
    })
    expect(response({ type: 'agent_message', text: '' })).toEqual({ messages: [], skipped: 'response_item:agent_message' })
    expect(response({ type: 'reasoning', content: [{ type: 'text', text: 'reasoning body' }] }))
      .toMatchObject({ messages: [{ kind: 'reasoning', text: 'reasoning body' }] })
    expect(response({ type: 'reasoning', summary: [], content: ['fallback reasoning'] }))
      .toMatchObject({ messages: [{ text: 'fallback reasoning' }] })
    expect(response({ type: 'reasoning', content: [] })).toEqual({ messages: [], skipped: 'response_item:reasoning' })
    expect(response({ type: 'custom_tool_call', input: 'fallback input' }))
      .toMatchObject({ messages: [{ toolName: 'tool', toolInput: 'fallback input' }] })
    expect(response({ type: 'local_shell_call', action: { command: [{ type: 'text', text: 'git status' }] } }))
      .toMatchObject({ messages: [{ toolName: 'shell', toolInput: 'git status' }] })
    expect(response({ type: 'local_shell_call', action: null }))
      .toMatchObject({ messages: [{ toolName: 'shell', toolInput: 'null' }] })
    expect(response({ type: 'local_shell_call', action: 'echo hi' }))
      .toMatchObject({ messages: [{ toolInput: '"echo hi"' }] })
    expect(response({ type: 'local_shell_call', action: { command: 'echo hi' } }))
      .toMatchObject({ messages: [{ toolInput: 'echo hi' }] })
    expect(response({ type: 'local_shell_call' })).toMatchObject({ messages: [{ toolInput: 'undefined' }] })
    expect(response({ type: 'function_call_output', output: '' }))
      .toMatchObject({ messages: [{ toolName: 'tool', kind: 'tool-result' }] })
    expect(response({ type: 'custom_tool_call_output', output: { content: 'plain output' } }))
      .toMatchObject({ messages: [{ toolOutput: 'plain output' }] })
    expect(response({ type: 'function_call_output', output: { content_items: [{ type: 'output_text', text: 'joined' }] } }))
      .toMatchObject({ messages: [{ toolOutput: 'joined' }] })
    expect(response({ type: 'function_call_output', output: { content: 1 } }))
      .toMatchObject({ messages: [{ toolName: 'tool' }] })
    expect(response({ type: 'function_call_output', output: 1 })).toMatchObject({ messages: [{ toolName: 'tool' }] })
    expect(response({ type: 'web_search_call', action: { mode: 'query' } }))
      .toMatchObject({ messages: [{ toolName: 'web_search', toolInput: 'query' }] })
    expect(response({ type: 'web_search_call' })).toMatchObject({ messages: [{ toolName: 'web_search' }] })
    expect(response({ type: 'future_item' })).toMatchObject({ messages: [{ nativeType: 'response_item:future_item' }] })

    const event = (payload: unknown) => project('event_msg', payload)
    expect(event(null)).toMatchObject({ messages: [{ nativeType: 'event_msg' }] })
    expect(event({ type: 'warning' })).toMatchObject({ messages: [{ kind: 'unknown', text: '{"type":"warning"}' }] })
    expect(event({ type: 'error' })).toMatchObject({ messages: [{ kind: 'error', text: '{"type":"error"}' }] })
    expect(event({ type: 'guardian_warning', message: 'guarded' })).toMatchObject({ messages: [{ text: 'guarded' }] })
    expect(event({ type: 'item_started' })).toEqual({ messages: [], skipped: 'event_msg:item_started' })
    expect(event({ type: 'plan_update', plan: [] })).toEqual({ messages: [], skipped: 'event_msg:plan_update' })
    expect(event({ type: 'plan_update', plan: 'invalid' })).toEqual({ messages: [], skipped: 'event_msg:plan_update' })
    expect(event({ type: 'plan_update', plan: [{ text: 'step text', status: 'active' }, {}, null, { step: 'done', completed: true }, { step: 'pending' }] }))
      .toMatchObject({ messages: [{ text: '- [active] step text\n- [completed] done\n- [pending] pending' }] })
    expect(event({ type: 'user_input', content: [{ type: 'input_text', text: 'from content' }] }))
      .toMatchObject({ messages: [{ role: 'user', text: 'from content' }] })
    expect(event({ type: 'user_message', message: 'from message' })).toMatchObject({ messages: [{ text: 'from message' }] })
    expect(event({ type: 'user_message' })).toEqual({ messages: [], skipped: 'event_msg:user_message' })
    expect(event({ type: 'agent_message', text: 'from text' })).toMatchObject({ messages: [{ text: 'from text' }] })
    expect(event({ type: 'agent_message', message: 'from message' })).toMatchObject({ messages: [{ text: 'from message' }] })
    expect(event({ type: 'agent_message' })).toEqual({ messages: [], skipped: 'event_msg:agent_message' })
    expect(event({ type: 'agent_reasoning_delta', delta: 'reason' })).toMatchObject({ messages: [{ kind: 'reasoning', text: 'reason' }] })
    expect(event({ type: 'agent_reasoning', text: 'reason text' })).toMatchObject({ messages: [{ text: 'reason text' }] })
    expect(event({ type: 'agent_reasoning' })).toEqual({ messages: [], skipped: 'event_msg:agent_reasoning' })
    expect(event({ type: 'exec_command_begin', command: [{ type: 'input_text', text: 'pwd' }] }))
      .toMatchObject({ messages: [{ toolName: 'shell', toolInput: 'pwd' }] })
    expect(event({ type: 'exec_command_begin' })).toMatchObject({ messages: [{ toolInput: 'undefined' }] })
    expect(event({ type: 'exec_command_end', stdout: 'out', stderr: 'err', exit_code: 1 }))
      .toMatchObject({ messages: [{ toolOutput: 'out\nerr', failed: true }] })
    expect(event({ type: 'exec_command_end', stderr: 'err', exit_code: 0 }))
      .toMatchObject({ messages: [{ toolOutput: 'err', failed: false }] })
    expect(event({ type: 'exec_command_end', exit_code: 'unknown' }).messages[0]?.failed).toBeUndefined()
    expect(event({ type: 'exec_command_end' }).messages[0]?.toolOutput).toBeUndefined()
    expect(event({ type: 'future_event' })).toEqual({ messages: [], skipped: 'event_msg:future_event' })
    expect(event({})).toEqual({ messages: [], skipped: 'event_msg:unknown' })

    const turnItem = (item: unknown) => event({ type: 'item_completed', item })
    expect(turnItem(null)).toEqual({ messages: [], skipped: 'event_msg:item_completed' })
    expect(turnItem({ type: 'user_message', content: 'hello' })).toMatchObject({ messages: [{ role: 'user', text: 'hello' }] })
    expect(turnItem({ type: 'user_message', content: [] })).toMatchObject({ messages: [], skipped: 'event_msg:item_completed:user_message' })
    expect(turnItem({ type: 'agent_message', content: [{ type: 'output_text', text: 'answer' }] }))
      .toMatchObject({ messages: [{ role: 'assistant', text: 'answer' }] })
    expect(turnItem({ type: 'agent_message' })).toMatchObject({ messages: [], skipped: 'event_msg:item_completed:agent_message' })
    expect(turnItem({ type: 'reasoning', summary: ['summary'] })).toMatchObject({ messages: [{ kind: 'reasoning', text: 'summary' }] })
    expect(turnItem({ type: 'reasoning', raw_content: 'raw' })).toMatchObject({ messages: [{ text: 'raw' }] })
    expect(turnItem({ type: 'reasoning' })).toMatchObject({ messages: [], skipped: 'event_msg:item_completed:reasoning' })
    expect(turnItem({ type: 'plan', text: 'planning' })).toMatchObject({ messages: [{ kind: 'plan', text: 'planning' }] })
    expect(turnItem({ type: 'plan' })).toMatchObject({ messages: [], skipped: 'event_msg:item_completed:plan' })
    expect(turnItem({ type: 'command_execution', status: 'in_progress', command: 'npm test' }))
      .toMatchObject({ messages: [{ kind: 'tool-call', toolInput: 'npm test' }] })
    expect(turnItem({ type: 'command_execution', status: 'in_progress', command: { command: 'make' } }))
      .toMatchObject({ messages: [{ toolInput: '{"command":"make"}' }] })
    expect(turnItem({ type: 'command_execution', status: 'declined' })).toMatchObject({ messages: [{ failed: true }] })
    expect(turnItem({ type: 'function_call_output', output: 'done', name: 'tool-x' }))
      .toMatchObject({ messages: [{ toolName: 'tool-x', toolOutput: 'done' }] })
    expect(turnItem({ type: 'function_call_output', output: 'done' }))
      .toMatchObject({ messages: [{ toolName: 'tool', toolOutput: 'done' }] })
    expect(turnItem({ type: 'dynamic_tool_call', tool: 'dynamic', prompt: 'prompt' }))
      .toMatchObject({ messages: [{ toolName: 'dynamic', toolInput: 'prompt' }] })
    expect(turnItem({ type: 'mcp_tool_call', arguments: { q: 1 } }))
      .toMatchObject({ messages: [{ toolName: 'mcp', toolInput: '{"q":1}' }] })
    expect(turnItem({ type: 'collab_agent_tool_call', name: 'worker', prompt: 'delegate' }))
      .toMatchObject({ messages: [{ toolName: 'worker', toolInput: 'delegate' }] })
    expect(turnItem({ type: 'file_change', changes: [{ path: 'a.ts' }, 'b.ts', {}, 3] }))
      .toMatchObject({ messages: [{ paths: ['a.ts', 'b.ts'] }] })
    expect(turnItem({ type: 'file_change', changes: [] })).toEqual({ messages: [], skipped: 'event_msg:item_completed:file_change' })
    expect(turnItem({ type: 'file_change', changes: 'invalid' })).toEqual({ messages: [], skipped: 'event_msg:item_completed:file_change' })
    expect(turnItem({ type: 'web_search', action: { type: 'search' } }))
      .toMatchObject({ messages: [{ toolInput: '{"type":"search"}' }] })
    expect(turnItem({ type: 'context_compaction' })).toMatchObject({ messages: [{ kind: 'summary' }] })
    expect(turnItem({})).toEqual({ messages: [], skipped: 'event_msg:item_completed:unknown' })
    expect(turnItem({ type: 'unknown_item' })).toEqual({ messages: [], skipped: 'event_msg:item_completed:unknown_item' })
  })
})

describe('transcript reading', () => {
  it('projects a full rollout window with every declared gap', async () => {
    const host = new FakeHost()
    host.addFile(ROLLOUT, `${FAMILY_LINES}\n`)
    const transcript = await codexAdapter(host, { transcriptTailBytes: 1024 * 1024 }).readTranscript({ session: sessionFixture() })
    expect(transcript.key).toBe(`codex:${THREAD}`)
    const kinds = transcript.messages.map(message => `${message.role}/${message.kind}`)
    expect(kinds).toEqual([
      'system/unknown',
      'system/unknown',
      'user/user',
      'assistant/reasoning',
      'assistant/tool-call',
      'tool/tool-result',
      'assistant/plan',
      'tool/tool-result',
      'tool/tool-result',
      'assistant/assistant',
      'system/error',
      'system/summary',
      'unknown/unknown',
      'unknown/unknown',
    ])
    expect(transcript.messages.map(message => message.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(transcript.hasMore).toBe(false)
    expect(transcript.totalMessages).toBeUndefined()
    expect(transcript.notes).toContain('records that carry no conversational content were not projected: token_usage x1')
    expect(transcript.notes.join('\n')).toContain('1 rollout line(s) in the window were not valid JSON')
    expect(transcript.notes.join('\n')).toContain('the mesh message kinds have no `system` member')
  })

  it('caps the window at the requested message count and says so', async () => {
    const host = new FakeHost()
    host.addFile(ROLLOUT, `${FAMILY_LINES}\n`)
    const transcript = await codexAdapter(host).readTranscript({ session: sessionFixture(), maxMessages: 3, maxBytes: 1024 * 1024 })
    expect(transcript.messages).toHaveLength(3)
    expect(transcript.messages[0]?.index).toBe(0)
    expect(transcript.hasMore).toBe(true)
    expect(transcript.notes.join('\n')).toContain('only the last 3 messages were returned; 11 earlier message(s) are outside the window')
  })

  it('marks text cut by the per-field cap', async () => {
    const host = new FakeHost()
    const long = 'x'.repeat(MAX_MESSAGE_TEXT_BYTES + 500)
    host.addFile(ROLLOUT, `${line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: long }] })}\n`)
    const transcript = await codexAdapter(host).readTranscript({ session: sessionFixture() })
    expect(transcript.messages[0]?.truncated).toBe(true)
    expect(transcript.messages[0]?.text?.endsWith(`[truncated by dsh-agent-codex at ${String(MAX_MESSAGE_TEXT_BYTES)} characters]`)).toBe(true)
  })

  it('notes the byte window when the tail read dropped a partial line', async () => {
    const host = new FakeHost()
    host.addFile(ROLLOUT, `${FAMILY_LINES}\n`)
    const transcript = await codexAdapter(host, { transcriptTailBytes: 200 }).readTranscript({ session: sessionFixture() })
    expect(transcript.hasMore).toBe(true)
    expect(transcript.notes.join('\n')).toContain('only the last 200 bytes of the rollout were read')
  })

  it('distinguishes an empty rollout from a tail made only of a partial line', async () => {
    const emptyHost = new FakeHost()
    emptyHost.addFile(ROLLOUT, '')
    const empty = await codexAdapter(emptyHost).readTranscript({ session: sessionFixture() })
    expect(empty.notes.join('\n')).toContain('the rollout tail was empty when it was read')

    const partialHost = new FakeHost()
    partialHost.addFile(ROLLOUT, 'x'.repeat(100))
    const partial = await codexAdapter(partialHost, { transcriptTailBytes: 10 }).readTranscript({ session: sessionFixture() })
    expect(partial.hasMore).toBe(true)
    expect(partial.notes.join('\n')).toContain('only the last 10 bytes of the rollout were read')
    expect(partial.notes.join('\n')).not.toContain('the rollout tail was empty when it was read')
  })

  it('throws a mesh error for a missing or compressed session', async () => {
    const host = new FakeHost()
    await expect(codexAdapter(host).readTranscript({ session: sessionFixture() })).rejects.toMatchObject({
      name: 'AgentMeshError',
      code: 'mesh/session-not-found',
    })

    host.addFile(`${ROLLOUT}.zst`, 'binary')
    await expect(codexAdapter(host).readTranscript({ session: sessionFixture() })).rejects.toMatchObject({
      name: 'AgentMeshError',
      code: 'mesh/unsupported-operation',
    })
    // A plain rollout wins over the compressed one for the same thread.
    host.addFile(ROLLOUT, `${FAMILY_LINES}\n`)
    expect((await codexAdapter(host).readTranscript({ session: sessionFixture() })).messages.length).toBeGreaterThan(0)
  })
})
