/**
 * Projection of a Grok Build session's own transcript.
 *
 * `updates.jsonl` is the authoritative ACP update stream: an envelope of
 * `{timestamp, method, params}` whose payload carries `update.sessionUpdate`, with
 * `session/update` and `_x.ai/session/update` as the emitting methods. When that file is
 * absent or empty the derived `chat_history.jsonl` model-message cache is used instead
 * and the substitution is declared in the result's notes.
 *
 * A native update type the mesh vocabulary cannot model becomes
 * `kind: 'unknown'` with its `nativeType` rather than being dropped, so a protocol
 * revision degrades into a visible gap.
 * @module @deepseek-ai/dsh-agent-grok/transcript
 */

import { join } from 'node:path'
import type {
  AgentHost,
  AgentMessage,
  AgentMessageKind,
  AgentMessageRole,
  AgentSessionKey,
  AgentTodoStatus,
  AgentTranscript,
} from '@deepseek-ai/dsh-agent-mesh'
import { DEFAULT_TRANSCRIPT_BYTES } from './config.ts'
import { CHAT_HISTORY_FILE, UPDATES_FILE } from './sessions.ts'

/** Characters kept of one projected field before it is cut and flagged. */
export const MAX_MESSAGE_FIELD_CHARS = 16 * 1024

/** Inputs of one transcript window read. */
export interface GrokTranscriptRequest {
  /** Host providing the bounded file reads. */
  readonly host: AgentHost
  /** Absolute session directory holding the transcript files. */
  readonly sessionDir: string
  /** Mesh key of the session, copied onto the result. */
  readonly key: AgentSessionKey
  /** Maximum number of trailing messages to return. */
  readonly maxMessages?: number
  /** Maximum bytes of store to read before projecting. */
  readonly maxBytes?: number
  /** Total messages in the session as the store counted them, when known. */
  readonly totalMessages?: number
}

/**
 * Read a bounded transcript window.
 *
 * @param request - Session directory, mesh key and read limits.
 * @returns the newest messages in ascending window order, plus whether older ones exist.
 */
export async function readGrokTranscript(request: GrokTranscriptRequest): Promise<AgentTranscript> {
  const { host } = request
  const cap = request.maxBytes ?? DEFAULT_TRANSCRIPT_BYTES
  const notes: string[] = []
  let messages: readonly AgentMessage[]
  let hasMore: boolean

  const updates = await host.readTail(join(request.sessionDir, UPDATES_FILE), cap)
  if (updates.text.trim() === '') {
    notes.push('updates.jsonl is absent or empty; the transcript was projected from chat_history.jsonl, a derived model-message cache rather than the authoritative ACP stream')
    const chat = await host.readTail(join(request.sessionDir, CHAT_HISTORY_FILE), cap)
    const mapped = mapChatHistory(chat.text)
    messages = mapped.messages
    hasMore = chat.droppedPartialLine || mapped.malformed > 0
  } else {
    const mapped = mapUpdates(updates.text)
    messages = mapped.messages
    hasMore = updates.droppedPartialLine || mapped.malformed > 0
    if (mapped.malformed > 0) {
      notes.push(`${String(mapped.malformed)} unparsable or unrecognized record(s) in the read window were skipped`)
    }
  }

  if (request.maxMessages !== undefined && messages.length > request.maxMessages) {
    messages = messages.slice(messages.length - request.maxMessages)
    hasMore = true
  }
  return {
    key: request.key,
    messages: messages.map((message, index): AgentMessage => ({ ...message, index })),
    ...(request.totalMessages === undefined ? {} : { totalMessages: request.totalMessages }),
    hasMore,
    notes,
  }
}

/** Map `updates.jsonl` lines (ACP envelopes carrying `update.sessionUpdate`). */
function mapUpdates(text: string): { messages: readonly AgentMessage[]; malformed: number } {
  const messages: AgentMessage[] = []
  const toolNames = new Map<string, string>()
  let malformed = 0
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const parsed = parseJson(raw)
    if (parsed === undefined) {
      malformed += 1
      continue
    }
    const message = messageFromUpdate(parsed, toolNames)
    if (message === undefined) malformed += 1
    else messages.push(message)
  }
  return { messages, malformed }
}

/** Project one persisted ACP/xAI session update. */
function messageFromUpdate(value: unknown, toolNames: Map<string, string>): AgentMessage | undefined {
  const envelope = asRecord(value)
  if (envelope === undefined) return undefined
  const method = nonEmpty(envelope['method'])
  const params = method === undefined ? envelope : asRecord(envelope['params'])
  if (params === undefined) return undefined
  const update = asRecord(params['update'])
  if (update === undefined) return undefined
  const nativeType = nonEmpty(update['sessionUpdate']) ?? method ?? 'unknown'
  const timestamp = timestampOf(envelope, params)

  switch (nativeType) {
    case 'user_message_chunk':
      return item('user', 'user', blockText(update['content']), timestamp, nativeType)
    case 'agent_message_chunk':
      return item('assistant', 'assistant', blockText(update['content']), timestamp, nativeType)
    case 'agent_thought_chunk':
      return item('assistant', 'reasoning', blockText(update['content']), timestamp, nativeType)
    case 'tool_call': {
      const callId = nonEmpty(update['toolCallId'])
      const name = nonEmpty(update['toolName']) ?? nonEmpty(update['title']) ?? 'tool'
      if (callId !== undefined) toolNames.set(callId, name)
      const input = bounded(update['rawInput'])
      const paths = locationPaths(update['locations'])
      return {
        index: 0,
        role: 'assistant',
        kind: 'tool-call',
        nativeType,
        toolName: name,
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(paths.length === 0 ? {} : { paths }),
        ...(input === undefined ? {} : { toolInput: input.text, ...(input.truncated ? { truncated: true } : {}) }),
      }
    }
    case 'tool_call_update': {
      const callId = nonEmpty(update['toolCallId'])
      const name = (callId === undefined ? undefined : toolNames.get(callId)) ?? 'tool'
      const output = bounded(toolContentText(update['content']) ?? update['rawOutput'])
      const paths = locationPaths(update['locations'])
      return {
        index: 0,
        role: 'tool',
        kind: 'tool-result',
        nativeType,
        toolName: name,
        failed: update['status'] === 'failed',
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(paths.length === 0 ? {} : { paths }),
        ...(output === undefined ? {} : { toolOutput: output.text, ...(output.truncated ? { truncated: true } : {}) }),
      }
    }
    case 'plan': {
      const entries = planEntries(update['entries'])
      const text = entries.map(entry => `${entry.status}: ${entry.content}`).join('\n')
      return item('assistant', 'plan', text === '' ? undefined : text, timestamp, nativeType)
    }
    case 'current_mode_update':
      return item('system', 'plan', nonEmpty(update['modeId']), timestamp, nativeType)
    default:
      return item('unknown', 'unknown', undefined, timestamp, nativeType)
  }
}

/** Map `chat_history.jsonl` lines (the derived model-message cache). */
function mapChatHistory(text: string): { messages: readonly AgentMessage[]; malformed: number } {
  const messages: AgentMessage[] = []
  let malformed = 0
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const parsed = parseJson(raw)
    const record = parsed === undefined ? undefined : asRecord(parsed)
    if (record === undefined) {
      malformed += 1
      continue
    }
    const type = nonEmpty(record['type']) ?? 'unknown'
    switch (type) {
      case 'system':
        // The mesh has no `system` message kind, so the role carries it and the native
        // type is what names the record.
        messages.push(item('system', 'unknown', contentText(record['content']), undefined, type))
        break
      case 'user':
        messages.push(item('user', 'user', contentText(record['content']), undefined, type))
        break
      case 'assistant': {
        messages.push(item('assistant', 'assistant', contentText(record['content']), undefined, type))
        const calls = Array.isArray(record['tool_calls']) ? record['tool_calls'] : []
        for (const call of calls) {
          const entry = asRecord(call)
          if (entry === undefined) continue
          const input = bounded(entry['arguments'])
          messages.push({
            index: 0,
            role: 'assistant',
            kind: 'tool-call',
            nativeType: 'assistant.tool_calls',
            toolName: nonEmpty(entry['name']) ?? 'tool',
            ...(input === undefined ? {} : { toolInput: input.text, ...(input.truncated ? { truncated: true } : {}) }),
          })
        }
        break
      }
      case 'tool_result': {
        const output = bounded(contentText(record['content']))
        messages.push({
          index: 0,
          role: 'tool',
          kind: 'tool-result',
          nativeType: type,
          toolName: 'tool',
          failed: false,
          ...(output === undefined ? {} : { toolOutput: output.text, ...(output.truncated ? { truncated: true } : {}) }),
        })
        break
      }
      case 'reasoning':
        messages.push(item('assistant', 'reasoning', contentText(record['content']), undefined, type))
        break
      default:
        messages.push(item('unknown', 'unknown', undefined, undefined, type))
        break
    }
  }
  return { messages, malformed }
}

/** Build a plain transcript item. */
function item(
  role: AgentMessageRole,
  kind: AgentMessageKind,
  text: string | undefined,
  timestamp: string | undefined,
  nativeType: string,
): AgentMessage {
  return {
    index: 0,
    role,
    kind,
    nativeType,
    ...(text === undefined ? {} : { text }),
    ...(timestamp === undefined ? {} : { timestamp }),
  }
}

/** Extract the ACP plan entries carried by a `plan` update. */
function planEntries(value: unknown): readonly { readonly content: string; readonly status: AgentTodoStatus }[] {
  const items = Array.isArray(value) ? value : []
  const out: { content: string; status: AgentTodoStatus }[] = []
  for (const entry of items) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const content = nonEmpty(record['content'])
    if (content === undefined) continue
    out.push({ content, status: todoStatus(record['status']) })
  }
  return out
}

/**
 * Canonical todo status for a native token.
 * @param value - The native status token.
 * @returns the canonical status; an unknown token is reported as `pending`.
 */
export function todoStatus(value: unknown): AgentTodoStatus {
  switch (value) {
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'pending'
  }
}

/** Paths an ACP `locations` array names. */
function locationPaths(locations: unknown): readonly string[] {
  const items = Array.isArray(locations) ? locations : []
  const paths: string[] = []
  for (const location of items) {
    const record = asRecord(location)
    const path = record === undefined ? undefined : nonEmpty(record['path'])
    if (path !== undefined && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/**
 * Text of an ACP tool content array.
 *
 * ACP wraps text as `{type:'content', content:{type:'text', text}}`; a `diff` entry
 * carries the touched path instead of text.
 * @param content - The raw `content` value.
 * @returns the joined text, or `undefined` when no entry carried any.
 */
export function toolContentText(content: unknown): string | undefined {
  const items = Array.isArray(content) ? content : []
  const parts: string[] = []
  for (const entry of items) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const inner = asRecord(record['content']) ?? record
    const text = nonEmpty(inner['text'])
    if (text !== undefined) parts.push(text)
    const path = nonEmpty(record['path'])
    if (record['type'] === 'diff' && path !== undefined) parts.push(`[diff] ${path}`)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** Text of an ACP content block, which is either a string or `{type:'text', text}`. */
function blockText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const record = asRecord(value)
  return record === undefined ? undefined : nonEmpty(record['text'])
}

/** Text of a chat-history `content` field, which is a string or a content-part array. */
function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const parts = Array.isArray(value) ? value : []
  const pieces: string[] = []
  for (const part of parts) {
    const record = asRecord(part)
    const piece = record === undefined ? undefined : nonEmpty(record['text'])
    if (piece !== undefined) pieces.push(piece)
  }
  return pieces.length === 0 ? undefined : pieces.join('\n')
}

/** Cap one projected field so a single record cannot dominate the window. */
function bounded(value: unknown): { readonly text: string; readonly truncated: boolean } | undefined {
  if (value === undefined || value === null) return undefined
  let serialized: string
  if (typeof value === 'string') {
    serialized = value
  } else {
    serialized = JSON.stringify(value)
  }
  if (serialized === '') return undefined
  return serialized.length > MAX_MESSAGE_FIELD_CHARS
    ? { text: serialized.slice(0, MAX_MESSAGE_FIELD_CHARS), truncated: true }
    : { text: serialized, truncated: false }
}

/** ISO timestamp of an update, from the envelope's seconds or the `_meta` millisecond clock. */
function timestampOf(envelope: Record<string, unknown>, params: Record<string, unknown>): string | undefined {
  const meta = asRecord(params['_meta'])
  const millis = meta === undefined ? undefined : number(meta['agentTimestampMs'])
  if (millis !== undefined && millis > 0) return new Date(millis).toISOString()
  const seconds = number(envelope['timestamp'])
  if (seconds !== undefined && seconds > 0) return new Date(seconds * 1000).toISOString()
  return undefined
}

/** Parse one JSON line, or `undefined` when it is not valid JSON. */
function parseJson(line: string): unknown {
  const trimmed = line.trim()
  try {
    const value: unknown = JSON.parse(trimmed)
    return value
  } catch (cause) {
    // An unparsable line is a projection gap, not an adapter failure; the caller counts it.
    void cause
    return undefined
  }
}

/** Narrow a JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

/** A non-empty string field. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A finite number field. */
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
