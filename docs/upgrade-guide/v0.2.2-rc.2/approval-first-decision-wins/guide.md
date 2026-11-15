---
kind: upgrade-guide
description: "An approval settled on one surface now stays settled on every surface; later answers from other surfaces no longer replace it."
---

# The first approval decision wins on every surface

English | [中文](guide.zh.md)

## Change

An approval request can be answered from the local prompt, a gateway client, or a remote transport. Previously the last answer observed for a request could replace an earlier one. Now the first decision settles the request for every surface, and later answers for the same request are discarded instead of applied.

## Migration

- Clients that let a person change an answer after submitting must treat the approval as final once it is accepted; the control belongs to whichever surface answered first.
- A surface that submits after another one already decided receives the settled decision rather than an error to retry.
- Automation that polls for a decision must not assume its own submission changed the outcome; read the settled decision back instead.
