/**
 * Grok Build's on-disk session store, read in place and never written.
 *
 * Layout: `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`, where the cwd level is the
 * URL-encoded working directory (or a slug plus a `.cwd` marker when the encoded name
 * exceeds the filesystem's name limit) and each session directory holds `summary.json`
 * as its authoritative metadata. Session ids are UUIDv7.
 *
 * Every read is bounded and tolerates a file another process is appending to; a malformed
 * record costs that record, not the session.
 * @module @deepseek-ai/dsh-agent-grok/sessions
 */

import { basename, join, resolve } from 'node:path'
import type {
  AgentHost,
  AgentId,
  AgentSession,
  AgentSessionKey,
  AgentSessionListOptions,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DEFAULT_STORE_FILE_BYTES } from './config.ts'
import { expandUserPath } from './detect.ts'

/** Agent id every row this package projects belongs to. */
export const GROK_AGENT_ID: AgentId = brandString<AgentId>('grok')

/** Environment variable that relocates Grok's home directory. */
export const GROK_HOME_ENV = 'GROK_HOME'

/** Environment variable that relocates Grok's credential file. */
export const GROK_AUTH_PATH_ENV = 'GROK_AUTH_PATH'

/** Home directory used when neither configuration nor `$GROK_HOME` names one. */
export const GROK_DEFAULT_HOME_DIR = '.grok'

/** Fixed file names inside a session directory. */
export const SUMMARY_FILE = 'summary.json'
/** The session's ACP update stream, the authoritative transcript source. */
export const UPDATES_FILE = 'updates.jsonl'
/** Derived model-message cache, read only when `updates.jsonl` is absent or empty. */
export const CHAT_HISTORY_FILE = 'chat_history.jsonl'
/** grok's native todo plan for the session. */
export const PLAN_FILE = 'plan.json'
/** grok's native plan-mode state for the session. */
export const PLAN_MODE_FILE = 'plan_mode.json'
/** Marker file in a slug-named cwd directory recording the original working directory. */
export const CWD_MARKER_FILE = '.cwd'

/** Bytes read from the `.cwd` marker of a slug-named cwd directory. */
const CWD_MARKER_BYTES = 8 * 1024

/** Resolved Grok Build locations for this machine. */
export interface GrokPaths {
  /** `$GROK_HOME` verbatim when non-empty, else `<home>/.grok`. */
  readonly home: string
  /** Whether {@link home} came from the environment rather than the home default. */
  readonly homeFromEnv: boolean
  /** `<home>/sessions`. */
  readonly sessionRoot: string
  /** `$GROK_AUTH_PATH` when set, else `<home>/auth.json`. */
  readonly credentialPath: string
}

/**
 * Render one projection note.
 *
 * The mesh records notes as plain strings, so a note names the canonical field it
 * belongs to by prefixing the reason with it; `*` marks a record-wide gap.
 * @param field - Canonical field the gap belongs to, or `*` for a record-wide gap.
 * @param reason - What could not be carried, addressed to the reader.
 * @returns the note as the mesh records it.
 */
export function note(field: string, reason: string): string {
  return field === '*' ? reason : `${field}: ${reason}`
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
 * Resolve the store locations the same way grok does.
 *
 * Precedence is the configured home, then `$GROK_HOME`, then `<host home>/.grok`;
 * `$GROK_AUTH_PATH` overrides the credential path wherever the home resolved to.
 * @param host - Host providing the home directory and environment.
 * @param homeDir - Configured Grok home, when the deployment named one.
 * @returns the resolved home, session root and credential path.
 */
export function resolveGrokPaths(host: AgentHost, homeDir?: string): GrokPaths {
  const override = homeDir === undefined || homeDir === '' ? undefined : homeDir
  const fromEnv = override === undefined ? host.env[GROK_HOME_ENV] : undefined
  const usedEnv = override === undefined && fromEnv !== undefined && fromEnv !== ''
  const home = override !== undefined
    ? expandUserPath(host, override)
    : fromEnv !== undefined && fromEnv !== ''
      ? fromEnv
      : join(host.home, GROK_DEFAULT_HOME_DIR)
  const authOverride = host.env[GROK_AUTH_PATH_ENV]
  return {
    home,
    homeFromEnv: usedEnv,
    sessionRoot: join(home, 'sessions'),
    credentialPath: authOverride === undefined || authOverride === '' ? join(home, 'auth.json') : authOverride,
  }
}

/** One JSON file read from an agent-owned store. */
export type StoreFileRead =
  | {
    /** No non-directory exists at the path. */
    readonly present: false
    readonly ok: false
  }
  | {
    /** A file exists but could not be read or parsed. */
    readonly present: true
    readonly ok: false
    /** Why the file could not be parsed. */
    readonly error: string
  }
  | {
    /** The existing file was read and parsed. */
    readonly present: true
    readonly ok: true
    /** The parsed value. */
    readonly value: unknown
  }

/**
 * Read and parse one JSON store file without writing it.
 *
 * A file longer than the cap, an empty file and malformed JSON are all reported through
 * {@link StoreFileRead.error} rather than thrown, because a store another process is
 * rewriting is an expected condition.
 * @param host - Host providing the file metadata and contents.
 * @param path - Absolute path of the store file.
 * @param maxBytes - Largest file this read accepts.
 * @returns the presence, parse result and error of the read.
 */
export async function readStoreJson(host: AgentHost, path: string, maxBytes: number): Promise<StoreFileRead> {
  const stat = await host.stat(path)
  if (stat === undefined || stat.isDirectory) return { present: false, ok: false }
  if (stat.size > maxBytes) {
    return { present: true, ok: false, error: `the file is larger than the ${String(maxBytes)}-byte read cap` }
  }
  const text = (await host.readHead(path, maxBytes)).trim()
  if (text === '') return { present: true, ok: false, error: 'the file is empty' }
  try {
    const value: unknown = JSON.parse(text)
    return { present: true, ok: true, value }
  } catch (cause) {
    return { present: true, ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Decode a cwd-level session directory name.
 *
 * grok encodes the working directory into the directory name and falls back to a
 * `{slug}-{hash}` name plus a `.cwd` marker when the encoded form exceeds the filesystem's
 * name limit.
 * @param host - Host providing the marker read.
 * @param dirPath - Absolute `<sessionRoot>/<encoded-cwd>` directory.
 * @returns the original cwd, or `undefined` when neither the name nor the marker yields one.
 */
export async function decodeCwdDirName(host: AgentHost, dirPath: string): Promise<string | undefined> {
  const name = basename(dirPath)
  const decoded = tryDecode(name)
  // An absolute Unix cwd always decodes to a leading "/"; the slug form never does.
  if (decoded !== undefined && decoded.startsWith('/')) return decoded
  const cwd = (await host.readHead(join(dirPath, CWD_MARKER_FILE), CWD_MARKER_BYTES)).trim()
  return cwd === '' ? undefined : cwd
}

/** Percent-decode a directory name, or `undefined` when it is not valid percent-encoding. */
function tryDecode(name: string): string | undefined {
  try {
    return decodeURIComponent(name)
  } catch (cause) {
    // A name that is not valid percent-encoding is the slug-hash form, not an error.
    void cause
    return undefined
  }
}

/** The subset of `summary.json` this adapter projects. */
export interface GrokSummary {
  /** `info.id`, the session's own identifier. */
  readonly id?: string
  /** `info.cwd`, the working directory the session ran in. */
  readonly cwd?: string
  /** Model-written narrative summary of the session. */
  readonly sessionSummary?: string
  /** ISO-8601 creation time. */
  readonly createdAt?: string
  /** ISO-8601 last-activity time. */
  readonly updatedAt?: string
  /** Message count as grok counted it. */
  readonly numMessages?: number
  /** Chat-message count as grok counted it. */
  readonly numChatMessages?: number
  /** Model the session currently uses. */
  readonly currentModelId?: string
  /** Parent session id, for a forked or subagent session. */
  readonly parentSessionId?: string
  /** grok's own classification of the session. */
  readonly sessionKind?: string
  /** Whether grok marks the session hidden from its own pickers. */
  readonly hidden?: boolean
  /** Source workspace of a worktree session. */
  readonly sourceWorkspaceDir?: string
  /** Repository root grok recorded. */
  readonly gitRootDir?: string
  /** Branch grok recorded. */
  readonly headBranch?: string
  /** Automatically generated title. */
  readonly generatedTitle?: string
  /** Whether the title came from a manual rename. */
  readonly titleIsManual?: boolean
  /** grok's own worktree label, when the session ran in one. */
  readonly worktreeLabel?: string
  /** Sandbox profile the session was created with. */
  readonly sandboxProfile?: string
}

/**
 * Parse `summary.json` tolerantly.
 * @param value - Parsed JSON of the file.
 * @returns the projected summary; every field is optional because grok omits unset ones.
 */
export function parseGrokSummary(value: unknown): GrokSummary {
  const record = asRecord(value)
  if (record === undefined) return {}
  const info = asRecord(record['info'])
  const id = nonEmpty(info?.['id'])
  const cwd = nonEmpty(info?.['cwd'])
  const sessionSummary = nonEmpty(record['session_summary'])
  const createdAt = isoValue(record['created_at'])
  const updatedAt = isoValue(record['updated_at'])
  const numMessages = whole(record['num_messages'])
  const numChatMessages = whole(record['num_chat_messages'])
  const currentModelId = nonEmpty(record['current_model_id'])
  const parentSessionId = nonEmpty(record['parent_session_id'])
  const sessionKind = nonEmpty(record['session_kind'])
  const sourceWorkspaceDir = nonEmpty(record['source_workspace_dir'])
  const gitRootDir = nonEmpty(record['git_root_dir'])
  const headBranch = nonEmpty(record['head_branch'])
  const generatedTitle = nonEmpty(record['generated_title'])
  const worktreeLabel = nonEmpty(record['worktree_label'])
  const sandboxProfile = nonEmpty(record['sandbox_profile'])
  return {
    ...(id === undefined ? {} : { id }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(sessionSummary === undefined ? {} : { sessionSummary }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(numMessages === undefined ? {} : { numMessages }),
    ...(numChatMessages === undefined ? {} : { numChatMessages }),
    ...(currentModelId === undefined ? {} : { currentModelId }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(sessionKind === undefined ? {} : { sessionKind }),
    ...(record['hidden'] === true ? { hidden: true } : {}),
    ...(sourceWorkspaceDir === undefined ? {} : { sourceWorkspaceDir }),
    ...(gitRootDir === undefined ? {} : { gitRootDir }),
    ...(headBranch === undefined ? {} : { headBranch }),
    ...(generatedTitle === undefined ? {} : { generatedTitle }),
    ...(record['title_is_manual'] === true ? { titleIsManual: true } : {}),
    ...(worktreeLabel === undefined ? {} : { worktreeLabel }),
    ...(sandboxProfile === undefined ? {} : { sandboxProfile }),
  }
}

/** One resolved session directory plus what was recoverable from it. */
export interface GrokSessionDirectory {
  /** Absolute session directory. */
  readonly dir: string
  /** cwd recorded for the session, when resolvable. */
  readonly cwd: string | undefined
  /** `updated_at` of the summary, when readable. */
  readonly updatedAt: string | undefined
  /** Message count as grok reported it, when readable. */
  readonly messageCount: number | undefined
  /** Parsed summary, when readable. */
  readonly summary: GrokSummary | undefined
  /** Declared projection gaps raised while resolving the directory. */
  readonly notes: readonly string[]
}

/**
 * Locate one session's directory by native id.
 *
 * The cwd level is unknown, so every cwd directory is probed for a child of that name; a
 * session directory is valid even when its `summary.json` is currently unreadable.
 * @param host - Host providing directory listings.
 * @param paths - Resolved Grok store locations.
 * @param nativeId - The agent's own session identifier.
 * @returns the resolved directory, or `undefined` when no cwd directory contains it.
 */
export async function findGrokSessionDir(
  host: AgentHost,
  paths: GrokPaths,
  nativeId: string,
): Promise<GrokSessionDirectory | undefined> {
  if (nativeId === '') return undefined
  for (const cwdDir of await host.listDir(paths.sessionRoot)) {
    if (!cwdDir.isDirectory) continue
    const dir = join(paths.sessionRoot, cwdDir.name, nativeId)
    if (!(await host.stat(dir))?.isDirectory) continue
    return await projectDirectory(host, dir, join(paths.sessionRoot, cwdDir.name))
  }
  return undefined
}

/**
 * Enumerate sessions from `summary.json`, newest first.
 *
 * Hidden sessions are listed with a note rather than filtered out, subagent and forked
 * children are included with their parent and `session_kind`, and an unreadable summary
 * degrades just that session.
 * @param params - Host, resolved paths and the filter options.
 * @returns one projection per session directory.
 */
export async function listGrokSessions(params: {
  readonly host: AgentHost
  readonly paths: GrokPaths
  readonly options: AgentSessionListOptions
}): Promise<readonly AgentSession[]> {
  const { host, paths, options } = params
  const sessions: AgentSession[] = []
  const wantCwd = options.cwd === undefined ? undefined : resolve(options.cwd)
  const aborted = (): boolean => options.signal?.aborted === true
  for (const cwdDir of await host.listDir(paths.sessionRoot)) {
    if (aborted()) break
    if (!cwdDir.isDirectory) continue
    const cwdDirPath = join(paths.sessionRoot, cwdDir.name)
    for (const entry of await host.listDir(cwdDirPath)) {
      if (aborted()) break
      if (!entry.isDirectory) continue
      const projected = await projectDirectory(host, join(cwdDirPath, entry.name), cwdDirPath)
      const session = toAgentSession(projected, entry.mtimeMs)
      if (wantCwd !== undefined && (session.cwd === undefined || resolve(session.cwd) !== wantCwd)) continue
      sessions.push(session)
    }
  }
  // Newest activity first; two sessions updated in the same millisecond keep a stable order.
  sessions.sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1
    return left.nativeId < right.nativeId ? -1 : 1
  })
  return options.limit === undefined ? sessions : sessions.slice(0, options.limit)
}

/** Read a session directory into its projected metadata. */
async function projectDirectory(host: AgentHost, dir: string, cwdDir: string): Promise<GrokSessionDirectory> {
  const notes: string[] = []
  const read = await readStoreJson(host, join(dir, SUMMARY_FILE), DEFAULT_STORE_FILE_BYTES)
  const summary = read.ok ? parseGrokSummary(read.value) : undefined
  if (!read.ok) {
    notes.push(note('*', read.present
      ? `summary.json could not be parsed: ${read.error}`
      : 'summary.json is absent; only the directory name and its timestamps are projected'))
  }

  let cwd = summary?.cwd
  if (cwd === undefined) {
    cwd = await decodeCwdDirName(host, cwdDir)
    if (cwd !== undefined) {
      notes.push(note('cwd', 'cwd recovered from the session directory name or its .cwd marker; summary.json did not carry info.cwd'))
    }
  }
  return {
    dir,
    cwd,
    updatedAt: summary?.updatedAt,
    messageCount: summary?.numMessages ?? summary?.numChatMessages,
    summary,
    notes,
  }
}

/** Project one resolved directory onto `AgentSession`, or drop it when it cannot be identified. */
function toAgentSession(projected: GrokSessionDirectory, mtimeMs: number): AgentSession {
  const native = projected.summary?.id ?? basename(projected.dir)
  const nativeId = native
  const notes: string[] = [...projected.notes]
  const summary = projected.summary

  if (summary === undefined) {
    notes.push(note('*', 'the session is readable only as a directory; its summary was not parsable'))
  }
  const fallbackTime = new Date(mtimeMs > 0 ? mtimeMs : 0).toISOString()
  if (summary === undefined || summary.updatedAt === undefined || summary.createdAt === undefined) {
    notes.push(note('*', 'summary.json recorded no usable timestamp, so the session directory modification time stands in for createdAt/updatedAt'))
  }
  if (summary?.hidden === true) {
    notes.push(note('*', 'grok marks this session hidden (hidden: true); it is listed here but is normally not shown'))
  }
  if (summary?.sandboxProfile !== undefined) {
    notes.push(note('sandboxProfile', `grok created this session with sandbox profile "${summary.sandboxProfile}" and refuses to resume it under a different explicit profile; no canonical session field carries it`))
  }
  if (summary?.worktreeLabel !== undefined) {
    notes.push(note('source', `grok labels this its own worktree "${summary.worktreeLabel}"; this adapter always creates the worktree itself and passes --cwd instead`))
  }
  if (summary?.sourceWorkspaceDir !== undefined) {
    notes.push(note('cwd', `grok recorded a source workspace of ${summary.sourceWorkspaceDir} for this worktree session`))
  }
  if (summary?.titleIsManual === true) {
    notes.push(note('title', 'the title was set by a manual rename, not by automatic titling'))
  }

  const title = summary?.generatedTitle ?? summary?.sessionSummary
  const updatedAt = summary?.updatedAt ?? fallbackTime
  return {
    key: sessionKey(GROK_AGENT_ID, nativeId),
    agentId: GROK_AGENT_ID,
    nativeId,
    ...(title === undefined ? {} : { title, titleIsNative: true }),
    ...(projected.cwd === undefined ? {} : { cwd: projected.cwd }),
    ...(summary?.gitRootDir === undefined ? {} : { repoRoot: summary.gitRootDir }),
    ...(summary?.headBranch === undefined ? {} : { branch: summary.headBranch }),
    ...(summary?.currentModelId === undefined ? {} : { model: summary.currentModelId }),
    createdAt: summary?.createdAt ?? updatedAt,
    updatedAt,
    status: summary === undefined ? 'unreadable' : 'idle',
    ...(projected.messageCount === undefined ? {} : { messageCount: projected.messageCount }),
    ...(summary?.parentSessionId === undefined ? {} : { parentNativeId: summary.parentSessionId }),
    ...(summary?.sessionKind === undefined ? {} : { source: summary.sessionKind }),
    notes,
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

/** A non-negative integer field. */
function whole(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.trunc(value)
}

/** An RFC3339 timestamp kept verbatim, when it parses. */
function isoValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return Number.isFinite(Date.parse(value)) ? value : undefined
}
