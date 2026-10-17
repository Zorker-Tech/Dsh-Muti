// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentsPanelIcon } from '../src/client/AgentsPanelIcon.tsx'
import { apply } from '../src/index.ts'
import { standardProps } from './standard-props.ts'

afterEach(cleanup)

describe('Agent mesh entry points', () => {
  it('keeps the host plugin entry callable without mounting browser behavior', () => {
    expect(apply).not.toThrow()
  })

  it('renders the decorative sidebar icon at the size supplied by its owner', () => {
    const view = render(<AgentsPanelIcon {...standardProps} size={18} active={false} />)
    expect(view.container.querySelector('svg')).not.toBeNull()
  })
})
