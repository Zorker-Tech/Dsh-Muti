/**
 * Pi's session store: layout resolution, the header/entry record model, branch following,
 * and read-only discovery.
 *
 * Everything here reads a store another process may be appending to right now, so every
 * read is bounded and nothing is ever written (the harness owns no file in Pi's agent
 * directory).
 *
 * Layout, verified against pi 1.2.0:
 *
 *   <agent-dir>/sessions/--<flattened-cwd>--/<ISO-with-:-and-.-replaced>-<sessionId>.jsonl
 *
 * where `<agent-dir>` is the configured `homeDir`, else `$PI_CODING_AGENT_DIR`, else
 * `~/.pi/agent`; the flattened cwd is
 * `'--' + absoluteCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'`; and the root is
 * `<agent-dir>/sessions`. A session directory override (the adapter's `sessionDir` setting,
 * then `$PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in Pi's `settings.json`) is **not**
 * a second root: it is the directory that directly holds the session files, replacing the
 * per-cwd subdirectory for every project, so it is read flat. Both the override directory
 * and the default root (with its subdirectories) are scanned, because a machine that
 * switched layouts keeps sessions in both, and the directory name is only a hint: the
 * header's own `cwd` field is authoritative.
 *
 * The file is a JSONL header line followed by append-only entries that form a tree. A branch
 * switch appends an entry whose `parentId` is not the previous line's `id`, so the live
 * conversation is the chain ending at the **last** line, never the file order.
 *
 * The module also owns this adapter's projection-note rendering: the mesh records `notes` as
 * strings rather than field-tagged records, so a note names the canonical field it belongs to
 * by prefixing the reason with it.
 * @module @deepseek-ai/dsh-agent-pi/sessions
 */

import { join, resolve as resolvePath } from 'node:path'
import type {
  AgentHost,
  AgentId,
  AgentSession,
  AgentSessionKey,
  AgentSessionListOptions,
  AgentUsage,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'

/** Environment variable that relocates Pi's agent directory. */
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'

/** Environment variable that sets the flat session directory Pi reads. */
export const PI_SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'

/** Agent directory under the user's home when nothing else names one. */
export const PI_DEFAULT_AGENT_DIR = '.pi/agent'

/** Session root inside the agent directory. */
export const PI_SESSIONS_DIR = 'sessions'

/** Credential file inside the agent directory; only its path is ever reported. */
export const PI_CREDENTIAL_FILE = 'auth.json'

/** Settings file inside the agent directory. */
export const PI_SETTINGS_FILE = 'settings.json'

/** Model and provider configuration inside the agent directory. */
export const PI_MODELS_FILE = 'models.json'

/** Session file format version this reader was verified against. */
export const PI_SESSION_VERSION = 3

/** How many session directories a single scan will look at. */
const MAX_SCAN_DIRECTORIES = 200

/** Per-directory file cap, so one runaway project cannot starve the scan. */
const MAX_SCAN_FILES_PER_DIRECTORY = 400

/** Global file cap for one scan. */
const MAX_SCAN_FILES = 1_500

/** Cap on header probes during a by-id lookup, whose fast path is the file name. */
const MAX_HEADER_PROBES = 300

/** Bytes read to obtain the header line of a large session file. */
export const HEADER_READ_BYTES = 64 * 1024

/** A file at or below this size is read whole; a larger one is read head + tail. */
export const SMALL_FILE_BYTES = 256 * 1024

/** Default byte window for one transcript read. */
export const DEFAULT_TRANSCRIPT_BYTES = 512 * 1024

/** Lower bound on a transcript window, so a caller cannot ask for an unusable read. */
export const MIN_TRANSCRIPT_BYTES = 64 * 1024

/** Upper bound on a transcript window. */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024

/** Characters of a raw native entry or payload retained for diagnostics. */
export const MAX_RAW_CHARS = 4_000

/** Byte cap on a settings/models file read. */
const JSON_FILE_MAX_BYTES = 1024 * 1024

/**
 * Render one projection note.
 * @param field - Canonical field the gap belongs to, or `*` for a record-wide gap.
 * @param reason - What could not be carried, addressed to the reader.
 * @returns the note as the mesh records it.
 */
export function note(field: string, reason: string): string {
  return field === '*' ? reason : `${field}: ${reason}`
}

// ---------------------------------------------------------------------------
// Native record narrowing. Pi's files are foreign JSON: every field is read
// through these guards, so a format change degrades a field, never a crash.
// ---------------------------------------------------------------------------

/**
 * Whether a decoded JSON value is a plain object.
 * @param value - Value to test.
 * @returns `true` for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a string field.
 * @param source - Object to read from, or `undefined`.
 * @param key - Field name.
 * @returns the value, or `undefined` when absent or not a string.
 */
export function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a finite number field.
 * @param source - Object to read from, or `undefined`.
 * @param key - Field name.
 * @returns the value, or `undefined` when absent or not a finite number.
 */
export function readNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read a boolean field.
 * @param source - Object to read from, or `undefined`.
 * @param key - Field name.
 * @returns the value, or `undefined` when absent or not a boolean.
 */
export function readBoolean(source: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = source?.[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Read an object field.
 * @param source - Object to read from, or `undefined`.
 * @param key - Field name.
 * @returns the nested object, or `undefined`.
 */
export function readRecord(
  source: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = source?.[key]
  return isRecord(value) ? value : undefined
}

/**
 * Read an array field.
 * @param source - Object to read from, or `undefined`.
 * @param key - Field name.
 * @returns the array, or `undefined`.
 */
export function readArray(source: Record<string, unknown> | undefined, key: string): readonly unknown[] | undefined {
  const value = source?.[key]
  return Array.isArray(value) ? value : undefined
}

/**
 * Parse one line as JSON.
 * @param line - One line without its terminator.
 * @returns the parsed value, or the parse error message.
 */
export function parseJsonLine(line: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = line.trim()
  if (trimmed === '') return { ok: false, error: 'empty line' }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Build the mesh-wide session key, `<agentId>:<nativeId>`.
 * @param agentId - Owning agent.
 * @param nativeId - The agent's own session identifier.
 * @returns the branded mesh key.
 */
export function sessionKey(agentId: AgentId, nativeId: string): AgentSessionKey {
  return brandString<AgentSessionKey>(`${String(agentId)}:${nativeId}`)
}

/**
 * An ISO 8601 time for a native timestamp string, when it is parseable.
 * @param value - The native timestamp, or `undefined` when the record carried none.
 * @returns the timestamp in ISO 8601 form, or `undefined` when it was absent or unparseable.
 */
export function isoOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

// ---------------------------------------------------------------------------
// Store layout
// ---------------------------------------------------------------------------

/** Where a machine keeps Pi's configuration, its sessions and its credentials. */
export interface PiStoreLayout {
  /** Resolved agent directory (configured, `$PI_CODING_AGENT_DIR`, or `~/.pi/agent`). */
  readonly agentDir: string
  /** Root holding one directory per project, plus any stray session files. */
  readonly defaultSessionsRoot: string
  /** Flat session directory in force, when the adapter, the environment or Pi configured one. */
  readonly sessionDirOverride?: string
  /** `auth.json`, for display and read-only status inspection. */
  readonly credentialPath: string
  /** `settings.json`, read for `sessionDir`, the default model and the enabled-model scope. */
  readonly settingsPath: string
  /** `models.json`, read for configured providers and their models. */
  readonly modelsPath: string
}

/** Everything the store layout is resolved from. */
export interface PiStoreRead {
  /** Host providing the environment, the home directory and the reads. */
  readonly host: AgentHost
  /** Configured agent directory, the highest-priority source. */
  readonly homeDir?: string
  /** Configured session directory override, the highest-priority source. */
  readonly sessionDir?: string
  /** Environment to resolve from; defaults to the host's. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Resolve the store layout from the adapter configuration, the environment and Pi's own
 * settings file, in that precedence order.
 *
 * @param read - Host, configured overrides and the environment to resolve from.
 * @returns the resolved layout.
 */
export async function resolvePiStore(read: PiStoreRead): Promise<PiStoreLayout> {
  const env = read.env ?? read.host.env
  const configuredAgentDir = read.homeDir === undefined ? undefined : expandPath(read.host, read.homeDir)
  const envAgentDir = scalarEnv(env, PI_AGENT_DIR_ENV)
  const agentDir =
    configuredAgentDir ??
    (envAgentDir === undefined ? undefined : expandPath(read.host, envAgentDir)) ??
    join(read.host.home, ...PI_DEFAULT_AGENT_DIR.split('/'))
  const settingsPath = join(agentDir, PI_SETTINGS_FILE)
  const configuredSessionDir = read.sessionDir === undefined ? undefined : expandPath(read.host, read.sessionDir)
  const envSessionDir = scalarEnv(env, PI_SESSION_DIR_ENV)
  const override =
    configuredSessionDir ??
    (envSessionDir === undefined ? undefined : expandPath(read.host, envSessionDir)) ??
    (await readSettingsSessionDir(read.host, settingsPath))
  return {
    agentDir,
    defaultSessionsRoot: join(agentDir, PI_SESSIONS_DIR),
    ...(override === undefined ? {} : { sessionDirOverride: override }),
    credentialPath: join(agentDir, PI_CREDENTIAL_FILE),
    settingsPath,
    modelsPath: join(agentDir, PI_MODELS_FILE),
  }
}

/** Read `sessionDir` from Pi's own settings.json, tolerating every failure. */
async function readSettingsSessionDir(host: AgentHost, settingsPath: string): Promise<string | undefined> {
  const parsed = parseJsonLine(await host.readHead(settingsPath, JSON_FILE_MAX_BYTES))
  if (!parsed.ok || !isRecord(parsed.value)) return undefined
  return scalar(readString(parsed.value, 'sessionDir'))
}

/** A non-empty trimmed value, or `undefined`. */
function scalar(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** A set, non-empty environment value, or `undefined`; values never leave this module. */
function scalarEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  return scalar(env[name])
}

/** Expand a leading `~` and make a path absolute, resolving relative paths against the process directory. */
function expandPath(host: AgentHost, path: string): string {
  if (path === '~') return host.home
  if (path.startsWith('~/')) return join(host.home, path.slice(2))
  return resolvePath(path)
}

// ---------------------------------------------------------------------------
// Store records
// ---------------------------------------------------------------------------

/** The first line of a Pi session file. */
export interface PiSessionHeader {
  /** Session id, verbatim. */
  readonly id: string
  /** Creation time, verbatim ISO 8601. */
  readonly timestamp: string
  /** Absolute working directory the session was started in; empty on very old files. */
  readonly cwd: string
  /** Path of the session this one was forked from, when it was. */
  readonly parentSession?: string
  /** Native format version; absent on v1 files. */
  readonly version?: number
}

/**
 * Parse a session header.
 * @param value - Decoded JSON of the first line.
 * @returns the header, or `undefined` when the line is not a session header.
 */
export function readPiSessionHeader(value: unknown): PiSessionHeader | undefined {
  if (!isRecord(value) || readString(value, 'type') !== 'session') return undefined
  const id = readString(value, 'id')
  if (id === undefined || id === '') return undefined
  const timestamp = readString(value, 'timestamp')
  const cwd = readString(value, 'cwd')
  const version = readNumber(value, 'version')
  const parentSession = readString(value, 'parentSession')
  return {
    id,
    timestamp: timestamp ?? '',
    cwd: cwd ?? '',
    ...(version === undefined ? {} : { version: Math.trunc(version) }),
    ...(parentSession === undefined || parentSession === '' ? {} : { parentSession }),
  }
}

/** One parsed session entry, in file order, with its bounded raw line. */
export interface PiNativeEntry {
  /** Entry id, verbatim. */
  readonly id: string
  /** Parent entry id; `null` at a branch root or for the first entry. */
  readonly parentId: string | null
  /** Entry timestamp, verbatim ISO 8601 (empty when the file omits it). */
  readonly timestamp: string
  /** Entry type, verbatim. */
  readonly type: string
  /** Decoded record, for field access. */
  readonly record: Record<string, unknown>
  /** Raw JSONL line, truncated for diagnostics only. */
  readonly raw: string
}

/**
 * Parse one session entry.
 * @param value - Decoded JSON of a non-header line.
 * @param raw - The raw line, retained bounded for `unknown` projections.
 * @returns the entry, or `undefined` when the line is not an entry.
 */
export function readPiEntry(value: unknown, raw: string): PiNativeEntry | undefined {
  if (!isRecord(value)) return undefined
  const id = readString(value, 'id')
  const type = readString(value, 'type')
  if (id === undefined || id === '' || type === undefined || type === '') return undefined
  const parentId = value['parentId']
  return {
    id,
    parentId: typeof parentId === 'string' ? parentId : null,
    timestamp: readString(value, 'timestamp') ?? '',
    type,
    record: value,
    raw: raw.length > MAX_RAW_CHARS ? raw.slice(0, MAX_RAW_CHARS) : raw,
  }
}

/** One bounded read of a session file. */
export interface PiSessionView {
  /** Session header, when the read window contained it. */
  readonly header?: PiSessionHeader
  /** Entries in the read window, in file order. */
  readonly entries: readonly PiNativeEntry[]
  /** Whether earlier file content was outside the window. */
  readonly windowTruncated: boolean
  /** Whether the window dropped a leading partial line. */
  readonly droppedPartialLine: boolean
  /** File size at read time, or `-1` when absent. */
  readonly size: number
  /** File modification time in milliseconds. */
  readonly mtimeMs: number
  /** JSON lines in the window that did not parse as a header or an entry. */
  readonly malformed: number
  /** Whether the file was absent or unreadable. */
  readonly missing: boolean
  /** Declared gaps produced while reading. */
  readonly notes: readonly string[]
}

/** Mutable accumulator for one window parse. */
interface WindowAccumulator {
  header: PiSessionHeader | undefined
  sawFirstLine: boolean
  entries: PiNativeEntry[]
  malformed: number
}

/**
 * Read a bounded view of one session file: the whole file when it is small, else the header
 * plus a tail window. Read-only, and capped so a large session is never read into memory
 * whole.
 *
 * @param host - Host providing the reads.
 * @param path - Absolute session file path.
 * @param maxBytes - Desired window size.
 * @returns the view; `missing: true` when the file is gone or unreadable.
 */
export async function readPiSessionView(host: AgentHost, path: string, maxBytes: number): Promise<PiSessionView> {
  const cap = Math.max(MIN_TRANSCRIPT_BYTES, Math.min(maxBytes, MAX_TRANSCRIPT_BYTES))
  const fingerprint = await host.stat(path)
  if (fingerprint === undefined) return missingView(-1, 0)

  const notes: string[] = []
  const accumulator: WindowAccumulator = { header: undefined, sawFirstLine: false, entries: [], malformed: 0 }
  let windowTruncated: boolean
  let droppedPartialLine = false

  if (fingerprint.size <= cap) {
    const whole = await host.readHead(path, Math.max(1, fingerprint.size))
    if (whole === '' && fingerprint.size > 0) return missingView(fingerprint.size, fingerprint.mtimeMs)
    windowTruncated = false
    accumulateWindow(whole, accumulator)
  } else {
    // The header is the first line and the fold window is the tail. Reading the head first
    // keeps the authoritative cwd available even for a huge session.
    const head = await host.readHead(path, HEADER_READ_BYTES)
    const headerLine = completeFirstLine(head)
    if (headerLine === undefined) {
      notes.push(note('cwd', `the session header did not fit in ${HEADER_READ_BYTES} bytes, so the cwd is unavailable`))
    } else {
      accumulateWindow(headerLine, accumulator)
    }
    const tail = await host.readTail(path, cap)
    if (tail.text === '' && fingerprint.size > 0) return missingView(fingerprint.size, fingerprint.mtimeMs)
    droppedPartialLine = tail.droppedPartialLine
    windowTruncated = true
    // The tail starts on a record boundary and never holds the header, so its first line is
    // an entry: the accumulator is advanced past its header phase.
    accumulator.sawFirstLine = true
    for (const line of tail.text.split('\n')) {
      if (line.trim() === '') continue
      const parsed = parseJsonLine(line)
      if (!parsed.ok) {
        accumulator.malformed += 1
        continue
      }
      const entry = readPiEntry(parsed.value, line)
      if (entry === undefined) accumulator.malformed += 1
      else accumulator.entries.push(entry)
    }
  }

  return {
    ...(accumulator.header === undefined ? {} : { header: accumulator.header }),
    entries: accumulator.entries,
    windowTruncated,
    droppedPartialLine,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    malformed: accumulator.malformed,
    missing: false,
    notes,
  }
}

/**
 * Read only the header of a session file, for by-id lookups and resume checks.
 * @param host - Host providing the read.
 * @param path - Absolute session file path.
 * @returns the header, or `undefined` when the first line is not a complete header.
 */
export async function readPiSessionHeaderAt(host: AgentHost, path: string): Promise<PiSessionHeader | undefined> {
  const firstLine = completeFirstLine(await host.readHead(path, HEADER_READ_BYTES))
  if (firstLine === undefined) return undefined
  const parsed = parseJsonLine(firstLine)
  return parsed.ok ? readPiSessionHeader(parsed.value) : undefined
}

/** A view of a session file that could not be read. */
function missingView(size: number, mtimeMs: number): PiSessionView {
  return {
    entries: [],
    windowTruncated: false,
    droppedPartialLine: false,
    size,
    mtimeMs,
    malformed: 0,
    missing: true,
    notes: [note('*', 'the session file is absent')],
  }
}

/** Parse a block of JSONL text whose first line may be the session header. */
function accumulateWindow(text: string, accumulator: WindowAccumulator): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      accumulator.malformed += 1
      continue
    }
    if (!accumulator.sawFirstLine) {
      accumulator.sawFirstLine = true
      const header = readPiSessionHeader(parsed.value)
      if (header === undefined) {
        accumulator.malformed += 1
        continue
      }
      accumulator.header = header
      continue
    }
    const entry = readPiEntry(parsed.value, line)
    if (entry === undefined) accumulator.malformed += 1
    else accumulator.entries.push(entry)
  }
}

/**
 * The first complete line of a text window.
 * @param text - Text that may end mid-line.
 * @returns the first line without its terminator, or `undefined` when none is complete.
 */
function completeFirstLine(text: string): string | undefined {
  const newline = text.indexOf('\n')
  return newline === -1 ? undefined : text.slice(0, newline)
}

// ---------------------------------------------------------------------------
// Directory-name encoding
// ---------------------------------------------------------------------------

/**
 * Pi's flattened-cwd directory name for an absolute cwd.
 * @param cwd - Working directory; resolved first.
 * @returns the directory name, e.g. `--Volumes-Net-Repo--`.
 */
export function encodeCwdDirName(cwd: string): string {
  const resolved = resolvePath(cwd)
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/**
 * Best-effort decode of a flattened-cwd directory name.
 *
 * The encoding is lossy: a real `-` in a path is indistinguishable from a separator, and a
 * Windows drive colon is flattened too. This is only ever a hint — the header's own `cwd`
 * field is authoritative.
 *
 * @param name - Directory entry name.
 * @returns the candidate absolute path, or `undefined` when the name is not encoded.
 */
export function decodeCwdDirName(name: string): string | undefined {
  if (name.length < 4 || !name.startsWith('--') || !name.endsWith('--')) return undefined
  const inner = name.slice(2, -2)
  return inner === '' ? undefined : `/${inner.replace(/-/g, '/')}`
}

// ---------------------------------------------------------------------------
// Folding and branch walking
// ---------------------------------------------------------------------------

/** Entry types this reader models, directly or as declared state. */
const KNOWN_ENTRY_TYPES: readonly string[] = [
  'message',
  'session_info',
  'model_change',
  'thinking_level_change',
  'usage',
  'context_edit',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
]

/** A session's state as folded from one read window. */
export interface PiSessionFold {
  /** Latest `session_info` name in the window; an empty name clears it. */
  readonly title?: string
  /** Latest `model_change` model id, else the last assistant message's model. */
  readonly model?: string
  /** Usage summed over the window (assistant messages and `usage` entries). */
  readonly usage?: AgentUsage
  /** `message` entries seen in the window. */
  readonly messageCount: number
  /** Latest user/assistant message time in the window, ISO 8601. */
  readonly lastMessageAt?: string
  /** Image blocks seen, which the mesh message vocabulary has no field for. */
  readonly images: number
  /** `usage` entries in the window (cache-warming accounting). */
  readonly usageEntries: number
  /** `context_edit` entries in the window. */
  readonly contextEdits: number
  /** `compaction` entries in the window. */
  readonly compactions: number
  /** Cache-write tokens seen, which `AgentUsage` cannot carry. */
  readonly cacheWriteTokens: number
  /** Entry types this reader does not model, distinct, at most a handful. */
  readonly unknownEntryTypes: readonly string[]
}

/** Mutable usage totals, because `AgentUsage` members are read-only. */
interface MutableUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  costUsd?: number
}

/**
 * Fold a read window into session state.
 * @param entries - Entries in file order.
 * @returns the folded state.
 */
export function foldPiEntries(entries: readonly PiNativeEntry[]): PiSessionFold {
  const draft = {
    messageCount: 0,
    images: 0,
    usageEntries: 0,
    contextEdits: 0,
    compactions: 0,
    cacheWriteTokens: 0,
  }
  const title: { value?: string } = {}
  const model: { value?: string } = {}
  const lastMessageAt: { value?: string } = {}
  const totals: MutableUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  const unknown: string[] = []
  let sawUsage = false

  for (const entry of entries) {
    switch (entry.type) {
      case 'message': {
        draft.messageCount += 1
        const message = readRecord(entry.record, 'message')
        if (message === undefined) break
        const activity = messageActivity(message, entry.timestamp)
        if (activity !== undefined && (lastMessageAt.value === undefined || activity > lastMessageAt.value)) {
          lastMessageAt.value = activity
        }
        draft.images += countImages(message)
        if (readString(message, 'role') === 'assistant') {
          const messageModel = scalar(readString(message, 'model'))
          if (messageModel !== undefined) model.value = messageModel
          const usage = readRecord(message, 'usage')
          if (usage !== undefined) {
            sawUsage = true
            addUsage(totals, usage)
          }
        }
        break
      }
      case 'session_info': {
        const name = readString(entry.record, 'name')
        if (name === undefined) break
        // The latest session_info wins, and an empty name clears the title.
        const trimmed = name.trim()
        if (trimmed === '') delete title.value
        else title.value = trimmed
        break
      }
      case 'model_change': {
        const modelId = scalar(readString(entry.record, 'modelId'))
        if (modelId !== undefined) model.value = modelId
        break
      }
      case 'usage': {
        draft.usageEntries += 1
        const usage = readRecord(entry.record, 'usage')
        if (usage !== undefined) {
          sawUsage = true
          addUsage(totals, usage)
        }
        break
      }
      case 'context_edit':
        draft.contextEdits += 1
        break
      case 'compaction':
        draft.compactions += 1
        break
      default:
        // A format revision must degrade into a visible gap, not a silent drop.
        if (!KNOWN_ENTRY_TYPES.includes(entry.type) && !unknown.includes(entry.type)) unknown.push(entry.type)
        break
    }
  }

  return {
    ...(title.value === undefined ? {} : { title: title.value }),
    ...(model.value === undefined ? {} : { model: model.value }),
    ...(sawUsage ? { usage: projectUsage(totals) } : {}),
    messageCount: draft.messageCount,
    ...(lastMessageAt.value === undefined ? {} : { lastMessageAt: lastMessageAt.value }),
    images: draft.images,
    usageEntries: draft.usageEntries,
    contextEdits: draft.contextEdits,
    compactions: draft.compactions,
    cacheWriteTokens: totals.cacheWrite,
    unknownEntryTypes: unknown,
  }
}

/** Project running total. */
function projectUsage(totals: MutableUsage): AgentUsage {
  return {
    // addUsage initializes these totals whenever a usage record is observed.
    inputTokens: totals.input,
    outputTokens: totals.output,
    cachedInputTokens: totals.cacheRead,
    ...(totals.reasoning === undefined ? {} : { reasoningTokens: totals.reasoning }),
    totalTokens: totals.totalTokens,
    ...(totals.costUsd === undefined ? {} : { costUsd: totals.costUsd }),
  }
}

/** Sum a native `Usage` record into running totals. */
function addUsage(totals: MutableUsage, usage: Record<string, unknown>): void {
  const cost = readRecord(usage, 'cost')
  const costUsd = cost === undefined ? undefined : readNumber(cost, 'total')
  totals.input += readNumber(usage, 'input') ?? 0
  totals.output += readNumber(usage, 'output') ?? 0
  totals.cacheRead += readNumber(usage, 'cacheRead') ?? 0
  totals.cacheWrite += readNumber(usage, 'cacheWrite') ?? 0
  totals.totalTokens += readNumber(usage, 'totalTokens') ?? 0
  const reasoning = readNumber(usage, 'reasoning')
  if (reasoning !== undefined) totals.reasoning = (totals.reasoning ?? 0) + reasoning
  if (costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + costUsd
}

/**
 * The ISO 8601 activity time of a message record.
 * @param message - The native message record.
 * @param fallback - The entry's own timestamp.
 * @returns the time, or `undefined` for a record with no activity time.
 */
export function messageActivity(message: Record<string, unknown>, fallback: string): string | undefined {
  const role = readString(message, 'role')
  if (role !== 'user' && role !== 'assistant') return undefined
  const native = readNumber(message, 'timestamp')
  if (native !== undefined) {
    const date = new Date(native)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return isoOrUndefined(fallback)
}

/** Count image blocks anywhere in a message's content. */
function countImages(message: Record<string, unknown>): number {
  const content = message['content']
  if (!Array.isArray(content)) return 0
  let images = 0
  for (const block of content) {
    if (isRecord(block) && readString(block, 'type') === 'image') images += 1
  }
  return images
}

/** The live conversation of a session file. */
export interface PiBranch {
  /** Entries on the branch that ends at the last line, in conversation order. */
  readonly chain: readonly PiNativeEntry[]
  /** Entries in the window that belong to abandoned branches. */
  readonly abandoned: number
  /** Whether the chain start is outside the read window or a parent link is missing. */
  readonly truncated: boolean
}

/**
 * Walk `parentId` links from the last entry to produce the live branch.
 *
 * The store is append-only and the last line is where the next entry attaches, so the last
 * entry is the live leaf; everything reachable from it is the conversation, and everything
 * else is an abandoned branch. A corrupt file could contain a cycle, and a bounded walk is
 * the one safe answer.
 *
 * @param view - A read window.
 * @returns the chain, the abandoned count, and whether the chain start is unknown.
 */
export function piBranch(view: PiSessionView): PiBranch {
  const byId = new Map<string, PiNativeEntry>()
  for (const entry of view.entries) byId.set(entry.id, entry)
  const leaf = view.entries[view.entries.length - 1]
  if (leaf === undefined) return { chain: [], abandoned: 0, truncated: view.windowTruncated }

  const chain: PiNativeEntry[] = []
  const visited = new Set<string>()
  let cursor: PiNativeEntry | undefined = leaf
  while (cursor !== undefined) {
    if (visited.has(cursor.id)) break
    visited.add(cursor.id)
    chain.push(cursor)
    if (cursor.parentId === null) break
    cursor = byId.get(cursor.parentId)
  }
  chain.reverse()
  const root = chain[0]
  const truncated = view.windowTruncated || (root !== undefined && root.parentId !== null)
  return { chain, abandoned: view.entries.length - chain.length, truncated }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** One directory level of a Pi store: direct session files and project subdirectories. */
export interface PiScanRoot {
  /** Directory to read. */
  readonly path: string
}

/**
 * The roots a scan reads: the override directory first, then Pi's default root.
 * @param layout - Resolved store layout.
 * @returns the roots, with a dedupe guard for an override that names the default root.
 */
export function piScanRoots(layout: PiStoreLayout): readonly PiScanRoot[] {
  const roots: PiScanRoot[] = []
  if (layout.sessionDirOverride !== undefined) {
    // An override holds session files for every project; it is read for subdirectories too,
    // because an override may point at an otherwise default-shaped root.
    roots.push({ path: layout.sessionDirOverride })
  }
  if (layout.sessionDirOverride !== layout.defaultSessionsRoot) {
    roots.push({ path: layout.defaultSessionsRoot })
  }
  return roots
}

/** Everything one session listing needs. */
export interface PiSessionScan {
  /** Host providing the filesystem and the clock. */
  readonly host: AgentHost
  /** Owning agent id, stamped on every session. */
  readonly agentId: AgentId
  /** Resolved store layout. */
  readonly layout: PiStoreLayout
  /** Caller options: cwd filter, limit and abort signal. */
  readonly options: AgentSessionListOptions
}

/**
 * Enumerate Pi's sessions.
 *
 * The directory name is only a hint: the header's own `cwd` is authoritative, so a
 * disagreement (or an unreadable header) is declared as a projection note rather than
 * silently resolving to the lossy decode.
 *
 * @param scan - Host, layout and caller options.
 * @returns sessions, newest first, bounded by the scan caps.
 */
export async function listPiSessions(scan: PiSessionScan): Promise<readonly AgentSession[]> {
  const { host, layout, options } = scan
  const limit = options.limit === undefined || options.limit <= 0 ? Number.POSITIVE_INFINITY : options.limit
  const wantedCwd = options.cwd === undefined ? undefined : expandPath(host, options.cwd)
  const sessions: AgentSession[] = []
  const scanNotes: string[] = []
  let filesSeen = 0
  let directoriesSeen = 0
  let scanStopped = false

  for (const root of piScanRoots(layout)) {
    if (scanStopped || sessions.length >= limit) break
    if (!(await isDirectory(host, root.path))) continue
    const entries = await host.listDir(root.path)
    for (const entry of entries) {
      if (aborted(options.signal) || sessions.length >= limit) break
      if (entry.isDirectory || !isSessionFileName(entry.name)) continue
      if (filesSeen >= MAX_SCAN_FILES) {
        scanNotes.push(note('*', `the scan stopped after ${MAX_SCAN_FILES} session files`))
        scanStopped = true
        break
      }
      filesSeen += 1
      // A file directly in the root has no directory-name hint for its cwd.
      const session = await projectSession(scan, undefined, join(root.path, entry.name), entry.mtimeMs, wantedCwd)
      if (session !== undefined) sessions.push(session)
    }
    if (scanStopped) continue
    for (const directory of entries) {
      if (scanStopped || aborted(options.signal) || sessions.length >= limit) break
      if (!directory.isDirectory) continue
      if (directoriesSeen >= MAX_SCAN_DIRECTORIES) {
        scanNotes.push(
          note('*', `only the ${MAX_SCAN_DIRECTORIES} most recently touched session directories were scanned`),
        )
        scanStopped = true
        break
      }
      if (filesSeen >= MAX_SCAN_FILES) {
        scanNotes.push(note('*', `the scan stopped after ${MAX_SCAN_FILES} session files`))
        scanStopped = true
        break
      }
      directoriesSeen += 1
      const directoryPath = join(root.path, directory.name)
      const files = (await host.listDir(directoryPath)).filter(
        file => !file.isDirectory && isSessionFileName(file.name),
      )
      let filesHere = 0
      for (const file of files) {
        if (aborted(options.signal) || sessions.length >= limit) break
        if (filesSeen >= MAX_SCAN_FILES) {
          scanNotes.push(note('*', `the scan stopped after ${MAX_SCAN_FILES} session files`))
          scanStopped = true
          break
        }
        if (filesHere >= MAX_SCAN_FILES_PER_DIRECTORY) {
          scanNotes.push(
            note('*', `only the ${MAX_SCAN_FILES_PER_DIRECTORY} most recent files of ${directory.name} were scanned`),
          )
          break
        }
        filesHere += 1
        filesSeen += 1
        const session = await projectSession(
          scan,
          directory.name,
          join(directoryPath, file.name),
          file.mtimeMs,
          wantedCwd,
        )
        if (session !== undefined) sessions.push(session)
      }
    }
  }

  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (scanNotes.length === 0 || sessions.length === 0) return sessions
  // The listing has no channel of its own, so the scan's gaps ride on the newest session.
  return sessions.map((session, index) =>
    index === 0 ? { ...session, notes: [...session.notes, ...scanNotes] } : session,
  )
}

/** Whether a host path is a directory. */
async function isDirectory(host: AgentHost, path: string): Promise<boolean> {
  return (await host.stat(path))?.isDirectory === true
}

/** Whether a caller's signal asked to stop. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/**
 * Whether a file name is a Pi session file.
 * @param name - The basename to test.
 * @returns `true` when the name ends in `.jsonl`.
 */
export function isSessionFileName(name: string): boolean {
  return name.endsWith('.jsonl')
}

/**
 * The session id encoded in a session file name, when the convention holds.
 *
 * Pi separates the id from the rest of the stem with an underscore; the id is the
 * segment after the last one, and a name with no usable separator carries none.
 * @param name - The basename to decode.
 * @returns the session id, or `undefined` when the name does not carry one.
 */
export function idFromFileName(name: string): string | undefined {
  if (!name.endsWith('.jsonl')) return undefined
  const stem = name.slice(0, -'.jsonl'.length)
  const separator = stem.lastIndexOf('_')
  if (separator <= 0 || separator === stem.length - 1) return undefined
  return stem.slice(separator + 1)
}

/** The session id behind a header `parentSession` path, when it can be recovered. */
function idFromSessionReference(reference: string): string | undefined {
  const lastSegment = reference.split(/[/\\]/).pop()
  if (lastSegment === undefined || lastSegment === '') return undefined
  if (!isSessionFileName(lastSegment)) return reference
  return idFromFileName(lastSegment) ?? reference
}

/** The basename of an absolute path. */
function baseName(path: string): string {
  return path.split(/[/\\]/).slice(-1).join('')
}

/** Project one session file onto a mesh session. */
async function projectSession(
  scan: PiSessionScan,
  directoryName: string | undefined,
  path: string,
  mtimeMs: number,
  wantedCwd: string | undefined,
): Promise<AgentSession | undefined> {
  const { host, agentId } = scan
  const view = await readPiSessionView(host, path, SMALL_FILE_BYTES)
  if (view.missing) return undefined
  const notes: string[] = [...view.notes]
  const decoded = directoryName === undefined ? undefined : decodeCwdDirName(directoryName)
  const mtimeIso = new Date(mtimeMs).toISOString()
  const header = view.header

  if (header === undefined) {
    const derivedId = idFromFileName(baseName(path))
    if (derivedId === undefined) {
      host.log('warn', `skipping a Pi session file with no readable header and no id in its name: ${path}`)
      return undefined
    }
    notes.push(
      note('*', 'the session header was unreadable; the id came from the file name and no metadata is available'),
    )
    return {
      key: sessionKey(agentId, derivedId),
      agentId,
      nativeId: derivedId,
      nativePath: path,
      status: 'unreadable',
      ...(decoded === undefined ? {} : { cwd: decoded }),
      createdAt: mtimeIso,
      updatedAt: mtimeIso,
      notes,
    }
  }

  const headerCwd = header.cwd === '' ? undefined : header.cwd
  const cwd = headerCwd ?? decoded
  if (decoded !== undefined && headerCwd !== undefined && decoded !== headerCwd) {
    notes.push(
      note(
        'cwd',
        `the directory name decodes to ${decoded} but the header records ${headerCwd}; ` +
          `pi would name this session's directory ${encodeCwdDirName(headerCwd)}, so the path ` +
          'likely contains a real dash, which the encoding flattens',
      ),
    )
  } else if (headerCwd === undefined && decoded !== undefined) {
    notes.push(note('cwd', 'taken from the lossy directory-name encoding; the header recorded no cwd'))
  }
  if (wantedCwd !== undefined && headerCwd !== undefined && resolvePath(headerCwd) !== wantedCwd) return undefined

  const branch = piBranch(view)
  const fold = foldPiEntries(branch.chain)
  if (view.windowTruncated) {
    notes.push(
      note('*', 'the file exceeded the read window; counts and usage cover only the live branch inside that window'),
    )
  }
  if (branch.abandoned > 0) {
    notes.push(note('messages', `${branch.abandoned} entries on abandoned branches are excluded from the linear reading`))
  }
  if (fold.contextEdits > 0) {
    notes.push(
      note('messages', `${fold.contextEdits} context edits are recorded but not applied: the transcript shows the recorded content`),
    )
  }
  if (fold.usage !== undefined) {
    notes.push(note('usage', 'token usage is recorded by pi for this session, and the mesh session record has no usage field'))
  }
  if (fold.cacheWriteTokens > 0) {
    notes.push(note('usage', 'cache-write tokens are recorded by pi but have no canonical field'))
  }
  if (view.malformed > 0) {
    notes.push(note('*', `${view.malformed} lines in the read window did not parse`))
  }
  if (fold.images > 0) {
    notes.push(
      note('messages', `${fold.images} image blocks have no canonical field and are not represented in this summary`),
    )
  }
  if (fold.unknownEntryTypes.length > 0) {
    notes.push(
      note('messages', `entry types this adapter does not model were left out: ${fold.unknownEntryTypes.join(', ')}`),
    )
  }

  const parentId = header.parentSession === undefined ? undefined : idFromSessionReference(header.parentSession)
  return {
    key: sessionKey(agentId, header.id),
    agentId,
    nativeId: header.id,
    nativePath: path,
    ...(fold.title === undefined ? {} : { title: fold.title, titleIsNative: true }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(fold.model === undefined ? {} : { model: fold.model }),
    createdAt: isoOrUndefined(header.timestamp) ?? mtimeIso,
    updatedAt: fold.lastMessageAt ?? isoOrUndefined(header.timestamp) ?? mtimeIso,
    status: 'idle',
    ...(view.windowTruncated ? {} : { messageCount: fold.messageCount }),
    ...(parentId === undefined ? {} : { parentNativeId: parentId }),
    source: header.parentSession === undefined ? 'pi' : 'pi:fork',
    notes,
  }
}

/**
 * Locate a session file for a native id, or for a path given verbatim.
 *
 * There is no session index in Pi, so this is a bounded directory scan: first by the
 * `<timestamp>_<id>.jsonl` file-name convention (cheap and exact), then by probing headers
 * when the name convention does not match.
 *
 * @param host - Host providing the filesystem.
 * @param layout - Resolved store layout.
 * @param nativeId - Session id, or a session file path given verbatim.
 * @returns the absolute path, or `undefined` when no file matches.
 */
export async function findPiSessionFile(
  host: AgentHost,
  layout: PiStoreLayout,
  nativeId: string,
): Promise<string | undefined> {
  const raw = nativeId.trim()
  if (raw === '') return undefined
  if (raw.includes('/') || raw.includes('\\') || raw.endsWith('.jsonl')) {
    const candidate = expandPath(host, raw)
    return (await host.stat(candidate))?.isDirectory === false ? candidate : undefined
  }

  let probes = 0
  let visitedDirectories = 0
  let fallback: string | undefined
  const candidates: { path: string; namedMatch: boolean }[] = []

  for (const root of piScanRoots(layout)) {
    if (!(await isDirectory(host, root.path))) continue
    const entries = await host.listDir(root.path)
    for (const entry of entries) {
      if (!entry.isDirectory && isSessionFileName(entry.name)) {
        candidates.push({ path: join(root.path, entry.name), namedMatch: idFromFileName(entry.name) === raw })
      }
    }
    for (const directory of entries) {
      if (!directory.isDirectory || visitedDirectories >= MAX_SCAN_DIRECTORIES) continue
      visitedDirectories += 1
      const directoryPath = join(root.path, directory.name)
      const files = (await host.listDir(directoryPath)).filter(
        entry => !entry.isDirectory && isSessionFileName(entry.name),
      )
      for (const file of files) {
        candidates.push({ path: join(directoryPath, file.name), namedMatch: idFromFileName(file.name) === raw })
      }
    }
  }

  // Name matches are checked first and cheaply; only then are headers probed.
  candidates.sort((a, b) => Number(b.namedMatch) - Number(a.namedMatch))
  for (const candidate of candidates) {
    if (!candidate.namedMatch && probes >= MAX_HEADER_PROBES) continue
    probes += 1
    const header = await readPiSessionHeaderAt(host, candidate.path)
    if (header?.id !== raw) continue
    if (candidate.namedMatch) return candidate.path
    if (fallback === undefined) fallback = candidate.path
  }
  if (fallback === undefined && probes >= MAX_HEADER_PROBES) {
    host.log('info', `the by-id Pi session lookup stopped at its header probe cap: ${raw}`)
  }
  return fallback
}
