/**
 * Safe, compact previews for events shown in the Agent mesh run list.
 *
 * The run view does not repeat tool input or output, native payloads, or
 * reasoning text. It shows bounded assistant text and the public event data
 * needed to identify progress.
 */

import type { AgentRunEvent } from '@deepseek-ai/dsh-agent-mesh/types'

const MAX_PREVIEW_CHARS = 320

/** Bound one text preview so a single run event cannot dominate the panel. */
function bounded(value: string): string {
  return value.length > MAX_PREVIEW_CHARS ? `${value.slice(0, MAX_PREVIEW_CHARS)}…` : value
}

/**
 * Return the non-sensitive summary for one run event.
 * @param event - Event projected by the agent adapter.
 * @returns A short preview, or null when the event has no safe display detail.
 */
export function runEventPreview(event: AgentRunEvent): string | null {
  if (event.kind === 'reasoning.delta') return null
  if ('text' in event) return bounded(event.text)
  if ('toolName' in event) return event.toolName
  if ('paths' in event) return bounded(event.paths.join(', '))
  if ('message' in event) return bounded(event.message)
  if ('nativeType' in event) {
    /* v8 ignore next -- JSON-backed Session events omit nativeType rather than storing undefined. */
    return event.nativeType ?? null
  }
  if ('nativeSessionId' in event) return event.nativeSessionId
  if ('todos' in event) return String(event.todos.length)
  return null
}
