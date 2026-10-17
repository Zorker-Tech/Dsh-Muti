---
description: "agent-mesh 的 OpenAI Codex adapter：`codex` 与 `$CODEX_HOME` 检测、只读 rollout、凭据与已配置模型，以及支持会话续接、中断和审批转发的原生 app-server 运行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

[English](README.md) | 中文

## 概述

挂载本包后，Harness 可以使用已安装的 Codex CLI。它列出 Codex 自己的 rollout 会话，以有界尾部窗口读取 transcript、清单与计划状态，报告 ChatGPT 或 API key 凭据状态，列出已配置模型，通过 `ctx.llm` 暴露支持的 Responses API 路由，并通过 `codex app-server --stdio` 执行可续接的 turn。原生命令和文件变更审批请求可以交由 DSH 处理；取消会先中断当前 turn，进程卡住后再终止。没有 Codex 二进制时，检测报告 `installed: false`。

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
- id: agent-codex
  name: '@deepseek-ai/dsh-agent-codex'
  config:
    homeDir: ~/.codex
    model: gpt-5-codex
```

### When to choose it

在运行 Codex CLI、且希望会话留在 Codex 自己存储中的机器上选择本 adapter。它是唯一能列出、读取或派发 Codex 会话的包，并且在被读取或派发之前保持惰性；没有该二进制的机器仍可挂载它，并会报告 `installed: false` 及原因。独立的 `ctx.llm` provider 会按支持的 Codex 用户级配置暴露模型。需要其他外部智能体的组合也可以挂载对应 adapter，同一个 profile 可以挂载多个。本 adapter 从不重新实现 Codex，也从不读取 `$CODEX_HOME` 之外的存储。

### Minimal configuration

上面的行在完全不带 `config` 时也可用：检测会搜索 `PATH` 与已知安装目录，home 依次回退到 `$CODEX_HOME` 与 `~/.codex`。这里列出全部可接受的字段。

| Field | Default | Meaning |
|---|---|---|
| `binaryPath` | unset | 显式 `codex` 可执行文件，先于 `PATH` 与已知安装目录尝试。 |
| `homeDir` | unset | 显式 Codex home，先于 `$CODEX_HOME` 与 `~/.codex` 尝试。 |
| `env` | `{}` | 本 adapter 启动的每个子进程的额外环境变量。 |
| `model` | unset | 未被运行指定的模型，使用 Codex 自己的命名。 |
| `runMode` | `duplex-protocol` | `duplex-protocol` 使用 `codex app-server --stdio`；`headless-exec` 使用 `codex exec --json`，不支持原生中断或审批转发。 |
| `sandbox` | unset | 未被运行指定的沙箱 profile；取 `read-only`、`workspace-write`、`danger-full-access` 之一。 |
| `approval` | unset | 未被运行指定的审批模式；取 `on-request`、`never` 之一。 |
| `timeoutMs` | `0` | 默认运行预算（毫秒）；`0` 表示运行不受时限。 |
| `interruptGraceMs` | `10000` | 发送 `turn/interrupt` 后等待 Codex 完成 turn 的时长；超时后终止受管进程。 |
| `transcriptTailBytes` | `1048576` | 投影 transcript 时读取的 rollout 尾部窗口。 |
| `taskTailBytes` | `1048576` | 提取原生任务状态时读取的 rollout 尾部窗口。 |
| `loginTimeoutMs` | `600000` | 委托的 `codex login` 的挂钟预算。 |
| `logoutTimeoutMs` | `60000` | 委托的 `codex logout` 的挂钟预算。 |
| `versionProbeTimeoutMs` | `10000` | `--version` 检测探测的挂钟预算。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

该 adapter 是 `CodexHost`（mesh 的宿主端口）的纯函数：`detect.ts` 解析二进制并探测 `--version`，`sessions.ts` 解析 home 布局并从头读取 rollout 来枚举，`transcript.ts` 投影 rollout 行，`tasks.ts` 折叠最新的清单或计划记录，`auth.ts` 分类 `auth.json` 并委托凭据流程，`models.ts` 扫描 `config.toml`，`run.ts` 拥有 `codex exec --json` transport，`app-server-run.ts` 拥有双工 app-server 生命周期、事件投影、审批请求、中断与终态分类。插件的 `apply` 只从 Cordis 上下文构建该宿主并把 adapter 注册为一个 effect，因此卸载即移除。检测与 home 布局只解析一次并缓存；检测失败不缓存，因为用户可以安装该二进制后再次请求。

| File | What it owns |
|---|---|
| `src/index.ts` | `codex` adapter：缓存的检测、能力声明、登录/登出委托，以及注册到 `ctx.agentMesh`。 |
| `src/detect.ts` | 二进制解析、`--version` 探测，以及沙箱与审批词汇表。 |
| `src/sessions.ts` | home 解析、有界的 rollout 发现、`session_meta` 解析，以及 `session_index.jsonl` 标题。 |
| `src/transcript.ts` | 把 rollout 行投影为 mesh 消息，并施加 16 KiB 字段上限。 |
| `src/tasks.ts` | 最新的 `plan_update`、`update_plan`、`todo_list` 与 `plan` 状态，以及跨重读稳定的 todo id。 |
| `src/auth.ts` | `auth.json` 分类、环境变量优先级、委托的 `codex login`/`logout`，以及脱敏。 |
| `src/models.ts` | 用户层 `config.toml` 扫描，得出已配置的模型 id。 |
| `src/llm-models.ts` | 只读投影 Codex Responses API 模型路由与环境变量凭据引用。 |
| `src/run.ts` | `codex exec --json` 的 argv、事件流映射、取消与退出分类。 |
| `src/app-server-run.ts` | `codex app-server --stdio` 会话生命周期、事件投影、DSH 单次审批、中断与终态结果。 |
| `src/config.ts` | `CodexAdapterConfig`/`ResolvedCodexConfig` 的拆分与全部默认值。 |
| `src/types.ts`、`src/json.ts`、`src/notes.ts` | 宿主端口别名，以及 JSON 与投影备注的收窄辅助函数。 |

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

mesh 工具保持独立：本包不添加 prompt 文本或工具；这些工具仍通过 [`@deepseek-ai/dsh-agent-mesh-tools`](../tools/README.zh.md) 访问 `AgentAdapter`。`mesh_run` 会等待原生 turn 完成，并返回最终答案或分类错误。app-server transport 会把命令与文件变更审批请求转给发起调用的 DSH 会话，且只接受原生单次授权。该 adapter 还会向 `ctx.llm` 注册 `agent-codex`；用户选择其已配置模型后，请求会直接发送到配置的 Responses API endpoint。

#### Token effect

自身没有。`mesh_*` 工具调用的 token 成本属于工具包的结果内容；本 adapter 不向请求添加任何自己的文本。派发运行的结果同样只经 `mesh_run`/`mesh_runs` 到达模型。

#### KV Cache effect

无。本包不贡献任何模型请求内容；进入请求的内容由 mesh 工具包拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `headless-exec` 无法中断单个 turn，也不能转发运行期间的审批请求；需要这些功能时请使用默认的 `duplex-protocol` 模式。
- app-server adapter 会把命令和文件变更审批请求转交 DSH，只会授予原生单次 `accept`；其他原生审批选项都会被拒绝。用户输入、额外 turn 权限和 MCP elicitation 请求会 fail closed，并返回空答案或拒绝响应。
- `resolveMcpServer` 会为 `mesh_mcp_connect` 读取 `$CODEX_HOME/config.toml` 与项目 `.codex/config.toml` 层。DSH 只会在首次使用审批后启动受支持的 stdio 或 Streamable HTTP server；SSE 与 OAuth 条目会 fail closed。
- 不解压 zstd 压缩的 rollout（`rollout-*.jsonl.zst`）：列出时报告为 `unreadable`，`readNativeTasks` 返回带备注的空状态，`readTranscript` 抛出 `mesh/unsupported-operation`。请在 Codex 中打开该会话以生成普通 rollout。
- transcript 与任务读取都是有界的尾部窗口（`transcriptTailBytes` 与 `taskTailBytes`，默认 1 MiB），更早的内容落在窗口之外并在 `notes` 中声明；Codex 不记录消息计数，因此 `totalMessages` 永不报告。
- 会话列出只读取每个 rollout 头部的 64 KiB，每个根最多遍历 4 层目录与 5,000 个 rollout 文件，标题只取自 `session_index.jsonl`；列出期间不读取首条用户消息。
- 模型目录只读取用户配置层（`$CODEX_HOME/config.toml`）：旧式 `[profiles.*]` 选择、工作目录层与受信任的项目 `.codex/config.toml` 层被有意不合并，因为 mesh 模型行不携带来源信息，部分生效的层优先级无法如实报告。
- `ctx.llm` 路由支持 `model`、`review_model`、`model_provider`、`wire_api = "responses"`、`base_url`、`name` 与 `env_key`；不会复用 Codex `auth.json` 中的 OAuth 会话、查询参数或其他 wire API。直接模型请求需要命名的环境变量 API key，通常为 `OPENAI_API_KEY`。
- keyring 凭据存储或无法识别的 `auth_mode` 报告为 `unknown` 而不是已登出；`id_token` 声明（账号、套餐、过期时间）在解码时不校验签名，仅用于显示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/` 固定了二进制解析与 home 回退、凭据分类与委托登录/登出、`config.toml` 扫描与 LLM 路由投影、会话列出（归档、压缩、cwd 过滤、中止）、带全部声明缺口的 rollout 行投影、原生任务提取与 id 稳定性、exec argv 与事件投影，以及 app-server 生命周期、审批、中断和失败分类。zstd 路径只作为不可读情形被覆盖，而非解压。

</details>
