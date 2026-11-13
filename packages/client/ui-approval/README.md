---
description: "Browser approval UI that answers Host permission requests through the scoped interaction path."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-approval

English | [中文](README.zh.md)

## Summary

Browser approval presentation over the Agent-scoped Remote Event waterfall. The plugin publishes each pending request through `ctx.uiSession`, takes over the Conversation composer, optionally renders correlated Tool detail, and returns the user's decision to the waiting Host request. Use it when a browser must collect approval for a waiting Host operation. The card lives in the Agent scope the waterfall dispatched on; a dispatch whose subject carries no tag resolves through the Agent the request names and retains that generation for the card, and a request that reaches no Agent identity at all is reported on the console and delegated to the Host chain instead of disappearing.

## Table of Contents

- [Recovering a pending approval](#recovering-a-pending-approval)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="recovering-a-pending-approval"></a>
## Recovering a pending approval

Besides the live dispatch, the plugin reconciles the Session's `approvalState` projection: a request the log still lists as undecided gets one answerable card again after a reload or reconnect, and answering it calls `remote.approval.answerLate` because no waterfall waits in this browser. The two sources share one card per ask — a live dispatch adopts the card the projection already presented instead of publishing a second one — and a recovery card disappears when the projection stops listing the ask, while either source ends it when the live request is cancelled. A live card is never reclaimed just because a projection frame has not listed it yet. A refusal that no retry can fix retires the card locally, so a Host that restarted without re-registering the ask cannot resurrect it on the next projection update.

Focus the approval detail region to approve with Enter or reject with Escape. The mounted plugin reserves both keys against editable shortcuts. Enter on the focused Reject button retains its native reject action. Input controls and IME candidates keep their own keys. Keyboard and pointer actions share one pending-request lock; a withdrawn or replaced request cannot accept another answer, and an earlier failed answer cannot unlock its replacement.

When offered, **Always allow** is the highlighted primary button. Otherwise, the current-request allow action is primary. Enter in the detail region always grants the limited scope: once for a tool approval, or the current session for CUA. Persistent access requires explicitly activating Always allow. The shortcut reference uses Allow because the caller supplies that scope.

Callers can supply localized warning copy through the shared card's optional `warning` field, with paragraphs separated by blank lines (`\n\n`). Hovering or keyboard-focusing the tag opens a formatted nonmodal card; clicking or tapping also opens it. The pointer can cross into the card to read or select its text. Leaving both surfaces closes it after a short grace period unless keyboard focus remains inside. Moving focus outside, clicking outside, and Escape also dismiss it without rejecting the request. Hover does not move focus. Moving focus elsewhere also closes a hover-open card, including when a foreground modal takes focus. Switching away from the window or hiding the browser tab closes it without restoring focus. Foreground modals and input-method composition retain their keyboard handling. CSS anchors position the card above the tag with window-edge fallbacks and internal scrolling when space is limited.

<a id="model-experience"></a>
## Model Experience

None, as this package presents approval requests in the browser and registers nothing model-facing.

#### KV Cache effect

None; approval request and response rendering does not alter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A pending approval whose Host process restarted cannot be settled in that process: the log still carries the ask, but no in-flight decision exists to answer. The card is retired on the first refused answer and stays retired until the log stops listing the ask, so a reload no longer shows a prompt that cannot work. The localized notice for that retirement is written to the Client diagnostics log; this package owns no toast surface.
- The shared `conversation.approval.card` Factory presents reject, allow and an optional always-allow action, with caller-owned scope, subject metadata and answer callbacks. Tool approvals retain their two outcomes. Application consent can reuse the card without adopting tool-approval policy. Subject metadata enables left-aligned content and wrapping actions; callers that omit it retain inherited alignment and a single action row. Icons and labels identify the subject visually; the caller owns identity verification and saved grants.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
