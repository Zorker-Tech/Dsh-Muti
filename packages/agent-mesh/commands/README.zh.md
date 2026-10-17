---
description: "通过 DSH 人类命令菜单查看外部 agent、原生会话、集成诊断和最近运行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh-commands

[English](README.md) | 中文

## 概述

六条全局命令可查看外部 agent 注册、原生会话、诊断、运行及 DSH 拥有的 mesh 状态。已绑定的 agent 还会提供文件型命令别名，例如 `/agent-codex-review <task>`。别名会排入一条带精确原生命令与工作目录的模型任务；`mesh_run` 仍需经过 DSH 审批。`/agent-refresh` 会重新读取原生存储，但不会另建会话索引。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待处理工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

当用户需要在支持命令的 UI 中快速以文本查看 Agent Mesh 原生状态时，使用这些命令。

### 命令参考

| 输入 | 结果 |
|---|---|
| `/agents` | 列出已注册 agent、安装状态和粗粒度凭据状态，不显示凭据值 |
| `/agent-sessions [cwd]` | 读取原生会话存储，可按工作目录筛选，并显示最多 20 条返回记录 |
| `/agent-refresh` | 从原生存储中读取每个 agent 最多 100 条会话；不会新建或刷新另一份索引 |
| `/agents-diagnostics` | 显示 agent 探测结果、版本、二进制与存储路径以及警告 |
| `/mesh-runs` | 显示最近 20 次跟踪运行，不渲染提示词或回答 |
| `/mesh-state` | 统计已注册 agent、持久绑定、会话标记和跟踪运行 |

`/agent-sessions` 会把去掉首尾空白的输入作为一个工作目录路径传入；命令不解析引号。某个存储读取失败时，结果会同时保留其他可读会话和该失败信息。

文件型别名格式为 `/agent-<agent>-<command> <task>`。绑定或工作目录变化时会刷新别名；Session 解绑或销毁时会移除别名。别名会排入一条普通模型后续消息，不会直接启动外部 CLI。

### 挂载命令

此包不接受配置。在自定义组合中，应在命令注册表和 Agent Mesh 服务之后挂载；DSH base bundle 已与这些依赖一起挂载此包。

```yaml
- id: agent-mesh-commands
  name: '@deepseek-ai/dsh-agent-mesh-commands'
```

mesh 服务需要 storage-domain 提供方。Agent adapter 分别注册，因此即使没有安装外部 agent，这些命令也仍然可用。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部结构——点击展开</summary>

命令提供方通过 DSH 命令注册表注册六个全局名称和每个 Agent 的别名。它按需读取会话存储，并从绑定 agent 当前能力清单中的文件型命令生成别名。绑定或工作目录变化时会替换别名；每个别名在排入模型后续消息前都会重新读取能力清单。DSH 命令服务会把调用和完成事件记录到接收命令的会话日志。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 注册命令、限制会话与运行输出行数，并渲染 mesh 状态 |

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Agent Mesh 包映射](../README.zh.md) —— 原生 agent、面板、工具与协作包。
- [Agent Mesh 服务](../mesh/README.zh.md) —— 会话所有权、绑定、标记、诊断与运行。
- [Commands 服务](../../interaction/commands/README.zh.md) —— 命令注册、分发与结果处理。
- [Agent Mesh 面板](../../client/ui-agent-mesh/README.zh.md) —— agent、凭据、会话与运行的交互式控制。

-----

<a id="model-experience"></a>
## 模型体验

### 人类命令输出

#### 模型看到什么

六条全局查询命令会直接返回结果，不进入模型请求。文件型别名会排入一条 user-role 后续消息，写明精确 agent、`mesh_run.commandName`、工作目录与任务。该消息会记录在 Session 中；provider 启动 run 前，模型仍须通过常规 DSH 审批。

#### Token 影响

发现或运行全局查询命令不会增加模型 token。文件型别名会把排入的任务加入下一条模型请求；命令的直接结果不会包含在请求中。

#### KV Cache 影响

全局命令发现和直接输出不会改变模型请求前缀或其缓存。文件型别名会通过添加任务改变下一条请求。

## 已知限制与待处理工作

<a id="known-limitations-and-deferred-work"></a>

以下限制说明用户何时应改用面板或面向模型的工具，而不是命令菜单。

- **文本输出有界** —— 会话与运行命令最多显示 20 行；`/agent-refresh` 每个 agent 最多读取 100 条会话，且不提供分页。
- **需要交互式命令 adapter** —— 此包会注册命令，但没有命令客户端的无头组合无法接收或显示这些命令。
- **原生存储仍是权威数据源** —— agent 更新自己的存储后，不同读取之间的会话数量和记录可能变化。
- **原生命令名必须符合 DSH 命令语法** —— 名称不受支持或与 Agent 作用域已有命令重名的别名会被跳过并记录日志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
