# Agent Note: a resumed Web page replaces its connection generation

Status: implemented

English | [中文](2026-11-10-client-resume-reconnect.zh.md)

## Problem

A phone that backgrounds the Web client freezes its WebSocket without delivering `close`. The Client still reports `connected`, receives no events, and never fills the session and Workspace lists; the Workspace restoration waits for a `ready` list that never arrives, so the page sits on the empty conversation for as long as the user leaves it there. The only recovery was a manual reload, and an installed app has no reload control at all — when the bootstrap itself failed, the boot report was a dead end too.

Nothing in the Client re-established a generation on resume: `reconnect()` had exactly one caller (the settings connection indicator), and Connection watched only `online` and `offline`.

## Decision

`installConnection` installs `watchBrowserResume` beside `watchBrowserNetwork`. It replaces the generation — the loop's `reconnect()`, not a second transport — in two cases: a `visibilitychange` to visible after the page was hidden for at least `resumeReconnectAfterMs`, and a `pageshow` whose `persisted` is true, which is the bfcache restore the hidden window cannot observe. The owner tears the listeners down with the loop, so a stopped or released connection ignores both events.

`focus` is deliberately not watched. An ordinary desktop tab switch must keep its generation, because replacing one aborts the current stream; the threshold therefore defaults to 5000 ms instead of the shortest interval that would still catch a suspended phone, and a deployment can retune it through `ConnectionRecoveryConfig` (including the value the Host injects as `__DSH_CONNECTION_RECOVERY__`).

A replacement generation is what repairs the stuck page: the session controller runs `handleConnected()` again on the new generation and restarts its control stream, which repopulates the lists the Workspace restoration waits on.

The boot page's failure report gained a `Reload` action. That report renders before the locale plugin loads, and it is the only recovery surface an installed app has.

## Alternatives considered

- **Reconnect on every `visibilitychange`.** Cheapest to write, but a desktop tab switch would abort an in-flight generation mid-stream. The hidden-duration threshold makes the ordinary desktop case a no-op while still catching a suspended phone.
- **Detect a stale socket instead of replacing it.** The server heartbeat is a WebSocket control frame (`socket.ping()`), invisible to page script, and an idle session carries no application frames to timestamp, so the Client has no reliable staleness signal.
- **A reconnect banner instead of an automatic replacement.** Keeps recovery in the user's hands, but a suspended phone renders a stale transcript that looks live; the automatic path is what actually repairs the state.

## Consequences

- A page hidden longer than the threshold costs one handshake and one control restart on return. A turn that was streaming at hide time continues on the Host and is replayed from the session log into the new generation.
- Desktop and mobile share this behavior; only the threshold could distinguish them, and nothing in the Client distinguishes them today.
- `packages/client/connection/tests/client-apply.client.spec.ts` pins the below-threshold, at-threshold, bfcache, stopped-loop, and no-document cases.
