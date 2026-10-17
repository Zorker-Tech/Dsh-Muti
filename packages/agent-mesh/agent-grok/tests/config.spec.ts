import { describe, expect, it } from 'vitest'
import { DEFAULT_RUN_MODE, resolveGrokConfig } from '../src/config.ts'

describe('Grok adapter configuration', () => {
  it('resolves an empty configuration to the documented defaults', () => {
    expect(resolveGrokConfig()).toMatchObject({ runMode: DEFAULT_RUN_MODE, timeoutMs: 0, maxTurns: undefined })
  })

  it('rejects an unknown run transport', () => {
    // @ts-expect-error Exercise the resolver's runtime check for untyped configuration input.
    expect(() => resolveGrokConfig({ runMode: 'unknown' })).toThrow(
      'runMode must be "duplex-protocol" or "headless-exec"',
    )
  })
})
