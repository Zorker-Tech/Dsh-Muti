/**
 * Narrow readers for the untyped JSON Codex writes into its own stores.
 *
 * Codex's rollout records, `auth.json` and the `codex exec --json` stream are all
 * foreign JSON: every field is read through a guard that narrows it (or returns
 * `undefined`) instead of a cast, so a renamed or retyped field degrades into a
 * declared gap rather than a crash.
 * @module @deepseek-ai/dsh-agent-codex/json
 */

/**
 * View a value as a JSON object.
 * @param value - Any parsed JSON value.
 * @returns the object, or `undefined` for arrays, scalars and `null`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Read a non-empty string field.
 * @param record - Object to read from, or `undefined`.
 * @param key - Field name.
 * @returns the value when it is a non-empty string, else `undefined`.
 */
export function str(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read a finite number field.
 * @param record - Object to read from, or `undefined`.
 * @param key - Field name.
 * @returns the value when it is a finite number, else `undefined`.
 */
export function num(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Normalize a native type token for comparison.
 *
 * Codex serializes the same conceptual item under different casings and separators
 * (`AgentMessage` in one payload family, `agent_message` in another), so unknown
 * tokens are compared on a separator-free lowercase form.
 * @param value - Native type token, or `undefined`.
 * @returns the comparable form, or an empty string.
 */
export function normalizeToken(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Serialize a native value to text, tolerating cycles and non-JSON values.
 * @param value - Native value.
 * @returns the JSON text, or `String(value)` when it cannot be serialized.
 */
export function jsonText(value: unknown): string {
  try {
    // Widened deliberately: `JSON.stringify` is declared as returning a string, but it
    // returns `undefined` for `undefined` input, which the fallback below covers.
    const text: unknown = JSON.stringify(value)
    return typeof text === 'string' ? text : String(value)
  } catch {
    return String(value)
  }
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
    /* v8 ignore next -- JSON.parse throws only SyntaxError, which is an Error. */
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
