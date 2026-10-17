---
description: "agent-mesh 的 Pi coding agent adapter：`pi` 检测、只读会话与凭据、已配置的 LLM 路由，以及原生 RPC 运行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-pi

[English](README.md) | 中文

## 概述

挂载本包，暴露这台机器上已安装的 Pi coding agent。它列出 `~/.pi/agent` 下 Pi 自己的 JSONL 会话树，把会话的活跃分支读取为有界 transcript，通过 `ctx.llm` 暴露 Pi 配置中的模型与 provider 路由，检查 provider 凭据状态，并默认使用 `pi --mode rpc` 派发运行。不会向 Pi 的存储写入任何内容，只有检测与运行派发会启动进程。Pi 没有非交互式登录或登出，因此这些操作返回指引，且它不记录原生 todo 列表或 plan。

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
- id: agent-pi
  name: '@deepseek-ai/dsh-agent-pi'
  config:
    homeDir: ~/.pi/agent
    sessionDir: ~/.pi/sessions
```

### When to choose it

在运行 Pi、且希望会话留在 Pi 自己存储中的机器上选择本 adapter。它是唯一能列出、读取或派发 Pi 会话的包，并且在被读取或派发之前保持惰性；没有该二进制的机器仍可挂载它，并会报告 `installed: false` 及原因。它还会把 Pi 配置中声明的路由注册到 `ctx.llm`，使用 Pi 文件里的 endpoint、protocol 与凭据信息。它不提供原生任务状态，因为 Pi 不记录 todo 列表或 plan，所以需要这些的调用方必须另选会记录它们的智能体。需要其他外部智能体的组合也可以挂载对应 adapter，同一个 profile 可以挂载多个。

### Minimal configuration

上面的行在完全不带 `config` 时也可用：检测会搜索 `PATH` 与已知安装目录，agent 目录依次回退到 `$PI_CODING_AGENT_DIR` 与 `~/.pi/agent`，会话目录依次回退到 `$PI_CODING_AGENT_SESSION_DIR` 与 Pi 自己的 `settings.json`。这里列出全部可接受的字段。

| Field | Default | Meaning |
|---|---|---|
| `binaryPath` | unset | 显式 `pi` 可执行文件，先于 `PATH` 与已知安装目录尝试。 |
| `homeDir` | unset | 显式 Pi agent 目录，先于 `$PI_CODING_AGENT_DIR` 与 `~/.pi/agent` 尝试。 |
| `sessionDir` | unset | 扁平会话目录，先于 `$PI_CODING_AGENT_SESSION_DIR` 与 Pi `settings.json` 的 `sessionDir` 尝试。 |
| `env` | `{}` | 本 adapter 启动的每个子进程的额外环境变量。 |
| `runMode` | `duplex-protocol` | `duplex-protocol` 使用 `pi --mode rpc`；`headless-exec` 使用 `pi --mode json`。 |
| `interruptGraceMs` | `10000` | RPC abort 后，在终止 Pi 进程前等待的时间。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

该 adapter 是 mesh 的 `AgentHost` 的纯函数：`detect.ts` 解析二进制并探测 `--version`，`sessions.ts` 解析存储布局、解析会话头与追加式条目、沿 `parentId` 树走到活跃分支，并同时扫描扁平覆盖目录与默认的按项目根目录，`transcript.ts` 把分支条目投影为 mesh 消息，`auth.ts` 分类 `auth.json` 并报告它不会伪造的凭据操作，`index.ts` 读取 agent 目录，`llm-models.ts` 从 `models.json`、`settings.json` 与 `auth.json` 投影已配置模型，且不会写入 Pi 数据。`run.ts` 拥有共享事件投影与 `pi --mode json`；`rpc-run.ts` 拥有 RPC 会话绑定、prompt、abort 与进程拆卸。插件的 `apply` 从 Cordis 上下文构建宿主，再分别将 mesh adapter 与 LLM provider 注册为 effect；`describe()` 缓存其 descriptor，因为 mesh 目录在每次 GUI 加载时都会被查询。

| File | What it owns |
|---|---|
| `src/index.ts` | `pi` adapter、`PI_CAPABILITIES`/`PI_TRANSPORTS` 声明，以及两个 provider 注册。 |
| `src/detect.ts` | 二进制解析与 `--version` 探测。 |
| `src/sessions.ts` | 存储布局解析、头/条目记录模型、活跃分支遍历、有界发现，以及有损的 cwd 目录编码。 |
| `src/transcript.ts` | 把活跃分支投影为 mesh 消息，并施加 16 KiB 字段上限。 |
| `src/auth.ts` | `auth.json` 分类、provider 环境变量列表，以及登录/登出指引。 |
| `src/llm-models.ts` | 将 Pi provider 路由、model override 与 API key 来源只读投影到 `ctx.llm`。 |
| `src/run.ts` | 共享事件投影、`pi --mode json` 的 argv、不 spawn 的 resume 拒绝、取消与退出分类。 |
| `src/rpc-run.ts` | `pi --mode rpc` 的会话绑定、受支持确认请求的 DSH 审批、prompt 与 abort 命令及进程拆卸。 |
| `src/config.ts` | `PiAdapterConfig`/`ResolvedPiConfig` 的拆分与全部默认值。 |

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

本包不添加 prompt 文本或工具。mesh 工具仍通过 [`@deepseek-ai/dsh-agent-mesh-tools`](../tools/README.zh.md) 访问它的 `AgentAdapter`。它还会将 `agent-pi` 注册到 `ctx.llm`，使 Pi 配置中声明的模型可以用于 Harness 请求。mesh 工具渲染的会话行、transcript 消息与运行结果仍来自 `AgentAdapter`，其中包括每条声明投影缺口的 `notes` 字符串。

#### Token effect

自身没有。`mesh_*` 工具调用的 token 成本属于工具包的结果内容；本 adapter 不向请求添加任何自己的文本。派发运行的结果同样只经 `mesh_run`/`mesh_runs` 到达模型。

#### KV Cache effect

无。本包不贡献任何模型请求内容；进入请求的内容由 mesh 工具包拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 默认的 `duplex-protocol` 运行使用 `pi --mode rpc`；`runMode: headless-exec` 选择 `pi --mode json`。RPC 用 `get_state` 绑定当前会话，发送一个 prompt，投影 Pi 事件，并对运行中的回合发送原生 `abort`；若需要则在 `interruptGraceMs` 后终止进程。
- 如果 host 拒绝提供子进程退出结果，adapter 会取消 Pi、记录无法确认退出的警告，并返回 `run/protocol-error`；重试前先确认 Pi 进程已经停止。
- Pi RPC 会将 `confirm` 请求，以及带有明确一次性允许和拒绝选项的 `select` 请求交给 DSH 审批。其它对话框和选择会被拒绝并发出警告。运行请求的 `approval: approve` 选项会传入 Pi 的 `--approve` 标志。
- 原生 UI 审批响应写入失败会以 `run/protocol-error` 结束运行；调用方取消后若 UI 取消响应写入失败但取消成功，运行仍标记为已取消，并在 notes 中记录写入失败。
- Pi 没有非交互式登录或登出：两个操作都返回 `ok: false` 及指引，且从不启动任何进程，`capabilities().credentials` 声明 `login: ['interactive']` 与 `logout: false`。
- `resolveMcpServer` 会为 `mesh_mcp_connect` 读取用户 `mcp.json` 与项目 `.pi/mcp.json` 层。DSH 只会在首次使用审批后启动受支持的 stdio 或 Streamable HTTP server；SSE 与托管 OAuth 条目会 fail closed。
- Pi 不记录原生 todo 列表，也没有 plan 模式：`readNativeTasks` 返回 `available: false`，因此 Pi 会话的 mesh 任务面始终为空。
- 记录 cwd 与请求 cwd 不一致的 resume 会在 spawn 之前被拒绝（`run/context-unavailable`），否则 Pi 会提出受管子进程无法回答的交互式 fork 问题；同理，resume 传的是会话文件路径而不是裸 id。
- transcript 读取限定在活跃分支：不超过读取窗口（默认 512 KiB，钳制在 64 KiB–8 MiB）的会话文件整体读取；更大的文件只贡献头部加尾部窗口。链首落在窗口之外时 `totalMessages` 不报告，被放弃的分支不贡献任何内容。
- 会话目录名是有损的 cwd 提示（`--<flattened>--`），头部自身的 `cwd` 才是权威，二者不一致会声明为备注；adapter 同时扫描扁平 `sessionDir` 覆盖目录与默认 `sessions/` 根，上限为每次扫描 200 个目录、每目录 400 个文件、共 1,500 个文件。
- 模型目录只读取 `models.json` 与 `settings.json`：Pi 的内置目录及其 pi.dev overlay 被有意不读取，因此会把已配置模型全部移除的 `enabledModels` 范围会被忽略，而不是报告零个可运行模型。
- `ctx.llm` 路由也只读取 Pi 的用户文件。它投影已声明的 provider/model、override，以及 `defaultProvider`/`defaultModel`；API key 来自 `auth.json` 的 `api_key` 记录或 `models.json` 值与环境变量引用。已存储 OAuth 无法刷新，shell 命令凭据或 headers 会被拒绝；原生凭据不会复制到 Harness 凭据存储。
- 假进程测试覆盖 RPC 会话绑定、流式事件与原生 abort；尚未执行真实 Pi 模型运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

假 RPC 进程在不发起模型请求的情况下测试会话绑定、事件投影与原生 abort。

</details>
