import { describe, expect, it } from 'vitest'
import type { AgentHost, HostDirEntry, HostStat } from '../src/types.ts'
import { findAgentContextFiles, listAgentContextFiles, MAX_AGENT_CAPABILITY_FILE_BYTES, readAgentCapabilityFile, readAgentSkillRoot } from '../src/capabilities.ts'

function host(files: Readonly<Record<string, string>> = {}, directories: readonly string[] = []): AgentHost {
  const content = new Map(Object.entries(files))
  const dirs = new Set(directories)
  for (const path of content.keys()) {
    let parent = path.slice(0, path.lastIndexOf('/')) || '/'
    while (parent !== '/' && parent !== '.') {
      dirs.add(parent)
      parent = parent.slice(0, parent.lastIndexOf('/')) || '/'
    }
  }
  return {
    env: {},
    home: '/home/tester',
    async stat(path): Promise<HostStat | undefined> {
      const value = content.get(path)
      if (value !== undefined) return { size: Buffer.byteLength(value), mtimeMs: 0, isDirectory: false }
      return dirs.has(path) ? { size: 0, mtimeMs: 0, isDirectory: true } : undefined
    },
    async listDir(path): Promise<readonly HostDirEntry[]> {
      const entries: HostDirEntry[] = []
      for (const child of content.keys()) {
        if (child.slice(0, child.lastIndexOf('/')) === path) entries.push({ name: child.slice(child.lastIndexOf('/') + 1), isDirectory: false, mtimeMs: 0 })
      }
      for (const child of dirs) {
        if (child !== path && child.slice(0, child.lastIndexOf('/')) === path) entries.push({ name: child.slice(child.lastIndexOf('/') + 1), isDirectory: true, mtimeMs: 0 })
      }
      return entries
    },
    async readHead(path, maxBytes): Promise<string> {
      return Buffer.from(content.get(path) ?? '').subarray(0, maxBytes).toString('utf8')
    },
    async readTail(): Promise<{ text: string; droppedPartialLine: boolean }> { return { text: '', droppedPartialLine: false } },
    spawn() { throw new Error('not used') },
    now: () => 0,
    log() {},
  }
}

describe('agent capability file helpers', () => {
  it('records missing, directory, oversized and readable files', async () => {
    const reader = host({
      '/cfg/large': 'x'.repeat(MAX_AGENT_CAPABILITY_FILE_BYTES + 1),
      '/cfg/readable': 'hello',
    }, ['/cfg/directory'])

    await expect(readAgentCapabilityFile(reader, '/cfg/missing')).resolves.toMatchObject({
      source: { path: '/cfg/missing', present: false, note: 'not present' },
    })
    await expect(readAgentCapabilityFile(reader, '/cfg/directory')).resolves.toMatchObject({
      source: { present: true, note: 'expected a file but found a directory' },
    })
    await expect(readAgentCapabilityFile(reader, '/cfg/large')).resolves.toMatchObject({
      source: { present: true, note: `larger than ${MAX_AGENT_CAPABILITY_FILE_BYTES} bytes; not read` },
    })
    await expect(readAgentCapabilityFile(reader, '/cfg/readable')).resolves.toEqual({
      source: { path: '/cfg/readable', present: true }, text: 'hello',
    })
  })

  it('checks cancellation before and after host reads', async () => {
    const aborted = AbortSignal.abort()
    await expect(readAgentCapabilityFile(host(), '/missing', aborted)).rejects.toMatchObject({ name: 'AbortError' })
    const controller = new AbortController()
    const base = host({ '/cfg/file': 'ok' })
    const cancelAfterStat: AgentHost = {
      ...base,
      async stat(path) {
        const result = await base.stat(path)
        controller.abort()
        return result
      },
    }
    await expect(readAgentCapabilityFile(cancelAfterStat, '/cfg/file', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('lists bundled and flat skills, extracting only known frontmatter', async () => {
    const reader = host({
      '/skills/review/SKILL.md': '---\ndescription: \'Review code\'\nuser-invocable: true\n---\nbody',
      '/skills/flat.md': '---\nuser-invocable: false\n---\nbody',
      '/skills/no-frontmatter.md': '# Hello',
      '/skills/notes.txt': 'not a skill',
      '/skills/oversized.md': 'x'.repeat(MAX_AGENT_CAPABILITY_FILE_BYTES + 1),
    }, ['/skills', '/skills/empty'])
    const result = await readAgentSkillRoot(reader, '/skills', 'user')
    expect(result.source).toEqual({ path: '/skills', present: true })
    expect(result.skills).toEqual([
      { name: 'flat', source: 'user', path: '/skills/flat.md', userInvocable: false },
      { name: 'no-frontmatter', source: 'user', path: '/skills/no-frontmatter.md' },
      { name: 'review', source: 'user', path: '/skills/review/SKILL.md', description: 'Review code', userInvocable: true },
    ])
  })

  it('skips bundled and flat skills whose files exceed the read bound', async () => {
    const reader = host({
      '/skills/large/SKILL.md': 'x'.repeat(MAX_AGENT_CAPABILITY_FILE_BYTES + 1),
      '/skills/large-flat.md': 'x'.repeat(MAX_AGENT_CAPABILITY_FILE_BYTES + 1),
    })
    await expect(readAgentSkillRoot(reader, '/skills', 'user')).resolves.toMatchObject({
      source: { path: '/skills', present: true },
      skills: [],
    })
  })

  it('reports absent or non-directory skill roots and honors cancellation during enumeration', async () => {
    const reader = host({ '/skills/not-a-dir': 'file' })
    await expect(readAgentSkillRoot(reader, '/missing', 'project')).resolves.toMatchObject({
      source: { present: false, note: 'not present' }, skills: [],
    })
    await expect(readAgentSkillRoot(reader, '/skills/not-a-dir', 'project')).resolves.toMatchObject({
      source: { present: false, note: 'not a directory' }, skills: [],
    })
    const controller = new AbortController()
    const base = host({ '/skills/a.md': '# A' }, ['/skills'])
    const cancelDuringList: AgentHost = {
      ...base,
      async listDir(path) {
        const result = await base.listDir(path)
        controller.abort()
        return result
      },
    }
    await expect(readAgentSkillRoot(cancelDuringList, '/skills', 'project', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('finds context files from the working directory through the filesystem root', async () => {
    const reader = host({
      '/AGENTS.md': 'root',
      '/work/AGENTS.md': 'work',
      '/work/repo/CLAUDE.md': 'repo',
    })
    await expect(findAgentContextFiles(reader, '/work/repo', ['AGENTS.md', 'CLAUDE.md']))
      .resolves.toEqual(['/work/repo/CLAUDE.md', '/work/AGENTS.md', '/AGENTS.md'])
    await expect(listAgentContextFiles(reader, '/work', ['CLAUDE.md', 'AGENTS.md']))
      .resolves.toEqual(['/work/AGENTS.md'])
    await expect(findAgentContextFiles(reader, '/work/repo', ['AGENTS.md'], AbortSignal.abort()))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
