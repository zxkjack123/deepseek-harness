# Agent Note: 恢复的 Web 页面替换它的连接 generation

Status: implemented

[English](2026-11-10-client-resume-reconnect.md) | 中文

## Problem

手机把 Web 客户端切到后台后，WebSocket 被冻结却不派发 `close`。客户端仍报告 `connected`，收不到任何事件，会话列表与 Workspace 列表永远填不满；Workspace 恢复逻辑在等一个永远不会到达的 `ready` 列表，于是页面停在一个空对话上，用户放多久就是多久。唯一的出路是手动刷新，而安装成 App 之后根本没有刷新控件——当引导本身失败时，那张启动失败页同样是死路。

客户端在恢复时不会重建 generation：`reconnect()` 只有一个调用方（设置页的连接指示器），而 Connection 只监听 `online` 与 `offline`。

## Decision

`installConnection` 在 `watchBrowserNetwork` 旁边安装 `watchBrowserResume`。它在两种情况下替换 generation——调用循环自身的 `reconnect()`，而不是另起一套传输：页面隐藏至少 `resumeReconnectAfterMs` 之后 `visibilitychange` 变为可见；以及 `persisted` 为 true 的 `pageshow`，即隐藏窗口观察不到的 bfcache 恢复。owner 随循环一起拆除监听，因此已停止或已释放的连接对这两个事件不作反应。

刻意不监听 `focus`。普通的桌面切标签页必须保留自己的 generation，因为替换会中断当前流；因此阈值默认取 5000 ms，而不是"仍能抓住挂起手机"的最短间隔，部署可以通过 `ConnectionRecoveryConfig` 重新调参（包括 Host 注入的 `__DSH_CONNECTION_RECOVERY__` 中的那份值）。

替换 generation 正是修复卡死页面的手段：会话控制器会在新 generation 上再次执行 `handleConnected()` 并重启控制流，从而重新填充 Workspace 恢复逻辑所等待的那些列表。

启动失败页的报告新增了 `Reload` 动作。那张页面在 locale 插件加载之前渲染，而它是安装型 App 唯一可用的恢复入口。

## Alternatives considered

- **每次 `visibilitychange` 都重连。** 写起来最省，但桌面切标签页会在流进行到一半时中断当前 generation。用隐藏时长阈值让普通桌面场景变成空操作，同时仍能抓住挂起的手机。
- **检测陈旧 socket 而不是替换它。** 服务端心跳是 WebSocket 控制帧（`socket.ping()`），页面脚本看不到；而空闲会话不携带任何可供打时间戳的应用层帧，客户端因此没有可靠的陈旧判据。
- **用重连横幅代替自动替换。** 把恢复留在用户手里，但挂起的手机渲染出的是一份看起来仍然实时的陈旧记录；真正修复状态的是自动路径。

## Consequences

- 隐藏超过阈值的页面在返回时付出一次握手和一次控制流重启。隐藏时正在流的轮次在 Host 上继续，并被重新从会话日志回放进新 generation。
- 桌面与手机共用这套行为；只有阈值能区分二者，而当前客户端并不区分。
- `packages/client/connection/tests/client-apply.client.spec.ts` 钉住了低于阈值、达到阈值、bfcache、循环已停止、无 document 这五种情形。
