---
kind: upgrade-guide
description: "AgentAdapter now requires native MCP configuration resolution before DSH can approve and start a server."
---

# Agent adapters resolve native MCP servers

English | [中文](guide.zh.md)

## Change

`AgentAdapter` now requires `resolveMcpServer(request)`. Custom adapters that implement the pre-stable mesh interface must provide it. The model-facing `mesh_mcp_connect` tool can start a declared stdio or Streamable HTTP server only after DSH approval for the calling Agent. Capability inventory does not start servers and does not return environment values, command arguments, URL paths, or query values. SSE and managed OAuth declarations are unsupported and fail closed.

## Migration

1. Add `resolveMcpServer(request: AgentMcpServerResolveRequest)` to each custom `AgentAdapter` implementation. Return `undefined` when the requested server is absent; otherwise return the effective `AgentMcpServerConfig` without starting the server.
2. Keep credentials in the resolved in-memory config. Do not copy them into `AgentCapabilityInventory` or capability notes.
3. Rebuild each adapter against `@deepseek-ai/dsh-agent-mesh`, then confirm that approving `mesh_mcp_connect` exposes tools only to the calling Agent and that rejecting it starts no server.
