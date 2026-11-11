# Agent Note: Persist the Web launch URL

Status: implemented

English | [中文](2026-11-11-web-launch-url-persist.zh.md)

## Problem

The Web process creates a fresh launch token and prints its authenticated entry URL once. A full-screen TUI in the same profile can hide that line, leaving the operator without the entry point. Patching installed JavaScript restores discoverability only until the next package upgrade.

## Decision

The existing Web runtime plugin records its authenticated URL at readiness independently of printing and browser handoff. Its validated `launchUrlFile` setting accepts a nonempty path or `false`; omission resolves to `$DSH_HOME/web-url.txt`, with the established empty-or-unset home fallback to `~/.dsh`. The default preserves the operator's existing recovery location.

Atomic replacement writes the URL and a newline with mode `0600`; new parent directories use `0700`. Existing directories retain their permissions. The default credential copy stays only in the Harness home, not the workspace or system temporary directory. An explicit custom path transfers directory protection to the operator. Persistence is best-effort: one write diagnostic does not prevent printing, browser handoff, or server startup.

## Alternatives considered

**Keep patching the installed bundle.** Rejected because an upgrade silently removes recovery and the implementation has no source-level tests.

**Add a separate persistence plugin.** Rejected because the existing Web runtime already owns the authenticated URL and Loader readiness. Another plugin would duplicate readiness coordination or require an extension point solely to copy one startup value. This behavior remains configurable in that existing owner.

**Retain stdout only.** Rejected because terminal alternate screens can hide the only printed credential. Making persistence opt-in would leave existing profiles without recovery.

## Consequences

The file is a credential, not a harmless bookmark. Owner-only POSIX modes do not exclude the same OS user, privileged readers, backups, or weak Windows ACLs. Operators must protect those surfaces or set `launchUrlFile: false`. Disabling does not delete an earlier copy. Concurrent processes sharing the path use last-writer-wins replacement and need separate configured files when both entry points must remain discoverable. A crashed or failed later launch can leave an obsolete URL; the file is not a liveness signal. No active note previously owns this persistence decision.
