---
kind: upgrade-guide
description: "Subagent 结果新增独立的 diagnostic 字段（上限 4096 UTF-8 字节），childRunDeadlineMs 为子级运行设墙钟上限。"
---

# Subagent 失败会报告独立的诊断信息

[English](guide.md) | 中文

## 变更

`SubagentResult` 在 `output` 之外新增 `diagnostic`：本地失败详情，例如 `OPERATION_ABORTED: <消息链>`，按 `MAX_SUBAGENT_DIAGNOSTIC_BYTES`（4096 个 UTF-8 字节，由 `@deepseek-ai/dsh-subagent` 导出）截断。消费方应把它与子级自己的回答分开展示。

子级运行同时受 `subagent.childRunDeadlineMs` 配置约束。到期后子级以 `aborted` 结清并附带期限诊断，而不是无限期占用父级。

## 迁移

- 把 `diagnostic` 当作错误详情渲染，绝不当成子级的 `output`，也不要解析其结构：它是自由格式的消息链，可能在字符串中途被截断。
- 与正文一起读 `stopReason`。`error`、`max-tokens`、`aborted`、`refusal` 对应不同处置，即使诊断被截断也仍能指明是哪一种。
- 需要更紧的墙钟时在组合里设置 `childRunDeadlineMs`；默认值刻意宽松，它只为拦住真挂死的子级。
