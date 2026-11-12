---
description: "Turn-stop guard that keeps a parent agent's turn open until an abnormally finished subagent is handled, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-child-failure-reminder

English | [中文](README.zh.md)

## Summary

This package makes a parent agent act on a subagent that did not finish its task. `dsh-subagent` already delivers a settlement notice for every background child, including its stop reason; without pressure, a parent can answer that notice with one sentence of prose and close its turn. This guard watches those notices and, at the turn-stop boundary, steers a reminder that names the child, its stop reason, and the actions that resolve the failure — so the turn does not close until the model takes one. The `dsh` base bundle enables it with the default reminder budget.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when an agent delegates work to subagents that can fail — a context overflow, a provider error, an abort, or a refusal — and the parent must decide what to do about it instead of treating the settlement notice as information. The `dsh` base bundle already runs it; tune the reminder budget or the abnormal set below when a deployment needs different pressure.

### When to choose it

Choose it when a silently dropped subagent failure is the expensive outcome: work that looks delegated but never happened, or a context-overflowed child the parent never re-scoped. Avoid it when settlements are purely informational for that deployment — a workflow that intentionally dispatches fire-and-forget children and reads results elsewhere — because the guard keeps the parent turn open until the failure is handled or abandoned.

### Configuring the abnormal set and the budget

Mount the plugin with configuration when the defaults do not fit:

```yaml
- name: '@deepseek-ai/dsh-child-failure-reminder'
  config:
    stopReasons: [error, max-tokens, aborted, refusal]  # what counts as unfinished
    maxPerTurn: 2                                       # reminders steered into one turn
    detailPreviewChars: 500                             # quoted notice detail
    dispositionTools: [subagent, send_message]          # calls that count as handling it
```

| Field | Default | Meaning |
|---|---|---|
| `stopReasons` | `[error, max-tokens, aborted, refusal]` | Stop reasons treated as unfinished work. `completed` never reminds; a reason this build cannot name always does |
| `maxPerTurn` | `2` | Reminders the guard may steer into one turn; further abnormal settlements in that turn stay silent |
| `detailPreviewChars` | `500` | How many characters of the settlement notice's final line a reminder quotes |
| `dispositionTools` | `[subagent, send_message]` | Tools whose call after a notice counts as the parent handling it; an empty list disables the signal |

Invalid configuration fails at startup with a clear error — an empty `stopReasons` list, a blank reason or tool name, or a `maxPerTurn`/`detailPreviewChars` that is not a positive integer — never a silent change of behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-child-failure-reminder) documents every accepted value.

### What you get

With the defaults, a parent whose child ended with `error`, `max-tokens`, `aborted`, or `refusal` receives one reminder at the end of the turn that saw the settlement. The reminder names the child and its stop reason, quotes the notice's diagnostic line, states that describing the failure in prose does not resolve it, and lists the actions: check side effects before a rerun, shrink the scope after a context overflow, re-route after an error, finish the work itself, or record `[DELEGATION-FAILED: <child> - <reason>]` when abandoning the task. Steering keeps the turn open, so the model's next step is a real action rather than a closing paragraph. A parent that already dispatched or messaged a child after the notice draws no reminder, and a second abnormal settlement in the same turn draws at most one more.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard collects failures and forces a decision, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **Read the durable log, not the inbox.** A settlement becomes an observation only when the loop claims it into a step, which appends the `user/message` event. Acting on a notice the model has not seen would force a decision about something it was never told.
- **Decide at the stop boundary.** `agent/turn-stopping` is the one point where the model owes no response and the turn is about to close; a `steer` there makes the machine re-read its inbox and run another step, which is exactly the pressure a prose answer cannot satisfy.
- **Bound the pressure.** One reminder per settlement, at most `maxPerTurn` per turn. The guard exists to break one dropped failure, not to hold a session hostage.
- **Fail loud at load.** Every field validates in `apply` and throws, never falling back to a default.

### Collection: from settlement notice to pending failure

`ctx.on('session/event')` observes the parent session's own log. Three event types matter:

- **`turn/start`** opens a turn: the guard records the turn number, clears the previous turn's settlements, and resets the reminder budget.
- **`user/message`** whose source kind is `subagent-settled` records one pending failure — the child's model-facing name (read from the notice summary, falling back to the sender session id), its `stopReason`, and the notice's final text block, which is the manager's diagnostic whenever it recorded one. A notice without a `stopReason` (older logs) is not classifiable and is ignored.
- **`tool/call`** named in `dispositionTools` marks every pending failure as handled: the parent acted on what it was told. The guard does not read the call's arguments, so one dispatch-level call settles every notice that preceded it.

State lives in a `WeakMap<Session, SessionState>` owned by the plugin instance, so a disposed or unreferenced session carries no residue and no disposal listener is needed.

### Forcing the decision

At `agent/turn-stopping` the guard selects the oldest pending failure from the stopping turn that was neither reminded nor handled. If one exists and the turn's budget allows, it marks the failure reminded, counts the reminder against the turn, and calls `agent.steer(...)` with a `{kind: 'child-failure-reminder', form: 'notice'}` message. The loop re-reads its inbox, runs another step with the reminder in context, and reaches the stop boundary again; every later pass finds nothing left to remind. When no failure qualifies, the listener returns without steering and the turn closes normally.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, settlement collection and the stop-boundary steer |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Subagents subsystem reference](../../../docs/subsystems/subagent.md) — the settlement notice, `stopReason` semantics, and how a child result reaches its parent.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-child-failure-reminder) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages this one ships beside.

-----

<a id="model-experience"></a>
## Model Experience

### Failure reminder

#### What the model sees

At the stop boundary of a turn that received an abnormal settlement the parent has not handled, that agent is steered the reminder below, with the child's name, stop reason, and notice detail substituted; the detail line is omitted when the notice carries none, and its text is capped at `detailPreviewChars`. No tool schema or normal-call text is added.

##### Reminder

```markdown
Subagent "<child>" did not finish its task (stopReason: <stopReason>).
Last line of its settlement notice: <diagnostic>
A sentence in your reply does not resolve it: act on it now, before this turn ends. In your next step, take one of these actions with a tool:
- If the subagent could have written files, commits, or task-board records, inspect those side effects before deciding to rerun it.
- max-tokens or a context-limit failure: re-dispatch with a smaller scope. Do not replay the same prompt unchanged; it hits the same ceiling.
- error: re-dispatch once on a different route — another preset, model, or provider.
- Or finish the work yourself.
- If you are abandoning the task, record `[DELEGATION-FAILED: <child> - <reason>]` in your reply so the failure stays visible.
```

#### Token effect

Zero tokens until an abnormal settlement is left unhandled at the stop boundary. Each reminder is then retained history: the settlement notice (`dsh-subagent`'s own text) plus one reminder of roughly 120 tokens, capped at `maxPerTurn` per turn.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Turn-scoped only** — a settlement the parent saw in an earlier turn is not reminded again; the guard does not persist pending failures across turns or sessions.
- **One reminder per settlement** — a parent that ends its turn twice without acting draws one reminder, not escalating pressure; only `maxPerTurn` and the per-turn reset bound repetition.
- **Coarse disposition signal** — any `subagent` or `send_message` call after a notice counts as handling it. The guard does not parse tool arguments, so a dispatch for one child settles every notice that preceded it.
- **Notice text is the diagnostic source** — the quoted detail is the settlement notice's final text block, so it follows `dsh-subagent`'s notice layout rather than an exported API.
- **No reminder for a child that never settles** — a child stuck inside a tool call produces no settlement and therefore no pressure; `subagent.childRunDeadlineMs` owns that case.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The [child-failure reminder feature note](../../../.agents/notes/implemented/feature/2026-11-12-child-failure-reminder.md) records why the pressure lives at the stop boundary, why the reminder budget is bounded, and why the guard does not re-dispatch children itself.

</details>
