# Agent Note: 审批界面先决断者胜

Status: implemented

[English](2026-11-11-first-decision-wins-approval-surfaces.md) | 中文

## 问题

Host 组合可以同时把 `approval/request` 转发给 Web Client，并在进程内注册 TUI answerer。转发 listener 位于最外层，因此只有 Client 返回 `{ kind: 'next' }` 时才会触及 TUI。浏览器标签打开时 TUI 永远不被询问；没有任何可作答的 Client 流时 Host waterfall 永不结算，审批在两边都没有提示框的情况下挂起。请求进行中 Client 断开会产生同样的挂起，而两个界面也没有规则决定哪个答复继续本轮。

## 决策

**没有可作答 Client 的转发 waterfall 交给 Host 链。** Gateway 在启动时零投递、以及最后一条投递在未作答前断开时，以 `{ kind: 'next' }` 结算 pending event，让 source listener 继续，而不是等待一个无法作答的 Client。

**`approval/request` 让两个界面竞速，先产生的决断获胜。** `API_REMOTE_FORWARDED_EVENTS` 中带 `raceWithHost` 的行让转发 listener 同时运行 Client 路径与 Host 链。Client 的 `{ kind: 'result' }` 是决断；Host 返回值除该行声明的 `hostAbsentValue`（`'unavailable'`）之外是决断；Client 的 `{ kind: 'next' }`、source 结束、Host 拒绝以及该缺省值都不是决断。落败一方被中和，`next()` 恰好运行一次，两边都未决断时返回 Host 结果（fail-closed 的 `'unavailable'`）。

Host 链决断时，listener 调用 invocation 上的 `dismiss`；Gateway 在认领事件时安装该回调。`dismiss` 停止跟踪事件，并向每个已收到它的 Client 推送 `cancel` 帧，因此浏览器卡片消失而无需结算 source。`user-questions/request` 保持纯委托：它的 TUI answerer 不监听请求撤回，参与竞速会让提问框永久停在原地并阻塞后续提问。

`ApprovalService.decide` 向每个 answerer 派发与调用方信号组合的请求级信号，并在请求结算后中止它。只监听该信号的进程内面板因此在 Web Client 获胜时撤单，而调用方取消仍然结算 `'cancelled'`。

## 考虑过的替代方案

**Client 连接时让转发 listener 总是委托。** 否决：Client 可能永不作答，重新制造挂起，而且仍然一次只询问一个界面。

**Host 一有答复就返回。** 否决：fail-closed 的 `'unavailable'` 或 Host 拒绝不是用户决断，提前返回会在用户仍可在浏览器批准时关闭卡片。

**由 source 直接结算 pending event，而不是用 Gateway 安装的 `dismiss`。** 否决：source 闭包不经过 Gateway，Client 收不到 `cancel` 帧，pending map 也会保留该条目。

## 影响

同一次审批可能在两个界面都显示提示；先产生的答复继续本轮，另一个被撤回。pending event 不再等待之后才连接的 Client：该 Client 看不到卡片，Host 链单独作答。Gateway 拥有的 invocation 增加一个可变的 `dismiss` 回调，source 不得在 Gateway 认领之前调用它。只有 `approval/request` 选择竞速，`user-questions/request` 保持既有的委托语义。
