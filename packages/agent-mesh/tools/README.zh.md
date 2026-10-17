---
description: "面向模型的外部编码智能体 mesh 工具：已安装的智能体、能力清单、各智能体自己的会话与 transcript、原生 todo 与 plan，以及派发的 run。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh-tools

[English](README.md) | 中文

<a id="summary"></a>

## 概述

挂载本包后，模型可以检查外部编码智能体，通过 DSH 文件系统策略读取其声明的 skill、prompt 与上下文文件，在 DSH 审批后启用声明的 MCP server，读取各智能体自己的会话与任务状态，并在其 CLI 上派发工作。绑定到外部智能体的 DSH 会话也会将该 adapter 声明的上下文文件作为持久化模型输入，并在文件内容变更时刷新。没有 adapter 的智能体会响亮失败；智能体存储中不存在的会话报告为 not found，而不是空 transcript。

<a id="table-of-contents"></a>

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>

## 使用本包

在 mesh 接缝与至少一个 adapter 之后挂载。它注册的是全局工具，所有 preset 都能看到；同名工具会被 preset 自己注册的那个遮蔽。

`contextMaxBytes` 默认是 2 MiB，用于限制渲染后的原生上下文贡献。如果 adapter 声明的文件需要更多空间，可以在 `cordis.yml` 中调高该字段；快照超限或文件不可读时，本步骤会返回可操作的错误并拒绝接纳。

```yaml
- name: '@deepseek-ai/dsh-agent-mesh-tools'
  config:
    maxProxyTools: 24
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `contextMaxBytes` | `2097152` | 渲染后的原生上下文贡献的最大 UTF-8 字节数 |
| `maxProxyTools` | `24` | 每个已绑定 Agent 可见的原生工具名上限；`0` 会禁用代理，超过 `64` 的值会被拒绝 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-mesh-tools)列出了所有可接受字段。

<a id="understand-the-implementation"></a>

## 理解实现

每个工具都是一次 `defineTool` 注册。清单与会话工具调用 `readCapabilities` 和 `adapter(...)`；`mesh_capability_read` 通过 `ctx.fs` 读取一个精确列出的 skill 指令文件、上下文文件或文件型命令模板；run 工具调用 `startRun`、`runs` 和 `cancelRun`；MCP 工具解析原生配置，然后在调用方 Agent 所拥有的作用域中挂载一个 MCP 客户端。每个 Agent 首次连接某 server 时，`mesh_mcp_connect` 都会先请求 DSH 审批。`mesh_mcp_disconnect` 会移除该 Agent 的客户端；Agent 结束时会清理其余客户端。清理会尝试处理每个剩余作用域，并通过宿主日志报告被拒绝的清理。`mesh_run` 会等待 run 的终态结果。一个 pre-step listener 会通过相同文件系统策略读取已绑定 adapter 声明的上下文文件，并刷新必需的 `system-prompt` 上下文贡献；agent loop 会将其记录在持久化的 `runtime-context` 快照中，并在文本变化时替换该快照。adapter 的发现说明也会保留在贡献中。Agent 创建和 mesh 绑定变更 listener 会读取当前原生工具清单，并在下一次模型请求前于该 Agent 的作用域中注册最多 `maxProxyTools` 个任务委托工具。每个代理都会再次检查绑定关系和工具声明，并在 DSH 审批后通过 `startRun` 委托任务。`contextMaxBytes` 限制渲染后的原生贡献。输出 schema 携带渲染所需的字段，adapter 产生的每个 `notes` 数组都原样传递，因此模型能看到投影未能承载的内容。

<a id="further-exploration"></a>

## 进一步探索

- [接缝 README](../mesh/README.zh.md) —— 这些工具所投影的词汇。
- [组 README](../README.zh.md)。

<a id="model-experience"></a>

## 模型体验

### 读取类工具

#### What the model sees

十一个工具，各有自己的 schema：`mesh_agents`、`mesh_capabilities`、`mesh_capability_read`、`mesh_sessions`、`mesh_transcript`、`mesh_tasks`、`mesh_run`、`mesh_runs`、`mesh_run_cancel`、`mesh_mcp_connect` 和 `mesh_mcp_disconnect`。`mesh_capabilities` 报告已声明的工具、skill、MCP server、命令、上下文文件及来源路径，但不会调用它们。`mesh_capability_read` 将一个已列出的 skill 指令文件、上下文文件或文件型命令模板作为已记录的工具结果返回，文件上限为 1 MiB；未声明的路径会提示先刷新能力清单，文件系统错误保留 DSH 错误码。每个模型步骤开始前，已绑定的 DSH 会话都会刷新必需的 `agent-mesh:native-context` 贡献，并将其纳入持久化的 `runtime-context` 快照；文件变更或指令移除时，会替换 Session 表层中的旧快照。`contextMaxBytes` 限制原生贡献大小，默认值为 2 MiB。使用 `mesh_mcp_connect` 请求 DSH 审批，并为当前 Agent 启用一个已声明的 stdio 或 Streamable HTTP server。会话读取工具返回某个智能体自己存储中的投影记录，并且原样传递 adapter 产生的每个 `notes` 数组，因此模型能看到投影未能承载的内容。

#### Token effect

工具可见时每次请求的固定 schema 成本。会话与消息结果由调用方的 `limit` 与 `maxMessages` 约束；能力文件结果受 1 MiB 文件上限约束。已绑定会话还会将当前原生上下文贡献加入模型输入，大小不超过 `contextMaxBytes`。

#### KV Cache effect

工具集合与可见性不变时前缀稳定。结果文本追加在请求前缀之后。原生上下文只在首次注入或文件及发现说明变更时追加，因此文件未变时不会在每个步骤重复添加消息。

### Run 类工具

#### What the model sees

`mesh_run` 会等待外部 run 结束，并返回 run id、终态、最终答案或分类错误，以及 adapter 的 notes。它可接收当前能力清单中的精确 `commandName`；对于文件型命令，它会通过 `ctx.fs` 读取模板、移除 frontmatter，并将正文放在任务之前。`mesh_runs` 报告状态、选定答案、分类错误与保留的最近事件；`mesh_run_cancel` 报告是否有仍在进行的 run 被取消。如果 adapter 报告了原生工具名，已绑定的 Agent 还会看到最多 `maxProxyTools` 个 `mesh_agent_tool_*` schema；每个 schema 只接收自由文本 `task`，并要求外部 CLI 使用指定工具，因此这是通过外部 agent 委托任务，并非直接调用原生工具实现。代理调用需要 DSH 审批，并在派发前重新检查绑定关系和当前清单。派发前，`mesh_run` 要求 DSH 用户批准；所属 agent 或审批回答通道不可用时会 fail closed。`mesh_run` 与原生工具代理会为运行期间出现的受支持请求提供审批回调：Codex 默认 app-server 模式会转发命令与文件变更请求，并且只授予单次 `accept`；Grok ACP 会转发权限请求并只接受一次性允许或拒绝；Pi RPC 与 OMP `rpc-ui` 会转发 `confirm` 请求，且只转发选项中含有明确一次性允许和拒绝项的 `select` 请求。`mesh_run` 的 `approval` 参数只选择外部 CLI 自己的模式，不会授予 DSH 审批。adapter 不支持的模式以及未知 run 会以点名智能体或 run 的消息失败。

#### Token effect

`mesh_run` 是固定形状的小结果，但工具调用会一直等待，直到外部 run 进入终态。`mesh_runs` 随保留的事件窗口（每次 run 默认上限 200 条）与列出的 run 数量增长，因此在需要时可逐个读取。

#### KV Cache effect

只追加；这里不会改写更早的消息，因此新可见的结果跟随可复用的请求前缀。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- `mesh_transcript` 与 `mesh_tasks` 通过列举智能体存储来定位会话，因此无法列举的存储也无法按 id 读取。
- 派发的 run 没有 worktree 隔离；工作目录由调用方提供。
- run 事件只能通过 `mesh_runs` 报告的保留窗口看到，没有流式工具结果。
- 原生 CLI 工具不会以其原生实现或 JSON 参数 schema 导入。若 adapter 报告工具名，已绑定的 Agent 会收到最多 `maxProxyTools` 个 `mesh_agent_tool_*` 代理；代理只接收自由文本任务，并在 DSH 审批后通过外部 CLI 委托，执行时会重新检查绑定关系和当前清单。未报告原生工具名的 adapter（包括当前 Codex 清单）不会提供代理。声明的 skill 指令和文件型命令可通过 `mesh_capability_read` 按需读取；已绑定的 DSH 会话会自动注入上下文文件，文件型命令正文也可通过 `mesh_run.commandName` 加到派发任务前。adapter notes 会说明未能发现的上下文文件或目录。声明文件不可读或快照超过 `contextMaxBytes` 时，本步骤不会接纳，并会返回可操作的错误。`mesh_mcp_connect` 可在 DSH 审批后启用 stdio 和 Streamable HTTP server；SSE 与托管 OAuth 配置会 fail closed。清单仅报告可执行文件名和 endpoint 源站；审批文本会隐藏参数和凭据。
- 运行时审批转发需要双工传输与调用方提供的审批回调。无头运行和未提供回调的调用方会拒绝原生审批请求。

<a id="dev-note"></a>

### 开发备注

工具注册以及它们读取的 mesh 注册表由 `tests/tools.spec.ts` 固定。
