/**
 * Projection of one Codex rollout into mesh transcript messages.
 *
 * The rollout line taxonomy is projected faithfully, including the parts the mesh
 * vocabulary has no exact slot for: `response_item` model items, `event_msg` engine
 * events, the shared `TurnItem` family, turn contexts and compaction markers. A record
 * this module does not model still produces a message — `role: 'unknown'`,
 * `kind: 'unknown'`, native type preserved — while records that are *known* to carry no
 * conversational content are counted as skipped and declared in the transcript notes.
 * @module @deepseek-ai/dsh-agent-codex/transcript
 */

import type { AgentMessage, AgentTranscript } from '@deepseek-ai/dsh-agent-mesh'
import { AgentMeshError } from '@deepseek-ai/dsh-agent-mesh'
import type { AgentId } from '@deepseek-ai/dsh-agent-mesh'
import type { CodexHost } from './types.ts'
import { asRecord, jsonText, normalizeToken, parseJsonLine, str } from './json.ts'
import { note } from './notes.ts'
import { locateRollout, sessionKey, type CodexHome } from './sessions.ts'

/** Cap on any single text field copied into a mesh message. */
export const MAX_MESSAGE_TEXT_BYTES = 16 * 1024

/** Default bytes read from a rollout tail when the caller caps nothing. */
export const DEFAULT_TRANSCRIPT_TAIL_BYTES = 1024 * 1024

/** A mesh message before the reader assigns its window index. */
export type CodexMessageDraft = Omit<AgentMessage, 'index'>

/** Projection of one rollout line. */
export interface CodexLineProjection {
  /** Mesh messages the line yielded, in order. */
  readonly messages: readonly CodexMessageDraft[]
  /** Native type token for a record that was recognized but yields no message. */
  readonly skipped?: string
}

/**
 * Project one parsed rollout line.
 * @param value - One parsed JSONL line.
 * @returns the messages, and the native token of a recognized-but-unprojected record.
 */
export function projectRolloutLine(value: unknown): CodexLineProjection {
  const record = asRecord(value)
  if (record === undefined) {
    return { messages: [unknownMessage(String(value), undefined, 'rollout:non-object')] }
  }
  const timestamp = str(record, 'timestamp')
  const type = str(record, 'type')
  switch (type) {
    case 'session_meta':
      return projectSessionMeta(record['payload'], timestamp)
    case 'response_item':
      return projectResponseItem(record['payload'], timestamp)
    case 'event_msg':
      return projectEventMsg(record['payload'], timestamp)
    case 'turn_context':
      return projectTurnContext(record['payload'], timestamp)
    case 'compacted':
      return projectCompacted(record['payload'], timestamp)
    case 'inter_agent_communication':
      return {
        messages: [
          {
            role: 'system',
            kind: 'unknown',
            text: jsonText(record['payload']),
            nativeType: 'inter_agent_communication',
            ...optionalTimestamp(timestamp),
          },
        ],
      }
    case 'token_usage':
    case 'token_usage_record':
    case 'world_state':
    case 'retained_context':
    case 'security_risk_score':
    case 'realtime_item':
    case 'inter_agent_communication_metadata':
      return { messages: [], skipped: type }
    default:
      return {
        messages: [
          unknownMessage(
            record['payload'] === undefined ? jsonText(value) : jsonText(record['payload']),
            timestamp,
            type === undefined ? 'rollout:untyped' : `rollout:${type}`,
          ),
        ],
      }
  }
}

/** Project the session header line. */
function projectSessionMeta(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const record = asRecord(payload)
  const meta = asRecord(record?.['meta']) ?? record
  if (meta === undefined) {
    return { messages: [unknownMessage(jsonText(payload), timestamp, 'session_meta')] }
  }
  const id = str(meta, 'id') ?? str(meta, 'session_id')
  const parts: string[] = []
  const cwd = str(meta, 'cwd')
  const originator = str(meta, 'originator')
  const cliVersion = str(meta, 'cli_version')
  if (cwd !== undefined) parts.push(`cwd ${cwd}`)
  if (originator !== undefined) parts.push(`originator ${originator}`)
  if (cliVersion !== undefined) parts.push(`codex ${cliVersion}`)
  const head = id === undefined ? 'Codex session started' : `Codex session ${id} started`
  return {
    messages: [
      {
        role: 'system',
        kind: 'unknown',
        text: parts.length === 0 ? head : `${head} (${parts.join(', ')})`,
        nativeType: 'session_meta',
        ...optionalTimestamp(timestamp),
      },
    ],
  }
}

/** Project a `turn_context` line: the per-turn model and policy snapshot. */
function projectTurnContext(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const context = asRecord(payload)
  if (context === undefined) return { messages: [], skipped: 'turn_context(no payload)' }
  const parts: string[] = []
  const model = str(context, 'model')
  const sandbox = describePolicyValue(context['sandbox_policy'])
  const approval = describePolicyValue(context['approval_policy'])
  const effort = describePolicyValue(context['effort'])
  if (model !== undefined) parts.push(`model ${model}`)
  if (sandbox !== undefined) parts.push(`sandbox ${sandbox}`)
  if (approval !== undefined) parts.push(`approvals ${approval}`)
  if (effort !== undefined) parts.push(`reasoning ${effort}`)
  return {
    messages: [
      {
        role: 'system',
        kind: 'unknown',
        text: parts.length === 0 ? 'Codex turn context' : `Codex turn context: ${parts.join(', ')}`,
        nativeType: 'turn_context',
        ...optionalTimestamp(timestamp),
      },
    ],
  }
}

/** Project a compaction marker, whose payload carries the summary text. */
function projectCompacted(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const summary = str(asRecord(payload), 'message')
  return {
    messages: [
      {
        role: 'system',
        kind: 'summary',
        text: summary === undefined ? 'Codex compacted the session context' : `Codex compacted the session context:\n${summary}`,
        nativeType: 'compacted',
        ...optionalTimestamp(timestamp),
      },
    ],
  }
}

/** Project a `response_item` payload, which is a model item. */
function projectResponseItem(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const item = asRecord(payload)
  if (item === undefined) {
    return { messages: [unknownMessage(jsonText(payload), timestamp, 'response_item')] }
  }
  const type = str(item, 'type')
  const nativeType = `response_item:${type ?? 'unknown'}`
  switch (normalizeToken(type)) {
    case 'message': {
      const role = str(item, 'role') ?? ''
      const text = collectText(item['content']) || str(item, 'text') || ''
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage(roleOf(role), kindOf(role), text, nativeType, timestamp)] }
    }
    case 'agentmessage': {
      const text = collectText(item['content']) || str(item, 'text') || ''
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'assistant', text, nativeType, timestamp)] }
    }
    case 'reasoning': {
      const text = collectText(item['summary']) || collectText(item['content'])
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'reasoning', text, nativeType, timestamp)] }
    }
    case 'functioncall':
    case 'customtoolcall': {
      const name = str(item, 'name') ?? 'tool'
      const input = str(item, 'arguments') ?? str(item, 'input')
      return { messages: [toolCall(name, input, nativeType, timestamp)] }
    }
    case 'localshellcall': {
      const action = asRecord(item['action'])
      const command = collectText(action?.['command'] ?? action)
      return { messages: [toolCall('shell', command === '' ? jsonText(item['action']) : command, nativeType, timestamp)] }
    }
    case 'functioncalloutput':
    case 'customtoolcalloutput':
      return { messages: [toolResult(str(item, 'name') ?? 'tool', outputText(item['output']), nativeType, timestamp)] }
    case 'websearchcall': {
      const query = str(item, 'query') ?? describePolicyValue(item['action'])
      return { messages: [toolCall('web_search', query, nativeType, timestamp)] }
    }
    default:
      return { messages: [unknownMessage(jsonText(payload), timestamp, nativeType)] }
  }
}

/** Project an `event_msg` payload, which is a structured engine event. */
function projectEventMsg(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const event = asRecord(payload)
  if (event === undefined) {
    return { messages: [unknownMessage(jsonText(payload), timestamp, 'event_msg')] }
  }
  const type = str(event, 'type')
  const nativeType = `event_msg:${type ?? 'unknown'}`
  switch (normalizeToken(type)) {
    case 'error': {
      const message = str(event, 'message') ?? jsonText(event)
      return { messages: [textMessage('system', 'error', message, nativeType, timestamp)] }
    }
    case 'warning':
    case 'guardianwarning': {
      const message = str(event, 'message') ?? jsonText(event)
      return { messages: [textMessage('system', 'unknown', message, nativeType, timestamp)] }
    }
    case 'itemstarted':
    case 'itemupdated':
    case 'itemcompleted': {
      const item = asRecord(event['item'])
      if (item === undefined) return { messages: [], skipped: nativeType }
      return projectTurnItem(item, nativeType, timestamp)
    }
    case 'planupdate': {
      const text = renderPlanSteps(event['plan'])
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'plan', text, nativeType, timestamp)] }
    }
    case 'usermessage':
    case 'userinput': {
      const text = str(event, 'message') ?? collectText(event['content'])
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('user', 'user', text, nativeType, timestamp)] }
    }
    case 'agentmessage': {
      const text = str(event, 'message') ?? str(event, 'text') ?? ''
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'assistant', text, nativeType, timestamp)] }
    }
    case 'agentreasoning':
    case 'agentreasoningdelta': {
      const text = str(event, 'text') ?? str(event, 'delta') ?? ''
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'reasoning', text, nativeType, timestamp)] }
    }
    case 'execcommandbegin': {
      const command = collectText(event['command'])
      return { messages: [toolCall('shell', command === '' ? jsonText(event['command']) : command, nativeType, timestamp)] }
    }
    case 'execcommandend': {
      const output = [str(event, 'stdout'), str(event, 'stderr')].filter(part => part !== undefined).join('\n')
      const exitCode = event['exit_code']
      return {
        messages: [
          toolResult('shell', output, nativeType, timestamp, typeof exitCode === 'number' ? exitCode !== 0 : undefined),
        ],
      }
    }
    default:
      return { messages: [], skipped: nativeType }
  }
}

/** Project a `TurnItem`, the item family shared by rollout events and the app server. */
function projectTurnItem(
  item: Record<string, unknown>,
  nativeType: string,
  timestamp: string | undefined,
): CodexLineProjection {
  const type = str(item, 'type')
  const token = `${nativeType}:${type ?? 'unknown'}`
  switch (normalizeToken(type)) {
    case 'usermessage': {
      const text = collectText(item['content'])
      if (text === '') return { messages: [], skipped: token }
      return { messages: [textMessage('user', 'user', text, token, timestamp)] }
    }
    case 'agentmessage': {
      const text = str(item, 'text') ?? collectText(item['content'])
      if (text === '') return { messages: [], skipped: token }
      return { messages: [textMessage('assistant', 'assistant', text, token, timestamp)] }
    }
    case 'reasoning': {
      const text = collectText(item['summary_text']) || collectText(item['summary']) || collectText(item['raw_content'])
      if (text === '') return { messages: [], skipped: token }
      return { messages: [textMessage('assistant', 'reasoning', text, token, timestamp)] }
    }
    case 'plan': {
      const text = str(item, 'text') ?? ''
      if (text === '') return { messages: [], skipped: token }
      return { messages: [textMessage('assistant', 'plan', text, token, timestamp)] }
    }
    case 'commandexecution': {
      const status = normalizeToken(str(item, 'status'))
      if (status === 'inprogress') {
        const command = str(item, 'command') ?? jsonText(item['command'])
        return { messages: [toolCall('shell', command, token, timestamp)] }
      }
      return {
        messages: [
          toolResult(
            'shell',
            str(item, 'aggregated_output'),
            token,
            timestamp,
            status === 'failed' || status === 'declined',
          ),
        ],
      }
    }
    case 'functioncalloutput':
      return { messages: [toolResult(str(item, 'name') ?? 'tool', outputText(item['output']), token, timestamp)] }
    case 'dynamictoolcall':
    case 'mcptoolcall':
    case 'collabagenttoolcall': {
      const name = str(item, 'name') ?? str(item, 'tool') ?? 'mcp'
      const input = item['arguments'] === undefined ? str(item, 'prompt') : jsonText(item['arguments'])
      return { messages: [toolCall(name, input, token, timestamp)] }
    }
    case 'filechange': {
      const paths = collectPaths(item['changes'])
      if (paths.length === 0) return { messages: [], skipped: token }
      // The mesh message union has no file-change kind; the paths are the point of the
      // record, so they are carried on a tool message whose native type keeps the origin.
      return { messages: [{ role: 'tool', kind: 'tool-result', paths, nativeType: token, ...optionalTimestamp(timestamp) }] }
    }
    case 'websearch': {
      const query = str(item, 'query') ?? jsonText(item['action'])
      return { messages: [toolCall('web_search', query, token, timestamp)] }
    }
    case 'contextcompaction':
      return { messages: [textMessage('system', 'summary', 'Codex compacted the session context', token, timestamp)] }
    default:
      return { messages: [], skipped: token }
  }
}

/** Collect file paths out of a native change list. */
function collectPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const paths: string[] = []
  for (const entry of value) {
    const path = str(asRecord(entry), 'path')
    if (path !== undefined) paths.push(path)
    else if (typeof entry === 'string') paths.push(entry)
  }
  return paths
}

/** Render a native plan step list as readable plan text. */
function renderPlanSteps(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const lines: string[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const step = str(record, 'step') ?? str(record, 'text')
    if (step === undefined) continue
    // The native status token is rendered verbatim; the canonical vocabulary is applied
    // separately by the task reader.
    const marker = record['completed'] === true ? 'completed' : str(record, 'status') ?? 'pending'
    lines.push(`- [${marker}] ${step}`)
  }
  return lines.join('\n')
}

/** The `output` of a native function-call output, which is a string or a content list. */
function outputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const record = asRecord(value)
  if (record === undefined) return undefined
  const items = collectText(record['content_items'])
  if (items !== '') return items
  return str(record, 'content')
}

/** Render a native policy value (sandbox policy, approval policy, effort) as one token. */
function describePolicyValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const record = asRecord(value)
  if (record === undefined) return undefined
  const token = str(record, 'type') ?? str(record, 'kind') ?? str(record, 'mode')
  if (token !== undefined) return token
  const keys = Object.keys(record)
  return keys.length === 0 ? undefined : keys.join(',')
}

/** Mesh role for a native message role. */
function roleOf(role: string): AgentMessage['role'] {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'system':
    case 'developer':
      return 'system'
    case 'tool':
      return 'tool'
    default:
      return 'unknown'
  }
}

/** Mesh kind for a native message role. */
function kindOf(role: string): AgentMessage['kind'] {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'tool':
      return 'tool-result'
    default:
      // The mesh kind vocabulary has no `system` member; an informational developer or
      // system message keeps its role and its native type.
      return 'unknown'
  }
}

/**
 * A mesh text field, with the cap flag the contract asks for.
 * @param text - Native text.
 * @returns the text, and whether the field cap cut it.
 */
function capped(text: string): { text: string; truncated: boolean } {
  return text.length <= MAX_MESSAGE_TEXT_BYTES ? { text, truncated: false } : { text: capText(text), truncated: true }
}

/** A `truncated` field, present only when something was cut. */
function truncatedFlag(truncated: boolean): { truncated?: boolean } {
  return truncated ? { truncated: true } : {}
}

/** Build a plain text message draft. */
function textMessage(
  role: AgentMessage['role'],
  kind: AgentMessage['kind'],
  text: string,
  nativeType: string,
  timestamp: string | undefined,
): CodexMessageDraft {
  const body = capped(text)
  return {
    role,
    kind,
    text: body.text,
    ...truncatedFlag(body.truncated),
    nativeType,
    ...optionalTimestamp(timestamp),
  }
}

/** Build a tool-call draft. */
function toolCall(name: string, input: string | undefined, nativeType: string, timestamp: string | undefined): CodexMessageDraft {
  const body = input === undefined || input === '' ? undefined : capped(input)
  return {
    role: 'assistant',
    kind: 'tool-call',
    nativeType,
    toolName: name,
    ...(body === undefined ? {} : { toolInput: body.text }),
    ...(body === undefined ? {} : truncatedFlag(body.truncated)),
    ...optionalTimestamp(timestamp),
  }
}

/** Build a tool-result draft. */
function toolResult(
  name: string,
  output: string | undefined,
  nativeType: string,
  timestamp: string | undefined,
  failed?: boolean,
): CodexMessageDraft {
  const body = output === undefined || output === '' ? undefined : capped(output)
  return {
    role: 'tool',
    kind: 'tool-result',
    nativeType,
    toolName: name,
    ...(body === undefined ? {} : { toolOutput: body.text }),
    ...(failed === undefined ? {} : { failed }),
    ...(body === undefined ? {} : truncatedFlag(body.truncated)),
    ...optionalTimestamp(timestamp),
  }
}

/** Build an `unknown` message draft preserving a native payload. */
function unknownMessage(text: string, timestamp: string | undefined, nativeType: string): CodexMessageDraft {
  const body = capped(text)
  return {
    role: 'unknown',
    kind: 'unknown',
    text: body.text,
    ...truncatedFlag(body.truncated),
    nativeType,
    ...optionalTimestamp(timestamp),
  }
}

/** A `timestamp` field, or nothing when the record carries none. */
function optionalTimestamp(timestamp: string | undefined): { timestamp?: string } {
  return timestamp === undefined ? {} : { timestamp }
}

/** Truncate native text to the transcript field cap. */
function capText(text: string): string {
  if (text.length <= MAX_MESSAGE_TEXT_BYTES) return text
  return `${text.slice(0, MAX_MESSAGE_TEXT_BYTES)}\n[truncated by dsh-agent-codex at ${String(MAX_MESSAGE_TEXT_BYTES)} characters]`
}

/** Concatenate the text parts of a native content list. */
function collectText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      parts.push(entry)
      continue
    }
    const record = asRecord(entry)
    if (record === undefined) continue
    const token = normalizeToken(str(record, 'type'))
    const text = str(record, 'text')
    if (text !== undefined && (token === 'text' || token === 'inputtext' || token === 'outputtext' || token === 'summarytext')) {
      parts.push(text)
    } else if (token === 'image' || token === 'inputimage' || token === 'localimage') {
      parts.push('[image]')
    } else if (token === 'audio' || token === 'inputaudio' || token === 'localaudio') {
      parts.push('[audio]')
    }
  }
  return parts.join('\n')
}

/** Everything a transcript read needs. */
export interface CodexTranscriptRead {
  /** Host providing the rollout read. */
  readonly host: CodexHost
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Owning agent id, stamped on the returned key. */
  readonly agentId: AgentId
  /** Native session (thread) id to read. */
  readonly nativeId: string
  /** Maximum trailing messages to return. */
  readonly maxMessages?: number
  /** Maximum bytes of rollout to read before projecting. */
  readonly maxBytes?: number
  /** Tail bytes to read when the caller caps nothing. */
  readonly defaultTailBytes: number
}

/**
 * Read a bounded transcript window from the tail of a rollout.
 *
 * `totalMessages` is deliberately never reported: Codex records no message count, so
 * claiming one would mean a full read on every call.
 *
 * @param read - Host, home layout and caller bounds.
 * @returns the messages, whether older content exists, and every declared gap.
 * @throws {AgentMeshError} `mesh/session-not-found` when no rollout carries this id, and
 *   `mesh/unsupported-operation` when the rollout is zstd-compressed, because this
 *   adapter version cannot decompress one.
 */
export async function readCodexTranscript(read: CodexTranscriptRead): Promise<AgentTranscript> {
  const key = sessionKey(read.agentId, read.nativeId)
  const located = await locateRollout(read.host, read.home, read.nativeId)
  if (located === undefined) {
    throw new AgentMeshError('mesh/session-not-found', `no Codex rollout for session ${read.nativeId} under ${read.home.path}`, {
      remediation: 'Refresh the session list; the rollout may have been archived elsewhere or deleted.',
    })
  }
  if (located.compressed) {
    throw new AgentMeshError(
      'mesh/unsupported-operation',
      `Codex session ${read.nativeId} is stored zstd-compressed (${located.path})`,
      {
        remediation:
          'This adapter version does not decompress rollouts. Open the session in Codex, which materialises the plain rollout, then read it again.',
      },
    )
  }
  const maxBytes = Math.max(1, read.maxBytes ?? read.defaultTailBytes)
  const tail = await read.host.readTail(located.path, maxBytes)
  const drafts: CodexMessageDraft[] = []
  const skipped = new Map<string, number>()
  let unparsable = 0
  for (const line of tail.text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      unparsable += 1
      drafts.push({ role: 'unknown', kind: 'unknown', text: capText(line), nativeType: 'rollout:unparsable' })
      continue
    }
    const projection = projectRolloutLine(parsed.value)
    for (const message of projection.messages) drafts.push(message)
    if (projection.skipped !== undefined) {
      skipped.set(projection.skipped, (skipped.get(projection.skipped) ?? 0) + 1)
    }
  }
  const maxMessages = read.maxMessages
  const dropped =
    maxMessages !== undefined && maxMessages > 0 && drafts.length > maxMessages ? drafts.length - maxMessages : 0
  const window = dropped === 0 ? drafts : drafts.slice(dropped)
  const messages: AgentMessage[] = window.map((draft, index) => ({ index, ...draft }))
  const notes: string[] = []
  if (tail.droppedPartialLine) {
    notes.push(
      note('messages', `only the last ${String(maxBytes)} bytes of the rollout were read; older messages are outside the window`),
    )
  }
  if (tail.text === '' && !tail.droppedPartialLine) {
    notes.push(note('messages', 'the rollout tail was empty when it was read; the file may have been replaced during the read'))
  }
  if (dropped > 0) {
    notes.push(
      note(
        'messages',
        `only the last ${String(maxMessages)} messages were returned; ${String(dropped)} earlier message(s) are outside the window`,
      ),
    )
  }
  if (unparsable > 0) {
    notes.push(
      note(
        '*',
        `${String(unparsable)} rollout line(s) in the window were not valid JSON; each is preserved as an \`unknown\` message holding the raw line`,
      ),
    )
  }
  if (skipped.size > 0) {
    const rendered = [...skipped.entries()].map(([type, count]) => `${type} x${String(count)}`).join(', ')
    notes.push(note('*', `records that carry no conversational content were not projected: ${rendered}`))
  }
  notes.push(note('*', 'the mesh message kinds have no `system` member: informational records keep role `system` and their native type'))
  notes.push(note('usage', 'Codex records token usage on token_usage lines and turn boundaries, not per message, so no message carries usage'))
  return { key, messages, hasMore: tail.droppedPartialLine || dropped > 0, notes }
}
