/**
 * OMP's session store: layout resolution, discovery, the title-slot/header/entry record
 * model, folding, branch walking, and the native todo/plan snapshot source.
 *
 * Everything here is read-only and bounded, because the store belongs to another process
 * that may be appending to it right now.
 *
 * Current OMP session files use this path:
 *
 *   <agent-dir>/sessions/<encoded-cwd>/<file-safe-timestamp>_<sessionId>.jsonl
 *
 * where `<agent-dir>` is the adapter's `homeDir` override, then a named profile's
 * `<config-root>/profiles/<profile>/agent`, then `$PI_CODING_AGENT_DIR`, then
 * `<config-root>/agent`; `PI_CONFIG_DIR` renames the `.omp` config root. A session
 * directory override (`$PI_CODING_AGENT_SESSION_DIR`, or the adapter's own `sessionDir`
 * setting) is not a second root: it is the directory that directly holds session files,
 * replacing the per-cwd bucket for every project, so it is read flat as well as one level
 * down.
 *
 * The file physically begins with a 256-byte fixed-width `type: "title"` slot (including
 * its newline), then the `type: "session"` header, then append-only entry values that
 * form a tree (OMP's own loaders strip and fold the slot; legacy files may begin directly
 * with the header). A branch switch appends an entry whose `parentId` is not the previous
 * line's `id`, so the live conversation is the chain ending at the live leaf, never the
 * file order — and a late `model_usage` entry that carries `activeLeafId` selects a leaf
 * other than the last line.
 * @module @deepseek-ai/dsh-agent-omp/sessions
 */

import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'
import type {
  AgentHost,
  AgentId,
  AgentSession,
  AgentSessionKey,
  AgentSessionListOptions,
  HostDirEntry,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResolvedOmpConfig } from './config.ts'

/** Session file format version this reader supports. */
export const OMP_SESSION_VERSION = 3

/** Bytes of the fixed-width title slot at the head of a current session file. */
export const OMP_TITLE_SLOT_BYTES = 256

/** How many session directories a single scan will look at. */
const MAX_SCAN_DIRECTORIES = 200
/** Per-directory file cap, so one runaway project cannot starve the scan. */
const MAX_SCAN_FILES_PER_DIRECTORY = 400
/** Global file cap for one scan. */
const MAX_SCAN_FILES = 1_500
/** Cap on header probes during a by-id lookup, whose fast path is the file name. */
const MAX_HEADER_PROBES = 300
/** Bytes read to obtain the slot and header lines of a large session file. */
const HEADER_READ_BYTES = 64 * 1024
/** A file at or below this size is read whole; a larger one is read head + tail. */
export const OMP_SMALL_FILE_BYTES = 256 * 1024
/** Default byte window for one transcript read. */
export const OMP_DEFAULT_TRANSCRIPT_BYTES = 512 * 1024
/** Lower bound on a transcript window, so a caller cannot ask for an unusable read. */
const MIN_TRANSCRIPT_BYTES = 64 * 1024
/** Upper bound on a transcript window; the host caps reads too. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
/** Characters of a raw native entry retained for diagnostics. */
const MAX_RAW_CHARS = 4_000

/**
 * Render one projection note.
 *
 * The mesh session, transcript and task records carry `notes` as strings rather than
 * field-tagged records, so a native projection states which canonical field a gap belongs
 * to by prefixing the reason with it.
 *
 * @param field - Canonical field the gap belongs to, or `*` for a record-wide gap.
 * @param reason - What could not be carried, addressed to the reader.
 * @returns the note as the mesh records it.
 */
export function note(field: string, reason: string): string {
  return field === '*' ? reason : `${field}: ${reason}`
}

/** Where a machine keeps OMP's configuration, sessions and credential store. */
export interface OmpStoreLayout {
  /** Resolved agent config directory (`~/.omp/agent` or its profile/override form). */
  readonly agentDir: string
  /** Config root the agent directory hangs off (`~/.omp`, or `$HOME/$PI_CONFIG_DIR`). */
  readonly configRoot: string
  /** Active named profile, when one is selected. */
  readonly profile?: string
  /** Root holding one directory per project, plus any stray session files. */
  readonly defaultSessionsRoot: string
  /** Flat session directory in force, when the adapter or the host configured one. */
  readonly sessionDirOverride?: string
  /** Whether the override came from the adapter's own `sessionDir` setting. */
  readonly sessionsDirFromSetting: boolean
  /** Whether the agent directory came from an override rather than the default. */
  readonly agentDirFromEnv: boolean
  /** `agent.db`, OMP's SQLite store holding the credential rows. */
  readonly credentialPath: string
  /** `config.yml`, the primary settings file (else its `config.yaml` sibling). */
  readonly settingsPath: string
  /** `models.yml`, the primary provider/model file (else its `models.yaml` sibling). */
  readonly modelsPath: string
}

/** Everything the layout resolution reads: the host, the adapter configuration, the environment. */
export interface OmpStoreResolution {
  /** Host providing the home directory and the environment. */
  readonly host: AgentHost
  /** Resolved adapter configuration. */
  readonly config: ResolvedOmpConfig
  /** Environment to resolve from; defaults to the host's own. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Resolve the store layout from the adapter configuration, the environment and OMP's own
 * profile selection.
 *
 * Precedence mirrors OMP's `getAgentDir()`: the adapter's `homeDir`, then a named
 * profile's `<config-root>/profiles/<name>/agent` (which ignores `$PI_CODING_AGENT_DIR`),
 * then `$PI_CODING_AGENT_DIR`, then `<config-root>/agent` where the config root is
 * `$HOME/<PI_CONFIG_DIR || '.omp'>`. The session-directory override is the adapter
 * setting, then `$PI_CODING_AGENT_SESSION_DIR`; OMP has no settings key for it.
 *
 * @param resolution - Host, adapter configuration and environment.
 * @returns the resolved layout.
 */
export function resolveOmpStore(resolution: OmpStoreResolution): OmpStoreLayout {
  const { host, config } = resolution
  const env = resolution.env ?? host.env
  const profile = activeProfile(env)
  const configDirName = readEnv(env, 'PI_CONFIG_DIR') ?? '.omp'
  const configRoot = resolvePathValue(host, join(host.home, configDirName))
  const agentDirEnv = readEnv(env, 'PI_CODING_AGENT_DIR')
  const agentDirFromEnv = config.homeDir !== undefined || (profile === undefined && agentDirEnv !== undefined)
  const agentDir = resolvePathValue(
    host,
    config.homeDir ??
      (profile !== undefined ? join(configRoot, 'profiles', profile, 'agent') : agentDirEnv ?? join(configRoot, 'agent')),
  )
  const override = config.sessionDir ?? readEnv(env, 'PI_CODING_AGENT_SESSION_DIR')
  return {
    agentDir,
    configRoot,
    ...(profile === undefined ? {} : { profile }),
    defaultSessionsRoot: `${agentDir}/sessions`,
    ...(override === undefined ? {} : { sessionDirOverride: resolvePathValue(host, override) }),
    sessionsDirFromSetting: config.sessionDir !== undefined,
    agentDirFromEnv,
    credentialPath: `${agentDir}/agent.db`,
    settingsPath: `${agentDir}/config.yml`,
    modelsPath: `${agentDir}/models.yml`,
  }
}

/** A non-empty environment value, trimmed. */
function readEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Expand `~` and resolve a relative value, as the harness filesystem service does. */
function resolvePathValue(host: AgentHost, path: string): string {
  if (path === '~') return host.home
  if (path.startsWith('~/')) return join(host.home, path.slice(2))
  return isAbsolute(path) ? path : resolvePath(path)
}

/**
 * The named profile the environment selects, normalized as OMP does: `OMP_PROFILE` wins
 * over the legacy `PI_PROFILE`, and the explicit `default` sentinel selects the default
 * profile.
 *
 * @param env - Environment to read.
 * @returns the profile name, or `undefined` for the default profile.
 */
export function activeProfile(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = env['OMP_PROFILE'] !== undefined ? env['OMP_PROFILE'] : env['PI_PROFILE']
  const trimmed = raw?.trim()
  return trimmed === undefined || trimmed === '' || trimmed === 'default' ? undefined : trimmed
}

/**
 * Build the mesh-wide session key, `<agentId>:<nativeId>`.
 * @param agentId - Owning agent.
 * @param nativeId - The agent's own session identifier.
 * @returns the branded mesh key.
 */
export function sessionKey(agentId: AgentId, nativeId: string): AgentSessionKey {
  return brandString<AgentSessionKey>(`${agentId}:${nativeId}`)
}

// ---------------------------------------------------------------------------
// Native record narrowing. OMP's files are foreign JSON: every field is read
// through these guards, so a format change degrades a field, never a crash.
// ---------------------------------------------------------------------------

/**
 * Whether a decoded JSON value is a plain object.
 *
 * @param value - Value to test.
 * @returns `true` for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a string field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns the value, or `undefined` when absent or not a string.
 */
export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a finite number field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns the value, or `undefined` when absent or not a finite number.
 */
export function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read a boolean field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns the value, or `undefined` when absent or not a boolean.
 */
export function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Read an object field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns the nested object, or `undefined`.
 */
export function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key]
  return isRecord(value) ? value : undefined
}

/**
 * Read an array field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns the array, or `undefined`.
 */
export function readArray(source: Record<string, unknown>, key: string): readonly unknown[] | undefined {
  const value = source[key]
  return Array.isArray(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// Store records
// ---------------------------------------------------------------------------

/** The fixed-width current-title slot that physically heads a current session file. */
export interface OmpTitleSlot {
  /** Current session title, verbatim. */
  readonly title: string
  /** Who set it: `auto` (titler) or `user` (an explicit rename). */
  readonly source?: string
  /** ISO 8601 time the slot was last written. */
  readonly updatedAt?: string
}

/**
 * Parse the physical title slot.
 *
 * @param value - Decoded JSON of the first line.
 * @returns the slot, or `undefined` when the line is not the title slot.
 */
export function readOmpTitleSlot(value: unknown): OmpTitleSlot | undefined {
  if (!isRecord(value) || readString(value, 'type') !== 'title') return undefined
  const title = readString(value, 'title')
  if (title === undefined) return undefined
  const source = readString(value, 'source')
  const updatedAt = readString(value, 'updatedAt')
  return {
    title,
    ...(source === undefined ? {} : { source }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/** The logical first record of an OMP session file. */
export interface OmpSessionHeader {
  /** Session id, verbatim. */
  readonly id: string
  /** Creation time, verbatim ISO 8601. */
  readonly timestamp: string
  /** Absolute working directory the session was started in; empty on very old files. */
  readonly cwd: string
  /** Session title folded into the header by OMP's loaders, when it carries one. */
  readonly title?: string
  /** Who set the folded title. */
  readonly titleSource?: string
  /** Path or id of the session this one was forked from, when it was. */
  readonly parentSession?: string
  /** Native format version; absent on v1 files. */
  readonly version?: number
  /** Extra workspace roots beyond `cwd`, which `AgentSession` has no field for. */
  readonly additionalDirectories: number
  /** Previous absolute locations recorded by successful moves. */
  readonly previousSessionFiles: number
  /** Whether an inherited provider prompt-cache identity is recorded (a local-only field). */
  readonly hasProviderPromptCacheKey: boolean
}

/**
 * Parse a session header.
 *
 * @param value - Decoded JSON of the header line.
 * @returns the header, or `undefined` when the line is not a session header.
 */
export function readOmpSessionHeader(value: unknown): OmpSessionHeader | undefined {
  if (!isRecord(value) || readString(value, 'type') !== 'session') return undefined
  const id = readString(value, 'id')
  if (id === undefined || id === '') return undefined
  const timestamp = readString(value, 'timestamp')
  const cwd = readString(value, 'cwd')
  const version = readNumber(value, 'version')
  const parentSession = readString(value, 'parentSession')
  const title = readString(value, 'title')
  const titleSource = readString(value, 'titleSource')
  return {
    id,
    timestamp: timestamp ?? '',
    cwd: cwd ?? '',
    ...(version === undefined ? {} : { version: Math.trunc(version) }),
    ...(parentSession === undefined || parentSession === '' ? {} : { parentSession }),
    ...(title === undefined || title === '' ? {} : { title }),
    ...(titleSource === undefined || titleSource === '' ? {} : { titleSource }),
    additionalDirectories: (readArray(value, 'additionalDirectories') ?? []).length,
    previousSessionFiles: (readArray(value, 'previousSessionFiles') ?? []).length,
    hasProviderPromptCacheKey: readString(value, 'providerPromptCacheKey') !== undefined,
  }
}

/** One parsed session entry, in file order, with its bounded raw line. */
export interface OmpNativeEntry {
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
 *
 * @param value - Decoded JSON of a non-header line.
 * @param raw - The raw line, retained bounded for `unknown` projections.
 * @returns the entry, or `undefined` when the line is not an entry.
 */
export function readOmpEntry(value: unknown, raw: string): OmpNativeEntry | undefined {
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
export interface OmpSessionView {
  /** The physical title slot, when the read window contained it. */
  readonly titleSlot?: OmpTitleSlot
  /** Session header, when the read window contained it. */
  readonly header?: OmpSessionHeader
  /** Entries in the read window, in file order. */
  readonly entries: readonly OmpNativeEntry[]
  /** Whether earlier file content was outside the window. */
  readonly windowTruncated: boolean
  /** Whether the window dropped a leading partial line. */
  readonly droppedPartialLine: boolean
  /** File size at read time, or `-1` when absent. */
  readonly size: number
  /** File modification time in milliseconds. */
  readonly mtimeMs: number
  /** JSON lines in the window that did not parse as the slot, the header or an entry. */
  readonly malformed: number
  /** Whether the file was absent. */
  readonly missing: boolean
  /** Declared gaps produced while reading. */
  readonly notes: readonly string[]
}

interface WindowAccumulator {
  titleSlot: OmpTitleSlot | undefined
  header: OmpSessionHeader | undefined
  sawFirstLine: boolean
  entries: OmpNativeEntry[]
  malformed: number
}

/**
 * Read a bounded view of one session file: the whole file when it is small, else the
 * slot/header lines plus a tail window. Read-only, and capped so a large session is never
 * read into memory whole.
 *
 * @param host - Host providing the reads.
 * @param path - Absolute session file path.
 * @param maxBytes - Desired window size.
 * @returns the view; `missing: true` when the file is gone.
 */
export async function readOmpSessionView(host: AgentHost, path: string, maxBytes: number): Promise<OmpSessionView> {
  const cap = Math.max(MIN_TRANSCRIPT_BYTES, Math.min(maxBytes, MAX_TRANSCRIPT_BYTES))
  const fingerprint = await host.stat(path)
  if (fingerprint === undefined) return missingView(-1, 0)

  const notes: string[] = []
  const accumulator: WindowAccumulator = {
    titleSlot: undefined,
    header: undefined,
    sawFirstLine: false,
    entries: [],
    malformed: 0,
  }
  let windowTruncated: boolean
  let droppedPartialLine = false

  if (fingerprint.size <= cap) {
    const whole = await host.readHead(path, Math.max(1, fingerprint.size))
    if (whole === '') return missingView(fingerprint.size, fingerprint.mtimeMs)
    windowTruncated = false
    accumulateLines(whole, accumulator)
  } else {
    // The slot and header head the file, and the fold window is the tail. Reading the
    // head first keeps the slot and the authoritative cwd available for a huge session.
    const head = await host.readHead(path, HEADER_READ_BYTES)
    const lead = completeLeadLines(head, 2)
    if (lead.length < 2) {
      notes.push(
        note(
          'cwd',
          `the title slot and session header did not both fit in ${String(HEADER_READ_BYTES)} bytes, so the cwd is unavailable`,
        ),
      )
    }
    accumulateLines(lead.join('\n'), accumulator)
    const tail = await host.readTail(path, cap)
    // Both reads are empty only when the file went away between the stat and the reads.
    if (head === '' && tail.text === '') return missingView(fingerprint.size, fingerprint.mtimeMs)
    droppedPartialLine = tail.droppedPartialLine
    windowTruncated = true
    // The tail starts on a record boundary and never holds the slot or the header, so its
    // first line is an entry: the accumulator is advanced past its lead phase.
    accumulator.sawFirstLine = true
    for (const line of tail.text.split('\n')) {
      if (line.trim() === '') continue
      const parsed = parseJsonLine(line)
      if (!parsed.ok) {
        accumulator.malformed += 1
        continue
      }
      const entry = readOmpEntry(parsed.value, line)
      if (entry === undefined) accumulator.malformed += 1
      else accumulator.entries.push(entry)
    }
  }

  return {
    ...(accumulator.titleSlot === undefined ? {} : { titleSlot: accumulator.titleSlot }),
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
 * Read only the slot and header of a session file, for by-id lookups and resume checks.
 *
 * @param host - Host providing the read.
 * @param path - Absolute session file path.
 * @returns the slot and header, each absent when its line is missing or unreadable.
 */
export async function readOmpSessionLeadAt(
  host: AgentHost,
  path: string,
): Promise<{ readonly titleSlot?: OmpTitleSlot; readonly header?: OmpSessionHeader }> {
  const head = await host.readHead(path, HEADER_READ_BYTES)
  if (head === '') return {}
  const accumulator: WindowAccumulator = {
    titleSlot: undefined,
    header: undefined,
    sawFirstLine: false,
    entries: [],
    malformed: 0,
  }
  accumulateLines(completeLeadLines(head, 2).join('\n'), accumulator)
  return {
    ...(accumulator.titleSlot === undefined ? {} : { titleSlot: accumulator.titleSlot }),
    ...(accumulator.header === undefined ? {} : { header: accumulator.header }),
  }
}

/**
 * Read only the header of a session file, for by-id lookups and resume checks.
 *
 * @param host - Host providing the read.
 * @param path - Absolute session file path.
 * @returns the header, or `undefined` when no complete header line was read.
 */
export async function readOmpSessionHeaderAt(host: AgentHost, path: string): Promise<OmpSessionHeader | undefined> {
  return (await readOmpSessionLeadAt(host, path)).header
}

/** The view of a file the host could not read at all. */
function missingView(size: number, mtimeMs: number): OmpSessionView {
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

/** Parse a block of JSONL text whose leading lines are the title slot and the header. */
function accumulateLines(text: string, accumulator: WindowAccumulator): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      accumulator.malformed += 1
      continue
    }
    if (!accumulator.sawFirstLine) {
      accumulator.sawFirstLine = true
      const slot = readOmpTitleSlot(parsed.value)
      if (slot !== undefined) {
        accumulator.titleSlot = slot
        // The slot is not the logical first entry: the header still follows it.
        accumulator.sawFirstLine = false
        continue
      }
      const header = readOmpSessionHeader(parsed.value)
      if (header === undefined) {
        accumulator.malformed += 1
        continue
      }
      accumulator.header = header
      continue
    }
    const entry = readOmpEntry(parsed.value, line)
    if (entry === undefined) accumulator.malformed += 1
    else accumulator.entries.push(entry)
  }
}

/** Parse one nonblank line as JSON. */
function parseJsonLine(line: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const trimmed = line.trim()
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    return { ok: false }
  }
}

/**
 * The first `count` complete lines of a text window, in order.
 *
 * @param text - Text that may end mid-line.
 * @param count - How many lines to collect.
 * @returns the lines without their terminators; fewer when the text holds fewer.
 */
function completeLeadLines(text: string, count: number): readonly string[] {
  const lines: string[] = []
  let start = 0
  while (lines.length < count) {
    const newline = text.indexOf('\n', start)
    if (newline === -1) break
    lines.push(text.slice(start, newline))
    start = newline + 1
  }
  return lines
}

// ---------------------------------------------------------------------------
// Directory-name encoding
// ---------------------------------------------------------------------------

/**
 * OMP's session bucket name for an absolute cwd.
 *
 * A cwd under home is `-<relative>`, one under the temp root is `-tmp-<relative>`, and
 * anything else is `--<encoded-absolute>--`, with path separators (and a Windows drive
 * colon) replaced by `-`.
 *
 * @param cwd - Working directory; resolved first.
 * @param options - Home and temp roots to classify against; default to this process's.
 * @returns the directory name, e.g. `--Volumes-Net-Repo--`.
 */
export function encodeCwdDirName(cwd: string, options: { readonly home?: string; readonly tempRoot?: string } = {}): string {
  const resolved = resolvePath(cwd)
  const home = resolvePath(options.home ?? process.env['HOME'] ?? '')
  const tempRoot = resolvePath(options.tempRoot ?? tmpdir())
  const homeRelative = relativeWithin(home, resolved)
  const tempRelative = relativeWithin(tempRoot, resolved)
  if (tempRelative !== undefined) return `-tmp-${tempRelative.replace(/[/\\:]/g, '-')}`
  if (homeRelative !== undefined) return `-${homeRelative.replace(/[/\\:]/g, '-')}`
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/** The path of `target` relative to `root`, when it is at or inside `root`. */
function relativeWithin(root: string, target: string): string | undefined {
  if (target === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : undefined
}

/**
 * Best-effort decode of a session bucket name.
 *
 * The encoding is lossy: a real `-` in a path is indistinguishable from a separator, a
 * Windows drive colon is flattened, and `-tmp-<x>` is also the home-relative name of
 * `home/tmp/x`. This is only ever a hint — the header's own `cwd` is authoritative.
 *
 * @param name - Directory entry name.
 * @param options - Home and temp roots to decode against; default to this process's.
 * @returns the candidate absolute path, or `undefined` when the name is not encoded.
 */
export function decodeCwdDirName(name: string, options: { readonly home?: string; readonly tempRoot?: string } = {}): string | undefined {
  if (name.length < 2) return undefined
  if (name.startsWith('--') && name.endsWith('--')) {
    const inner = name.slice(2, -2)
    return inner === '' ? undefined : `/${inner.replace(/-/g, '/')}`
  }
  if (!name.startsWith('-')) return undefined
  const home = resolvePath(options.home ?? process.env['HOME'] ?? '')
  const tempRoot = resolvePath(options.tempRoot ?? tmpdir())
  if (name.startsWith('-tmp-')) {
    const inner = name.slice('-tmp-'.length)
    return inner === '' ? undefined : `${tempRoot}/${inner.replace(/-/g, '/')}`
  }
  const inner = name.slice(1)
  return `${home}/${inner.replace(/-/g, '/')}`
}

// ---------------------------------------------------------------------------
// Folding and branch walking
// ---------------------------------------------------------------------------

/** Entry types this reader models, directly or as declared state. */
const KNOWN_ENTRY_TYPES: readonly string[] = [
  'message',
  'model_usage',
  'thinking_level_change',
  'model_change',
  'service_tier_change',
  'compaction',
  'branch_summary',
  'reset_boundary',
  'custom',
  'custom_message',
  'label',
  'title_change',
  'ttsr_injection',
  'credential_pin',
  'session_init',
  'mode_change',
]

/** Mode names OMP records that mean plan mode is on. */
export const OMP_PLAN_MODES: readonly string[] = ['plan', 'plan_paused']

/** A session's state as folded from one read window. */
export interface OmpSessionFold {
  /** Latest title: a `title_change` on the live branch, else the folded header title. */
  readonly title?: string
  /** Latest `model_change` on the live branch, else the last assistant message's `provider/model`. */
  readonly model?: string
  /** Totals summed over the window (assistant message usage and `model_usage` entries). */
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cachedInputTokens?: number
    readonly reasoningTokens?: number
    readonly totalTokens?: number
    readonly costUsd?: number
  }
  /** `message` entries seen in the window. */
  readonly messageCount: number
  /** Latest user/assistant message time in the window, ISO 8601. */
  readonly lastMessageAt?: string
  /** Latest `mode_change` mode name on the live branch, verbatim (`none` means no mode is active). */
  readonly mode?: string
  /** Plan file path recorded alongside a plan-mode transition on the live branch. */
  readonly planFilePath?: string
  /** Image blocks in the window, which the canonical projection has no field for. */
  readonly images: number
  /** `model_usage` entries in the window (out-of-transcript accounting). */
  readonly modelUsageEntries: number
  /** `session_init` entries in the window (subagent bootstrap records). */
  readonly sessionInitEntries: number
  /** `reset_boundary` entries in the window. */
  readonly resetBoundaries: number
  /** `compaction` entries in the window. */
  readonly compactions: number
  /** `ttsr_injection` entries in the window. */
  readonly ttsrInjections: number
  /** `credential_pin` entries in the window (pseudonymous account pins). */
  readonly credentialPins: number
  /** Cache-write tokens seen, which the mesh usage type cannot carry. */
  readonly cacheWriteTokens: number
  /** Entry types in the window this reader does not model, distinct, at most a handful. */
  readonly unknownEntryTypes: readonly string[]
}

/** Mutable running usage totals, before they are projected. */
interface MutableUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  costUsd?: number
}

/** The fold under construction, before it is returned as an {@link OmpSessionFold}. */
interface MutableFold {
  title?: string
  model?: string
  usage?: OmpSessionFold['usage']
  messageCount: number
  lastMessageAt?: string
  mode?: string
  planFilePath?: string
  images: number
  modelUsageEntries: number
  sessionInitEntries: number
  resetBoundaries: number
  compactions: number
  ttsrInjections: number
  credentialPins: number
  cacheWriteTokens: number
  unknownEntryTypes: string[]
}

/**
 * Fold a read window into session state.
 *
 * The counters describe the file that was read, so every entry in the window contributes:
 * an abandoned branch's messages still count, and a late `model_usage` marker still adds
 * its totals. The state fields (`title`, `model`, `mode`, `planFilePath`) describe the
 * conversation that continues, so only entries on the live branch chain commit them.
 *
 * @param entries - Entries in the read window, in file order.
 * @param header - The header, when the window held it.
 * @param chain - The live branch whose entries commit the state fields; defaults to `entries`.
 * @returns the folded state.
 */
export function foldOmpEntries(
  entries: readonly OmpNativeEntry[],
  header?: OmpSessionHeader,
  chain: readonly OmpNativeEntry[] = entries,
): OmpSessionFold {
  const fold: MutableFold = {
    messageCount: 0,
    images: 0,
    modelUsageEntries: 0,
    sessionInitEntries: 0,
    resetBoundaries: 0,
    compactions: 0,
    ttsrInjections: 0,
    credentialPins: 0,
    cacheWriteTokens: 0,
    unknownEntryTypes: [],
  }
  if (header?.title !== undefined) fold.title = header.title
  const branchIds = new Set<string>()
  for (const entry of chain) branchIds.add(entry.id)
  const totals: MutableUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  const unknown: string[] = []
  let sawUsage = false

  for (const entry of entries) {
    const onLiveBranch = branchIds.has(entry.id)
    switch (entry.type) {
      case 'message': {
        fold.messageCount += 1
        const message = readRecord(entry.record, 'message')
        if (message === undefined) break
        const activity = messageActivity(message, entry.timestamp)
        if (activity !== undefined && (fold.lastMessageAt === undefined || activity > fold.lastMessageAt)) {
          fold.lastMessageAt = activity
        }
        fold.images += countImages(message)
        if (readString(message, 'role') !== 'assistant') break
        const usage = readRecord(message, 'usage')
        if (usage !== undefined) {
          sawUsage = true
          addUsage(totals, usage)
        }
        if (!onLiveBranch) break
        // OMP records the provider and the bare model id separately on a message; the
        // `provider/model` selector is the form `--model` accepts.
        const model = readString(message, 'model')
        if (model !== undefined && model !== '') {
          const provider = readString(message, 'provider')
          fold.model = provider === undefined || provider === '' ? model : `${provider}/${model}`
        }
        break
      }
      case 'model_usage': {
        fold.modelUsageEntries += 1
        const usage = readRecord(entry.record, 'usage')
        if (usage !== undefined) {
          sawUsage = true
          addUsage(totals, usage)
        }
        break
      }
      case 'model_change': {
        if (!onLiveBranch) break
        // OMP records the selector verbatim as `provider/modelId`.
        const model = readString(entry.record, 'model')
        if (model !== undefined && model !== '') fold.model = model
        break
      }
      case 'title_change': {
        if (!onLiveBranch) break
        const title = readString(entry.record, 'title')
        if (title !== undefined) {
          const trimmed = title.trim()
          if (trimmed === '') delete fold.title
          else fold.title = trimmed
        }
        break
      }
      case 'mode_change': {
        if (!onLiveBranch) break
        const mode = readString(entry.record, 'mode')
        if (mode !== undefined && mode !== '') fold.mode = mode
        const data = readRecord(entry.record, 'data')
        const planFilePath = data === undefined ? undefined : readString(data, 'planFilePath')
        if (planFilePath !== undefined && planFilePath !== '') fold.planFilePath = planFilePath
        break
      }
      case 'session_init':
        fold.sessionInitEntries += 1
        break
      case 'reset_boundary':
        fold.resetBoundaries += 1
        break
      case 'compaction':
        fold.compactions += 1
        break
      case 'ttsr_injection':
        fold.ttsrInjections += 1
        break
      case 'credential_pin':
        fold.credentialPins += 1
        break
      default:
        // A format revision must degrade into a visible gap, not a silent drop.
        if (!KNOWN_ENTRY_TYPES.includes(entry.type) && !unknown.includes(entry.type)) unknown.push(entry.type)
        break
    }
  }

  fold.unknownEntryTypes = unknown
  fold.cacheWriteTokens = totals.cacheWrite
  if (sawUsage) {
    fold.usage = {
      inputTokens: totals.input,
      outputTokens: totals.output,
      cachedInputTokens: totals.cacheRead,
      ...(totals.reasoning === undefined ? {} : { reasoningTokens: totals.reasoning }),
      totalTokens: totals.totalTokens,
      ...(totals.costUsd === undefined ? {} : { costUsd: totals.costUsd }),
    }
  }
  return {
    ...(fold.title === undefined ? {} : { title: fold.title }),
    ...(fold.model === undefined ? {} : { model: fold.model }),
    ...(fold.usage === undefined ? {} : { usage: fold.usage }),
    messageCount: fold.messageCount,
    ...(fold.lastMessageAt === undefined ? {} : { lastMessageAt: fold.lastMessageAt }),
    ...(fold.mode === undefined ? {} : { mode: fold.mode }),
    ...(fold.planFilePath === undefined ? {} : { planFilePath: fold.planFilePath }),
    images: fold.images,
    modelUsageEntries: fold.modelUsageEntries,
    sessionInitEntries: fold.sessionInitEntries,
    resetBoundaries: fold.resetBoundaries,
    compactions: fold.compactions,
    ttsrInjections: fold.ttsrInjections,
    credentialPins: fold.credentialPins,
    cacheWriteTokens: fold.cacheWriteTokens,
    unknownEntryTypes: fold.unknownEntryTypes,
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
  const reasoning = readNumber(usage, 'reasoningTokens')
  if (reasoning !== undefined) totals.reasoning = (totals.reasoning ?? 0) + reasoning
  if (costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + costUsd
}

/** The ISO 8601 activity time of a message record. */
function messageActivity(message: Record<string, unknown>, fallback: string): string | undefined {
  const role = readString(message, 'role')
  if (role !== 'user' && role !== 'assistant') return undefined
  const native = readNumber(message, 'timestamp')
  if (native !== undefined) return new Date(native).toISOString()
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

/**
 * An ISO 8601 time for a native timestamp string, when it is parseable.
 * @param value - Native timestamp, possibly absent or empty.
 * @returns the normalized ISO 8601 time, or `undefined` when it cannot be parsed.
 */
export function isoOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

/** The live conversation of a session file. */
export interface OmpBranch {
  /** Entries on the branch that ends at the live leaf, in conversation order. */
  readonly chain: readonly OmpNativeEntry[]
  /** Entries in the window that belong to abandoned branches. */
  readonly abandoned: number
  /** Whether the chain start is outside the read window or a parent link is missing. */
  readonly truncated: boolean
}

/**
 * Walk `parentId` links from the live leaf to produce the live branch.
 *
 * The store is append-only, so the last line is where the next entry attaches — with one
 * recorded exception: a late `model_usage` entry names the leaf that was active when the
 * usage arrived (`activeLeafId`), and OMP replays that captured leaf rather than the
 * marker itself. Everything reachable from the resolved leaf is the conversation;
 * everything else is an abandoned branch.
 *
 * @param view - A read window.
 * @returns the chain, the abandoned count, and whether the chain start is unknown.
 */
export function ompBranch(view: OmpSessionView): OmpBranch {
  const byId = new Map<string, OmpNativeEntry>()
  for (const entry of view.entries) byId.set(entry.id, entry)
  const last = view.entries[view.entries.length - 1]
  if (last === undefined) return { chain: [], abandoned: 0, truncated: view.windowTruncated }
  const leaf = leafEntry(last, byId)

  const chain: OmpNativeEntry[] = []
  const visited = new Set<string>()
  let cursor: OmpNativeEntry | undefined = leaf
  while (cursor !== undefined) {
    // A corrupt file could contain a cycle; a bounded walk is the one safe answer.
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

/** The leaf a late `model_usage` marker selects, when it names one that is present. */
function leafEntry(last: OmpNativeEntry, byId: ReadonlyMap<string, OmpNativeEntry>): OmpNativeEntry {
  if (last.type !== 'model_usage') return last
  const activeLeafId = last.record['activeLeafId']
  if (typeof activeLeafId !== 'string' || activeLeafId === '') return last
  return byId.get(activeLeafId) ?? last
}

// ---------------------------------------------------------------------------
// Discovery and reading
// ---------------------------------------------------------------------------

/** One directory level of an OMP store: session files and/or project buckets. */
interface ScanRoot {
  /** Directory to read. */
  readonly path: string
}

/** The roots a scan reads: the override directory first, then OMP's default root. */
function scanRoots(layout: OmpStoreLayout): readonly ScanRoot[] {
  const roots: ScanRoot[] = []
  if (layout.sessionDirOverride !== undefined) {
    // An override holds session files for every project; it is read for subdirectories
    // too, because an override may point at an otherwise default-shaped root.
    roots.push({ path: layout.sessionDirOverride })
  }
  // A dedupe guard: an override that names the default root must not double-scan it.
  if (layout.sessionDirOverride !== layout.defaultSessionsRoot) {
    roots.push({ path: layout.defaultSessionsRoot })
  }
  return roots
}

/**
 * Directory entries by descending modification time, with the name breaking ties.
 *
 * The scan caps keep the *most recent* directories and files, so the order the caps
 * consume must be recency, which the host reports per entry.
 *
 * @param entries - Entries as the host listed them.
 * @returns a copy ordered newest first.
 */
function byRecency(entries: readonly HostDirEntry[]): readonly HostDirEntry[] {
  return [...entries].sort((a, b) => (b.mtimeMs === a.mtimeMs ? a.name.localeCompare(b.name) : b.mtimeMs - a.mtimeMs))
}

/** Everything a session listing needs. */
export interface OmpSessionScan {
  /** Host providing the filesystem and the environment. */
  readonly host: AgentHost
  /** Owning agent id, stamped on every session. */
  readonly agentId: AgentId
  /** Resolved store layout. */
  readonly layout: OmpStoreLayout
  /** Caller options: cwd filter, limit and abort signal. */
  readonly options: AgentSessionListOptions
}

/**
 * Enumerate OMP's sessions.
 *
 * The directory name is only a hint: the header's own `cwd` is authoritative, so a
 * disagreement (or an unreadable header) is declared as a projection note rather than
 * silently resolving to the lossy decode. The scan is bounded by the ported caps (200
 * directories, 400 files per directory, 1500 files), whose notes state what was skipped.
 *
 * @param scan - Host, layout and caller options.
 * @returns sessions, newest first, bounded by the scan caps.
 */
export async function listOmpSessions(scan: OmpSessionScan): Promise<readonly AgentSession[]> {
  const limit = scan.options.limit === undefined || scan.options.limit <= 0 ? Number.POSITIVE_INFINITY : scan.options.limit
  const wantedCwd = scan.options.cwd === undefined ? undefined : resolvePath(scan.options.cwd)
  const sessions: AgentSession[] = []
  const scanNotes: string[] = []
  let filesSeen = 0
  let directoriesSeen = 0
  let scanStopped = false

  for (const root of scanRoots(scan.layout)) {
    if (scanStopped || sessions.length >= limit) break
    const entries = await scan.host.listDir(root.path)
    for (const entry of byRecency(entries)) {
      if (aborted(scan.options.signal) || sessions.length >= limit) break
      if (entry.isDirectory) continue
      if (!isSessionFileName(entry.name)) continue
      if (filesSeen >= MAX_SCAN_FILES) {
        scanNotes.push(note('sessions', `the scan stopped after ${String(MAX_SCAN_FILES)} session files`))
        scanStopped = true
        break
      }
      filesSeen += 1
      // A file directly in the root has no directory-name hint for its cwd.
      const session = await projectSession(scan, undefined, join(root.path, entry.name), entry.mtimeMs, wantedCwd)
      if (session !== undefined) sessions.push(session)
    }
    if (scanStopped) continue
    for (const directory of byRecency(entries)) {
      if (scanStopped || aborted(scan.options.signal) || sessions.length >= limit) break
      if (!directory.isDirectory) continue
      if (directoriesSeen >= MAX_SCAN_DIRECTORIES) {
        scanNotes.push(
          note(
            'sessions',
            `only the ${String(MAX_SCAN_DIRECTORIES)} most recently touched session directories were scanned`,
          ),
        )
        scanStopped = true
        break
      }
      if (filesSeen >= MAX_SCAN_FILES) {
        scanNotes.push(note('sessions', `the scan stopped after ${String(MAX_SCAN_FILES)} session files`))
        scanStopped = true
        break
      }
      directoriesSeen += 1
      const directoryPath = join(root.path, directory.name)
      const files = (await scan.host.listDir(directoryPath)).filter(
        file => !file.isDirectory && isSessionFileName(file.name),
      )
      let filesHere = 0
      for (const file of byRecency(files)) {
        if (aborted(scan.options.signal) || sessions.length >= limit) break
        if (filesSeen >= MAX_SCAN_FILES) {
          scanNotes.push(note('sessions', `the scan stopped after ${String(MAX_SCAN_FILES)} session files`))
          scanStopped = true
          break
        }
        if (filesHere >= MAX_SCAN_FILES_PER_DIRECTORY) {
          scanNotes.push(
            note(
              'sessions',
              `only the ${String(MAX_SCAN_FILES_PER_DIRECTORY)} most recent files of ${directory.name} were scanned`,
            ),
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
  if (scanNotes.length === 0) return sessions
  return sessions.map((session, index) =>
    index === 0 ? { ...session, notes: [...session.notes, ...scanNotes] } : session,
  )
}

/**
 * Whether a caller's signal asked to stop.
 *
 * @param signal - Caller signal, when one was supplied.
 * @returns `true` only once the signal has aborted.
 */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/** Project one session file onto `AgentSession`. */
async function projectSession(
  scan: OmpSessionScan,
  directoryName: string | undefined,
  path: string,
  mtimeMs: number,
  wantedCwd: string | undefined,
): Promise<AgentSession | undefined> {
  const view = await readOmpSessionView(scan.host, path, OMP_SMALL_FILE_BYTES)
  if (view.missing) return undefined
  const notes: string[] = [...view.notes]
  const decoded = directoryName === undefined ? undefined : decodeCwdDirName(directoryName, { home: scan.host.home })
  const mtimeIso = new Date(mtimeMs).toISOString()
  const header = view.header

  if (header === undefined) {
    const derivedId = idFromFileName(fileName(path))
    if (derivedId === undefined) {
      scan.host.log('info', `skipping a session file with no readable header and no id in its name: ${path}`)
      return undefined
    }
    notes.push(
      note('*', 'the session header was unreadable; the id came from the file name and no metadata is available'),
      note('createdAt', 'the session header was unreadable, so the file modification time stands in'),
    )
    return {
      key: sessionKey(scan.agentId, derivedId),
      agentId: scan.agentId,
      nativeId: derivedId,
      nativePath: path,
      status: 'unreadable',
      ...(view.titleSlot === undefined || view.titleSlot.title === ''
        ? {}
        : { title: view.titleSlot.title, titleIsNative: true }),
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
          `omp would name this session's directory ${encodeCwdDirName(headerCwd, { home: scan.host.home })}, so the path ` +
          'likely contains a real dash or a flattened drive colon',
      ),
    )
  } else if (headerCwd === undefined && decoded !== undefined) {
    notes.push(note('cwd', 'taken from the lossy directory-name encoding; the header recorded no cwd'))
  }
  if (wantedCwd !== undefined && headerCwd !== undefined && resolvePath(headerCwd) !== wantedCwd) return undefined
  if (header.additionalDirectories > 0) {
    notes.push(
      note('cwd', `${String(header.additionalDirectories)} additional workspace directories are recorded; AgentSession has one cwd`),
    )
  }
  if (header.previousSessionFiles > 0) {
    notes.push(
      note(
        'nativePath',
        `${String(header.previousSessionFiles)} previous session file locations are recorded by successful session moves`,
      ),
    )
  }
  if (header.hasProviderPromptCacheKey) {
    notes.push(
      note('*', 'the header carries a local-only provider prompt-cache identity, which is never read into a projection'),
    )
  }
  if (header.version !== undefined && header.version < OMP_SESSION_VERSION) {
    notes.push(
      note('*', `the file is session format v${String(header.version)}; this reader was ported against v${String(OMP_SESSION_VERSION)}`),
    )
  }

  const branch = ompBranch(view)
  const fold = foldOmpEntries(view.entries, header, branch.chain)
  const title = titleOf(view, fold)
  if (view.windowTruncated) {
    notes.push(
      note('usage', 'the file exceeded the read window; counts and usage cover only the live branch inside that window'),
    )
  }
  if (branch.abandoned > 0) {
    notes.push(
      note('messages', `${String(branch.abandoned)} entries on abandoned branches are excluded from the linear reading`),
    )
  }
  if (fold.resetBoundaries > 0) {
    notes.push(
      note(
        'messages',
        `${String(fold.resetBoundaries)} /clear reset boundaries are recorded but not applied: the transcript shows ` +
          'the branch as recorded, not the collapsed live view',
      ),
    )
  }
  if (fold.cacheWriteTokens > 0) {
    notes.push(note('usage', 'cache-write tokens are recorded by omp but have no canonical field'))
  }
  if (view.malformed > 0) {
    notes.push(note('*', `${String(view.malformed)} lines in the read window did not parse`))
  }
  if (fold.images > 0) {
    notes.push(
      note(
        'messages',
        `${String(fold.images)} image blocks have no canonical field and are not represented in this summary`,
      ),
    )
  }
  if (fold.modelUsageEntries > 0) {
    notes.push(
      note(
        'usage',
        `${String(fold.modelUsageEntries)} model_usage entries count out-of-transcript model calls in the totals`,
      ),
    )
  }
  if (fold.sessionInitEntries > 0) {
    notes.push(
      note(
        'messages',
        `${String(fold.sessionInitEntries)} session_init entries describe a subagent's bootstrap and carry no message`,
      ),
    )
  }
  if (fold.ttsrInjections > 0) {
    notes.push(
      note('messages', `${String(fold.ttsrInjections)} ttsr_injection entries record which time-traveling rules were injected`),
    )
  }
  if (fold.credentialPins > 0) {
    notes.push(
      note(
        '*',
        `${String(fold.credentialPins)} credential_pin entries are pseudonymous account hashes; they are counted, never read`,
      ),
    )
  }
  if (fold.unknownEntryTypes.length > 0) {
    notes.push(
      note('messages', `entry types this adapter does not model were left out: ${fold.unknownEntryTypes.join(', ')}`),
    )
  }

  const parentId = header.parentSession === undefined ? undefined : idFromSessionReference(header.parentSession)
  return {
    key: sessionKey(scan.agentId, header.id),
    agentId: scan.agentId,
    nativeId: header.id,
    nativePath: path,
    ...(title === undefined ? {} : { title, titleIsNative: true }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(fold.model === undefined ? {} : { model: fold.model }),
    createdAt: isoOrUndefined(header.timestamp) ?? mtimeIso,
    updatedAt: fold.lastMessageAt ?? isoOrUndefined(header.timestamp) ?? mtimeIso,
    status: 'idle',
    ...(view.windowTruncated ? {} : { messageCount: fold.messageCount }),
    ...(parentId === undefined ? {} : { parentNativeId: parentId }),
    source: header.parentSession === undefined ? 'omp' : 'omp:fork',
    notes,
  }
}

/**
 * The title a session file records: the fixed-width slot is the current title and wins
 * over the entries; a `title_change` inside the window is the audit trail, and the
 * header's folded title is the fallback (a rename updates the slot without rewriting the
 * body, so the slot is the authoritative copy).
 *
 * @param view - A read window.
 * @param fold - Its folded state.
 * @returns the title, or `undefined` when the session has none.
 */
function titleOf(view: OmpSessionView, fold: OmpSessionFold): string | undefined {
  const slot = view.titleSlot
  if (slot !== undefined && slot.title.trim() !== '') return slot.title.trim()
  return fold.title
}

/** Whether a file name is an OMP session file. */
function isSessionFileName(name: string): boolean {
  return name.endsWith('.jsonl')
}

/** The last path segment of a path, treating a backslash as a separator too. */
function fileName(path: string): string {
  return path.includes('\\') ? basename(path.replace(/\\/g, '/')) : basename(path)
}

/** The session id encoded in a session file name, when the convention holds. */
function idFromFileName(name: string): string | undefined {
  const stem = name.slice(0, -'.jsonl'.length)
  const separator = stem.lastIndexOf('_')
  if (separator <= 0 || separator === stem.length - 1) return undefined
  return stem.slice(separator + 1)
}

/** The session id behind a header `parentSession` value, when it can be recovered. */
function idFromSessionReference(reference: string): string | undefined {
  const lastSegment = reference.split(/[/\\]/).slice(-1).join('')
  if (lastSegment === '') return undefined
  if (!isSessionFileName(lastSegment)) return reference
  return idFromFileName(lastSegment) ?? reference
}

/**
 * Locate a session file for a native id, or for a path given verbatim.
 *
 * There is no session index in this adapter's reach — `history.db`'s `session_titles`
 * table is a title index, not a path index, and `agent.db` is the credential store — so
 * this is a bounded directory scan: first by the `<timestamp>_<id>.jsonl` file-name
 * convention (cheap and exact), then by probing headers when the name convention does
 * not match.
 *
 * @param host - Host providing the filesystem.
 * @param layout - Resolved store layout.
 * @param nativeId - Session id or file path.
 * @returns the absolute path, or `undefined` when no file matches.
 */
export async function findOmpSessionFile(
  host: AgentHost,
  layout: OmpStoreLayout,
  nativeId: string,
): Promise<string | undefined> {
  const raw = nativeId.trim()
  if (raw === '') return undefined
  if (raw.includes('/') || raw.includes('\\') || raw.endsWith('.jsonl')) {
    const candidate = resolvePathValue(host, raw)
    const stat = await host.stat(candidate)
    return stat !== undefined && !stat.isDirectory ? candidate : undefined
  }

  let probes = 0
  let visitedDirectories = 0
  let fallback: string | undefined
  const candidates: { readonly path: string; readonly namedMatch: boolean }[] = []

  for (const root of scanRoots(layout)) {
    const entries = await host.listDir(root.path)
    for (const entry of entries) {
      if (!entry.isDirectory && isSessionFileName(entry.name)) {
        candidates.push({ path: join(root.path, entry.name), namedMatch: idFromFileName(entry.name) === raw })
      }
    }
    for (const directory of byRecency(entries)) {
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
    const header = await readOmpSessionHeaderAt(host, candidate.path)
    if (header?.id !== raw) continue
    if (candidate.namedMatch) return candidate.path
    if (fallback === undefined) fallback = candidate.path
  }
  if (fallback === undefined && probes >= MAX_HEADER_PROBES) {
    host.log('info', `the by-id session lookup stopped at its header probe cap: ${raw}`)
  }
  return fallback
}
