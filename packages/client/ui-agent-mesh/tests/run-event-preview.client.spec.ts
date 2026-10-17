import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentRunEvent, AgentRunId } from '@deepseek-ai/dsh-agent-mesh/types'
import { runEventPreview } from '../src/client/run-event-preview.ts'

const RUN_ID = brandString<AgentRunId>('run-preview')
const CODEX_ID = brandString<AgentId>('codex')
const AT = '2026-10-17T00:00:00.000Z'

describe('run event previews', () => {
  it('shows bounded progress while omitting reasoning and native payloads', () => {
    const events: readonly AgentRunEvent[] = [
      { kind: 'message.delta', runId: RUN_ID, at: AT, text: 'working' },
      { kind: 'message.completed', runId: RUN_ID, at: AT, text: 'finished' },
      { kind: 'reasoning.delta', runId: RUN_ID, at: AT, text: 'private reasoning' },
      { kind: 'tool.started', runId: RUN_ID, at: AT, toolName: 'read_file', input: 'private input' },
      { kind: 'tool.completed', runId: RUN_ID, at: AT, toolName: 'write_file', output: 'private output' },
      { kind: 'files.changed', runId: RUN_ID, at: AT, paths: ['src/app.ts', 'src/ui.tsx'] },
      { kind: 'warning', runId: RUN_ID, at: AT, message: 'a warning' },
      { kind: 'unknown', runId: RUN_ID, at: AT, nativeType: 'future.event', native: '{"secret":true}' },
      { kind: 'unknown', runId: RUN_ID, at: AT, native: '{"secret":true}' },
      { kind: 'session.bound', runId: RUN_ID, at: AT, nativeSessionId: 'session-1' },
      { kind: 'todos.updated', runId: RUN_ID, at: AT, todos: [{ content: 'review', status: 'pending' }] },
      { kind: 'run.started', runId: RUN_ID, agentId: CODEX_ID, at: AT },
      { kind: 'usage.updated', runId: RUN_ID, at: AT, usage: {} },
    ]

    expect(events.map(runEventPreview)).toEqual([
      'working', 'finished', null, 'read_file', 'write_file', 'src/app.ts, src/ui.tsx',
      'a warning', 'future.event', null, 'session-1', '1', null, null,
    ])
  })

  it('clips long message, path, and warning previews', () => {
    const longValue = 'x'.repeat(321)
    const clipped = `${'x'.repeat(320)}…`

    expect(runEventPreview({ kind: 'message.delta', runId: RUN_ID, at: AT, text: longValue })).toBe(clipped)
    expect(runEventPreview({ kind: 'files.changed', runId: RUN_ID, at: AT, paths: [longValue] })).toBe(clipped)
    expect(runEventPreview({ kind: 'warning', runId: RUN_ID, at: AT, message: longValue })).toBe(clipped)
  })
})
