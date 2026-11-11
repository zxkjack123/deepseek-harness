# Agent Note: First decision wins across approval surfaces

Status: implemented

English | [中文](2026-11-11-first-decision-wins-approval-surfaces.zh.md)

## Problem

A Host composition can forward `approval/request` to a Web Client while an in-process TUI answerer is also registered. The forwarded listener is outermost, so the TUI was reached only when the Client answered `{ kind: 'next' }`. With a browser tab open the TUI was never asked; with no answering Client stream the Host waterfall never settled, so the approval hung with no prompt anywhere. A disconnect mid-request produced the same hang, and the two surfaces had no rule for which answer continues the turn.

## Decision

**A forwarded waterfall with no answering Client delegates to the Host chain.** The Gateway settles the pending event with `{ kind: 'next' }` when it starts with zero deliveries and when the last delivery disconnects unanswered, so the source listener resumes instead of waiting for a Client that cannot answer.

**`approval/request` races both surfaces and the first decision wins.** The `raceWithHost` row in `API_REMOTE_FORWARDED_EVENTS` makes the forwarded listener run the Client path and the Host chain concurrently. A Client `{ kind: 'result' }` is a decision; a Host value other than the declared `hostAbsentValue` (`'unavailable'`) is a decision; a Client `{ kind: 'next' }`, source end, a Host rejection, and that absent value are not. The loser is neutralized, `next()` runs exactly once, and with neither path deciding the Host outcome is returned (the fail-closed `'unavailable'`).

When the Host chain decides, the listener calls the invocation's `dismiss`, which the Gateway installs while claiming the event. `dismiss` stops tracking the event and pushes a `cancel` frame to every Client that received it, so the browser card disappears without settling the source. `user-questions/request` keeps pure delegation because its TUI answerer does not observe request withdrawal: racing it would leave a question parked and block later questions.

`ApprovalService.decide` dispatches every answerer a request-scoped signal composed with the caller's and aborts it once the request settles. An in-process panel that observes only that signal withdraws when the Web Client wins, and caller cancellation still settles `'cancelled'`.

## Alternatives considered

**Make the forwarded listener always delegate when a Client is connected.** Rejected: the Client may never answer, which recreates the hang, and it still asks one surface at a time.

**Return the Host answer as soon as it exists.** Rejected: a fail-closed `'unavailable'` or a Host rejection is not a user decision, so it would close the browser card before the user could approve there.

**Settle the pending event from the source instead of a Gateway-installed `dismiss`.** Rejected: the source closure does not pass through the Gateway, so Clients never receive the `cancel` frame and the pending map would keep the entry.

## Consequences

Both surfaces can show a prompt for one approval; the first answer continues the turn and the other is withdrawn. A pending event no longer waits for a Client that connects later: that Client sees no card and the Host chain answers alone. The Gateway-owned invocation gains a mutable `dismiss` callback that the source must not call before the Gateway claims it. Only `approval/request` opts into racing, so `user-questions/request` keeps its existing delegation semantics.
