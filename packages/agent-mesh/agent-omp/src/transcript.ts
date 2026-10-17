/**
 * Projection of one OMP session file into mesh transcript messages.
 *
 * The live branch is read first (see `ompBranch`), then each entry is projected through
 * the entry taxonomy: `message` entries by role (`user`, `developer`, `assistant` with
 * per-block text/thinking/toolCall, `toolResult`, `bashExecution`, `pythonExecution`,
 * `fileMention`, `custom`, the legacy `hookMessage`, `branchSummary`,
 * `compactionSummary`), plus `custom_message`, `compaction` and `branch_summary` entries.
 * A role or entry type this module does not model still produces a message —
 * `kind: 'unknown'` with the native type preserved — while entries that are known to
 * carry only state are counted and declared in the transcript notes.
 *
 * The mesh message union is narrower than the reference adapter's: there is no
 * `file-change` and no `system` kind, so an inlined file mention becomes a user message
 * carrying its `paths`, and a non-displayed custom message is projected as `unknown` with
 * its native type. Text fields are cut at {@link MAX_MESSAGE_TEXT_BYTES} with the
 * `truncated` flag set, which the reference adapter did not do.
 * @module @deepseek-ai/dsh-agent-omp/transcript
 */

import type { AgentMessage, AgentSession, AgentTranscript, AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import {
  OMP_DEFAULT_TRANSCRIPT_BYTES,
  findOmpSessionFile,
  foldOmpEntries,
  isRecord,
  note,
  ompBranch,
  readArray,
  readBoolean,
  readNumber,
  readOmpSessionView,
  readRecord,
  readString,
  type OmpNativeEntry,
  type OmpStoreLayout,
} from './sessions.ts'

/** Cap on any single text field copied into a mesh message. */
export const MAX_MESSAGE_TEXT_BYTES = 16 * 1024

/** Characters of a native value serialized into a tool-input or tool-output field. */
const MAX_SERIALIZED_CHARS = 4_000

/** A mesh message before the reader assigns its window index. */
export type OmpMessageDraft = Omit<AgentMessage, 'index'>

/** Counters a projection run accumulates, so the reader can declare what it dropped. */
export interface OmpProjectionCounters {
  /** Image blocks seen, which the mesh message has no field for. */
  images: number
  /** Content block types this adapter does not model. */
  unknownBlocks: number
  /** Message roles this adapter does not model. */
  unknownRoles: number
  /** `fileMention` records projected as user messages carrying their paths. */
  fileMentions: number
}

/**
 * Allocate zeroed projection counters.
 *
 * @returns fresh counters for one projection run.
 */
export function ompProjectionCounters(): OmpProjectionCounters {
  return { images: 0, unknownBlocks: 0, unknownRoles: 0, fileMentions: 0 }
}

/**
 * Project one entry into mesh messages, unwrapping OMP's camelCase message roles.
 *
 * Content blocks are `text`, `thinking`, `toolCall` and `image`, and a tool result is its
 * own message with role `toolResult`; an assistant entry therefore expands into one
 * message per content block. Images and unknown block types are counted for the caller's
 * notes instead of being invented into text.
 *
 * @param entry - A session entry on the live branch.
 * @param counters - Accumulator for what this projection cannot carry.
 * @returns projected messages in block order; empty for state-only entries.
 */
export function projectOmpEntry(entry: OmpNativeEntry, counters: OmpProjectionCounters): readonly OmpMessageDraft[] {
  switch (entry.type) {
    case 'message':
      return projectMessageEntry(entry, counters)
    case 'custom_message':
      return projectCustomMessage(entry, counters, undefined)
    case 'compaction':
      return projectSummary(entry, 'compaction', readString(entry.record, 'summary'), counters)
    case 'branch_summary':
      return projectSummary(entry, 'branch_summary', readString(entry.record, 'summary'), counters)
    default:
      // model_usage, thinking_level_change, model_change, service_tier_change,
      // reset_boundary, label, title_change, ttsr_injection, credential_pin,
      // session_init, mode_change and any future entry type carry state or context
      // bookkeeping, not conversation content; the caller notes the ones with projection
      // consequences.
      return []
  }
}

/** Project one `message` entry by its native role. */
function projectMessageEntry(entry: OmpNativeEntry, counters: OmpProjectionCounters): readonly OmpMessageDraft[] {
  const message = readRecord(entry.record, 'message')
  if (message === undefined) return []
  const timestamp = messageActivity(message, entry.timestamp)
  const role = readString(message, 'role') ?? ''

  switch (role) {
    case 'user':
    case 'developer': {
      const text = projectMessageContent(message, counters)
      return [
        {
          role: 'user',
          kind: 'user',
          ...cappedText(text),
          ...spreadTime(timestamp),
          nativeType: role === 'developer' ? 'developer' : 'message',
        },
      ]
    }
    case 'assistant': {
      const content = readArray(message, 'content')
      if (content === undefined) {
        const text = readString(message, 'content')
        return text === undefined
          ? []
          : [{ role: 'assistant', kind: 'assistant', ...cappedText(text), ...spreadTime(timestamp), nativeType: 'message' }]
      }
      return projectAssistantBlocks(content, counters).map(item => ({
        ...item,
        ...spreadTime(timestamp),
        nativeType: 'message',
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
          ...cappedField('toolOutput', output),
          ...(failed ? { failed: true } : {}),
          ...spreadTime(timestamp),
          nativeType: 'message',
        },
      ]
    }
    case 'bashExecution':
    case 'pythonExecution': {
      const tool = role === 'bashExecution' ? 'bash' : 'python'
      const output = readString(message, 'output')
      const command = readString(message, 'command') ?? readString(message, 'code')
      const exitCode = readNumber(message, 'exitCode')
      return [
        {
          role: 'tool',
          kind: 'tool-result',
          toolName: tool,
          ...cappedField('toolInput', command),
          ...cappedField('toolOutput', output),
          ...(exitCode === undefined || exitCode === 0 ? {} : { failed: true }),
          ...spreadTime(timestamp),
          nativeType: tool,
        },
      ]
    }
    case 'fileMention': {
      const paths = (readArray(message, 'paths') ?? []).filter((path): path is string => typeof path === 'string')
      counters.fileMentions += 1
      return [
        {
          role: 'user',
          kind: 'user',
          ...cappedText(projectMessageContent(message, counters)),
          ...spreadTime(timestamp),
          nativeType: 'message',
          paths,
        },
      ]
    }
    case 'custom':
      return projectCustomMessage(entry, counters, message)
    case 'hookMessage': {
      // v3 rewrites `hookMessage` to `custom`; a reader must still accept the legacy role.
      counters.unknownRoles += 1
      return projectCustomMessage(entry, counters, message)
    }
    case 'branchSummary':
      return projectSummary(entry, 'branch_summary', readString(message, 'summary'), counters)
    case 'compactionSummary':
      return projectSummary(entry, 'compaction', readString(message, 'summary'), counters)
    default: {
      counters.unknownRoles += 1
      const text = typeof message['content'] === 'string' ? message['content'] : undefined
      return [{ role: 'unknown', kind: 'unknown', ...cappedText(text), ...spreadTime(timestamp), nativeType: 'message' }]
    }
  }
}

/** Project an assistant message's content blocks, one mesh message per block. */
function projectAssistantBlocks(
  content: readonly unknown[],
  counters: OmpProjectionCounters,
): readonly OmpMessageDraft[] {
  const items: OmpMessageDraft[] = []
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
          ...(args === undefined ? {} : cappedField('toolInput', stringifyBounded(args))),
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

/** The text of a user or developer message's content. */
function projectMessageContent(message: Record<string, unknown>, counters: OmpProjectionCounters): string | undefined {
  const content = message['content']
  if (typeof content === 'string') return content
  return projectTextBlocks(content, counters)
}

/** Join the text blocks of a content array, counting what is dropped. */
function projectTextBlocks(content: unknown, counters: OmpProjectionCounters): string | undefined {
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

/** Project a `custom` message, from the message record or from the entry itself. */
function projectCustomMessage(
  entry: OmpNativeEntry,
  counters: OmpProjectionCounters,
  message: Record<string, unknown> | undefined,
): readonly OmpMessageDraft[] {
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
      ...spreadTime(isoOrUndefinedTime(entry.timestamp)),
    },
  ]
}

/** Project a compaction or branch summary entry as a system summary message. */
function projectSummary(
  entry: OmpNativeEntry,
  nativeType: string,
  summary: string | undefined,
  counters: OmpProjectionCounters,
): readonly OmpMessageDraft[] {
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
      ...spreadTime(isoOrUndefinedTime(entry.timestamp)),
    },
  ]
}

/** Serialize a native value for a mesh string field, bounded. */
function stringifyBounded(value: unknown): string {
  let text: string
  try {
    const serialized: unknown = JSON.stringify(value)
    text = typeof serialized === 'string' ? serialized : String(value)
  } catch {
    text = '<unserializable>'
  }
  return text.length > MAX_SERIALIZED_CHARS ? text.slice(0, MAX_SERIALIZED_CHARS) : text
}

/** The ISO 8601 activity time of a message record. */
function messageActivity(message: Record<string, unknown>, fallback: string): string | undefined {
  const role = readString(message, 'role')
  if (role !== 'user' && role !== 'assistant') return undefined
  const native = readNumber(message, 'timestamp')
  if (native !== undefined) return new Date(native).toISOString()
  return isoOrUndefinedTime(fallback)
}

/** An ISO 8601 time for a native timestamp string, when it is parseable. */
function isoOrUndefinedTime(value: string): string | undefined {
  if (value === '') return undefined
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

/** A capped text field, carrying the `truncated` flag only when it was cut. */
function cappedText(text: string | undefined): { readonly text?: string; readonly truncated?: boolean } {
  if (text === undefined) return {}
  if (text.length <= MAX_MESSAGE_TEXT_BYTES) return { text }
  return { text: `${text.slice(0, MAX_MESSAGE_TEXT_BYTES)}\n[truncated by dsh-agent-omp at ${String(MAX_MESSAGE_TEXT_BYTES)} characters]`, truncated: true }
}

/** A capped named field (`toolInput` or `toolOutput`). */
function cappedField(
  field: 'toolInput' | 'toolOutput',
  value: string | undefined,
): { readonly toolInput?: string; readonly toolOutput?: string; readonly truncated?: boolean } {
  if (value === undefined || value === '') return {}
  if (value.length <= MAX_MESSAGE_TEXT_BYTES) {
    return field === 'toolInput' ? { toolInput: value } : { toolOutput: value }
  }
  const cut = `${value.slice(0, MAX_MESSAGE_TEXT_BYTES)}\n[truncated by dsh-agent-omp at ${String(MAX_MESSAGE_TEXT_BYTES)} characters]`
  return field === 'toolInput' ? { toolInput: cut, truncated: true } : { toolOutput: cut, truncated: true }
}

/** A `timestamp` field, or nothing when the record carries none. */
function spreadTime(timestamp: string | undefined): { readonly timestamp?: string } {
  return timestamp === undefined ? {} : { timestamp }
}

/** Everything a transcript read needs. */
export interface OmpTranscriptRead {
  /** Host providing the filesystem and the environment. */
  readonly host: AgentHost
  /** Resolved store layout. */
  readonly layout: OmpStoreLayout
  /** Session to read, as returned by a session listing. */
  readonly session: AgentSession
  /** Maximum trailing messages to return. */
  readonly maxMessages?: number
  /** Maximum bytes of store to read before projecting. */
  readonly maxBytes?: number
}

/**
 * Read a bounded transcript window along a session's live branch.
 *
 * The session's own `nativePath` is used when the listing recorded one; otherwise the
 * store is scanned by file-name convention and then by header probes, bounded by the
 * ported probe cap.
 *
 * @param read - Host, layout, the session, and the caller's bounds.
 * @returns the window, oldest first, with every declared gap.
 */
export async function readOmpTranscript(read: OmpTranscriptRead): Promise<AgentTranscript> {
  const path = read.session.nativePath ?? (await findOmpSessionFile(read.host, read.layout, read.session.nativeId))
  if (path === undefined) {
    return {
      key: read.session.key,
      messages: [],
      hasMore: false,
      notes: [note('*', `no session file was found for ${read.session.nativeId}`)],
    }
  }
  const view = await readOmpSessionView(read.host, path, read.maxBytes ?? OMP_DEFAULT_TRANSCRIPT_BYTES)
  if (view.missing) {
    return {
      key: read.session.key,
      messages: [],
      hasMore: false,
      notes: [note('*', 'the session file disappeared during the read')],
    }
  }

  const branch = ompBranch(view)
  const counters = ompProjectionCounters()
  const drafts: OmpMessageDraft[] = []
  for (const entry of branch.chain) {
    for (const item of projectOmpEntry(entry, counters)) drafts.push(item)
  }

  const maxMessages = read.maxMessages
  const window =
    maxMessages === undefined || maxMessages <= 0 || drafts.length <= maxMessages
      ? drafts
      : drafts.slice(drafts.length - maxMessages)
  const messages: AgentMessage[] = window.map((draft, index) => ({ index, ...draft }))

  const notes: string[] = [...view.notes]
  if (view.malformed > 0) {
    notes.push(note('*', `${String(view.malformed)} lines in the read window did not parse`))
  }
  if (branch.abandoned > 0) {
    notes.push(
      note('messages', `${String(branch.abandoned)} entries on abandoned branches are excluded from the linear reading`),
    )
  }
  if (branch.truncated) {
    notes.push(note('messages', 'the live branch extends past the read window, so older messages were not read'))
  }
  if (messages.length < drafts.length) {
    notes.push(note('messages', `the window was capped at ${String(messages.length)} of ${String(drafts.length)} projected items`))
  }
  if (counters.images > 0) {
    notes.push(note('messages', `${String(counters.images)} image blocks were omitted; the mesh message has no image field`))
  }
  const fold = foldOmpEntries(branch.chain, view.header)
  if (fold.unknownEntryTypes.length > 0) {
    notes.push(note('messages', `entry types this adapter does not model were left out: ${fold.unknownEntryTypes.join(', ')}`))
  }
  if (counters.unknownBlocks > 0) {
    notes.push(note('messages', `${String(counters.unknownBlocks)} content blocks have no canonical kind`))
  }
  if (counters.unknownRoles > 0) {
    notes.push(note('messages', `${String(counters.unknownRoles)} messages had a role this adapter does not model`))
  }
  if (counters.fileMentions > 0) {
    notes.push(
      note(
        'messages',
        'the mesh has no file-change kind, so an inlined `fileMention` is projected as a user message carrying its paths',
      ),
    )
  }

  return {
    key: read.session.key,
    messages,
    ...(branch.truncated ? {} : { totalMessages: countMessageEntries(branch.chain) }),
    hasMore: branch.truncated || messages.length < drafts.length,
    notes,
  }
}

/** Entries on the branch that are `message` records, which `totalMessages` counts. */
function countMessageEntries(entries: readonly OmpNativeEntry[]): number {
  let count = 0
  for (const entry of entries) if (entry.type === 'message') count += 1
  return count
}
