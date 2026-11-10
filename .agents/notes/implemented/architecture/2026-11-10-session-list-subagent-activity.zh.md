# Agent Note：会话列表由 Host 报告实时直接子智能体活动

Status: implemented

[English](2026-11-10-session-list-subagent-activity.md) | 中文

## 问题

委派会话的直接子会话还在工作时，Workspace 侧边栏却把它标记为已完成。Client 从父会话的 `subagentCatalog` 投影推导该活动，而该投影只能经由客户端本地投影 store 到达：重连会清空这些 store，冷父会话可能永远拿不到当前 catalog cut，于是计数静默变成 0，绿色"已完成"提示接手了该行。第二个缺口在 Client 侧完全没有数据源：external 子执行不拥有本地 Session，因此没有任何 Session header、状态事件或带运行中 Agent 的 catalog 行能表示它。

两个候选的"等待"状态对直接子会话并不存在。`ask_user_question` 拒绝调用 Agent 为 subagent 的请求（`DELEGATED_CALLER`），所以 child 无法挂起用户提问；而审批等待发生在未结束的轮次内部，child 的 Agent 仍处于 `running` 阶段。因此单独统计 `waiting` 类别只会报告不会出现的状态，而每个审批等待都已计入运行中。

## 决定

`SessionSummary` 携带可选的 `subagentActivity: { running, external }`。`running` 统计自身 header 指向该父会话且 Agent 状态为 `running` 的直接 child；`external` 统计 Subagent 服务中的活跃 external 执行。两者都在 Host 的 `summaryFor()` 与 `summarizeCold()` 中解析，因此已接入父会话、冷父会话，以及从未加载 catalog 的 Client 都会拿到同一个事实。两个计数都不为正时该字段缺席。

external 计数是唯一新增的查询面：`SubagentRuntime.externalChildCounts()` 读取 manager 的驻留 activation，按持久化的直接创建者（`ancestors` 的最后一项）报告活跃 external 执行。它不持久化任何内容，也不新增 Session 事件。

child 的 Agent 状态变化时，以及 `subagent/start`、`subagent/end` 边沿到达时，父行以 `api-session/added` 重新发布，与 `agent/created` 重新发布可用性的既有做法一致。这些是逐个 child 的生命周期翻转，不是逐帧工作；每次翻转只重建一次摘要。未接入的父会话没有可摘要的 Session，因此它保留上一行，直到下一次列表读取。

Client 优先使用 Host 事实，并在摘要没有该字段时保留先前"catalog ∪ child 列表行"的推导作为回退。活跃 child 全部为 external 的行会在文案中标明外部子智能体；状态仍为 `ongoing`，因此等待用户不会与主状态槽竞争。

## 考虑过的替代方案

**只保留 Client 侧推导。** 第一轮已把 catalog 与 child 列表行并集，修好了常见的重连与过期 catalog 情形。它看不到 external 执行，而且仍依赖某个 Client 恰好加载了哪些投影。它保留为回退，因为旧 Host 的摘要与本地合成的列表行不带该字段。

**子会话运行时抑制父会话的 `completionUnread`。** 该行会落到静息状态（`idle`）而不是"进行中"，而且会改变由 `ui-session` 拥有、刻意独立的未读完成提醒的含义。

**在 Host 上从 `subagentCatalog` 投影计算该字段。** 投影已注册且驻留 Host，但它只记录成员关系：条目不带执行状态，caller 交付的 external 运行根本不进入 catalog。不改投影无法回答这两个问题，而改投影需要新增 Session 事件与持久化格式变更。

**新增持久化 `waiting` 计数。** subagent 无法挂起用户提问，审批等待本身已是 `running`。持久化计数器需要新的投影来表示不会发生的状态。

## 影响

`subagentActivity` 是对 pre-stable wire 类型的可选补充；所有 Client 消费方都会合并它，且不改变任何持久化 Session 格式或投影 state version。冷父会话的活动在下一次列表读取或 run 边沿时刷新，而不是来自逐 child 事件，这与它其余列表事实的新鲜度一致。自行从 Session 摘要构建完成标记的产品（包括仓库外的 TUI）必须主动采用该字段；本次改动不改变任何外部客户端。
