---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-child-failure-reminder-source

English | [中文](2026-11-12-child-failure-reminder-source.zh.md)

## Summary

Adds the `child-failure-reminder` member to the merge-extensible message-source union carried by `user/message`, `developer/message`, `agent/inbox/spliced`, and `session/title-llm-request`.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-child-failure-reminder-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "b055eaf2244ddaf2cb4845115eef56919c26a1d56d6f50cf450c2e271df4c933"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "1b69149e1776e53dce0e2d512a8ebf6d55d0401d64ea29fbf0ef136a1d1d2fe7"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "e45cb8cf6f0eb11505f589772be6ab81db7579ed0e002b5cd43907c22ae9e11c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "bf474d1407751cd84c3bf4b87a410389bdae490f8b78df6acd32a4b52f437548"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The change only adds a union variant, so no persisted record becomes unreadable. Older readers meet an unrecognized `kind` the same way they already meet every producer-owned kind: message-source unions are merge-extensible and consumers switch on the known kinds and fall through the rest, and V4 admission accepts any nonempty producer-owned source kind with no per-kind allowlist. Migrations pass non-`plugin` kinds through unchanged, so a log written by this build upgrades exactly like one written before it. No discriminator can mis-read the new messages: their text is ordinary user-role context and their source attributes it to this plugin. New readers keep reading older logs unchanged, because no variant was removed or renamed. The header version therefore stays the same.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/guard/child-failure-reminder: 28 tests passed. pnpm exec vitest run packages/session/session-format-v3-to-v4 packages/session/session-format-v2-to-v3: 923 tests passed. pnpm run typecheck: 5 gates passed. pnpm run build:check: 2 gates passed.

<a id="dev-note"></a>
## Dev Note

None.
