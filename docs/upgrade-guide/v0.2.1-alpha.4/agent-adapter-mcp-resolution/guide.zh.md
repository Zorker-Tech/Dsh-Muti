---
kind: upgrade-guide
description: "AgentAdapter 现在必须解析原生 MCP 配置，DSH 才能审批并启动 server。"
---

# Agent adapter 解析原生 MCP server

[English](guide.md) | 中文

## 变更

`AgentAdapter` 现在要求实现 `resolveMcpServer(request)`。实现预稳定 mesh 接口的自定义 adapter 必须补充该方法。面向模型的 `mesh_mcp_connect` 工具只能在 DSH 为调用方 Agent 审批后启动已声明的 stdio 或 Streamable HTTP server。能力清单不会启动 server，也不会返回环境值、命令参数、URL 路径或查询值。SSE 与托管 OAuth 声明不受支持，并会 fail closed。

## 迁移

1. 为每个自定义 `AgentAdapter` 实现添加 `resolveMcpServer(request: AgentMcpServerResolveRequest)`。请求的 server 不存在时返回 `undefined`；否则返回生效的 `AgentMcpServerConfig`，但不要启动 server。
2. 将凭据保留在内存中的解析配置里。不要把凭据复制到 `AgentCapabilityInventory` 或能力说明中。
3. 使用 `@deepseek-ai/dsh-agent-mesh` 重新构建每个 adapter，然后确认批准 `mesh_mcp_connect` 后工具只对调用方 Agent 可见，拒绝审批时不会启动 server。
