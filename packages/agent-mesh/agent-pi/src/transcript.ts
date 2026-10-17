/**
 * Projection of one Pi session file into mesh transcript messages.
 *
 * The live branch is the `parentId` chain ending at the file's last entry, so an abandoned
 * branch contributes nothing and is declared as a note. Pi's `AgentMessage` content blocks
 * are `text`, `thinking`, `toolCall` and `image`; a tool result is its own message with role
 * `toolResult`, and a shell run is a `bashExecution` message.
 *
 * Three adaptations of the mesh vocabulary show up here, each declared in the notes:
 *
 * - `AgentMessageKind` has no `system` member, so a non-displayed custom message keeps role
 *   `system` with kind `unknown`, and a compaction or branch summary is reported as kind
 *   `summary`.
 * - `AgentMessage` has no per-message id, so Pi's entry ids and tool-call ids are dropped.
 * - Image blocks have no field and are counted, never invented into text.
 *
 * Text fields are capped at {@link MAX_MESSAGE_TEXT_BYTES} with `truncated: true`, because a
 * single assistant block can carry an entire file.
 * @module @deepseek-ai/dsh-agent-pi/transcript
 */

import type { AgentHost, AgentMessage, AgentSession, AgentTranscript } from '@deepseek-ai/dsh-agent-mesh'
import {
  DEFAULT_TRANSCRIPT_BYTES,
  findPiSessionFile,
  foldPiEntries,
  isRecord,
  isoOrUndefined,
  MAX_RAW_CHARS,
  messageActivity,
  note,
  piBranch,
  readArray,
  readBoolean,
  readNumber,
  readPiSessionView,
  readRecord,
  readString,
  type PiNativeEntry,
  type PiStoreLayout,
} from './sessions.ts'

/** Cap on any single text field copied into a mesh message. */
export const MAX_MESSAGE_TEXT_BYTES = 16 * 1024

/** A mesh message before the reader assigns its window index. */
export type PiMessageDraft = Omit<AgentMessage, 'index'>

/** Counters a projection run accumulates, so the reader can declare what it dropped. */
export interface PiProjectionCounters {
  /** Image blocks seen, which the mesh message has no field for. */
  images: number
  /** Content block types this adapter does not model. */
  unknownBlocks: number
  /** Message roles this adapter does not model. */
  unknownRoles: number
}

/**
 * Allocate zeroed projection counters.
 * @returns fresh counters for one projection run.
 */
export function projectionCounters(): PiProjectionCounters {
  return { images: 0, unknownBlocks: 0, unknownRoles: 0 }
}

/**
 * Project one entry into mesh messages, unwrapping Pi's `AgentMessage` record.
 *
 * An assistant entry expands into one message per content block, and a tool call keeps its
 * arguments as `toolInput`. Entry types that carry state or context bookkeeping
 * (`session_info`, `model_change`, `usage`, `context_edit`, `label`, …) carry no conversation
 * content and produce nothing.
 *
 * @param entry - A session entry.
 * @param counters - Accumulator for what this projection cannot carry.
 * @returns projected messages in block order; empty for state-only entries.
 */
export function projectPiEntry(entry: PiNativeEntry, counters: PiProjectionCounters): readonly PiMessageDraft[] {
  switch (entry.type) {
    case 'message':
      return projectMessageEntry(entry, counters)
    case 'custom_message':
    case 'custom':
      return projectCustomMessage(entry, counters)
    case 'compaction':
      return projectSummary(entry, 'compaction', readString(entry.record, 'summary'), counters)
    case 'branch_summary':
      return projectSummary(entry, 'branch_summary', readString(entry.record, 'summary'), counters)
    default:
      return []
  }
}

/** Project one `message` entry by the role its record carries. */
function projectMessageEntry(entry: PiNativeEntry, counters: PiProjectionCounters): readonly PiMessageDraft[] {
  const message = readRecord(entry.record, 'message')
  if (message === undefined) return []
  const timestamp = messageActivity(message, entry.timestamp) ?? isoOrUndefined(entry.timestamp)
  const nativeType = 'message'

  switch (readString(message, 'role') ?? '') {
    case 'user': {
      const text = projectMessageContent(message, counters)
      return [{ role: 'user', kind: 'user', ...spreadText(text), ...optionalTimestamp(timestamp), nativeType }]
    }
    case 'assistant': {
      const content = readArray(message, 'content')
      if (content === undefined) {
        const text = readString(message, 'content')
        return text === undefined
          ? []
          : [{ role: 'assistant', kind: 'assistant', ...cappedText(text), ...optionalTimestamp(timestamp), nativeType }]
      }
      return projectAssistantBlocks(content, counters).map(item => ({
        ...item,
        ...optionalTimestamp(timestamp),
        nativeType,
      }))
    }
    case 'toolResult': {
      const output = projectMessageContent(message, counters)
      const failed = readBoolean(message, 'isError') === true
      return [
        {
          role: 'tool',
          kind: 'tool-result',
          toolName: readString(message, 'toolName') ?? 'tool',
          ...spreadOutput(output),
          ...(failed ? { failed: true } : {}),
          ...optionalTimestamp(timestamp),
          nativeType,
        },
      ]
    }
    case 'bashExecution': {
      const output = readString(message, 'output')
      const command = readString(message, 'command')
      const exitCode = readNumber(message, 'exitCode')
      return [
        {
          role: 'tool',
          kind: 'tool-result',
          toolName: 'bash',
          ...(command === undefined ? {} : { toolInput: capText(command).text }),
          ...spreadOutput(output),
          ...(exitCode === undefined || exitCode === 0 ? {} : { failed: true }),
          ...optionalTimestamp(timestamp),
          nativeType,
        },
      ]
    }
    case 'custom':
      return projectCustomMessage(entry, counters, message)
    case 'branchSummary':
      return projectSummary(entry, 'branch_summary', readString(message, 'summary'), counters)
    case 'compactionSummary':
      return projectSummary(entry, 'compaction', readString(message, 'summary'), counters)
    default: {
      counters.unknownRoles += 1
      const text = typeof message['content'] === 'string' ? message['content'] : undefined
      return [{ role: 'unknown', kind: 'unknown', ...spreadText(text), ...optionalTimestamp(timestamp), nativeType }]
    }
  }
}

/** Project an assistant message's content blocks, one mesh message per block. */
function projectAssistantBlocks(
  content: readonly unknown[],
  counters: PiProjectionCounters,
): readonly PiMessageDraft[] {
  const items: PiMessageDraft[] = []
  for (const block of content) {
    if (!isRecord(block)) {
      counters.unknownBlocks += 1
      continue
    }
    switch (readString(block, 'type')) {
      case 'text': {
        const text = readString(block, 'text')
        if (text !== undefined && text !== '') {
          items.push({ role: 'assistant', kind: 'assistant', ...cappedText(text) })
        }
        break
      }
      case 'thinking': {
        const text = readString(block, 'thinking')
        if (text !== undefined && text !== '') {
          items.push({ role: 'assistant', kind: 'reasoning', ...cappedText(text) })
        }
        break
      }
      case 'toolCall': {
        const args = block['arguments']
        items.push({
          role: 'assistant',
          kind: 'tool-call',
          toolName: readString(block, 'name') ?? 'tool',
          ...(args === undefined ? {} : { toolInput: boundedJson(args) }),
        })
        break
      }
      case 'image':
        counters.images += 1
        break
      default:
        counters.unknownBlocks += 1
        break
    }
  }
  return items
}

/** The text of a user message, which is a string or a content array. */
function projectMessageContent(message: Record<string, unknown>, counters: PiProjectionCounters): string | undefined {
  const content = message['content']
  if (typeof content === 'string') return content
  return projectTextBlocks(content, counters)
}

/** Join the text blocks of a content array, counting what is dropped. */
function projectTextBlocks(content: unknown, counters: PiProjectionCounters): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) {
      counters.unknownBlocks += 1
      continue
    }
    const type = readString(block, 'type')
    if (type === 'text') {
      const text = readString(block, 'text')
      if (text !== undefined) parts.push(text)
    } else if (type === 'image') counters.images += 1
    else counters.unknownBlocks += 1
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Project a custom message.
 *
 * Pi renders a displayed custom message like a user turn and injects it as one; a
 * non-displayed one is an injection the mesh vocabulary has no kind for, so it keeps role
 * `system` and kind `unknown` with its native `customType` preserved.
 *
 * @param entry - The entry carrying the message.
 * @param counters - Accumulator for what this projection cannot carry.
 * @param message - The nested `message` record of a `message` entry, when there is one.
 * @returns zero or one message, in block order.
 */
function projectCustomMessage(
  entry: PiNativeEntry,
  counters: PiProjectionCounters,
  message?: Record<string, unknown>,
): readonly PiMessageDraft[] {
  const source = message ?? entry.record
  const content = source['content']
  const text = typeof content === 'string' ? content : projectTextBlocks(content, counters)
  if (text === undefined || text === '') return []
  const display = readBoolean(source, 'display') === true
  const customType = readString(source, 'customType') ?? readString(entry.record, 'customType')
  return [
    {
      role: display ? 'user' : 'system',
      kind: display ? 'user' : 'unknown',
      ...cappedText(text),
      nativeType: customType ?? 'custom_message',
      ...optionalTimestamp(isoOrUndefined(entry.timestamp)),
    },
  ]
}

/** Project a compaction or branch summary entry as one summary message. */
function projectSummary(
  entry: PiNativeEntry,
  nativeType: string,
  summary: string | undefined,
  counters: PiProjectionCounters,
): readonly PiMessageDraft[] {
  if (summary === undefined || summary === '') {
    counters.unknownBlocks += 1
    return []
  }
  return [
    {
      role: 'system',
      kind: 'summary',
      ...cappedText(summary),
      nativeType,
      ...optionalTimestamp(isoOrUndefined(entry.timestamp)),
    },
  ]
}

/** Serialize a native value for a canonical string field, bounded. */
function boundedJson(value: unknown): string {
  let text: string
  try {
    const serialized: unknown = JSON.stringify(value)
    text = typeof serialized === 'string' ? serialized : String(value)
  } catch {
    text = '<unserializable>'
  }
  return text.length > MAX_RAW_CHARS ? text.slice(0, MAX_RAW_CHARS) : text
}

/** A `text` field, or nothing when the record carries none. */
function spreadText(text: string | undefined): { text?: string; truncated?: boolean } {
  return text === undefined ? {} : cappedText(text)
}

/** A `toolOutput` field, or nothing when the record carries none. */
function spreadOutput(text: string | undefined): { toolOutput?: string; truncated?: boolean } {
  if (text === undefined) return {}
  const body = capText(text)
  return { toolOutput: body.text, ...(body.truncated ? { truncated: true } : {}) }
}

/** A `timestamp` field, or nothing when the record carries none. */
function optionalTimestamp(timestamp: string | undefined): { timestamp?: string } {
  return timestamp === undefined ? {} : { timestamp }
}

/** A capped `text` field with its truncation flag. */
function cappedText(text: string): { text: string; truncated?: boolean } {
  const body = capText(text)
  return { text: body.text, ...(body.truncated ? { truncated: true } : {}) }
}

/** Truncate native text to the transcript field cap. */
function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MESSAGE_TEXT_BYTES) return { text, truncated: false }
  const marker = `\n[truncated by dsh-agent-pi at ${MAX_MESSAGE_TEXT_BYTES} characters]`
  return {
    text: `${text.slice(0, MAX_MESSAGE_TEXT_BYTES - marker.length)}${marker}`,
    truncated: true,
  }
}

/** Everything a transcript read needs. */
export interface PiTranscriptRead {
  /** Host providing the session-file reads. */
  readonly host: AgentHost
  /** Resolved store layout. */
  readonly layout: PiStoreLayout
  /** Session to read, as a listing returned it. */
  readonly session: AgentSession
  /** Maximum number of trailing messages to return. */
  readonly maxMessages?: number
  /** Maximum bytes of session file to read before projecting. */
  readonly maxBytes?: number
}

/**
 * Read a bounded transcript window along the live branch.
 *
 * A session file that cannot be found or that vanished between the listing and the read is
 * reported as a note on an empty window, not thrown: the caller already holds the session
 * record, and the store belongs to another process that may be rotating it.
 *
 * @param read - Host, layout, session and the caller's bounds.
 * @returns the window, oldest first, with every declared gap.
 */
export async function readPiTranscript(read: PiTranscriptRead): Promise<AgentTranscript> {
  const { host, layout, session } = read
  const path = session.nativePath ?? (await findPiSessionFile(host, layout, session.nativeId))
  if (path === undefined) {
    return {
      key: session.key,
      messages: [],
      hasMore: false,
      notes: [note('*', `no session file was found for ${session.nativeId}`)],
    }
  }
  const view = await readPiSessionView(host, path, read.maxBytes ?? DEFAULT_TRANSCRIPT_BYTES)
  if (view.missing) {
    return {
      key: session.key,
      messages: [],
      hasMore: false,
      notes: [note('*', 'the session file disappeared during the read')],
    }
  }

  const branch = piBranch(view)
  const counters = projectionCounters()
  const drafts: PiMessageDraft[] = []
  for (const entry of branch.chain) {
    for (const item of projectPiEntry(entry, counters)) drafts.push(item)
  }

  const maxMessages = read.maxMessages
  const window =
    maxMessages === undefined || maxMessages <= 0 || drafts.length <= maxMessages
      ? drafts
      : drafts.slice(drafts.length - maxMessages)
  const messages: AgentMessage[] = window.map((draft, index) => ({ index, ...draft }))

  const notes: string[] = [...view.notes]
  if (view.malformed > 0) {
    notes.push(note('*', `${view.malformed} lines in the read window did not parse`))
  }
  if (branch.abandoned > 0) {
    notes.push(note('messages', `${branch.abandoned} entries on abandoned branches are excluded from the linear reading`))
  }
  if (branch.truncated) {
    notes.push(note('messages', 'the live branch extends past the read window, so older messages were not read'))
  }
  if (messages.length < drafts.length) {
    notes.push(note('messages', `the window was capped at ${messages.length} of ${drafts.length} projected items`))
  }
  if (counters.images > 0) {
    notes.push(note('messages', `${counters.images} image blocks were omitted; the canonical message has no image field`))
  }
  const fold = foldPiEntries(branch.chain)
  if (fold.unknownEntryTypes.length > 0) {
    notes.push(
      note('messages', `entry types this adapter does not model were left out: ${fold.unknownEntryTypes.join(', ')}`),
    )
  }
  if (counters.unknownBlocks > 0) {
    notes.push(note('messages', `${counters.unknownBlocks} content blocks have no canonical kind`))
  }
  if (counters.unknownRoles > 0) {
    notes.push(note('messages', `${counters.unknownRoles} messages had a role this adapter does not model`))
  }
  notes.push(
    note('*', 'the mesh message kinds have no `system` member: pi summaries are reported as kind `summary`, and injected messages keep role `system` with kind `unknown`'),
  )
  notes.push(note('*', "pi's entry ids and tool-call ids are not carried: the mesh message record has no id field"))

  return {
    key: session.key,
    messages,
    ...(branch.truncated ? {} : { totalMessages: countMessageEntries(branch.chain) }),
    hasMore: branch.truncated || messages.length < drafts.length,
    notes,
  }
}

/** The number of `message` entries in a chain. */
function countMessageEntries(entries: readonly PiNativeEntry[]): number {
  let count = 0
  for (const entry of entries) if (entry.type === 'message') count += 1
  return count
}
