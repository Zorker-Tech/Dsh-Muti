/**
 * The model ids this machine's Codex configuration names.
 *
 * Codex keeps no built-in model list, so the honest catalog is exactly what its
 * configuration names. This adapter reads the **user layer** (`$CODEX_HOME/config.toml`):
 * the default `model`, the `review_model`, the `model_provider` that serves the default,
 * and the `[model_providers.*]` table. The reference plugin additionally merges the legacy
 * `[profiles.*]` selection, the working-directory layer and the trusted `.codex/config.toml`
 * project layers, which this reader deliberately does not: the mesh model row carries no
 * provenance and no notes channel, so a partially applied layer precedence could not be
 * reported and would silently misstate where a model came from.
 *
 * Read-only and secret-free: the file is read, never written, and no provider credential
 * value is touched — a literal `experimental_bearer_token` is not read even to test it.
 * @module @deepseek-ai/dsh-agent-codex/models
 */

import { join } from 'node:path'
import type { AgentModel } from '@deepseek-ai/dsh-agent-mesh'
import type { CodexHost } from './types.ts'
import { type CodexHome } from './sessions.ts'

/** Configuration file name Codex reads from its home. */
export const CODEX_CONFIG_FILE = 'config.toml'

/** Cap on the bytes read from the configuration file. */
const CONFIG_MAX_BYTES = 1024 * 1024

/**
 * Read Codex's configured models from its user configuration layer.
 *
 * @param host - Host providing the read.
 * @param home - Resolved home layout.
 * @returns the configured models; empty when the configuration names none.
 */
export async function readCodexModels(host: CodexHost, home: CodexHome): Promise<readonly AgentModel[]> {
  const text = await host.readHead(join(home.path, CODEX_CONFIG_FILE), CONFIG_MAX_BYTES)
  if (text.trim() === '') return []
  const scan = scanConfig(text)
  const models: AgentModel[] = []
  const defaultModel = scan.topLevel['model']
  if (defaultModel !== undefined) {
    const provider = scan.topLevel['model_provider']
    models.push({ id: defaultModel, ...(provider === undefined ? {} : { provider }) })
  }
  const reviewModel = scan.topLevel['review_model']
  if (reviewModel !== undefined && reviewModel !== defaultModel) {
    models.push({ id: reviewModel })
  }
  return models
}

/** The configuration facts this reader extracts. */
export interface CodexConfigScan {
  /** Top-level string assignments, in file order. */
  readonly topLevel: Readonly<Record<string, string>>
  /** Keys declared under `[model_providers]`, in file order. */
  readonly providers: readonly string[]
}

/**
 * Extract the top-level string assignments and provider names from TOML text.
 *
 * This is a bounded scan of the subset Codex's own model configuration uses — quoted
 * top-level assignments before the first table header, plus `[model_providers.<id>]`
 * table names — not a general TOML parser.
 *
 * @param text - Configuration file text.
 * @returns the extracted keys.
 */
export function scanConfig(text: string): CodexConfigScan {
  const topLevel: Record<string, string> = {}
  const providers: string[] = []
  let inTable = false
  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine).trim()
    if (line === '') continue
    const header = /^\[\[?\s*([^\]]+?)\s*\]?\]$/.exec(line)
    if (header !== null) {
      inTable = true
      // The table-header expression matched the entire line, so its delimiters
      // and name are present by construction.
      const name = line.replace(/^\[\[?\s*/, '').replace(/\s*\]?\]$/, '')
      const provider = /^model_providers\s*\.\s*("([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/.exec(name)
      const id = provider?.[2] ?? provider?.[3] ?? provider?.[4]
      if (id !== undefined) providers.push(id)
      continue
    }
    if (inTable) continue
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line)
    if (assignment === null) continue
    // The assignment expression validates both sides; slicing the matched line
    // avoids impossible missing-capture branches in this bounded TOML reader.
    const separator = line.indexOf('=')
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().slice(1, -1)
    topLevel[key] = unescapeTomlString(value)
  }
  return { topLevel, providers }
}

/** Remove a `#` comment that is not inside a quoted string. */
function stripComment(line: string): string {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote === undefined && (char === '"' || char === "'")) quote = char
    else if (quote !== undefined && char === quote && line[index - 1] !== '\\') quote = undefined
    else if (quote === undefined && char === '#') return line.slice(0, index)
  }
  return line
}

/** Resolve the escapes a TOML basic string may carry. */
function unescapeTomlString(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}
