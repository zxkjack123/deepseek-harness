---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-child-failure-reminder-source

[English](2026-11-12-child-failure-reminder-source.md) | 中文

## 概述

在 `user/message`、`developer/message`、`agent/inbox/spliced` 与 `session/title-llm-request` 携带的可合并消息来源联合类型中新增 `child-failure-reminder` 成员。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-child-failure-reminder-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "b055eaf2244ddaf2cb4845115eef56919c26a1d56d6f50cf450c2e271df4c933"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "1b69149e1776e53dce0e2d512a8ebf6d55d0401d64ea29fbf0ef136a1d1d2fe7"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "e45cb8cf6f0eb11505f589772be6ab81db7579ed0e002b5cd43907c22ae9e11c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "bf474d1407751cd84c3bf4b87a410389bdae490f8b78df6acd32a4b52f437548"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

本次变更只新增联合类型变体，没有任何持久记录变得不可读。旧版本读取方遇到无法识别的 `kind` 时，处理方式与它面对所有生产者自有 kind 时一致：消息来源联合类型是可合并的，消费方按已知种类分支、其余走默认，且 V4 接纳任何非空的生产者自有来源类型、没有逐类型白名单。迁移对非 `plugin` 类型原样传递，因此本构建写出的日志与之前的日志升级路径完全相同。任何判别字段都不会误读新消息：其内容是普通的 user 角色上下文，来源将该消息归属于本插件。新版本读取旧日志也不变，因为没有删除或重命名任何变体。因此头部版本保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/guard/child-failure-reminder：28 个测试通过。pnpm exec vitest run packages/session/session-format-v3-to-v4 packages/session/session-format-v2-to-v3：923 个测试通过。pnpm run typecheck：5 个门禁通过。pnpm run build:check：2 个门禁通过。

<a id="dev-note"></a>
## 开发备注

无。
