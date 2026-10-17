import { describe, expect, it } from 'vitest'
import { asRecord, jsonText, normalizeToken, num, parseJsonLine, str } from '../src/json.ts'

describe('Codex JSON readers', () => {
  it('narrows records and scalar values without coercion', () => {
    const record = { text: 'value', empty: '', count: 4, infinite: Number.POSITIVE_INFINITY }
    expect(asRecord(record)).toBe(record)
    expect(asRecord(null)).toBeUndefined()
    expect(asRecord([])).toBeUndefined()
    expect(asRecord('text')).toBeUndefined()
    expect(str(record, 'text')).toBe('value')
    expect(str(record, 'empty')).toBeUndefined()
    expect(str(record, 'count')).toBeUndefined()
    expect(str(undefined, 'text')).toBeUndefined()
    expect(num(record, 'count')).toBe(4)
    expect(num(record, 'infinite')).toBeUndefined()
    expect(num(record, 'text')).toBeUndefined()
    expect(num(undefined, 'count')).toBeUndefined()
  })

  it('normalizes token casing and separators', () => {
    expect(normalizeToken('Agent_Message')).toBe('agentmessage')
    expect(normalizeToken(undefined)).toBe('')
  })

  it('serializes native values and falls back for undefined or cyclic input', () => {
    expect(jsonText({ key: 'value' })).toBe('{"key":"value"}')
    expect(jsonText(undefined)).toBe('undefined')
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(jsonText(cyclic)).toBe('[object Object]')
  })

  it('parses one trimmed JSON line and identifies empty or malformed lines', () => {
    expect(parseJsonLine('  {"key":"value"}  ')).toEqual({ ok: true, value: { key: 'value' } })
    expect(parseJsonLine('   ')).toEqual({ ok: false, error: 'empty line' })
    expect(parseJsonLine('{broken')).toMatchObject({ ok: false })
  })
})
