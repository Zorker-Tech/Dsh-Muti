import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_LOGOUT_TIMEOUT_MS,
  DEFAULT_INTERRUPT_GRACE_MS,
  DEFAULT_RUN_MODE,
  DEFAULT_TASK_TAIL_BYTES,
  DEFAULT_TRANSCRIPT_TAIL_BYTES,
  DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  resolveCodexConfig,
} from '../src/config.ts'

describe('Codex adapter configuration', () => {
  it('resolves empty configuration to the documented defaults', () => {
    expect(resolveCodexConfig()).toEqual({
      binaryPath: undefined,
      homeDir: undefined,
      env: {},
      model: undefined,
      runMode: DEFAULT_RUN_MODE,
      sandbox: undefined,
      approval: undefined,
      timeoutMs: 0,
      interruptGraceMs: DEFAULT_INTERRUPT_GRACE_MS,
      transcriptTailBytes: DEFAULT_TRANSCRIPT_TAIL_BYTES,
      taskTailBytes: DEFAULT_TASK_TAIL_BYTES,
      loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
      logoutTimeoutMs: DEFAULT_LOGOUT_TIMEOUT_MS,
      versionProbeTimeoutMs: DEFAULT_VERSION_PROBE_TIMEOUT_MS,
    })
  })

  it('keeps only non-empty strings and positive integer budgets', () => {
    expect(resolveCodexConfig({
      binaryPath: '/opt/codex',
      homeDir: '/home/codex',
      env: { CODEX_HOME: '/home/codex' },
      model: 'gpt-5-codex',
      runMode: 'headless-exec',
      sandbox: 'workspace-write',
      approval: 'on-request',
      timeoutMs: 0,
      transcriptTailBytes: 2_000,
      taskTailBytes: 3_000,
      loginTimeoutMs: 4_000,
      logoutTimeoutMs: 5_000,
      versionProbeTimeoutMs: 6_000,
      interruptGraceMs: 7_000,
    })).toMatchObject({
      binaryPath: '/opt/codex', homeDir: '/home/codex', env: { CODEX_HOME: '/home/codex' },
      model: 'gpt-5-codex', runMode: 'headless-exec', sandbox: 'workspace-write', approval: 'on-request', timeoutMs: 0,
      interruptGraceMs: 7_000,
      transcriptTailBytes: 2_000, taskTailBytes: 3_000, loginTimeoutMs: 4_000,
      logoutTimeoutMs: 5_000, versionProbeTimeoutMs: 6_000,
    })
  })

  it('replaces empty strings and invalid budgets with defaults', () => {
    expect(resolveCodexConfig({
      binaryPath: '', homeDir: '', model: '', sandbox: '', approval: '',
      timeoutMs: -1, interruptGraceMs: -1, transcriptTailBytes: 1.5, taskTailBytes: 0,
      loginTimeoutMs: -1, logoutTimeoutMs: Number.POSITIVE_INFINITY, versionProbeTimeoutMs: 0,
    })).toMatchObject({
      binaryPath: undefined, homeDir: undefined, model: undefined, sandbox: undefined, approval: undefined,
      timeoutMs: 0,
      interruptGraceMs: DEFAULT_INTERRUPT_GRACE_MS,
      transcriptTailBytes: DEFAULT_TRANSCRIPT_TAIL_BYTES,
      taskTailBytes: DEFAULT_TASK_TAIL_BYTES,
      loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
      logoutTimeoutMs: DEFAULT_LOGOUT_TIMEOUT_MS,
      versionProbeTimeoutMs: DEFAULT_VERSION_PROBE_TIMEOUT_MS,
    })
  })

  it('rejects an unknown run transport', () => {
    // @ts-expect-error Exercise the resolver's runtime check for untyped configuration input.
    expect(() => resolveCodexConfig({ runMode: 'unknown' })).toThrow(
      'runMode must be "duplex-protocol" or "headless-exec"',
    )
  })
})
