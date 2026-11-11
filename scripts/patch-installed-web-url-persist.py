#!/usr/bin/env python3
"""Persist the authenticated `dsh web` launch URL onto disk for a published install.

Why
---
The launch token is generated per process and lives only in memory, so the
token-carrying URL is printed once on stdout and never stored. A profile that
also attaches the full-screen terminal client swallows that line behind the
alternate screen, and scraping terminal output is unreliable (alternate screen,
Ctrl-C, line wrapping).

This patches the *published* `@deepseek-ai/dsh-web-app` artifact so
`announceReady()` writes the URL to `$DSH_HOME/web-url.txt` (default
`~/.dsh/web-url.txt`, mode 0600, overwritten on every start) at the moment it
computes it.

Scope
-----
This is an operator-side stopgap for an installed package, not a source change.
`npm i -g @deepseek-ai/dsh` replaces the whole package directory, so re-run this
script after every upgrade. The durable fix belongs in
`packages/bundle/web-app/src/index.ts`; once that ships, retire this script.

Usage
-----
    python3 scripts/patch-installed-web-url-persist.py --check   # verify anchors only
    python3 scripts/patch-installed-web-url-persist.py           # apply, with backup and import check
    python3 scripts/patch-installed-web-url-persist.py --revert  # restore the newest backup
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

STAMP = time.strftime("%Y%m%d-%H%M%S")

IMPORT_OLD = 'import { dirname, join } from "node:path";\n'
IMPORT_NEW = (
    'import { dirname, join } from "node:path";\n'
    'import { mkdirSync, writeFileSync } from "node:fs";\n'
    'import { homedir } from "node:os";\n'
)

HELPER_OLD = "function apply(ctx, config) {\n"
HELPER_NEW = (
    "/**\n"
    " * Persist the authenticated launch URL so the operator can reopen the browser\n"
    " * surface after a full-screen terminal client swallowed the startup line.\n"
    " * Best effort: a failed write never changes startup.\n"
    " * @param url - Token-carrying URL this process advertises.\n"
    " */\n"
    "function recordLaunchUrl(url) {\n"
    "\ttry {\n"
    '\t\tconst home = process.env.DSH_HOME ?? join(homedir(), ".dsh");\n'
    "\t\tmkdirSync(home, { recursive: true, mode: 448 });\n"
    '\t\twriteFileSync(join(home, "web-url.txt"), `${url}\\n`, { mode: 384 });\n'
    "\t} catch {\n"
    "\t\t// The console line stays the only announcement.\n"
    "\t}\n"
    "}\n"
    "function apply(ctx, config) {\n"
)

CALL_OLD = (
    "\t\t\tconst authenticatedUrl = "
    "connectionCtx.connection.authenticatedUrl(webUrl);\n"
    "\t\t\tANNOUNCED_ROOTS.add(connectionCtx.root);\n"
)
CALL_NEW = (
    "\t\t\tconst authenticatedUrl = "
    "connectionCtx.connection.authenticatedUrl(webUrl);\n"
    "\t\t\tANNOUNCED_ROOTS.add(connectionCtx.root);\n"
    "\t\t\trecordLaunchUrl(authenticatedUrl);\n"
)

PATCHES = [
    ("install node imports", IMPORT_OLD, IMPORT_NEW, 'writeFileSync } from "node:fs"'),
    ("add recordLaunchUrl helper", HELPER_OLD, HELPER_NEW, "function recordLaunchUrl(url) {"),
    ("call it when the URL is announced", CALL_OLD, CALL_NEW, "\t\t\trecordLaunchUrl(authenticatedUrl);"),
]


def default_scope_root() -> Path | None:
    """Resolve the installed `@deepseek-ai` package directory of the global dsh."""
    try:
        global_modules = subprocess.run(
            ["npm", "root", "-g"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    if not global_modules:
        return None
    return Path(global_modules) / "@deepseek-ai" / "dsh" / "node_modules" / "@deepseek-ai"


def run(root: Path, dry_run: bool) -> int:
    path = root / "dsh-web-app/lib/index.js"
    if not path.is_file():
        print(f"FATAL: no {path}\nPass --root with the installed @deepseek-ai package directory.")
        return 2

    text = path.read_text(encoding="utf-8")
    planned = 0
    for label, old, new, marker in PATCHES:
        if marker in text:
            print(f"skip  {label:34s} already applied")
            continue
        hits = text.count(old)
        if hits != 1:
            print(f"FATAL {label:34s} anchor matched {hits} times (expected 1) — the installed build differs from what this script assumes")
            return 3
        text = text.replace(old, new, 1)
        planned += 1
        print(f"plan  {label:34s} dsh-web-app/lib/index.js")

    if planned == 0:
        print("\nNothing to do: the patch is already applied.")
        return 0
    if dry_run:
        print("\n--check: every anchor matched, nothing written.")
        return 0

    backup = path.with_name(f"{path.name}.bak-web-url-{STAMP}")
    shutil.copy2(path, backup)
    path.write_text(text, encoding="utf-8")
    print(f"write {path}\n      backup -> {backup.name}")

    script = (
        "const base = " + repr(str(root.resolve())) + ";\n"
        "const mod = await import(base + '/dsh-web-app/lib/index.js');\n"
        "if (typeof mod.apply !== 'function') throw new Error('apply missing');\n"
        "console.log('import ok');\n"
    )
    done = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True)
    if done.returncode != 0:
        shutil.copy2(backup, path)
        print("VERIFY FAILED, rolled back:\n" + (done.stderr or "").strip()[:1500])
        return 4
    print("verify ok: dsh-web-app still imports")

    print("\nDone. Restart the host; every start now writes web-url.txt under $DSH_HOME.")
    print(f"Revert: python3 {Path(__file__).name} --revert")
    return 0


def revert(root: Path) -> int:
    path = root / "dsh-web-app/lib/index.js"
    backups = sorted(path.parent.glob(f"{path.name}.bak-web-url-*"))
    if not backups:
        print(f"No backup matching {path.name}.bak-web-url-*")
        return 1
    shutil.copy2(backups[-1], path)
    print(f"restored {path} <- {backups[-1].name}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=None,
                        help="installed @deepseek-ai package directory (default: from `npm root -g`)")
    parser.add_argument("--check", action="store_true", help="verify the anchors without writing")
    parser.add_argument("--revert", action="store_true", help="restore the newest backup")
    args = parser.parse_args()

    root = args.root or default_scope_root()
    if root is None:
        parser.error("could not derive the installed package directory; pass --root")
    return revert(root) if args.revert else run(root, args.check)


if __name__ == "__main__":
    sys.exit(main())