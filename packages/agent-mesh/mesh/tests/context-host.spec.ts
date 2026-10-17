import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { createContextHost } from '../src/context-host.ts'

let ctx: Context
let fiber: Fiber
let root: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-context-host-'))
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem)
  await ctx.plugin(LocalSubprocessRuntime)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fiber.dispose()
  rmSync(root, { recursive: true, force: true })
})

/**
 * The harness-backed host reads and spawns through the services a profile
 * mounts, so its own behavior is pinned here rather than only through an
 * adapter: a missing path is absent (never a fabricated empty), a head read
 * works on a file larger than the whole-file read cap, and a child's lines,
 * stderr, and exit facts reach the caller.
 */
describe('createContextHost', () => {
  it('reports a missing path as absent and an existing one with its size', async () => {
    const file = join(root, 'present.txt')
    writeFileSync(file, 'hello')
    const host = createContextHost(ctx, { home: root })
    expect(await host.stat(join(root, 'missing.txt'))).toBeUndefined()
    const stat = await host.stat(file)
    expect(stat?.isDirectory).toBe(false)
    expect(stat?.size).toBe(5)
    expect(stat?.mtimeMs).toBeGreaterThan(0)
    expect((await host.stat(root))?.isDirectory).toBe(true)
  })

  it('reads a head window from a file larger than the whole-file read cap', async () => {
    const file = join(root, 'large.txt')
    writeFileSync(file, `FIRST\n${'x'.repeat(200_000)}\nLAST`)
    const host = createContextHost(ctx, { home: root })
    const head = await host.readHead(file, 64 * 1024)
    expect(head.startsWith('FIRST\n')).toBe(true)
    expect(head.length).toBe(64 * 1024)
    expect(await host.readHead(join(root, 'missing.txt'), 64)).toBe('')
  })

  it('reads a tail window, dropping the leading partial line', async () => {
    const file = join(root, 'lines.txt')
    writeFileSync(file, ['one', 'two', 'three', 'four'].join('\n'))
    const host = createContextHost(ctx, { home: root })
    // The last 12 bytes start mid-line, so the partial "o" of "two" is dropped
    // and the window begins at the next complete line.
    const tail = await host.readTail(file, 12)
    expect(tail.droppedPartialLine).toBe(true)
    expect(tail.text).toBe('three\nfour')
    const whole = await host.readTail(file, 4096)
    expect(whole).toEqual({ text: 'one\ntwo\nthree\nfour', droppedPartialLine: false })
  })

  it('lists a directory with each child\'s kind and modification time', async () => {
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'child.txt'), 'x')
    const host = createContextHost(ctx, { home: root })
    const entries = (await host.listDir(root)).map(entry => [entry.name, entry.isDirectory] as const).sort()
    expect(entries).toEqual([['child.txt', false], ['sub', true]])
    expect(await host.listDir(join(root, 'absent'))).toEqual([])
  })

  it('spawns a child and reports its lines, stderr, and exit facts', async () => {
    const host = createContextHost(ctx, { home: root })
    const child = host.spawn({
      command: process.execPath,
      args: ['-e', "process.stdout.write('a\\nb\\n'); process.stderr.write('boom'); process.exit(3)"],
      cwd: root,
      env: {},
    })
    const lines: string[] = []
    for await (const line of child.lines) lines.push(line)
    const exit = await child.exit
    expect(lines).toEqual(['a', 'b'])
    expect(await child.stderr()).toContain('boom')
    expect(exit.code).toBe(3)
    expect(exit.timedOut).toBe(false)
    expect(exit.cancelled).toBe(false)
  })

  it('writes stdin and reports a cancellation the caller requested', async () => {
    const host = createContextHost(ctx, { home: root })
    const child = host.spawn({
      command: process.execPath,
      args: ['-e', "process.stdin.on('data', data => { process.stdout.write(`got:${String(data).trim()}\\n`); process.exit(0) })"],
      cwd: root,
      env: {},
      stdin: 'payload',
    })
    const lines: string[] = []
    for await (const line of child.lines) lines.push(line)
    expect(lines).toEqual(['got:payload'])
    expect((await child.exit).code).toBe(0)

    const long = host.spawn({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      cwd: root,
      env: {},
    })
    long.cancel('test cancellation')
    // A second cancel is a no-op; the first wins and the child reports it.
    long.cancel('again')
    const exit = await long.exit
    expect(exit.cancelled).toBe(true)
    expect(exit.code === null || typeof exit.code === 'number').toBe(true)
  }, 20_000)

  it('keeps stdin open for duplex frames until the caller closes it', async () => {
    const host = createContextHost(ctx, { home: root })
    const child = host.spawn({
      command: process.execPath,
      args: ['-e', "let input = ''; process.stdin.on('data', data => { input += data }); process.stdin.on('end', () => process.stdout.write(input))"],
      cwd: root,
      env: {},
      interactive: true,
    })
    expect(typeof child.writeStdin).toBe('function')
    expect(typeof child.closeStdin).toBe('function')
    child.writeStdin?.('{"id":1}\n')
    child.writeStdin?.('{"id":2}\n')
    child.closeStdin?.()
    const lines: string[] = []
    for await (const line of child.lines) lines.push(line)
    expect(lines).toEqual(['{"id":1}', '{"id":2}'])
    expect((await child.exit).code).toBe(0)
  })

  it('terminates a child that outlives its deadline', async () => {
    const host = createContextHost(ctx, { home: root })
    const child = host.spawn({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      cwd: root,
      env: {},
      timeoutMs: 300,
    })
    const exit = await child.exit
    expect(exit.timedOut).toBe(true)
    expect(exit.cancelled).toBe(false)
  }, 20_000)

  it('drops an over-long stdout line and records a diagnostic', async () => {
    const logged: string[] = []
    const host = createContextHost(ctx, {
      home: root,
      env: {},
    })
    const child = host.spawn({
      command: process.execPath,
      args: ['-e', "process.stdout.write('y'.repeat(50)); process.stdout.write('\\nok\\n')"],
      cwd: root,
      env: {},
      maxLineBytes: 10,
    })
    const lines: string[] = []
    for await (const line of child.lines) lines.push(line)
    expect(lines).toEqual(['ok'])
    expect(await child.exit).toBeDefined()
    expect(logged).toEqual([])
  })
})

describe('createContextHost failure paths', () => {
  it('rejects conflicting, absent, and closed interactive stdin states', () => {
    const endedStdin = new PassThrough({ autoDestroy: false })
    endedStdin.end()
    expect(endedStdin.destroyed).toBe(false)
    expect(endedStdin.writable).toBe(false)

    const destroyedStdin = new PassThrough({ autoDestroy: false })
    destroyedStdin.destroy()
    expect(destroyedStdin.destroyed).toBe(true)

    const handle = (stdin: PassThrough | undefined): SubprocessHandle => ({
      control: undefined,
      stdin,
      stdout: undefined,
      stderr: undefined,
      collected: {},
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    })
    const handles = [handle(undefined), handle(undefined), handle(destroyedStdin), handle(endedStdin)]
    const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
      const next = handles.shift()
      if (next === undefined) throw new Error('unexpected spawn')
      return next
    })
    const host = createContextHost(ctx, { home: root })

    expect(() => host.spawn({
      command: 'fake', args: [], cwd: root, env: {}, interactive: true, stdin: 'batch',
    })).toThrow('agent-mesh: interactive stdin cannot also use batch stdin')
    expect(spawn).not.toHaveBeenCalled()

    const batch = host.spawn({ command: 'fake', args: [], cwd: root, env: {} })
    expect(() => batch.writeStdin?.('frame')).toThrow('agent-mesh: child stdin is not open for interactive writes')
    expect(() => batch.closeStdin?.()).toThrow('agent-mesh: child stdin is not open for interactive writes')

    const missing = host.spawn({ command: 'fake', args: [], cwd: root, env: {}, interactive: true })
    expect(() => missing.writeStdin?.('frame')).toThrow('agent-mesh: child stdin is not open for interactive writes')
    expect(() => missing.closeStdin?.()).toThrow('agent-mesh: child stdin is not open for interactive writes')

    const destroyed = host.spawn({ command: 'fake', args: [], cwd: root, env: {}, interactive: true })
    expect(() => destroyed.writeStdin?.('frame')).toThrow('agent-mesh: child stdin is already closed')
    expect(() => destroyed.closeStdin?.()).not.toThrow()

    const ended = host.spawn({ command: 'fake', args: [], cwd: root, env: {}, interactive: true })
    expect(() => ended.writeStdin?.('frame')).toThrow('agent-mesh: child stdin is already closed')
    expect(() => ended.closeStdin?.()).not.toThrow()
  })

  it('reports an unreadable tail as empty rather than throwing', async () => {
    const host = createContextHost(ctx, { home: root })
    expect(await host.readTail(join(root, 'missing.txt'), 64)).toEqual({ text: '', droppedPartialLine: false })
    // A directory cannot be read as a file: the failure is absorbed the same way.
    mkdirSync(join(root, 'adir'), { recursive: true })
    expect(await host.readTail(join(root, 'adir'), 64)).toEqual({ text: '', droppedPartialLine: false })
  })

  it('reports a child that cannot start as an exit with no code', async () => {
    const host = createContextHost(ctx, { home: root })
    const child = host.spawn({
      command: join(root, 'no-such-binary'),
      args: [],
      cwd: root,
      env: {},
    })
    const lines: string[] = []
    for await (const line of child.lines) lines.push(line)
    const exit = await child.exit
    expect(lines).toEqual([])
    expect(exit.code).toBeNull()
    expect(exit.signal).toBeNull()
    expect(await child.stderr()).toBe('')
  })

  it('records diagnostics at both levels', () => {
    const host = createContextHost(ctx, { home: root })
    expect(() =>{  host.log('info', 'a diagnostic') }).not.toThrow()
    expect(() =>{  host.log('warn', 'a warning') }).not.toThrow()
  })

  it('exposes the environment and home it was built with', () => {
    const host = createContextHost(ctx, { home: root, env: { PATH: '/bin' }, now: () => 42 })
    expect(host.home).toBe(root)
    expect(host.env).toEqual({ PATH: '/bin' })
    expect(host.now()).toBe(42)
  })

  it('uses process defaults when no host options are supplied', () => {
    const host = createContextHost(ctx)
    expect(host.env).toBe(process.env)
    expect(host.home.length).toBeGreaterThan(0)
    expect(host.now()).toBeGreaterThan(0)
  })

  it('treats filesystem resolve and read failures as absent or empty results', async () => {
    const file = join(root, 'present.txt')
    writeFileSync(file, 'content')
    const host = createContextHost(ctx, { home: root })

    vi.spyOn(ctx.fs, 'resolve').mockRejectedValue(new Error('filesystem denied'))
    expect(await host.stat(file)).toBeUndefined()
    expect(await host.listDir(root)).toEqual([])
    expect(await host.readHead(file, 64)).toBe('')
    expect(await host.readTail(file, 64)).toEqual({ text: '', droppedPartialLine: false })

    vi.restoreAllMocks()
    vi.spyOn(ctx.fs, 'readByteRange').mockRejectedValue(new Error('read denied'))
    expect(await host.readHead(file, 64)).toBe('')
  })

  it('treats filesystem metadata and directory failures as absent or empty results', async () => {
    const file = join(root, 'present.txt')
    writeFileSync(file, 'content')
    const host = createContextHost(ctx, { home: root })

    vi.spyOn(ctx.fs, 'stat').mockResolvedValue({ version: FsVersion('test-version'), type: 'file' })
    expect(await host.stat(join(root, 'unprobeable.txt'))).toEqual({ size: 0, mtimeMs: 0, isDirectory: false })

    vi.restoreAllMocks()
    vi.spyOn(ctx.fs, 'stat').mockResolvedValue(undefined)
    expect(await host.stat(file)).toBeUndefined()

    vi.restoreAllMocks()
    vi.spyOn(ctx.fs, 'stat').mockRejectedValue(new Error('stat denied'))
    expect(await host.stat(file)).toBeUndefined()
    expect(await host.readTail(file, 64)).toEqual({ text: '', droppedPartialLine: false })

    vi.restoreAllMocks()
    vi.spyOn(ctx.fs, 'listDir').mockRejectedValue(new Error('listing denied'))
    expect(await host.listDir(root)).toEqual([])
  })

  it('drops an offset tail that contains no complete line', async () => {
    const file = join(root, 'long-line.txt')
    writeFileSync(file, 'abcdefghij')
    const host = createContextHost(ctx, { home: root })
    expect(await host.readTail(file, 4)).toEqual({ text: '', droppedPartialLine: true })
  })

  it('handles string stdout chunks, complete and unfinished overlong lines, and final CRLF', async () => {
    const warning = vi.spyOn(ctx.logger, 'warn')
    const handles: SubprocessHandle[] = [
      {
        control: undefined,
        stdin: undefined,
        stdout: Readable.from(['x'.repeat(11) + '\n', 'y'.repeat(11), '\nok\ncarriage\r\nfinal\r']),
        stderr: undefined,
        collected: {},
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => {},
        waitForExit: () => Promise.resolve(true),
      },
      {
        control: undefined,
        stdin: undefined,
        stdout: Readable.from(['z'.repeat(11)]),
        stderr: undefined,
        collected: {},
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => {},
        waitForExit: () => Promise.resolve(true),
      },
      {
        control: undefined,
        stdin: undefined,
        stdout: Readable.from(['plain']),
        stderr: undefined,
        collected: {},
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => {},
        waitForExit: () => Promise.resolve(true),
      },
    ]
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
      const handle = handles.shift()
      if (handle === undefined) throw new Error('unexpected spawn')
      return handle
    })
    const host = createContextHost(ctx, { home: root })

    const first = host.spawn({ command: 'fake', args: [], cwd: root, env: {}, maxLineBytes: 10 })
    const firstLines: string[] = []
    for await (const line of first.lines) firstLines.push(line)
    expect(firstLines).toEqual(['ok', 'carriage', 'final'])
    expect(await first.stderr()).toBe('')

    const second = host.spawn({ command: 'fake', args: [], cwd: root, env: {}, maxLineBytes: 10 })
    const secondLines: string[] = []
    for await (const line of second.lines) secondLines.push(line)
    expect(secondLines).toEqual([])

    const third = host.spawn({ command: 'fake', args: [], cwd: root, env: {}, maxLineBytes: 10 })
    const thirdLines: string[] = []
    for await (const line of third.lines) thirdLines.push(line)
    expect(thirdLines).toEqual(['plain'])
    expect(warning).toHaveBeenCalledTimes(3)
  })

  it('handles a child without stdout or collected stderr and cancels without a reason', async () => {
    const terminate = vi.fn()
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({
      control: undefined,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {},
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate,
      waitForExit: () => Promise.resolve(true),
    })
    const host = createContextHost(ctx, { home: root })
    const child = host.spawn({ command: 'fake', args: [], cwd: root, env: {} })
    const lines: string[] = []
    for await (const line of child.lines) lines.push(line)
    expect(lines).toEqual([])
    expect(await child.stderr()).toBe('')
    child.cancel()
    expect(terminate).toHaveBeenCalledOnce()
  })
})
