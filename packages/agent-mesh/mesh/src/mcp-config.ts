/** Shared validation for native MCP declarations resolved by agent adapters.
 * @module @deepseek-ai/dsh-agent-mesh
 */

import { validateHeaderName, validateHeaderValue } from 'node:http'
import { isAbsolute, resolve } from 'node:path'

/** Narrow one parsed native config object.
 * @param value - Parsed value to inspect.
 * @param field - Field path used in the error.
 * @returns The object record.
 * @throws When the parsed value is not an object.
 */
export function mcpRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Read one required non-empty string from a native config object.
 * @param record - Parsed object.
 * @param key - Field name.
 * @param field - Config path used in the error.
 * @returns The trimmed field value.
 * @throws When the field is absent, empty, or not a string.
 */
export function mcpRequiredString(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field}.${key} must be a non-empty string`)
  return value.trim()
}

/** Read a native string-array field, defaulting an absent field to an empty list.
 * @param record - Parsed object.
 * @param key - Field name.
 * @param field - Config path used in the error.
 * @returns A copy of the configured strings.
 * @throws When the field is not an array of strings.
 */
export function mcpStringArray(record: Record<string, unknown>, key: string, field: string): string[] {
  const value = record[key]
  if (value === undefined) return []
  if (!isStringArray(value)) {
    throw new Error(`${field}.${key} must be an array of strings`)
  }
  return [...value]
}

/** Narrow an untrusted array to its string entries. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

/** Read a native string-valued map without resolving placeholders.
 * @param value - Parsed value.
 * @param field - Config path used in the error.
 * @returns A string map with no inherited properties.
 * @throws When the value is not an object of strings.
 */
export function mcpStringRecord(value: unknown, field: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  if (value === undefined) return result
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`)
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`${field} must contain only string values`)
    result[key] = entry
  }
  return result
}

/** Read environment values and resolve native `${NAME}` references without exposing them.
 * @param record - Optional environment object.
 * @param environment - Environment available to the external agent.
 * @param field - Config path used in the error.
 * @returns Resolved process environment values.
 * @throws When an entry is invalid or references a missing environment value.
 */
export function resolveMcpEnv(
  record: Record<string, unknown> | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  field: string,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  if (record === undefined) return result
  for (const [key, raw] of Object.entries(record)) {
    if (!isEnvironmentName(key) || typeof raw !== 'string') throw new Error(`${field} contains an invalid environment entry`)
    result[key] = expandMcpEnvValue(raw, environment, `${field}.${key}`)
  }
  return result
}

/** Read headers and resolve native `${NAME}` references without returning secrets to tools.
 * @param record - Optional HTTP header object.
 * @param environment - Environment available to the external agent.
 * @param field - Config path used in the error.
 * @param expandReferences - Whether to substitute `${NAME}` references.
 * @returns Validated HTTP headers.
 * @throws When a header is invalid, duplicated, or references a missing environment value.
 */
export function resolveMcpHeaders(
  record: Record<string, unknown> | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  field: string,
  expandReferences = true,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  const names = new Set<string>()
  if (record === undefined) return result
  for (const [name, raw] of Object.entries(record)) {
    if (typeof raw !== 'string') throw new Error(`${field} contains an invalid header entry`)
    const value = expandReferences ? expandMcpEnvValue(raw, environment, `${field}.${name}`) : raw
    try {
      validateHeaderName(name)
      validateHeaderValue(name, value)
    } catch (_invalidHeader) {
      throw new Error(`${field} contains an invalid header entry`)
    }
    const identity = name.toLowerCase()
    if (names.has(identity)) throw new Error(`${field} contains duplicate header names`)
    names.add(identity)
    result[name] = value
  }
  return result
}

/** Resolve one native environment reference, rejecting missing values and command expansion.
 * @param value - Configured value.
 * @param environment - Environment available to the external agent.
 * @param field - Config path used in the error.
 * @returns The resolved value.
 * @throws When the value uses command expansion or references a missing environment value.
 */
export function expandMcpEnvValue(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
  field: string,
): string {
  if (value.startsWith('!')) throw new Error(`${field} uses command expansion, which DSH does not execute from MCP config`)
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu, (_match, name: string, fallback: string | undefined) => {
    const resolved = environment[name]
    if (resolved !== undefined) return resolved
    if (fallback !== undefined) return fallback
    throw new Error(`${field} references unavailable environment variable "${name}"`)
  })
}

/** Validate and normalize a native MCP endpoint without exposing URL credentials.
 * @param value - Configured endpoint.
 * @param field - Config path used in the error.
 * @returns A normalized HTTP(S) endpoint.
 * @throws When the endpoint is not an absolute HTTP(S) URL or embeds credentials.
 */
export function resolveMcpUrl(value: string, field: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error(`${field} must be an absolute HTTP(S) URL`, { cause: error })
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw new Error(`${field} must be an absolute HTTP(S) URL without embedded credentials`)
  }
  return url.toString()
}

/** Resolve one configured MCP process directory against the selected project directory.
 * @param value - Optional configured directory.
 * @param cwd - Selected project directory.
 * @param home - Agent host home directory.
 * @returns The absolute process directory.
 */
export function resolveMcpCwd(value: string | undefined, cwd: string, home: string): string {
  const configured = value ?? cwd
  const expanded = configured.replace(/^~(?=\/|$)/u, home)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}

/** Project a configured executable to a display name without exposing its path.
 * @param value - Native command value.
 * @returns The final path component, or a generic label for command text with whitespace.
 */
export function mcpExecutableSummary(value: string): string {
  if (/\s/u.test(value)) return 'configured executable'
  const component = value.split(/[\\/]/u).at(-1)
  return component === undefined || component === '' ? 'configured executable' : component
}

/** Project an MCP URL to its origin so paths, query values, and credentials stay private.
 * @param value - Native endpoint value.
 * @returns The URL origin, or a generic label when the value is not a URL.
 */
export function mcpEndpointSummary(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : 'configured endpoint'
  } catch {
    return 'configured endpoint'
  }
}

/** Read an optional native boolean without accepting truthy non-boolean values.
 * @param record - Parsed object.
 * @param key - Field name.
 * @param field - Config path used in the error.
 * @returns The configured boolean, or `undefined` when absent.
 * @throws When the field is present and is not a boolean.
 */
export function mcpOptionalBoolean(record: Record<string, unknown>, key: string, field: string): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${field}.${key} must be a boolean`)
  return value
}

/** Reject a declaration that mixes a process command and an HTTP endpoint.
 * @param command - Optional process executable.
 * @param url - Optional HTTP endpoint.
 * @param field - Config path used in the error.
 * @returns `undefined` when transport declarations do not conflict.
 * @throws When both process and HTTP transports are declared.
 */
export function rejectMixedMcpTransports(command: string | undefined, url: string | undefined, field: string): void {
  if (command !== undefined && url !== undefined) throw new Error(`${field} must declare only one MCP transport`)
}

/** Whether one native environment key is valid across supported process hosts. */
function isEnvironmentName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
}
