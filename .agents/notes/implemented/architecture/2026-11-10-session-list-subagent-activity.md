# Agent Note: Session lists report live direct-subagent activity from the Host

Status: implemented

English | [中文](2026-11-10-session-list-subagent-activity.zh.md)

## Problem

The Workspace sidebar marked a delegating Session as completed while its direct children were still working. The Client derived that activity from the parent's `subagentCatalog` projection, which reaches it only through a client-local projection store: reconnecting clears those stores, and a cold parent may receive no current catalog cut, so the count silently became zero and the green "done" reminder took the row. A second gap has no Client-side source at all: an external child execution owns no local Session, so no Session header, status event, or catalog row with a running Agent can represent it.

Two candidate "waiting" states turned out not to exist for direct children. `ask_user_question` rejects a caller whose Agent is a subagent (`DELEGATED_CALLER`), so a child cannot park a user question; and an approval wait keeps the child's Agent in the `running` phase because the wait happens inside an open turn. Counting a separate `waiting` class would therefore report a state that cannot occur, and every approval wait is already counted as running.

## Decision

`SessionSummary` carries an optional `subagentActivity: { running, external }`. `running` counts direct children whose own header names the parent and whose Agent status is `running`; `external` counts active external executions from the Subagent service. Both are resolved on the Host in `summaryFor()` and `summarizeCold()`, so an attached parent, a cold parent, and a Client that never loaded a catalog receive the same fact. The field is absent when neither count is positive.

The external count is the one new query surface: `SubagentRuntime.externalChildCounts()` reads the manager's resident activations and reports active external runs per durable direct creator (the last of `ancestors`). It persists nothing and adds no Session event.

The parent row is republished as `api-session/added` when a child's Agent status changes and when a `subagent/start` or `subagent/end` edge arrives, matching how `agent/created` already republishes availability. These are per-child lifecycle transitions, not per-frame work; one summary rebuild runs per transition. An unattached parent has no Session to summarize, so it keeps its previous row until the next list read.

The Client prefers the Host fact and keeps the earlier catalog ∪ child-list-row derivation as the fallback for summaries without it. A row whose active children are all external names external subagents in its label; the state stays `ongoing`, so waiting for a user never competes with the primary status slot.

## Alternatives considered

**Keep the Client-side derivation only.** Round one already unioned the catalog with child list rows, which fixes the common reconnect and stale-catalog cases. It cannot see external executions, and it still depends on which projections a particular Client happened to load. It remains as the fallback because summaries from older Hosts and list rows synthesized locally do not carry the field.

**Suppress the parent's `completionUnread` while a child runs.** The row would fall back to its resting state (`idle`) rather than "ongoing", and it would change the meaning of a deliberately separate unread-completion reminder owned by `ui-session`.

**Compute the field from the `subagentCatalog` projection on the Host.** The projection is already registered and Host-resident, but it records membership only: entries carry no execution status, and caller-delivered external runs enter no catalog at all. It cannot answer either question without a new projection, which would need a Session event and a persisted format change.

**Add a durable `waiting` count.** A subagent cannot hold a user question, and an approval wait is already `running`. A durable counter would need a new persisted projection to represent states that do not occur.

## Consequences

`subagentActivity` is an optional addition to a pre-stable wire type; every Client consumer merges it, and no persisted Session format or projection state version changes. A cold parent's activity refreshes on the next list read or on a run edge, not from a per-child event, which is the same freshness its other list facts have. Products that build their own completion marker from Session summaries (including out-of-tree TUIs) must opt into the field; this change does not alter any external client.
