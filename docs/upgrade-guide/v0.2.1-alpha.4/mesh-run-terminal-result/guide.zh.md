---
kind: upgrade-guide
description: "`mesh_run` 现在会等待外部智能体返回终态结果。"
---

# `mesh_run` 返回终态结果

[English](guide.md) | 中文

## 变更

此前，`mesh_run` 会先返回 run id，外部智能体随后在后台继续运行。现在工具调用会保持打开，直到 run 进入终态，然后返回 run id、最终答案或分类错误以及 adapter notes。原先按立即派发结果解析的调用方需要处理终态字段和更长的调用时长。

## 迁移

1. 更新所有假设 `mesh_run` 会在智能体完成前返回的调用方。从结果中读取 `status`、可选的 `finalText` 或 `error`，以及 `notes`。
2. 完成后使用 `mesh_runs` 查看保留事件。确认成功调用返回终态 `status`，并在可用时包含智能体最终答案。
