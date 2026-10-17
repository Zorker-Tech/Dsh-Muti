---
description: "agent-mesh 的 oh-my-pi（`omp`）adapter：`omp` 与 `PI_CODING_AGENT_DIR` 检测、只读会话与 todos、已配置的 LLM 路由，以及双工 RPC 运行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-omp

[English](README.md) | 中文

## 概述

挂载本包，暴露这台机器上的 oh-my-pi（`omp`）。它列出 OMP 自己带 title slot 的 JSONL 会话，读取有界的活跃分支 transcript 和原生 todo、plan，报告凭据是否存在，并将已配置的模型路由投影到 `ctx.llm`。运行时会向 `omp --mode rpc-ui` 发送 prompt，由 OMP 创建或恢复原生会话，并向 DSH 暴露受支持的确认提示；取消通过 RPC `abort` 完成。读取会话不会写入 OMP 数据；adapter 不读取 SQLite 凭据数据库，因此已存储凭据会报告为 `unknown`。只有检测、凭据流程与运行派发会启动进程。

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

把该 adapter 挂在 mesh 与 LLM 服务之后；它注入 `agentMesh`、`llm`、`fs` 与 `subprocess`。

```yaml
- id: agent-mesh
  name: '@deepseek-ai/dsh-agent-mesh'
- id: agent-omp
  name: '@deepseek-ai/dsh-agent-omp'
  config:
    homeDir: ~/.omp/agent
    sessionDir: ~/.omp/sessions
```

### When to choose it

在运行 `omp` CLI、且希望会话留在 OMP 自己存储中的机器上选择本 adapter。它是唯一能列出、读取或派发 OMP 会话的包，并且在被读取或派发之前保持惰性；没有该二进制的机器仍可挂载它，并会报告 `installed: false` 及原因。它会报告原生 todos 与 plan 模式，因此这些内容重要时它是首选 adapter。它也会把已配置的 OMP 模型路由注册到 `ctx.llm`；这与 `AgentAdapter.listModels` 分开，后者仍不可用，因为 adapter 不会运行 OMP 模型目录探测。需要其他外部智能体的组合也可以挂载对应 adapter，同一个 profile 可以挂载多个。

### Minimal configuration

上面的行在完全不带 `config` 时也可用：检测会搜索 `PATH` 与已知安装目录，agent 目录遵循 OMP 自身的优先级 `$OMP_PROFILE`/`$PI_PROFILE`、`$PI_CODING_AGENT_DIR` 与 `$PI_CONFIG_DIR`。这里列出全部可接受的字段。

| Field | Default | Meaning |
|---|---|---|
| `binaryPath` | unset | 显式 `omp` 可执行文件，先于 `PATH` 与已知安装目录尝试。 |
| `homeDir` | unset | 显式 OMP agent 目录，是存储根的最高优先级来源。 |
| `sessionDir` | unset | 扁平会话目录，先于 `$PI_CODING_AGENT_SESSION_DIR` 尝试；OMP 没有对应的设置键。 |
| `env` | `{}` | 本 adapter 启动的每个子进程的额外环境变量。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

该 adapter 是 mesh 的 `AgentHost` 的纯函数：`detect.ts` 解析二进制并探测 `--version`，`sessions.ts` 解析存储布局、解析定宽 title slot、会话头与追加式条目、沿 `parentId` 树走到活跃叶子（末尾的 `model_usage` 标记可以改变该叶子）、折叠会话状态与用量，并同时扫描扁平覆盖目录与默认的按项目根目录，`transcript.ts` 把分支条目投影为 mesh 消息，`tasks.ts` 读取 todo 快照与 plan 模式转换，`auth.ts` 报告凭据是否存在并委托 `omp login`，`llm-models.ts` 在不打开凭据数据库的前提下读取已配置 YAML 模型路由与角色选择，`run.ts` 投影 OMP 会话事件并解析 resume 目标，`rpc-run.ts` 管理 RPC 命令、原生 abort 与终态。插件的 `apply` 从 Cordis 上下文构建宿主，再分别将 mesh adapter 和 LLM provider 注册为 effect。

| File | What it owns |
|---|---|
| `src/index.ts` | `omp` adapter、`OMP_TRANSPORTS` 声明、能力集合，以及注册到 `ctx.agentMesh`。 |
| `src/detect.ts` | 二进制解析、`--version` 探测、审批词汇表，以及 `provider/id` 模型拆分。 |
| `src/sessions.ts` | 存储布局与 profile 解析、title slot/头/条目模型、折叠、活跃分支遍历，以及有界发现。 |
| `src/transcript.ts` | 把活跃分支投影为 mesh 消息，并施加 16 KiB 字段上限。 |
| `src/tasks.ts` | `user_todo_edit` 快照与 `todo` 工具结果，以及 plan 模式状态与其 plan 文件路径。 |
| `src/auth.ts` | provider 环境变量列表、凭据存储是否存在，以及登录/登出指引。 |
| `src/llm-models.ts` | 将已配置的 provider、模型、角色选择与 API key 引用只读投影到 `ctx.llm`。 |
| `src/run.ts` | OMP 会话事件投影、resume 解析、子进程环境与退出分类。 |
| `src/rpc-run.ts` | RPC UI argv、会话绑定、受支持确认请求的 DSH 审批、prompt 完成，以及通过 OMP `abort` 命令中断回合。 |
| `src/config.ts` | `OmpAdapterConfig`/`ResolvedOmpConfig` 的拆分与全部默认值。 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [mesh 接缝](../mesh/README.zh.md) — 本 adapter 投影到的注册表与运行词汇。
- [mesh 工具](../tools/README.zh.md) — 经本 adapter 读取的面向模型的工具。
- [Group README](../README.zh.md) — 接缝、各 adapter、工具与 controller 如何配合。
- [Agent mesh 子系统](../../../docs/subsystems/agent-mesh.zh.md) — 规范类型与 adapter 契约。
- [原生多智能体集成决策](../../../.agents/notes/proposed/architecture/2026-10-16-native-agent-mesh-in-dsh.zh.md) — 该家族有意舍弃的内容。

-----

<a id="model-experience"></a>
## 模型体验

### Adapter records

#### What the model sees

本包不添加 prompt 文本或工具。mesh 工具仍保持独立，并通过 [`@deepseek-ai/dsh-agent-mesh-tools`](../tools/README.zh.md) 访问 `AgentAdapter`。本包还会将 `agent-omp` 注册到 `ctx.llm`，使已配置的 OMP 模型可以被选择；选中后，请求会经 Harness LLM 服务发送到配置的 endpoint。mesh 工具渲染的会话行、transcript 消息、todo 与 plan 状态及运行结果仍来自 `AgentAdapter`，其中包括每条声明投影缺口的 `notes` 字符串。

#### Token effect

自身没有。`mesh_*` 工具调用的 token 成本属于工具包的结果内容；本 adapter 不向请求添加任何自己的文本。派发运行的结果同样只经 `mesh_run`/`mesh_runs` 到达模型。

#### KV Cache effect

无。本包不贡献任何模型请求内容；进入请求的内容由 mesh 工具包拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 一项真实组合测试在隔离的 OMP 18.11.0 存储中通过 adapter 运行本地 `/model` 命令，并验证会话路径、v3 header、title slot、启动条目、run 结果与会话绑定。测试不请求模型，也不读取或写入已安装实例的用户存储。
- OMP 把凭据保存在 SQLite 数据库 `<agent-dir>/agent.db` 中；本 adapter 没有 SQLite 驱动，也从不读取它。存在 `agent.db` 时报告 `unknown`，provider 环境变量存在时报告 `authenticated`，两者都没有时报告 `unauthenticated`，因此 adapter 无法判断已存储凭据是否可用。
- `omp logout` 不是子命令：登出始终返回指引（TUI 中的 `/logout`、RPC 的 `logout` 命令，或 `omp auth-broker logout`），从不执行任何进程；登录只对 `interactive` 流程委托一个有界的 `omp login`，其提示需要终端，因此报告的结果通常是指引加失败。
- `resolveMcpServer` 会为 `mesh_mcp_connect` 读取已解析 agent 目录中的 `mcp.json` 与最近的项目 `.omp/mcp.json`。DSH 只会在首次使用审批后启动受支持的 stdio 或 Streamable HTTP server；SSE 与托管 OAuth 条目会 fail closed。
- `cancel()` 会发送 OMP RPC `abort` 命令并保留其会话文件。`rpc-ui` 会转发 `confirm` 请求；只有包含明确一次性允许和拒绝选项的 `select` 请求才会转发给 DSH，其它对话框和选择会被拒绝。
- 原生 UI 审批响应写入失败会以 `run/protocol-error` 结束运行；取消 UI 请求的响应写入失败后若取消成功，运行仍标记为已取消，并在 notes 中记录写入失败。
- `capabilities().listModels` 为 `false`：adapter 不会执行 `omp models --json`。独立的 `ctx.llm` 会读取 `models.yml` 与 `config.yml` 中已配置的 provider、模型、model override 和精确 `modelRoles` 选择；它不会读取 OMP 的 SQLite 凭据存储，也不使用 OMP OAuth。`auth: none` 会禁用 ambient key；`apiKey` 先按环境变量名解析，否则使用配置的字面值。Shell 命令凭据、`authHeader: false`，以及 Harness 无法复现的 OMP 特定请求行为都会被拒绝。
- transcript 与任务读取都对活跃分支施加字节窗口（默认 512 KiB；不超过窗口的会话文件整体读取，更大的文件只贡献 title slot、头部与尾部窗口），`mode_change` 条目定位的 plan 文件按原样报告且从不打开，`/clear` 重置边界只被记录，不作用于投影。
- 会话文件支持是针对格式 v3 移植的；头部带更旧 `version` 时仅在 `notes` 中注明，而不匹配文件名约定的按 id 查找最多探测 300 个头部。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/` 固定了 profile 与 agent 目录优先级、凭据状态报告、已挂载的 descriptor、argv 构建与子进程环境、NDJSON 投影、活跃分支叶子覆盖、title slot、扫描上限、todo 与 plan 提取，以及 `ctx.llm` 路由投影。安装了 OMP 时，real-store e2e 还会用 CLI 创建一个隔离会话，再通过本 adapter 读取路径、v3 header 和启动条目；它不发送模型 prompt，也不触碰用户的 OMP 存储。

</details>
