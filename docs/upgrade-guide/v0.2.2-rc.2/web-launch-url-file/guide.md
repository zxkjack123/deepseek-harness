---
kind: upgrade-guide
description: "The web app records the authenticated launch URL in $DSH_HOME/web-url.txt by default, which persists the process token to disk."
---

# The web app records its authenticated launch URL

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-web-app` gains `launchUrlFile?: string | false`. When unset it writes the authenticated launch URL to `$DSH_HOME/web-url.txt`; the file is created with mode `0o600` inside a `0o700` directory, and each launch replaces it. `false` writes no file, and a string selects another path.

The recorded URL embeds the process token that authorizes access to the running instance, so the file is a credential, not a bookmark.

## Migration

- Set `launchUrlFile: false` on compositions that must not persist tokens to disk, such as shared hosts, container images, and CI.
- Treat `$DSH_HOME/web-url.txt` as secret material: keep it out of images, logs, backups, and transcripts.
- A file from an earlier process opens nothing useful: the token belongs to the process that wrote it, so a stale file fails authentication rather than granting access.
