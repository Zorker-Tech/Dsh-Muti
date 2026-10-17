/**
 * Builders for OMP session-file text: the fixed-width title slot, the `type: "session"`
 * header, and append-only entries.
 * @module @deepseek-ai/dsh-agent-omp/tests/support/fixtures
 */

import { OMP_TITLE_SLOT_BYTES } from '../../src/sessions.ts'

/** The fixed-width title slot line, padded exactly as OMP pads it. */
export function titleSlot(title: string, extra: Record<string, unknown> = {}): string {
  const line = JSON.stringify({ type: 'title', title, ...extra })
  return `${line.padEnd(OMP_TITLE_SLOT_BYTES - 1, ' ')}\n`
}

/** One `type: "session"` header line. */
export function sessionHeader(header: {
  readonly id: string
  readonly timestamp?: string
  readonly cwd?: string
  readonly version?: number
  readonly parentSession?: string
  readonly title?: string
  readonly extra?: Record<string, unknown>
}): string {
  return `${JSON.stringify({
    type: 'session',
    id: header.id,
    timestamp: header.timestamp ?? '2026-10-16T00:00:00.000Z',
    cwd: header.cwd ?? '/work/repo',
    ...(header.version === undefined ? {} : { version: header.version }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    ...(header.title === undefined ? {} : { title: header.title }),
    ...header.extra,
  })}\n`
}

/** One session entry line. */
export function entry(
  id: string,
  parentId: string | null,
  type: string,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({ id, parentId, timestamp: '2026-10-16T00:00:01.000Z', type, ...extra })}\n`
}

/** One `message` entry carrying a native message record. */
export function messageEntry(
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
): string {
  return entry(id, parentId, 'message', { message })
}

/** One assistant message record. */
export function assistantMessage(content: readonly unknown[]): Record<string, unknown> {
  return { role: 'assistant', model: 'claude-sonnet-4', provider: 'anthropic', content }
}

/**
 * Assemble a session file: the title slot, the header, then the entries.
 * @param options - Title slot, header line and entry lines.
 * @returns the file text.
 */
export function sessionFile(options: {
  readonly title?: string
  readonly header: string
  readonly entries?: readonly string[]
}): string {
  return `${options.title === undefined ? '' : titleSlot(options.title)}${options.header}${(options.entries ?? []).join('')}`
}
