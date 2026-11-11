#!/usr/bin/env bash
# Sync locally built package entry files into the global @deepseek-ai/dsh install.
#
# The published CLI pulls its 90 dependencies from the registry, so a local build
# cannot be installed as a package. Overwrite the affected packages' built entry
# files instead, after taking a full backup of what is being replaced.
set -euo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
SRC="/home/gw/opt/deepseek-harness"
DST="/home/gw/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
BACKUP="/home/gw/opt/dsh-install-backup-${STAMP}"

PAIRS=(
  "packages/api/gateway:dsh-api-gateway"
  "packages/interaction/user-approval:dsh-user-approval"
  "packages/api/remotes:dsh-api-remotes"
  "packages/bundle/web-app:dsh-web-app"
)

mkdir -p "$BACKUP"
for pair in "${PAIRS[@]}"; do
  src_rel="${pair%%:*}"
  pkg="${pair##*:}"
  src_lib="$SRC/$src_rel/lib"
  dst_lib="$DST/$pkg/lib"
  if [ ! -d "$src_lib" ]; then
    echo "FATAL: no build output at $src_lib (run pnpm run build first)" >&2
    exit 2
  fi
  mkdir -p "$BACKUP/$pkg"
  cp -a "$dst_lib" "$BACKUP/$pkg/lib"
  for file in "$src_lib"/*.js; do
    name="$(basename "$file")"
    cp -a "$file" "$dst_lib/$name"
    echo "sync  $pkg/lib/$name"
  done
done

echo
echo "backup: $BACKUP"