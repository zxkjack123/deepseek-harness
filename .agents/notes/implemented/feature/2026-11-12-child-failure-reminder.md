# Agent Note: Child-failure reminder

Status: implemented

English | [中文](2026-11-12-child-failure-reminder.zh.md)

## Problem

`dsh-subagent` already tells a parent that a continuable or background child settled, and the settlement notice carries the exact `stopReason`. Nothing made the parent do anything with it. A parent could read `max-tokens` or `error`, write "I'll take over", and close its turn: no re-dispatch on another route, no smaller scope after a context overflow, and no record that the delegated work never happened. Observed session `session-dfcfc0ce` shows the delivery working and the handling missing.

## Decision

`@deepseek-ai/dsh-child-failure-reminder` watches the parent's own session log and, at `agent/turn-stopping`, steers a reminder for every abnormal settlement the parent has not handled.

A settlement enters the guard when the loop claims it into a step, which appends the `user/message` event whose source kind is `subagent-settled`. Reading `session/event` instead of the inbox or an admission hook gives the guard exactly the notices the model has actually seen, and it also carries the two other signals it needs: `turn/start` scopes every record and resets the per-turn budget, and `tool/call` shows the parent dispatching or messaging a child afterwards.

The stop boundary is the only place where the model owes no response and the turn is about to close. A `steer` from a listener there makes the machine re-read its inbox and run another step, so the pressure exists in the loop's own state machine rather than in prompt wording the model may ignore. Every abnormal settlement triggers at most one reminder, and a turn accepts at most `maxPerTurn` (default 2): the reminder is retained history, so an unbounded mechanism would spend tokens on every later request of the session and would turn one dropped failure into a loop.

A parent that called `subagent` or `send_message` after the notice has already acted, so its pending failures are marked handled and it draws no reminder. The guard compares tool names only; attributing a call to a specific child would require parsing arguments owned by another package's tool schema.

`stopReasons` (default: every known reason except `completed`) decides what counts as unfinished. A reason this build cannot name comes from a backend that merged a variant into `SubagentStopReasonMap`, and is treated as abnormal: reporting an uninterpretable ending as success is the failure this guard exists to prevent.

## Alternatives considered

**Prompt wording in the delegation instructions.** A line telling the parent to handle failures is advisory in the same way the notice already is; the model that closed the turn on a prose acknowledgment would do so again. It also cannot distinguish an acknowledgment from an action.

**A new agent-loop branch that refuses to close the turn.** The loop already documents `agent/turn-stopping` for exactly this control, and the plugin conventions require new behavior on documented extension points rather than loop changes.

**Automatic re-dispatch by the guard.** The guard cannot see the child's task, its side effects, or the reason the route failed, so it would replay prompts that are known to fail — a `max-tokens` child re-run with the same context overflows again. Re-scoping and re-routing are judgments that need the parent's context; the reminder forces the judgment instead of guessing it.

**Per-child attribution of the disposition call.** Parsing `subagent` and `send_message` arguments would bind this guard to another package's tool schema. The coarse rule — any dispatch-level call after a notice handles the notices that preceded it — errs toward staying silent, and the per-turn budget bounds the opposite error.

**Blocking the turn until the parent calls a specific tool.** Enforcing one required tool would decide the remedy for the parent, which contradicts the menu: checking side effects, re-scoping, re-routing, finishing the work, and recording an explicit abandonment are all legitimate outcomes.

## Consequences

A parent can no longer end a turn as soon as it acknowledges a failure; it spends at least one more step doing something. Sessions that delegate heavily and lose children to context limits now re-scope or record `[DELEGATION-FAILED: …]` instead of moving on silently. The cost is up to `maxPerTurn` reminder messages per turn, each roughly 120 tokens, plus the extra step each one forces.

The signal is turn-scoped: a settlement the parent saw in an earlier turn is not reminded again, because the reminder exists for the turn that received it. A settlement that arrives after the parent already closed its turn wakes a new turn and is reminded there, since the delivery claims the notice into that turn's first step. A child that never settles — stuck inside a tool call — produces no notice and no reminder; `subagent.childRunDeadlineMs` owns that case. The quoted detail is the settlement notice's final text block, so the reminder follows `dsh-subagent`'s notice layout rather than a dedicated API.

The `child-failure-reminder` message source is a new model-visible producer kind; it needs no session-format migration because V4 admits any producer-owned source kind and the plugin is not part of any released V3 generation.

## Verification

`packages/guard/child-failure-reminder/tests/child-failure-reminder.spec.ts` drives a real agent loop with a scripted model: each abnormal stop reason reminds once, `completed` and a notice without a `stopReason` stay silent, an unknown reason reminds, the per-turn budget caps the steers, a `subagent` or `send_message` call after the notice suppresses the reminder while an unrelated call does not, a second turn inherits no pending failure, and every config violation fails at load. The package is registered in `packages/bundle/base` and covered by the per-file 100% coverage gate.
