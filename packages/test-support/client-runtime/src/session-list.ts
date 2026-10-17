import type { SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Build a successful Session-list response with an empty native-agent catalog by default.
 * @param value - the existing session rows and any supplied native-agent catalog.
 * @returns a successful response with both native-agent lists populated.
 */
export function sessionListSuccess(
  value: Pick<SessionListValue, 'items'> & Partial<Pick<SessionListValue, 'agentSessions' | 'agentSessionFailures'>>,
): RemoteResult<SessionListValue> {
  return {
    ok: true,
    value: {
      ...value,
      agentSessions: value.agentSessions ?? [],
      agentSessionFailures: value.agentSessionFailures ?? [],
    },
  }
}
