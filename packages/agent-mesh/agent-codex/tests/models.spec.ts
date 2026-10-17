import { describe, expect, it } from 'vitest'
import { codexAdapter } from '../src/index.ts'
import { scanConfig } from '../src/models.ts'
import { FakeHost } from './fake-host.ts'

const CONFIG = '/home/tester/.codex/config.toml'

describe('model configuration scan', () => {
  it('reads top-level string assignments before the first table', () => {
    const scan = scanConfig(
      [
        '# a comment',
        'model = "gpt-5-codex"',
        'review_model = "gpt-5-codex-mini"',
        'model_provider = "openai"',
        'model_reasoning_effort = "high"',
        '[model_providers.local]',
        'model = "ignored"',
        '[projects."/repo"]',
        'trust_level = "trusted"',
      ].join('\n'),
    )
    expect(scan.topLevel).toEqual({
      model: 'gpt-5-codex',
      review_model: 'gpt-5-codex-mini',
      model_provider: 'openai',
      model_reasoning_effort: 'high',
    })
    expect(scan.providers).toEqual(['local'])
  })

  it('ignores commented and malformed lines', () => {
    const scan = scanConfig(['model = "gpt-5-codex" # trailing comment', 'broken line', 'nested = { a = 1 }'].join('\n'))
    expect(scan.topLevel).toEqual({ model: 'gpt-5-codex' })
  })
})

describe('configured models', () => {
  it('lists the default model with its provider and the review model', async () => {
    const host = new FakeHost()
    host.addFile(CONFIG, 'model = "gpt-5-codex"\nmodel_provider = "openai"\nreview_model = "gpt-5-codex-mini"\n')
    expect(await codexAdapter(host).listModels()).toEqual([
      { id: 'gpt-5-codex', provider: 'openai' },
      { id: 'gpt-5-codex-mini' },
    ])
  })

  it('lists nothing when the configuration names no model', async () => {
    const host = new FakeHost()
    expect(await codexAdapter(host).listModels()).toEqual([])
    host.addFile(CONFIG, '[model_providers.local]\nbase_url = "http://localhost:1234"\n')
    expect(await codexAdapter(host).listModels()).toEqual([])
  })

  it('does not list the review model twice when it repeats the default', async () => {
    const host = new FakeHost()
    host.addFile(CONFIG, 'model = "gpt-5-codex"\nreview_model = "gpt-5-codex"\n')
    expect(await codexAdapter(host).listModels()).toEqual([{ id: 'gpt-5-codex' }])
  })
})
