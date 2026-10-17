import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

/** The stores a machine must have for this check to mean anything. */
const INSTALLED_MARKERS: readonly { readonly agentId: string; readonly path: string }[] = [
  { agentId: 'codex', path: join(homedir(), '.codex', 'sessions') },
  { agentId: 'grok', path: join(homedir(), '.grok', 'sessions') },
  { agentId: 'pi', path: join(homedir(), '.pi', 'agent', 'sessions') },
  { agentId: 'omp', path: join(homedir(), '.omp', 'agent', 'sessions') },
]
const present = INSTALLED_MARKERS.filter(marker => existsSync(marker.path))

/** One agent's observation, as the fixture reports it. */
interface AgentObservation {
  readonly agentId: string
  readonly installed: boolean
  readonly version: string
  readonly detectionReason: string
  readonly sessionCount: number
  readonly firstSessionKey: string
  readonly firstSessionTitle: string
  readonly firstSessionStatus: string
  readonly firstSessionNotes?: readonly string[]
  readonly transcriptMessages: number
  readonly transcriptKinds: readonly string[]
  readonly nativeTodos: number
  readonly nativePlanItems: number
  readonly authStatus: string
  readonly authSource: string
  readonly error?: string
  readonly cliStoreRoundTrip?: {
    readonly nativeId: string
    readonly cwd: string
    readonly headerVersion: number
    readonly entryTypes: readonly string[]
    readonly transcriptMessages: number
    readonly runStatus: string
    readonly runSessionKey: string
    readonly runEventKinds: readonly string[]
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw new Error(`agent store report has invalid ${field}`)
  return value
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number') throw new Error(`agent store report has invalid ${field}`)
  return value
}

function requiredStrings(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field]
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`agent store report has invalid ${field}`)
  }
  return value
}

function parseObservation(value: unknown): AgentObservation {
  const record = asRecord(value)
  if (record === undefined || typeof record['installed'] !== 'boolean') {
    throw new Error('agent store report contains an invalid agent row')
  }
  const notes = record['firstSessionNotes']
  const error = record['error']
  const cliStoreRoundTrip = record['cliStoreRoundTrip']
  if (notes !== undefined && (!Array.isArray(notes) || !notes.every(item => typeof item === 'string'))) {
    throw new Error('agent store report has invalid firstSessionNotes')
  }
  if (error !== undefined && typeof error !== 'string') throw new Error('agent store report has invalid error')
  let parsedCliStoreRoundTrip: AgentObservation['cliStoreRoundTrip']
  if (cliStoreRoundTrip !== undefined) {
    const roundTrip = asRecord(cliStoreRoundTrip)
    if (roundTrip === undefined) throw new Error('agent store report has invalid cliStoreRoundTrip')
    parsedCliStoreRoundTrip = {
      nativeId: requiredString(roundTrip, 'nativeId'),
      cwd: requiredString(roundTrip, 'cwd'),
      headerVersion: requiredNumber(roundTrip, 'headerVersion'),
      entryTypes: requiredStrings(roundTrip, 'entryTypes'),
      transcriptMessages: requiredNumber(roundTrip, 'transcriptMessages'),
      runStatus: requiredString(roundTrip, 'runStatus'),
      runSessionKey: requiredString(roundTrip, 'runSessionKey'),
      runEventKinds: requiredStrings(roundTrip, 'runEventKinds'),
    }
  }
  return {
    agentId: requiredString(record, 'agentId'),
    installed: record['installed'],
    version: requiredString(record, 'version'),
    detectionReason: requiredString(record, 'detectionReason'),
    sessionCount: requiredNumber(record, 'sessionCount'),
    firstSessionKey: requiredString(record, 'firstSessionKey'),
    firstSessionTitle: requiredString(record, 'firstSessionTitle'),
    firstSessionStatus: requiredString(record, 'firstSessionStatus'),
    ...(notes === undefined ? {} : { firstSessionNotes: notes }),
    transcriptMessages: requiredNumber(record, 'transcriptMessages'),
    transcriptKinds: requiredStrings(record, 'transcriptKinds'),
    nativeTodos: requiredNumber(record, 'nativeTodos'),
    nativePlanItems: requiredNumber(record, 'nativePlanItems'),
    authStatus: requiredString(record, 'authStatus'),
    authSource: requiredString(record, 'authSource'),
    ...(error === undefined ? {} : { error }),
    ...(parsedCliStoreRoundTrip === undefined ? {} : { cliStoreRoundTrip: parsedCliStoreRoundTrip }),
  }
}

function parseObservations(source: string): AgentObservation[] {
  const value: unknown = JSON.parse(source)
  if (!Array.isArray(value)) throw new Error('agent store report is not an array')
  return value.map(parseObservation)
}

/**
 * Reads real agent stores through the family: the adapters must detect each
 * installed agent, list its own sessions, project a transcript into messages,
 * and report a credential state. Skipped on a machine with none of these
 * agents, because there would be nothing real to read.
 */
it.skipIf(present.length === 0)('reads the installed agents\' own stores through the mesh', async () => {
  const driver = resolve(import.meta.dirname, 'fixtures/real-stores.host.ts')
  let captured: AgentObservation[] | undefined
  await runLoaderSmoke({
    label: 'agent-mesh real stores',
    tempDirPrefix: 'agent-mesh-real-',
    binScript: driver,
    libBinScript: driver,
    configPath: resolve(import.meta.dirname, 'fixtures/family.patch.yml'),
    tsconfigPath: resolve(import.meta.dirname, '../../../../tsconfig.base.json'),
    inspect: async (cwd) => {
      captured = parseObservations(await readFile(resolve(cwd, 'agent-mesh-real-stores.json'), 'utf8'))
    },
  })

  const rows = captured ?? []
  // Printed so a passing run states what it actually read from this machine.
  console.info(JSON.stringify(rows.map(row => ({
    agent: row.agentId, installed: row.installed, version: row.version,
    sessions: row.sessionCount, first: row.firstSessionKey, status: row.firstSessionStatus,
    messages: row.transcriptMessages, kinds: row.transcriptKinds, notes: row.firstSessionNotes,
    cliStoreRoundTrip: row.cliStoreRoundTrip,
    auth: `${row.authStatus}/${row.authSource}`, todos: row.nativeTodos, plan: row.nativePlanItems,
    error: row.error ?? '',
  })), null, 1))
  expect(rows.map(row => row.agentId).sort()).toEqual(['codex', 'grok', 'omp', 'pi'])

  for (const marker of present) {
    const row = rows.find(candidate => candidate.agentId === marker.agentId)
    expect(row, `${marker.agentId} row`).toBeDefined()
    // The adapter must not fail on a real store.
    expect(row?.error ?? '', `${marker.agentId} error`).toBe('')
    expect(row?.installed, `${marker.agentId} detection`).toBe(true)
    expect(row?.version ?? '', `${marker.agentId} version ${JSON.stringify(row)}`).not.toBe('')
    // A real store with sessions must list them, and the newest one must project
    // into at least one message with a recognized role/kind.
    if ((row?.sessionCount ?? 0) > 0) {
      expect(row?.firstSessionKey, `${marker.agentId} key`).toMatch(new RegExp(`^${marker.agentId}:`))
      expect(row?.firstSessionStatus, `${marker.agentId} status`).not.toBe('')
      expect(row?.transcriptMessages, `${marker.agentId} messages`).toBeGreaterThan(0)
      expect(row?.transcriptKinds ?? [], `${marker.agentId} kinds`).not.toContain('')
    }
    expect(
      ['authenticated', 'unauthenticated', 'expired', 'misconfigured', 'unknown'],
      `${marker.agentId} auth`,
    ).toContain(row?.authStatus)
    expect(['env', 'file', 'keyring', 'cli-probe', 'none']).toContain(row?.authSource)
    if (marker.agentId === 'omp' && row?.installed) {
      expect(row.cliStoreRoundTrip, 'OMP session created through the DSH RPC adapter').toBeDefined()
      expect(row.cliStoreRoundTrip?.cwd).toBeTypeOf('string')
      expect(row.cliStoreRoundTrip?.headerVersion).toBe(3)
      expect(row.cliStoreRoundTrip?.runStatus).toBe('succeeded')
      expect(row.cliStoreRoundTrip?.runSessionKey).toMatch(/^omp:/)
      expect(row.cliStoreRoundTrip?.nativeId).not.toBe('')
      expect(row.cliStoreRoundTrip?.entryTypes).toContain('thinking_level_change')
      expect(row.cliStoreRoundTrip?.runEventKinds).toEqual(expect.arrayContaining(['run.started', 'session.bound', 'run.finished']))
    }
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
