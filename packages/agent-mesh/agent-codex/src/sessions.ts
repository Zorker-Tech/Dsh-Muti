/**
 * Codex home resolution and read-only session discovery.
 *
 * Everything here reads `$CODEX_HOME` in place: rollouts are bounded reads, nothing is
 * ever written, and a file that cannot be parsed becomes a declared gap
 * (`status: 'unreadable'`, or a note) instead of an exception. Listing reads only the
 * head of each rollout because the store is append-only and the first line,
 * `session_meta`, is authoritative.
 * @module @deepseek-ai/dsh-agent-codex/sessions
 */

import { isAbsolute, join } from 'node:path'
import type { AgentId, AgentSession, AgentSessionKey, AgentSessionListOptions } from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expandUserPath } from './detect.ts'
import type { CodexHost } from './types.ts'
import { asRecord, parseJsonLine, str } from './json.ts'
import { note } from './notes.ts'

/** Environment variable that relocates Codex's home directory. */
export const CODEX_HOME_ENV = 'CODEX_HOME'

/** Active rollout root, under `$CODEX_HOME`. */
export const CODEX_SESSIONS_DIR = 'sessions'

/** Archived rollout root, under `$CODEX_HOME`. */
export const CODEX_ARCHIVED_SESSIONS_DIR = 'archived_sessions'

/** Append-only thread-title index, under `$CODEX_HOME`. */
export const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

/** Credential file, under `$CODEX_HOME`; only its path is ever reported. */
export const CODEX_CREDENTIAL_FILE = 'auth.json'

/** Home directory used when `$CODEX_HOME` is absent or unusable. */
export const CODEX_DEFAULT_HOME_DIR = '.codex'

/** Bytes read from a rollout head when listing sessions. */
export const SESSION_HEAD_BYTES = 64 * 1024

/** Bytes read from `session_index.jsonl` when folding titles. */
const SESSION_INDEX_MAX_BYTES = 4 * 1024 * 1024

/** Directory levels visited below each session root. */
const ROLLOUT_MAX_DEPTH = 4

/** Rollout files collected per root, bounding a listing scan. */
const ROLLOUT_MAX_FILES = 5_000

/** Resolved Codex home layout, shared by discovery, model reading and credential inspection. */
export interface CodexHome {
  /** Absolute `$CODEX_HOME` root. */
  readonly path: string
  /** Active rollout root. */
  readonly sessionsRoot: string
  /** Archived rollout root. */
  readonly archivedRoot: string
  /** Append-only title index. */
  readonly indexFile: string
  /** Credential file path. */
  readonly credentialFile: string
  /** Whether `$CODEX_HOME` supplied the path rather than the default. */
  readonly fromEnv: boolean
  /** Why a configured `CODEX_HOME` was rejected in favour of the default. */
  readonly fallbackReason?: string
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

/**
 * Resolve Codex's home directory.
 *
 * A configured `homeDir` is honoured verbatim because it is the operator's explicit
 * choice; `$CODEX_HOME` is used only when it names a directory, which is what the CLI
 * itself does; otherwise the layout falls back to `~/.codex`.
 *
 * @param host - Host providing the environment, home directory and filesystem.
 * @param override - Configured `homeDir`, the highest-priority source.
 * @returns the resolved layout, with the reason a configured home was rejected.
 */
export async function resolveCodexHome(host: CodexHost, override?: string): Promise<CodexHome> {
  let path: string
  let fromEnv = false
  let fallbackReason: string | undefined
  if (override !== undefined && override !== '') {
    path = expandUserPath(host, override)
  } else {
    const envValue = host.env[CODEX_HOME_ENV]
    if (envValue !== undefined && envValue !== '') {
      path = envValue
      fromEnv = true
    } else {
      path = join(host.home, CODEX_DEFAULT_HOME_DIR)
    }
  }
  if (fromEnv && (await host.stat(path))?.isDirectory !== true) {
    const rejected = path
    path = join(host.home, CODEX_DEFAULT_HOME_DIR)
    fromEnv = false
    fallbackReason = `${CODEX_HOME_ENV} is set to ${rejected}, which is not a directory; using ${path}`
  }
  // An empty HOME would otherwise produce a relative home; the user's own home is the
  // only sane default when neither HOME nor USERPROFILE is set.
  if (!isAbsolute(path)) path = join(host.home, CODEX_DEFAULT_HOME_DIR)
  return {
    path,
    sessionsRoot: join(path, CODEX_SESSIONS_DIR),
    archivedRoot: join(path, CODEX_ARCHIVED_SESSIONS_DIR),
    indexFile: join(path, CODEX_SESSION_INDEX_FILE),
    credentialFile: join(path, CODEX_CREDENTIAL_FILE),
    fromEnv,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  }
}

/** One rollout file found on disk. */
export interface RolloutFile {
  /** Absolute path. */
  readonly path: string
  /** File name, which encodes the creation timestamp and the thread id. */
  readonly name: string
  /** Modification time in milliseconds, the session's last-activity time. */
  readonly mtimeMs: number
  /** Found under `archived_sessions` rather than `sessions`. */
  readonly archived: boolean
  /** zstd-compressed in place; this adapter cannot decompress it. */
  readonly compressed: boolean
}

/**
 * Whether a file name names a rollout.
 * @param name - File name.
 * @returns `true` for `rollout-*.jsonl` and its compressed `rollout-*.jsonl.zst` form.
 */
export function isRolloutFileName(name: string): boolean {
  return name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'))
}

/**
 * Thread id encoded in a rollout file name.
 *
 * A reverted thread's rollout appends `_<rolloutId>` after the stable thread id; only the
 * thread id is returned here.
 *
 * @param name - Rollout file name.
 * @returns the thread id, or `undefined` when the name does not match the convention.
 */
export function threadIdFromFileName(name: string): string | undefined {
  const base = name.endsWith('.zst') ? name.slice(0, -'.zst'.length) : name
  if (!base.startsWith('rollout-') || !base.endsWith('.jsonl')) return undefined
  const core = base.slice('rollout-'.length, -'.jsonl'.length)
  if (core.length <= 20 || core[19] !== '-') return undefined
  const id = core.slice(20).split('_', 1).join('')
  return id === '' ? undefined : id
}

/**
 * Enumerate rollout files under both session roots, newest first.
 *
 * The walk is bounded in depth and file count per root so a pathological store cannot
 * hang a listing; a caller that needs fewer entries applies its own limit afterwards.
 *
 * @param host - Host providing the directory listing.
 * @param home - Resolved home layout.
 * @returns rollout files, newest modification time first.
 */
export async function listRolloutFiles(host: CodexHost, home: CodexHome): Promise<readonly RolloutFile[]> {
  const roots: readonly { readonly root: string; readonly archived: boolean }[] = [
    { root: home.sessionsRoot, archived: false },
    { root: home.archivedRoot, archived: true },
  ]
  const out: RolloutFile[] = []
  for (const { root, archived } of roots) {
    for (const entry of await findRollouts(host, root)) {
      out.push({
        path: entry.path,
        name: entry.name,
        mtimeMs: entry.mtimeMs,
        archived,
        compressed: entry.name.endsWith('.zst'),
      })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** One rollout entry the bounded walk found, with its directory. */
interface WalkedRollout {
  /** Absolute path of the file. */
  readonly path: string
  /** File name. */
  readonly name: string
  /** Modification time in milliseconds. */
  readonly mtimeMs: number
}

/** Depth-first walk for rollout files, bounded in depth and file count. */
async function findRollouts(host: CodexHost, root: string): Promise<readonly WalkedRollout[]> {
  const found: WalkedRollout[] = []
  const queue: { readonly path: string; readonly depth: number }[] = [{ path: root, depth: 0 }]
  while (queue.length > 0) {
    const batch = queue.splice(0)
    for (const next of batch) {
      for (const entry of await host.listDir(next.path)) {
        if (found.length >= ROLLOUT_MAX_FILES) break
        if (entry.isDirectory) {
          if (next.depth < ROLLOUT_MAX_DEPTH) queue.push({ path: join(next.path, entry.name), depth: next.depth + 1 })
        } else if (isRolloutFileName(entry.name)) {
          found.push({ path: join(next.path, entry.name), name: entry.name, mtimeMs: entry.mtimeMs })
        }
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.slice(0, ROLLOUT_MAX_FILES)
}

/** Session-level metadata parsed from a rollout's first line. */
export interface CodexSessionMeta {
  /** Stable thread id. */
  readonly threadId: string
  /** Root thread id of the session this rollout belongs to. */
  readonly sessionId?: string
  /** Thread this session was forked from. */
  readonly forkedFromId?: string
  /** Parent thread, for a sub-agent rollout. */
  readonly parentThreadId?: string
  /** ISO 8601 creation time. */
  readonly timestamp?: string
  /** Working directory the session was created in. */
  readonly cwd?: string
  /** Codex entry point, verbatim (`cli`, `vscode`, `exec`, `mcp`, …). */
  readonly originator?: string
  /** CLI version that wrote the rollout. */
  readonly cliVersion?: string
  /** Native session source, rendered as one token. */
  readonly source?: string
  /** Native thread source classification, when recorded. */
  readonly threadSource?: string
  /** Nickname of a spawned sub-agent, when recorded. */
  readonly agentNickname?: string
  /** Role of a spawned sub-agent, when recorded. */
  readonly agentRole?: string
  /** Model provider recorded in the header. */
  readonly modelProvider?: string
  /** Git branch recorded in the header. */
  readonly gitBranch?: string
  /** Git commit recorded in the header. */
  readonly gitCommit?: string
  /** Sanitized git remote URL recorded in the header. */
  readonly gitOriginUrl?: string
  /** Model from the first `turn_context` line in the head read, when there was one. */
  readonly model?: string
}

/** Result of reading a rollout head. */
export type CodexHeadRead =
  | { readonly ok: true; readonly meta: CodexSessionMeta }
  | { readonly ok: false; readonly error: string }

/**
 * Render a native `SessionSource` as one token.
 *
 * The native enum is either a string or a single-key object (`{"sub_agent": …}`); nested
 * single-key objects are folded in so `sub_agent:thread_spawn` stays readable.
 *
 * @param value - The native source value.
 * @returns one token, or `undefined` when nothing usable is present.
 */
export function renderSessionSource(value: unknown): string | undefined {
  return renderSourceToken(value, 0)
}

/** Fold one native source token, bounded in depth. */
function renderSourceToken(value: unknown, depth: number): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const record = asRecord(value)
  if (record === undefined || depth > 2) return undefined
  const parts: string[] = []
  for (const [key, child] of Object.entries(record)) {
    const nested = renderSourceToken(child, depth + 1)
    parts.push(nested === undefined ? key : `${key}:${nested}`)
  }
  return parts.length === 0 ? undefined : parts.join(',')
}

/** The `session_meta` fields, tolerating both the flattened and the `{meta}` envelope form. */
function sessionMetaFields(payload: unknown): Record<string, unknown> | undefined {
  const record = asRecord(payload)
  if (record === undefined) return undefined
  return asRecord(record['meta']) ?? record
}

/**
 * Parse the authoritative metadata out of a rollout head.
 *
 * Lines are scanned in order: the first `session_meta` supplies identity and git state,
 * and the first `turn_context` supplies the model, which is the only cheap way to learn a
 * session's model without reading the rollout tail.
 *
 * @param text - Head text, decoded from the first {@link SESSION_HEAD_BYTES} bytes.
 * @param fallbackThreadId - Id derived from the file name, used when the header is unusable.
 * @returns the metadata, or why it could not be read.
 */
export function parseRolloutHead(text: string, fallbackThreadId: string): CodexHeadRead {
  let meta: Record<string, unknown> | undefined
  let git: Record<string, unknown> | undefined
  let model: string | undefined
  let parseErrors = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      parseErrors += 1
      continue
    }
    const record = asRecord(parsed.value)
    if (record === undefined) continue
    const type = str(record, 'type')
    if (type === 'session_meta' && meta === undefined) {
      meta = sessionMetaFields(record['payload'])
      git = asRecord(meta?.['git']) ?? asRecord(asRecord(record['payload'])?.['git'])
      continue
    }
    if (type === 'turn_context' && model === undefined) {
      model = str(asRecord(record['payload']), 'model')
    }
    if (meta !== undefined && model !== undefined) break
  }
  if (meta === undefined) {
    return {
      ok: false,
      error:
        parseErrors > 0
          ? `no parsable session_meta line in the head read (${String(parseErrors)} unparsable line(s))`
          : 'no session_meta line in the head read',
    }
  }
  const source = renderSessionSource(meta['source'])
  const sessionId = str(meta, 'session_id')
  const forkedFromId = str(meta, 'forked_from_id')
  const parentThreadId = str(meta, 'parent_thread_id')
  const timestamp = str(meta, 'timestamp')
  const cwd = str(meta, 'cwd')
  const originator = str(meta, 'originator')
  const cliVersion = str(meta, 'cli_version')
  const threadSource = str(meta, 'thread_source')
  const agentNickname = str(meta, 'agent_nickname')
  const agentRole = str(meta, 'agent_role')
  const modelProvider = str(meta, 'model_provider')
  const gitBranch = str(git, 'branch')
  const gitCommit = str(git, 'commit_hash')
  const gitOriginUrl = str(git, 'repository_url')
  return {
    ok: true,
    meta: {
      threadId: str(meta, 'id') ?? sessionId ?? fallbackThreadId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(forkedFromId === undefined ? {} : { forkedFromId }),
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(originator === undefined ? {} : { originator }),
      ...(cliVersion === undefined ? {} : { cliVersion }),
      ...(source === undefined ? {} : { source }),
      ...(threadSource === undefined ? {} : { threadSource }),
      ...(agentNickname === undefined ? {} : { agentNickname }),
      ...(agentRole === undefined ? {} : { agentRole }),
      ...(modelProvider === undefined ? {} : { modelProvider }),
      ...(gitBranch === undefined ? {} : { gitBranch }),
      ...(gitCommit === undefined ? {} : { gitCommit }),
      ...(gitOriginUrl === undefined ? {} : { gitOriginUrl }),
      ...(model === undefined ? {} : { model }),
    },
  }
}

/** One fold of the append-only title index. */
export interface CodexTitleEntry {
  /** Native thread name. */
  readonly title: string
  /** When the name was last set, as recorded by Codex. */
  readonly updatedAt?: string
}

/**
 * Apply one `session_index.jsonl` entry to a title map.
 *
 * The index is append-only and the newest entry for an id wins, so later lines overwrite
 * earlier ones; a line without a usable id or name is ignored.
 *
 * @param index - Map to update, keyed by thread id.
 * @param value - One parsed index line.
 */
export function applySessionIndexEntry(index: Map<string, CodexTitleEntry>, value: unknown): void {
  const record = asRecord(value)
  const id = str(record, 'id')
  const title = str(record, 'thread_name')
  if (id === undefined || title === undefined) return
  const updatedAt = str(record, 'updated_at')
  index.set(id, { title, ...(updatedAt === undefined ? {} : { updatedAt }) })
}

/**
 * Fold the append-only title index.
 * @param host - Host providing the read.
 * @param home - Resolved home layout.
 * @returns titles by thread id, newest entry per id; empty when the index is absent.
 */
export async function readSessionIndex(host: CodexHost, home: CodexHome): Promise<ReadonlyMap<string, CodexTitleEntry>> {
  const index = new Map<string, CodexTitleEntry>()
  const text = await host.readHead(home.indexFile, SESSION_INDEX_MAX_BYTES)
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (parsed.ok) applySessionIndexEntry(index, parsed.value)
  }
  return index
}

/** Everything a session listing needs. */
export interface CodexSessionScan {
  /** Host providing the filesystem and the clock. */
  readonly host: CodexHost
  /** Owning agent id, stamped on every session. */
  readonly agentId: AgentId
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Caller options: cwd filter, limit and abort signal. */
  readonly options: AgentSessionListOptions
}

/**
 * Enumerate this machine's Codex sessions.
 *
 * Each rollout contributes one session: identity and git state from the `session_meta`
 * head line, the title from `session_index.jsonl`, and the file's modification time as
 * the last-activity time. A rollout that cannot be read comes back as
 * `status: 'unreadable'` with the reason in `notes`, so one damaged file never costs the
 * whole listing.
 *
 * @param scan - Host, home layout and caller options.
 * @returns sessions, newest first, filtered by `cwd` and capped by `limit`.
 */
export async function listCodexSessions(scan: CodexSessionScan): Promise<readonly AgentSession[]> {
  const titles = await readSessionIndex(scan.host, scan.home)
  const rollouts = await listRolloutFiles(scan.host, scan.home)
  const cwdFilter = scan.options.cwd === undefined ? undefined : expandUserPath(scan.host, scan.options.cwd)
  // A thread can briefly have both a plain and a compressed rollout, because Codex
  // compresses in place; one session per key wins, and a readable record beats an
  // unreadable one regardless of which file is newer.
  const byKey = new Map<string, AgentSession>()
  for (const rollout of rollouts) {
    if (scan.options.signal?.aborted === true) break
    if (scan.options.limit !== undefined && byKey.size >= scan.options.limit) break
    const session = await projectSession(scan, rollout, titles)
    if (cwdFilter !== undefined && session.cwd !== cwdFilter) continue
    const existing = byKey.get(session.key)
    if (existing !== undefined && !(existing.status === 'unreadable' && session.status !== 'unreadable')) continue
    byKey.set(session.key, session)
  }
  return [...byKey.values()]
}

/** Project one rollout file into a mesh session, never throwing. */
async function projectSession(
  scan: CodexSessionScan,
  rollout: RolloutFile,
  titles: ReadonlyMap<string, CodexTitleEntry>,
): Promise<AgentSession> {
  const fallbackId = threadIdFromFileName(rollout.name) ?? rollout.name
  const updatedAt = new Date(rollout.mtimeMs).toISOString()
  if (rollout.compressed) {
    scan.host.log('warn', `codex rollout is zstd-compressed and was listed as unreadable: ${rollout.path}`)
    return unreadableSession(scan, rollout, fallbackId, updatedAt, [
      note(
        '*',
        'the rollout is zstd-compressed (rollout-*.jsonl.zst) and this adapter version does not decompress rollouts, so no metadata or transcript is available; open the session in Codex to materialise the plain rollout',
      ),
    ])
  }
  const head = await scan.host.readHead(rollout.path, SESSION_HEAD_BYTES)
  const parsed = parseRolloutHead(head, fallbackId)
  if (!parsed.ok) {
    scan.host.log('warn', `codex rollout head is unusable: ${rollout.path}: ${parsed.error}`)
    return unreadableSession(scan, rollout, fallbackId, updatedAt, [
      note('*', `the rollout head could not be parsed: ${parsed.error}`),
    ])
  }
  const meta = parsed.meta
  const title = titles.get(meta.threadId)
  const notes: string[] = []
  if (title === undefined) {
    notes.push(note('title', 'no entry for this thread in session_index.jsonl, and the first user message is not read during listing'))
  }
  notes.push(
    note(
      'updatedAt',
      title?.updatedAt === undefined
        ? 'the rollout file modification time stands in for the last activity time'
        : 'the session index timestamp is preferred over the rollout file modification time',
    ),
  )
  if (meta.model === undefined) {
    notes.push(note('model', 'no turn_context line appeared in the bounded head read'))
  }
  notes.push(note('usage', 'token usage lives in the rollout tail, which listing does not read'))
  notes.push(note('messageCount', 'Codex records no message count for a rollout; counting would require a full read'))
  notes.push(
    note('repoRoot', 'the repository root is not resolved during listing, which would cost one git spawn per session'),
  )
  if (meta.timestamp === undefined) {
    notes.push(note('createdAt', 'the session header carries no timestamp, so the rollout file modification time stands in'))
  }
  if (meta.cwd === undefined) {
    notes.push(note('cwd', 'the session header carries no working directory'))
  }
  if (meta.gitCommit !== undefined || meta.gitOriginUrl !== undefined) {
    notes.push(
      note('branch', 'the session header also records a commit sha and a remote url, which the mesh session has no field for'),
    )
  }
  const source = archiveAwareSource(meta.source, rollout.archived)
  if (source === undefined) {
    notes.push(note('source', 'the session header carries no session source'))
  } else if (rollout.archived) {
    notes.push(note('source', 'the rollout lives under archived_sessions rather than sessions'))
  }
  if (meta.forkedFromId !== undefined) {
    notes.push(note('parentNativeId', 'taken from the header field forked_from_id'))
  }
  const unprojected = [
    meta.sessionId === undefined || meta.sessionId === meta.threadId ? undefined : 'session_id',
    meta.originator === undefined ? undefined : 'originator',
    meta.cliVersion === undefined ? undefined : 'cli_version',
    meta.threadSource === undefined ? undefined : 'thread_source',
    meta.agentNickname === undefined ? undefined : 'agent_nickname',
    meta.agentRole === undefined ? undefined : 'agent_role',
    meta.modelProvider === undefined ? undefined : 'model_provider',
  ].filter(field => field !== undefined)
  if (unprojected.length > 0) {
    notes.push(note('*', `the session header also carries ${unprojected.join(', ')}, which the mesh session has no field for`))
  }
  const parentNativeId = meta.parentThreadId ?? meta.forkedFromId
  return {
    key: sessionKey(scan.agentId, meta.threadId),
    agentId: scan.agentId,
    nativeId: meta.threadId,
    nativePath: rollout.path,
    ...(title === undefined ? {} : { title: title.title, titleIsNative: true }),
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    ...(meta.gitBranch === undefined ? {} : { branch: meta.gitBranch }),
    ...(meta.model === undefined ? {} : { model: meta.model }),
    createdAt: meta.timestamp ?? updatedAt,
    updatedAt: title?.updatedAt ?? updatedAt,
    status: 'idle',
    ...(parentNativeId === undefined ? {} : { parentNativeId }),
    ...(source === undefined ? {} : { source }),
    notes,
  }
}

/** A session that exists on disk but could not be projected. */
function unreadableSession(
  scan: CodexSessionScan,
  rollout: RolloutFile,
  nativeId: string,
  updatedAt: string,
  notes: readonly string[],
): AgentSession {
  return {
    key: sessionKey(scan.agentId, nativeId),
    agentId: scan.agentId,
    nativeId,
    nativePath: rollout.path,
    createdAt: updatedAt,
    updatedAt,
    status: 'unreadable',
    notes,
  }
}

/** Render a session source token, noting archival. */
function archiveAwareSource(source: string | undefined, archived: boolean): string | undefined {
  if (!archived) return source
  return source === undefined ? 'archived' : `${source} (archived)`
}

/**
 * Locate the rollout file for a session id.
 *
 * Codex encodes the thread id in the rollout file name (with an optional rollout id
 * suffix for reverted threads), which makes a name lookup sufficient and cheap.
 *
 * @param host - Host providing the directory listing.
 * @param home - Resolved home layout.
 * @param nativeId - Native thread id.
 * @returns the newest matching rollout, or `undefined` when none exists.
 */
export async function locateRollout(
  host: CodexHost,
  home: CodexHome,
  nativeId: string,
): Promise<RolloutFile | undefined> {
  if (nativeId === '') return undefined
  const matches = (await listRolloutFiles(host, home)).filter(rollout => rollout.name.includes(nativeId))
  // A plain rollout wins over a compressed one: the compressed form is unreadable here,
  // and during in-place compression both can exist for the same thread.
  matches.sort((a, b) => (a.compressed === b.compressed ? b.mtimeMs - a.mtimeMs : a.compressed ? 1 : -1))
  return matches[0]
}
