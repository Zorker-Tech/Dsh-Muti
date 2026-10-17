/**
 * The mesh's durable state: which agent one harness session is bound to.
 *
 * The domain is mesh-owned and versioned independently of the session format,
 * so a harness that does not know this domain reads only its own data. Nothing
 * here is written into a session log or into the session-query index.
 * @module @deepseek-ai/dsh-agent-mesh/domain
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentId, AgentSessionKey } from './types.ts'

const agentId = z.string().transform(value => brandString<AgentId>(value))

/** Durable record of one session-to-agent binding. */
export const agentBindingRecord = z.object({
  agentId,
  boundAt: z.string(),
})

/** One stored binding record, inferred from {@link agentBindingRecord}. */
export type AgentBindingRecord = z.infer<typeof agentBindingRecord>

/** Durable state kept by the Harness for one external session row. */
export const agentSessionMarkRecord = z.object({
  agentId,
  nativeId: z.string(),
  disposition: z.enum(['pinned', 'archived']),
  updatedAt: z.string(),
})

/** One stored external-session mark, inferred from {@link agentSessionMarkRecord}. */
export type AgentSessionMarkRecord = z.infer<typeof agentSessionMarkRecord>

/** The mesh domain: one `bindings` table keyed by harness session id. */
export const agentMeshDomainSpec = defineDomain({
  name: 'agent_mesh',
  version: 1,
  tables: { bindings: domainTable<SessionId, AgentBindingRecord>(agentBindingRecord) },
})

/** The mesh-owned table for pin/archive choices on sessions kept by agent CLIs. */
export const agentMeshSessionMarkDomainSpec = defineDomain({
  name: 'agent_mesh_session_marks',
  version: 1,
  tables: { marks: domainTable<AgentSessionKey, AgentSessionMarkRecord>(agentSessionMarkRecord) },
})
