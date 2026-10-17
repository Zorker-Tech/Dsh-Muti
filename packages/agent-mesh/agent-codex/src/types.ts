/**
 * The host port the Codex adapter is written against.
 *
 * The port itself is owned by the mesh (`@deepseek-ai/dsh-agent-mesh/host`, exported as
 * {@link AgentHost}) together with its harness-backed implementation
 * (`createContextHost`), because every adapter in the family reads through the same
 * vocabulary. This module is the Codex package's alias for it: the adapter is a pure
 * function of this port, so its parsing, projection and classification are unit-testable
 * with an in-memory host and no Cordis context.
 * @module @deepseek-ai/dsh-agent-codex/types
 */

import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'

export type { HostDirEntry, HostExit, HostProcess, HostSpawnSpec, HostStat } from '@deepseek-ai/dsh-agent-mesh'

/** The host capabilities the Codex adapter uses; nothing else is reachable from `src/`. */
export type CodexHost = AgentHost
