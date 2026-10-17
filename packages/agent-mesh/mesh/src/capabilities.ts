/**
 * Bounded read helpers for native agent capability declarations.
 *
 * Agent-specific packages decide which files and directories apply. These helpers only
 * perform read-only host operations and retain an explicit record for each missing or
 * oversized source.
 * @module @deepseek-ai/dsh-agent-mesh/capabilities
 */

import { dirname, join, resolve } from 'node:path'
import type {
  AgentCapabilitySource,
  AgentCapabilitySourceFile,
  AgentHost,
  AgentSkillInfo,
} from './types.ts'

/** Largest config or instruction file copied into a capability inventory. */
export const MAX_AGENT_CAPABILITY_FILE_BYTES = 1024 * 1024

/** Result of one bounded file read. An unread file always explains why. */
export type AgentCapabilityFileRead =
  | {
    /** An absent path. */
    readonly source: AgentCapabilitySourceFile & { readonly present: false }
    /** Absent paths have no text. */
    readonly text?: never
  }
  | {
    /** A path that exists but could not be read as a bounded file. */
    readonly source: AgentCapabilitySourceFile & { readonly present: true; readonly note: string }
    /** Unreadable paths have no text. */
    readonly text?: never
  }
  | {
    /** A readable bounded file. */
    readonly source: AgentCapabilitySourceFile & { readonly present: true; readonly note?: never }
    /** Complete decoded text. */
    readonly text: string
  }

/**
 * Read one complete file within the capability inventory bound.
 * @param host - Read-only host supplied by the agent adapter.
 * @param path - Absolute native configuration path.
 * @param signal - Optional caller cancellation.
 * @returns Source metadata and complete text when the file is bounded.
 */
export async function readAgentCapabilityFile(
  host: AgentHost,
  path: string,
  signal?: AbortSignal,
): Promise<AgentCapabilityFileRead> {
  signal?.throwIfAborted()
  const stat = await host.stat(path)
  signal?.throwIfAborted()
  if (stat === undefined) return { source: { path, present: false, note: 'not present' } }
  if (stat.isDirectory) return { source: { path, present: true, note: 'expected a file but found a directory' } }
  if (stat.size > MAX_AGENT_CAPABILITY_FILE_BYTES) {
    return { source: { path, present: true, note: `larger than ${MAX_AGENT_CAPABILITY_FILE_BYTES} bytes; not read` } }
  }
  const text = await host.readHead(path, MAX_AGENT_CAPABILITY_FILE_BYTES)
  signal?.throwIfAborted()
  return { source: { path, present: true }, text }
}

/** Result of listing one native skill root. */
export interface AgentSkillRootRead {
  /** The directory observation. */
  readonly source: AgentCapabilitySourceFile
  /** Skills found directly under the root. */
  readonly skills: readonly AgentSkillInfo[]
}

/**
 * List top-level skill bundles and flat Markdown skills in one native directory.
 * @param host - Read-only host supplied by the agent adapter.
 * @param root - Absolute skill directory.
 * @param source - Origin of this directory.
 * @param signal - Optional caller cancellation.
 * @returns The observed root and every readable top-level skill.
 */
export async function readAgentSkillRoot(
  host: AgentHost,
  root: string,
  source: Extract<AgentCapabilitySource, 'project' | 'user'>,
  signal?: AbortSignal,
): Promise<AgentSkillRootRead> {
  signal?.throwIfAborted()
  const stat = await host.stat(root)
  signal?.throwIfAborted()
  if (stat === undefined || !stat.isDirectory) {
    return { source: { path: root, present: false, note: stat === undefined ? 'not present' : 'not a directory' }, skills: [] }
  }
  const skills: AgentSkillInfo[] = []
  for (const entry of await host.listDir(root)) {
    signal?.throwIfAborted()
    const path = join(root, entry.name)
    if (entry.isDirectory) {
      const skillPath = join(path, 'SKILL.md')
      const file = await readAgentCapabilityFile(host, skillPath, signal)
      if (file.text === undefined) continue
      skills.push(skillInfo(entry.name, source, skillPath, file.text))
    } else if (entry.name.endsWith('.md')) {
      const file = await readAgentCapabilityFile(host, path, signal)
      if (file.text === undefined) continue
      skills.push(skillInfo(entry.name.slice(0, -3), source, path, file.text))
    }
  }
  return { source: { path: root, present: true }, skills }
}

/**
 * Find native instruction files from the working directory through its ancestors.
 * @param host - Read-only host supplied by the agent adapter.
 * @param cwd - Working directory whose instruction hierarchy applies.
 * @param names - Instruction filenames in native precedence order.
 * @param signal - Optional caller cancellation.
 * @returns Existing instruction file paths, deepest directory first.
 */
export async function findAgentContextFiles(
  host: AgentHost,
  cwd: string,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const files: string[] = []
  let directory = resolve(cwd)
  for (let depth = 0; depth < 32; depth += 1) {
    signal?.throwIfAborted()
    for (const name of names) {
      const path = join(directory, name)
      const stat = await host.stat(path)
      signal?.throwIfAborted()
      if (stat !== undefined && !stat.isDirectory) files.push(path)
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return files
}

/**
 * Find instruction files directly in one agent home directory.
 * @param host - Read-only host supplied by the agent adapter.
 * @param directory - Agent-owned configuration directory.
 * @param names - Instruction filenames in native precedence order.
 * @param signal - Optional caller cancellation.
 * @returns Existing instruction file paths in the supplied order.
 */
export async function listAgentContextFiles(
  host: AgentHost,
  directory: string,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const files: string[] = []
  for (const name of names) {
    signal?.throwIfAborted()
    const path = join(directory, name)
    const stat = await host.stat(path)
    signal?.throwIfAborted()
    if (stat !== undefined && !stat.isDirectory) files.push(path)
  }
  return files
}

/** Parse the simple metadata lines shared by native `SKILL.md` frontmatter. */
function skillInfo(name: string, source: 'project' | 'user', path: string, text: string): AgentSkillInfo {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1] ?? ''
  const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim().replace(/^(['"])(.*)\1$/u, '$2')
  const userInvocableValue = /^user-invocable:\s*(true|false)\s*$/imu.exec(frontmatter)?.[1]?.toLowerCase()
  return {
    name,
    source,
    path,
    ...(description === undefined || description === '' ? {} : { description }),
    ...(userInvocableValue === undefined ? {} : { userInvocable: userInvocableValue === 'true' }),
  }
}
