/**
 * Presentation projections of the mesh wire vocabulary: the dictionary key of
 * each projected status, an agent's display name, and a safe rendering of a
 * timestamp a store may have recorded malformed.
 */

import type {
  AgentAuthSource, AgentAuthStatus, AgentLoginFlow, AgentMessageRole, AgentRunStatus, AgentTodoStatus,
} from '@deepseek-ai/dsh-agent-mesh/types'
import type { MeshAgentRow, MeshLaunchShell } from '@deepseek-ai/dsh-agent-mesh-controller/types'
import type { AgentMeshKey } from './locales.ts'

/** Session statuses an agent's own store can report; any other value stays verbatim. */
const SESSION_STATUS_KEYS: Readonly<Record<string, AgentMeshKey>> = {
  idle: 'sessions.status.idle',
  running: 'sessions.status.running',
  unreadable: 'sessions.status.unreadable',
}

/** Message roles, each with its own row label. */
const MESSAGE_ROLE_KEYS: Readonly<Record<AgentMessageRole, AgentMeshKey>> = {
  user: 'transcript.role.user',
  assistant: 'transcript.role.assistant',
  system: 'transcript.role.system',
  tool: 'transcript.role.tool',
  unknown: 'transcript.role.unknown',
}

/** Native todo statuses of every adapter vocabulary. */
const TODO_STATUS_KEYS: Readonly<Record<AgentTodoStatus, AgentMeshKey>> = {
  pending: 'tasks.status.pending',
  in_progress: 'tasks.status.in_progress',
  completed: 'tasks.status.completed',
  blocked: 'tasks.status.blocked',
  cancelled: 'tasks.status.cancelled',
}

/** Terminal and live states of a dispatched run. */
const RUN_STATUS_KEYS: Readonly<Record<AgentRunStatus, AgentMeshKey>> = {
  running: 'runs.status.running',
  succeeded: 'runs.status.succeeded',
  failed: 'runs.status.failed',
  cancelled: 'runs.status.cancelled',
  timeout: 'runs.status.timeout',
}

/** Coarse credential states. */
const AUTH_STATUS_KEYS: Readonly<Record<AgentAuthStatus, AgentMeshKey>> = {
  authenticated: 'accounts.status.authenticated',
  unauthenticated: 'accounts.status.unauthenticated',
  expired: 'accounts.status.expired',
  misconfigured: 'accounts.status.misconfigured',
  unknown: 'accounts.status.unknown',
}

/** Where an observed credential state came from. */
const AUTH_SOURCE_KEYS: Readonly<Record<AgentAuthSource, AgentMeshKey>> = {
  env: 'accounts.source.env',
  file: 'accounts.source.file',
  keyring: 'accounts.source.keyring',
  'cli-probe': 'accounts.source.cli-probe',
  none: 'accounts.source.none',
}

/** Login flows an adapter can perform. */
const LOGIN_FLOW_KEYS: Readonly<Record<AgentLoginFlow, AgentMeshKey>> = {
  'oauth-loopback': 'accounts.flow.oauth-loopback',
  'device-code': 'accounts.flow.device-code',
  'api-key': 'accounts.flow.api-key',
  interactive: 'accounts.flow.interactive',
}

/**
 * Every login flow an agent may declare, in the order the mesh vocabulary
 * lists them; the adapter reports an undeclared flow as a Remote failure.
 */
export const LOGIN_FLOWS: readonly AgentLoginFlow[] = ['oauth-loopback', 'device-code', 'api-key', 'interactive']

/**
 * Reduce an arbitrary reported status to its dictionary key.
 * @param map - key table of one closed vocabulary.
 * @param value - status string as the agent's store reported it.
 * @returns the dictionary key, or null when the store reported another value.
 */
function knownKey(map: Readonly<Record<string, AgentMeshKey>>, value: string): AgentMeshKey | null {
  if (!Object.hasOwn(map, value)) return null
  // The own-property check proves this key is present in the closed table.
  return map[value] as AgentMeshKey
}

/**
 * Dictionary key of one session status; a store-specific value has none.
 * @param status - status string from the session row.
 * @returns the dictionary key, or null to render the reported value verbatim.
 */
export function sessionStatusKey(status: string): AgentMeshKey | null {
  return knownKey(SESSION_STATUS_KEYS, status)
}

/**
 * Dictionary key of one message role.
 * @param role - projected message role.
 * @returns the dictionary key of the role label.
 */
export function messageRoleKey(role: AgentMessageRole): AgentMeshKey {
  return MESSAGE_ROLE_KEYS[role]
}

/**
 * Dictionary key of one native todo status.
 * @param status - projected todo status.
 * @returns the dictionary key of the status label.
 */
export function todoStatusKey(status: AgentTodoStatus): AgentMeshKey {
  return TODO_STATUS_KEYS[status]
}

/**
 * Dictionary key of one run status.
 * @param status - status the run registry reports.
 * @returns the dictionary key of the status label.
 */
export function runStatusKey(status: AgentRunStatus): AgentMeshKey {
  return RUN_STATUS_KEYS[status]
}

/**
 * Dictionary key of one credential status.
 * @param status - coarse status the adapter observed.
 * @returns the dictionary key of the status label.
 */
export function authStatusKey(status: AgentAuthStatus): AgentMeshKey {
  return AUTH_STATUS_KEYS[status]
}

/**
 * Dictionary key of one credential source.
 * @param source - surface the adapter observed the credential on.
 * @returns the dictionary key of the source label.
 */
export function authSourceKey(source: AgentAuthSource): AgentMeshKey {
  return AUTH_SOURCE_KEYS[source]
}

/**
 * Dictionary key of one login flow.
 * @param flow - flow an adapter can perform.
 * @returns the dictionary key of the flow label.
 */
export function loginFlowKey(flow: AgentLoginFlow): AgentMeshKey {
  return LOGIN_FLOW_KEYS[flow]
}

/**
 * Name one agent as a person reads it, falling back to its registry id.
 * @param agents - known agent rows.
 * @param agentId - registry identity to name.
 * @returns the display name, or the id when the roster does not carry it.
 */
export function agentLabel(agents: readonly MeshAgentRow[], agentId: string): string {
  return agents.find(agent => agent.agentId === agentId)?.displayName ?? agentId
}

/**
 * Render an ISO-8601 timestamp in the browser's locale.
 * @param value - timestamp a store recorded.
 * @returns the localized moment, or the recorded value when it is not a date.
 */
export function moment(value: string): string {
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString()
}

/**
 * Quote adapter-supplied argv for the shell running on the DSH Host.
 * @param argv - executable and arguments kept as separate values by the adapter.
 * @param shell - shell dialect reported by the Host.
 * @returns one command line that preserves each argv element.
 */
export function nativeLaunchCommandText(argv: readonly string[], shell: MeshLaunchShell): string {
  const quote = shell === 'powershell'
    ? (value: string): string => `'${value.replaceAll("'", "''")}'`
    : (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  return argv.map(quote).join(' ')
}
