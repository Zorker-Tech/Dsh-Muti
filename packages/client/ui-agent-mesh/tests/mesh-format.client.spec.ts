import { describe, expect, it } from 'vitest'
import type {
  AgentAuthSource, AgentAuthStatus, AgentMessageRole, AgentRunStatus, AgentTodoStatus,
} from '@deepseek-ai/dsh-agent-mesh/types'
import type { MeshAgentRow } from '@deepseek-ai/dsh-agent-mesh-controller/types'
import {
  LOGIN_FLOWS, agentLabel, authSourceKey, authStatusKey, loginFlowKey, messageRoleKey,
  moment, nativeLaunchCommandText, runStatusKey, sessionStatusKey, todoStatusKey,
} from '../src/client/mesh-format.ts'
import { en, zh, type AgentMeshKey } from '../src/client/locales.ts'

/** Every role the wire vocabulary can project, so each label is accounted for. */
const MESSAGE_ROLES: readonly AgentMessageRole[] = ['user', 'assistant', 'system', 'tool', 'unknown']

/** Every native todo status an adapter vocabulary records. */
const TODO_STATUSES: readonly AgentTodoStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled']

/** Every terminal and live state of a dispatched run. */
const RUN_STATUSES: readonly AgentRunStatus[] = ['running', 'succeeded', 'failed', 'cancelled', 'timeout']

/** Every coarse credential state. */
const AUTH_STATUSES: readonly AgentAuthStatus[] = ['authenticated', 'unauthenticated', 'expired', 'misconfigured', 'unknown']

/** Every credential surface an adapter can observe. */
const AUTH_SOURCES: readonly AgentAuthSource[] = ['env', 'file', 'keyring', 'cli-probe', 'none']

const AGENT: MeshAgentRow = {
  agentId: 'codex', displayName: 'Codex', installed: true, version: '1.2.3', warnings: [],
}

/**
 * Assert a projected key is one the panel can render: both dictionaries own it
 * with copy, so `t(key)` never falls back to the bare key.
 * @param key - dictionary key a projection returned.
 */
function expectCopy(key: AgentMeshKey): void {
  expect(Object.hasOwn(en, key)).toBe(true)
  expect(Object.hasOwn(zh, key)).toBe(true)
  expect([en[key], zh[key]].every(value => value !== '')).toBe(true)
}

describe('mesh status and label projection', () => {
  it('maps the session statuses the vocabulary names, leaving any other value to render verbatim', () => {
    expect(['idle', 'running', 'unreadable'].map(status => sessionStatusKey(status))).toEqual([
      'sessions.status.idle', 'sessions.status.running', 'sessions.status.unreadable',
    ])
    // A store-specific status has no dictionary key, so the panel repeats it.
    expect(sessionStatusKey('compacting')).toBeNull()
  })

  it('labels every projected message role', () => {
    expect(MESSAGE_ROLES.map(messageRoleKey)).toEqual([
      'transcript.role.user', 'transcript.role.assistant', 'transcript.role.system',
      'transcript.role.tool', 'transcript.role.unknown',
    ])
    for (const role of MESSAGE_ROLES) expectCopy(messageRoleKey(role))
  })

  it('labels every native todo status', () => {
    expect(TODO_STATUSES.map(todoStatusKey)).toEqual([
      'tasks.status.pending', 'tasks.status.in_progress', 'tasks.status.completed',
      'tasks.status.blocked', 'tasks.status.cancelled',
    ])
    for (const status of TODO_STATUSES) expectCopy(todoStatusKey(status))
  })

  it('labels every run status', () => {
    expect(RUN_STATUSES.map(runStatusKey)).toEqual([
      'runs.status.running', 'runs.status.succeeded', 'runs.status.failed',
      'runs.status.cancelled', 'runs.status.timeout',
    ])
    for (const status of RUN_STATUSES) expectCopy(runStatusKey(status))
  })

  it('labels every credential state and source', () => {
    expect(AUTH_STATUSES.map(authStatusKey)).toEqual([
      'accounts.status.authenticated', 'accounts.status.unauthenticated', 'accounts.status.expired',
      'accounts.status.misconfigured', 'accounts.status.unknown',
    ])
    expect(AUTH_SOURCES.map(authSourceKey)).toEqual([
      'accounts.source.env', 'accounts.source.file', 'accounts.source.keyring',
      'accounts.source.cli-probe', 'accounts.source.none',
    ])
    for (const status of AUTH_STATUSES) expectCopy(authStatusKey(status))
    for (const source of AUTH_SOURCES) expectCopy(authSourceKey(source))
  })

  it('labels every login flow an adapter may declare', () => {
    expect(LOGIN_FLOWS).toEqual(['oauth-loopback', 'device-code', 'api-key', 'interactive'])
    expect(LOGIN_FLOWS.map(loginFlowKey)).toEqual([
      'accounts.flow.oauth-loopback', 'accounts.flow.device-code',
      'accounts.flow.api-key', 'accounts.flow.interactive',
    ])
    for (const flow of LOGIN_FLOWS) expectCopy(loginFlowKey(flow))
  })

  it('names an agent by its row and falls back to the registry id for an unknown one', () => {
    expect(agentLabel([AGENT], 'codex')).toBe('Codex')
    expect(agentLabel([AGENT], 'grok')).toBe('grok')
    expect(agentLabel([], 'codex')).toBe('codex')
  })

  it('renders a recorded timestamp in the browser locale and repeats a malformed one', () => {
    const recorded = '2026-10-16T08:00:00.000Z'
    expect(moment(recorded)).toBe(new Date(recorded).toLocaleString())
    expect(moment(recorded)).not.toBe(recorded)
    expect(moment('not a date')).toBe('not a date')
  })

  it('quotes every argv element for the DSH Host shell without evaluating its contents', () => {
    expect(nativeLaunchCommandText(['/Applications/My CLI/codex', 'resume', "a'b", '$HOME'], 'posix'))
      .toBe("'/Applications/My CLI/codex' 'resume' 'a'\\''b' '$HOME'")
    expect(nativeLaunchCommandText(['C:\\Program Files\\codex.exe', 'resume', "a'b", '$env:HOME'], 'powershell'))
      .toBe("'C:\\Program Files\\codex.exe' 'resume' 'a''b' '$env:HOME'")
    expect(nativeLaunchCommandText([], 'posix')).toBe('')
  })
})
