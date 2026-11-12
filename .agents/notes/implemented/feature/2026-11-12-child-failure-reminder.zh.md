# Agent Note: Child-failure reminder

Status: implemented

[English](2026-11-12-child-failure-reminder.md) | 中文

## Problem

`dsh-subagent` 已经会告诉父级某个可继续或后台子代理收尾了，收尾通知里带着准确的 `stopReason`。但没有任何机制逼父级据此做事。父级可以读到 `max-tokens` 或 `error`，写一句「我接手」，然后结束回合：不换路由重派，上下文溢出后也不缩小 scope，更没有留下「这次委派从未完成」的记录。实测会话 `session-dfcfc0ce` 显示投递本身正常，缺少的是处置。

## Decision

`@deepseek-ai/dsh-child-failure-reminder` 观察父级自己的会话日志，并在 `agent/turn-stopping` 时为每一条尚未处置的异常收尾 steer 一条提醒。

收尾通知在 loop 把它 claim 进某一步、写下来源类型为 `subagent-settled` 的 `user/message` 事件时才算进入 guard。读 `session/event` 而不是读 inbox 或接纳钩子，让 guard 拿到的正好是模型确实看见过的那些通知，同时也带来它需要的另外两个信号：`turn/start` 为每条记录划定回合并重置该回合的提醒预算，`tool/call` 则显示父级事后是否派发或给某个子代理发了消息。

收尾边界是模型不再欠回复、回合即将关闭的唯一位置。在那里 steer 会让机器重读 inbox 再走一步，因此压力存在于 loop 自己的状态机里，而不是存在于模型可能忽略的提示词措辞里。每条异常收尾最多触发一条提醒，一个回合最多接受 `maxPerTurn`（默认 2）条：提醒是保留历史，没有上限的机制会在该会话之后每次请求上花 token，也会把一次被丢掉的失败变成循环。

父级在收到通知后调用过 `subagent` 或 `send_message`，就已经采取了动作，其待处置失败被标记为已处置，不再提醒。guard 只比较工具名；要把某次调用归因到具体子代理，就得解析另一个包工具 schema 拥有的参数。

`stopReasons`（默认：除 `completed` 外的全部已知原因）决定什么算没做完。本构建无法命名的原因来自把变体合并进 `SubagentStopReasonMap` 的某个后端，一律按异常处理：把无法解释的收尾报告成成功，正是本 guard 存在要防的失败。

## Alternatives considered

**在委派说明里加提示词。** 一条要求父级处置失败的话，与收尾通知本身一样只是建议；那个用一句正文了结回合的模型还会这样做。它也无法区分「致意」和「动作」。

**给 agent loop 加一个拒绝关闭回合的分支。** loop 已经为这种控制点记录了 `agent/turn-stopping`，而插件约定要求新行为挂在已记录的扩展点上，而不是改 loop。

**由 guard 自动重派。** guard 看不到子代理的任务、它可能留下的副作用，也看不到路由失败的原因，因此它会重放已知失败的 prompt——`max-tokens` 的子代理用同样的上下文重跑会再次溢出。缩小范围与换路由是需要父级上下文的判断；提醒逼出这个判断，而不是替它猜。

**按子代理归因处置调用。** 解析 `subagent` 与 `send_message` 的参数会把本 guard 绑到另一个包的工具 schema 上。粗粒度规则——通知之后任何派发级调用都了结它之前的通知——朝静默一侧犯错，而每回合预算约束了反方向的错误。

**阻塞回合直到父级调用某个指定工具。** 强制某个必需工具等于替父级决定补救方式，与菜单相悖：核对副作用、缩小范围、换路由、自己做完、显式记录放弃，都是正当结局。

## 正常收尾却没干完的子代理

停止原因看不见这种子代理：它自己耗尽了预算、报告说没能复现缺陷，然后以 `completed` 收尾。这个 guard 的第一批生产案例正是这种形状——五个子代理里两个失败，一个耗尽上下文、一个自报工作没做完，而只有前者是异常停止原因。

因此 `dsh-subagent` 扩展了初始的结果投递指引：干不完的子代理在收尾正文开头写 `INCOMPLETE:`。guard 在 `completed` 收尾上读到这个标记，就按普通失败处理。用协议词而不是让管理器推断：从散文里猜「INCOMPLETE coverage is the remaining risk」会被误判成失败，而让管理器做分类则每条收尾都要多一次模型调用。对子代理看不到该指引的部署，`treatIncompleteMarker: false` 可恢复只按停止原因判断的行为。

提醒里的动作菜单按这些失败实际被恢复的顺序给出：加大输出预算或缩小范围、把任务拆成更细的子任务、换一个提供方路由重派一次、由父级自己做完、或显式记录放弃。仍然不做自动重派：刚在一个 prompt 上耗尽预算的子代理，用同一个 prompt 还会以同样方式失败；而写操作型子代理可能已经留下副作用，重跑会重复它。

## Consequences

父级不能再一承认失败就结束回合；它至少要再多走一步做点事情。大量委派、并把子代理丢在上下文上限上的会话，现在会缩小范围重派或记录 `[DELEGATION-FAILED: …]`，而不是静默前进。代价是每回合最多 `maxPerTurn` 条提醒消息，每条约 120 token，外加每条提醒强制的那一步。

信号按回合生效：父级在更早回合见过的收尾不会再次提醒，因为提醒是为收到它的那个回合而存在的。在父级已经结束回合之后才到达的收尾会唤醒一个新回合，并在那里提醒，因为投递会把这个通知 claim 进那个回合的第一步。永不收尾的子代理——卡在工具调用里——不产生通知，也就没有提醒；该场景由 `subagent.childRunDeadlineMs` 负责。引用的细节是收尾通知的最后一个文本块，因此提醒跟随 `dsh-subagent` 的通知排版，而不是某个专用 API。

`child-failure-reminder` 消息来源是新的模型可见生产者类型；它不需要会话格式迁移，因为 V4 接受任何生产者拥有的来源类型，而本插件不属于任何已发布的 V3 世代。

## Verification

`packages/guard/child-failure-reminder/tests/child-failure-reminder.spec.ts` 用脚本化的模型驱动真实 agent loop：每种异常收尾原因各提醒一次，`completed` 与没有 `stopReason` 的通知保持静默，未知原因会提醒，每回合预算限制 steer 次数，通知之后的 `subagent` 或 `send_message` 调用抑制提醒而无关调用不会，第二个回合不继承任何待处置失败，每种配置违规都在加载时失败。本包已注册进 `packages/bundle/base`，并受逐文件 100% 覆盖率门禁约束。
