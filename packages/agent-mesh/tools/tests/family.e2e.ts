import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

interface FamilyReport {
  readonly meshMounted: boolean
  readonly toolsRegistered: readonly string[]
  readonly toolsMissing: readonly string[]
  readonly bindingsReady: boolean
  readonly adapterIds: readonly string[]
  readonly diagnosticsAgents: number
  readonly collaborationMounted: boolean
  readonly collaborationToolsMissing: readonly string[]
  readonly commandNames: readonly string[]
  readonly collaborationBoard?: { readonly todos: number; readonly phases: number }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseFamilyReport(source: string): FamilyReport {
  const value: unknown = JSON.parse(source)
  const record = asRecord(value)
  if (record === undefined) throw new Error('the family fixture report is not an object')
  const toolsRegistered = record['toolsRegistered']
  const toolsMissing = record['toolsMissing']
  const adapterIds = record['adapterIds']
  const collaborationToolsMissing = record['collaborationToolsMissing']
  const commandNames = record['commandNames']
  if (!stringList(toolsRegistered)) throw new Error('the family fixture report has invalid toolsRegistered')
  if (!stringList(toolsMissing)) throw new Error('the family fixture report has invalid toolsMissing')
  if (!stringList(adapterIds)) throw new Error('the family fixture report has invalid adapterIds')
  if (!stringList(collaborationToolsMissing)) throw new Error('the family fixture report has invalid collaborationToolsMissing')
  if (!stringList(commandNames)) throw new Error('the family fixture report has invalid commandNames')
  const meshMounted = record['meshMounted']
  const bindingsReady = record['bindingsReady']
  const collaborationMounted = record['collaborationMounted']
  const diagnosticsAgents = record['diagnosticsAgents']
  if (typeof meshMounted !== 'boolean') throw new Error('the family fixture report has invalid meshMounted')
  if (typeof bindingsReady !== 'boolean') throw new Error('the family fixture report has invalid bindingsReady')
  if (typeof collaborationMounted !== 'boolean') throw new Error('the family fixture report has invalid collaborationMounted')
  if (typeof diagnosticsAgents !== 'number') throw new Error('the family fixture report has invalid diagnosticsAgents')
  const boardValue = record['collaborationBoard']
  const board = boardValue === undefined ? undefined : asRecord(boardValue)
  let collaborationBoard: { readonly todos: number; readonly phases: number } | undefined
  if (boardValue !== undefined) {
    if (board === undefined || typeof board['todos'] !== 'number' || typeof board['phases'] !== 'number') {
      throw new Error('the family fixture report has invalid collaborationBoard')
    }
    collaborationBoard = { todos: board['todos'], phases: board['phases'] }
  }
  return {
    meshMounted,
    toolsRegistered,
    toolsMissing,
    bindingsReady,
    adapterIds,
    diagnosticsAgents,
    collaborationMounted,
    collaborationToolsMissing,
    commandNames,
    ...(collaborationBoard === undefined ? {} : { collaborationBoard }),
  }
}

/**
 * The seam, its tools, and its controller mount in a real shipped profile:
 * the Loader resolves each row, the registry answers, and every mesh tool is
 * registered on the tool runtime. This is the composition test that catches a
 * row which type-checks but never activates (a plugin that loses its `inject`
 * through `exports.default`, for example).
 */
it('mounts the agent-mesh family in the shipped headless profile', async () => {
  const driver = resolve(import.meta.dirname, 'fixtures/family.host.ts')
  let captured: FamilyReport | undefined

  await runLoaderSmoke({
    label: 'agent-mesh family',
    tempDirPrefix: 'agent-mesh-family-',
    binScript: driver,
    libBinScript: driver,
    configPath: resolve(import.meta.dirname, 'fixtures/family.patch.yml'),
    tsconfigPath: resolve(import.meta.dirname, '../../../../tsconfig.base.json'),
    inspect: async (cwd) => {
      captured = parseFamilyReport(await readFile(resolve(cwd, 'agent-mesh-family-report.json'), 'utf8'))
    },
  })

  if (captured === undefined) throw new Error('the fixture wrote no report')
  expect(captured.meshMounted).toBe(true)
  expect(captured.bindingsReady).toBe(true)
  expect(captured.toolsMissing).toEqual([])
  expect(captured.toolsRegistered).toHaveLength(8)
  // Every agent row registers on the seam, in row order. Whether a binary is
  // installed is this machine's fact, so only registration is asserted here.
  expect(captured.adapterIds).toEqual(['codex', 'grok', 'pi', 'omp'])
  expect(captured.diagnosticsAgents).toBe(4)
  // The collaboration capability mounts beside the seam and answers a real
  // plan/todo round trip inside the booted profile.
  expect(captured.collaborationMounted).toBe(true)
  expect(captured.collaborationToolsMissing).toEqual([])
  expect(captured.commandNames).toEqual(expect.arrayContaining([
    'agents', 'agent-sessions', 'agent-refresh', 'agents-diagnostics', 'mesh-runs', 'mesh-state',
  ]))
  expect(captured.collaborationBoard).toEqual({ todos: 1, phases: 1 })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
