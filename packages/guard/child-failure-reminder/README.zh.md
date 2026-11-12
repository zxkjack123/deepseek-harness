---
description: "回合收尾 guard：子代理异常收尾后，父 agent 的回合不会关闭，直到它做出处置，供选择、配置或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-child-failure-reminder

[English](README.md) | 中文

## 概述

本包让父 agent 必须处置没有完成任务的子代理。`dsh-subagent` 已经为每个后台子代理投递带 `stopReason` 的收尾通知；但如果没有压力，父级回一句「我接手」就能正常结束回合。本 guard 监听这些通知，在回合收尾边界 steer 一条提醒，点名子代理、它的 `stopReason` 以及能真正了结这次失败的动作，使模型不做出其中一个动作，回合就不关闭。`dsh` base bundle 以默认提醒预算启用本包。

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

当 agent 把工作委派给可能失败的子代理（上下文溢出、提供方错误、中止、拒绝，或以 `INCOMPLETE:` 开头收尾却正常结束的子代理），而父级必须决定怎么处理、而不是把收尾通知当信息读掉时，挂载本插件。`dsh` base bundle 已经运行它；部署需要不同的压力时，调整下面的提醒预算或异常集合。

### 何时选择

当「静默丢掉的子代理失败」是代价高昂的结局时选择它：看起来委派了、其实没做的工作，或者上下文爆掉而父级从未缩小范围重派的子代理。反过来，当这些收尾对该部署纯属信息——例如刻意的 fire-and-forget 工作流、结果在别处读取——就不要挂载，因为它会让父级回合一直开着，直到失败被处置或被明确放弃。

### 配置异常集合与预算

默认不合适时带配置挂载：

```yaml
- name: '@deepseek-ai/dsh-child-failure-reminder'
  config:
    stopReasons: [error, max-tokens, aborted, refusal]  # what counts as unfinished
    maxPerTurn: 2                                       # reminders steered into one turn
    detailPreviewChars: 500                             # quoted notice detail
    dispositionTools: [subagent, send_message]          # calls that count as handling it
    treatIncompleteMarker: true                         # read `INCOMPLETE:` closings as failure
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `stopReasons` | `[error, max-tokens, aborted, refusal]` | 视为未完成工作的收尾原因。`completed` 永不提醒；本构建无法命名的原因一律提醒 |
| `maxPerTurn` | `2` | 一个回合内可 steer 的提醒次数；该回合后续的异常收尾保持静默 |
| `detailPreviewChars` | `500` | 提醒中引用收尾通知最后一行的字符上限 |
| `dispositionTools` | `[subagent, send_message]` | 收到通知后调用这些工具即算父级已处置；空列表关闭该信号 |
| `treatIncompleteMarker` | `true` | 子代理以 `INCOMPLETE:` 开头收尾时，把 `completed` 收尾按失败处理 |

非法配置在启动时报错——`stopReasons` 为空、原因或工具名为空字符串，或 `maxPerTurn`/`detailPreviewChars` 不是正整数——绝不静默改变行为。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-child-failure-reminder)记录了每个可接受取值。

### 你会得到什么

默认配置下，子代理以 `error`、`max-tokens`、`aborted` 或 `refusal` 收尾时，父级会在收到该通知的那个回合结束时收到一条提醒。提醒点名子代理与收尾原因、引用通知里的诊断信息、说明「只在正文里描述失败并不算处置」，并列出动作：重跑前先核对副作用、上下文溢出后缩小 scope 重派、错误后换路由、自己接手做完，或放弃时记录 `[DELEGATION-FAILED: <child> - <reason>]`。steer 会让回合保持开启，因此模型的下一步是真实动作而不是收尾段落。若父级在收到通知后已经派发或给子代理发过消息，则不再提醒；同一回合的第二次异常收尾最多再多一条提醒。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

本节说明 guard 如何收集失败、如何强制做出决定，并指向实现它的代码；可观察行为在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

guard 建立在四项承诺上：

- **读持久日志，而不是读 inbox。** 只有当 loop 把收尾通知 claim 进某一步、写下 `user/message` 事件之后，guard 才算观察到它。对模型还没看见的通知施压，等于逼它对从未被告诉过的事情做决定。
- **在收尾边界决定。** `agent/turn-stopping` 是模型已经不再欠回复、回合即将关闭的唯一时刻；在这里 `steer` 会让机器重读 inbox 再走一步，正是正文回应无法提供的压力。
- **给压力设上限。** 每条收尾只提醒一次，每回合最多 `maxPerTurn` 次。guard 是为了打破一次被丢掉的失败，不是把会话扣为人质。
- **加载时大声失败。** 每个字段都在 `apply` 中校验并抛错，不回落到默认值。

### 采集：从收尾通知到待处置失败

`ctx.on('session/event')` 观察父会话自己的日志。只有三类事件相关：

- **`turn/start`** 开启回合并记录回合号，同时清空上一回合的收尾记录、重置提醒预算。
- **`user/message`** 的来源类型为 `subagent-settled` 时记录一条待处置失败——子代理的模型可见名字（从通知摘要中读取，失败时回落到发送方会话 id）、它的 `stopReason`，以及通知的最后一个文本块（只要 manager 记录了诊断，那就是诊断）。没有 `stopReason` 的通知（历史日志）无法分类，直接忽略。
- **`tool/call`** 的工具名在 `dispositionTools` 中时，把每条待处置失败标记为已处置：父级对数它被通知的事采取了动作。guard 不解析调用参数，因此一次派发级调用会了结它之前的全部通知。

状态放在插件实例持有的 `WeakMap<Session, SessionState>` 中，会话被释放或不再被引用时不残留状态，也不需要 disposal 监听。

### 强制决定

在 `agent/turn-stopping` 时，guard 从正在收尾的回合中选出最早的一条既未提醒、也未处置的待处置失败。若存在且该回合预算允许，就把它标记为已提醒、计入该回合的提醒次数，并用 `{kind: 'child-failure-reminder', form: 'notice'}` 的消息调用 `agent.steer(...)`。loop 重读 inbox、带着提醒再走一步，然后重新到达收尾边界；后续每一次经过都已经没有可提醒的对象。没有失败符合条件时，监听器直接返回、不 steer，回合正常关闭。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、加载期校验、收尾采集与收尾边界的 steer |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时，阅读这些页面。

- [子代理子系统参考](../../../docs/subsystems/subagent.zh.md) —— 收尾通知、`stopReason` 语义，以及子代理结果如何到达父级。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-child-failure-reminder) —— 每个可接受配置字段及其源码声明。
- [guard 分组地图](../README.zh.md) —— 与本包一起发布的同级 guard 包。

-----

<a id="model-experience"></a>
## 模型体验

### 失败提醒

#### 模型看到什么

在收到异常收尾、且父级尚未处置的回合收尾边界，该 agent 会收到下面这条被 steer 的提醒，其中子代理名字、收尾原因与通知细节已替换；通知没有细节时省略该行，文本受 `detailPreviewChars` 限制。不新增工具 schema，也不新增普通调用文本。

##### 提醒

```markdown
Subagent "<child>" did not finish its task (stopReason: <stopReason>).
Last line of its settlement notice: <diagnostic>
A sentence in your reply does not resolve it: act on it now, before this turn ends. In your next step, take one of these actions with a tool:
- If the subagent could have written files, commits, or task-board records, inspect those side effects before deciding to rerun it.
- Output budget or context exhausted: raise the output budget, or re-dispatch with a smaller scope. Do not replay the same prompt unchanged; it hits the same ceiling.
- The work is too large for one child: split it into finer subtasks and dispatch them separately.
- The provider failed: re-dispatch once on a different route — another preset, model, or provider.
- Or finish the work yourself.
- If you are abandoning the task, record `[DELEGATION-FAILED: <child> - <reason>]` in your reply so the failure stays visible.
```

#### Token 影响

在异常收尾于收尾边界仍未被处置之前为零。此后每条提醒都是保留历史：`dsh-subagent` 自己的收尾通知，加上约 120 token 的提醒，每回合最多 `maxPerTurn` 条。

#### KV Cache 影响

仅追加；新可见内容跟在可复用的请求前缀之后，不会让已有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本 guard 何时不适用。它们是当前包约束，不是任务清单。

- **只按回合生效** —— 父级在更早回合见过的收尾不会再次提醒；guard 不跨回合或跨会话持久化待处置失败。
- **每条收尾只提醒一次** —— 父级两次结束回合都没动作，也只得到一条提醒，不做升级施压；重复只由 `maxPerTurn` 与按回合重置来约束。
- **处置信号是粗粒度的** —— 通知之后任何 `subagent` 或 `send_message` 调用都算已处置。guard 不解析工具参数，因此针对一个子代理的派发会了结它之前的全部通知。
- **诊断来源是通知文本** —— 引用的细节是收尾通知的最后一个文本块，因此它跟随 `dsh-subagent` 的通知排版，而不是某个导出 API。
- **永不收尾的子代理不会提醒** —— 卡在工具调用里的子代理不产生收尾通知，也就没有压力；该场景由 `subagent.childRunDeadlineMs` 负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与方向，明确非权威——已发布行为、限制与已接受的决策理由在上面各节、包代码与链接的 Agent Note 中。

[子代理失败提醒特性记录](../../../.agents/notes/implemented/feature/2026-11-12-child-failure-reminder.zh.md)记录了为什么把压力放在收尾边界、为什么提醒次数有上限，以及为什么 guard 不自己重派子代理。

</details>
