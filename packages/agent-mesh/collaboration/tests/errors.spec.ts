import { describe, expect, it } from 'vitest'
import { CollaborationError } from '../src/errors.ts'

describe('CollaborationError', () => {
  it('preserves optional causes and remediation', () => {
    const plain = new CollaborationError('mesh/task-not-found', 'Task missing')
    expect(plain.name).toBe('CollaborationError')
    expect(plain.code).toBe('mesh/task-not-found')
    expect(plain.cause).toBeUndefined()
    expect(plain.remediation).toBeUndefined()

    const cause = new Error('storage failed')
    const detailed = new CollaborationError('worktree/create-failed', 'Could not create worktree', { cause, remediation: 'Check git access' })
    expect(detailed.cause).toBe(cause)
    expect(detailed.remediation).toBe('Check git access')
  })
})
