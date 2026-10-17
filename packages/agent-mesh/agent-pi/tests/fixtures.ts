/**
 * Builders for Pi's own session-file text, so a spec states only the fields it is about.
 * @module @deepseek-ai/dsh-agent-pi/tests/fixtures
 */

/** One entry's fields; every field beyond `id`, `type` and `parentId` is passed through. */
export interface EntryFields {
  /** Entry id, which a `parentId` link names. */
  readonly id: string
  /** Entry type, verbatim. */
  readonly type: string
  /** Parent entry id, or `null` at a branch root. */
  readonly parentId?: string | null
  /** Entry timestamp, ISO 8601. */
  readonly timestamp?: string
  /** Any further native field. */
  readonly [key: string]: unknown
}

/**
 * Render one session entry line.
 * @param fields - The entry's fields.
 * @returns the JSONL line, without its terminator.
 */
export function entryLine(fields: EntryFields): string {
  const { id, type, parentId, timestamp, ...rest } = fields
  return JSON.stringify({
    id,
    parentId: parentId ?? null,
    timestamp: timestamp ?? '2026-10-16T00:00:01.000Z',
    type,
    ...rest,
  })
}

/** One session header's fields. */
export interface HeaderFields {
  /** Session id. */
  readonly id: string
  /** Working directory the session was started in. */
  readonly cwd?: string
  /** Creation time, ISO 8601. */
  readonly timestamp?: string
  /** Native format version. */
  readonly version?: number
  /** Path of the session this one was forked from. */
  readonly parentSession?: string
}

/**
 * Render one session header line.
 * @param fields - The header's fields.
 * @returns the JSONL line, without its terminator.
 */
export function headerLine(fields: HeaderFields): string {
  return JSON.stringify({
    type: 'session',
    id: fields.id,
    timestamp: fields.timestamp ?? '2026-10-16T00:00:00.000Z',
    cwd: fields.cwd ?? '/home/tester/project',
    version: fields.version ?? 3,
    ...(fields.parentSession === undefined ? {} : { parentSession: fields.parentSession }),
  })
}

/**
 * Render a whole session file.
 * @param header - The header line's fields.
 * @param entries - Entry lines, in file order.
 * @returns the file text, newline-terminated.
 */
export function sessionFile(header: HeaderFields, entries: readonly string[]): string {
  return `${[headerLine(header), ...entries].join('\n')}\n`
}

/** An assistant message entry carrying content blocks. */
export function assistantEntry(
  id: string,
  parentId: string | null,
  blocks: readonly unknown[],
  extras: Record<string, unknown> = {},
): string {
  return entryLine({ id, type: 'message', parentId, message: { role: 'assistant', content: blocks, ...extras } })
}

/** A user message entry. */
export function userEntry(id: string, parentId: string | null, text: string): string {
  return entryLine({ id, type: 'message', parentId, message: { role: 'user', content: text } })
}
