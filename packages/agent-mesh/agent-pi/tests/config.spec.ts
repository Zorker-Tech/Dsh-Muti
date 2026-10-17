/**
 * Adapter configuration resolution: every deployment choice becomes explicit.
 * @module @deepseek-ai/dsh-agent-pi/tests/config
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_INTERRUPT_GRACE_MS, DEFAULT_RUN_MODE, resolvePiConfig } from '../src/config.ts'

describe('pi adapter configuration', () => {
  it('resolves an absent configuration to the documented defaults', () => {
    expect(resolvePiConfig()).toEqual({
      binaryPath: undefined,
      homeDir: undefined,
      sessionDir: undefined,
      env: {},
      runMode: DEFAULT_RUN_MODE,
      interruptGraceMs: DEFAULT_INTERRUPT_GRACE_MS,
    })
  })

  it('trims configured paths and drops blank ones', () => {
    expect(
      resolvePiConfig({
        binaryPath: '  /opt/pi/bin/pi  ',
        homeDir: '   ',
        sessionDir: '\t~/.pi/sessions\n',
        env: { PI_CODING_AGENT_DIR: '/custom' },
        runMode: 'headless-exec',
        interruptGraceMs: 25,
      }),
    ).toEqual({
      binaryPath: '/opt/pi/bin/pi',
      homeDir: undefined,
      sessionDir: '~/.pi/sessions',
      env: { PI_CODING_AGENT_DIR: '/custom' },
      runMode: 'headless-exec',
      interruptGraceMs: 25,
    })
  })

  it('rejects unsupported transports and resolves invalid interrupt grace to the default', () => {
    let failure: unknown
    try {
      Reflect.apply(resolvePiConfig, undefined, [{ runMode: 'unknown' }])
    } catch (cause: unknown) {
      failure = cause
    }
    expect(failure).toBeInstanceOf(TypeError)
    if (failure instanceof TypeError) expect(failure.message).toContain('runMode must be')
    expect(resolvePiConfig({ interruptGraceMs: 0 }).interruptGraceMs).toBe(DEFAULT_INTERRUPT_GRACE_MS)
  })
})
