---
kind: upgrade-guide
description: "Subagent results carry a separate diagnostic field capped at 4096 UTF-8 bytes, and childRunDeadlineMs bounds a child run."
---

# Subagent failures report a separate diagnostic

English | [中文](guide.zh.md)

## Change

`SubagentResult` now carries `diagnostic` beside `output`: the local failure detail, such as `OPERATION_ABORTED: <message chain>`, truncated to `MAX_SUBAGENT_DIAGNOSTIC_BYTES` (4096 UTF-8 bytes, exported from `@deepseek-ai/dsh-subagent`). Consumers present it separately from the subagent's own answer.

A child run is also bounded by the `subagent.childRunDeadlineMs` config. On expiry the child settles as `aborted` with a deadline diagnostic instead of holding its parent open indefinitely.

## Migration

- Render `diagnostic` as error detail, never as the subagent's `output`, and never parse it for structure: it is a free-form message chain that may be truncated mid-string.
- Read `stopReason` together with the text. `error`, `max-tokens`, `aborted`, and `refusal` describe different repairs, and a truncated diagnostic still names which one it is.
- Set `childRunDeadlineMs` in the composition when a tighter wall clock is required; the default is generous by design, because it only exists to stop a hung child.
