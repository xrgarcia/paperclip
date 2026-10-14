#!/usr/bin/env bash
# Compile the server files Slashbin patches into <out>, laid out like server/dist,
# for overlaying onto a published build (install.sh, and the jerky/slashbin
# Railway image). Only the files in SERVER_FILES are compiled; every other server
# file stays exactly as published. tsconfig sets isolatedModules, so a per-file
# transpile emits what tsc would.
#
# Usage: slashbin/server-overlay.sh <out-dir>
set -euo pipefail

# Paths under server/src. Add a file here when a patch touches it (PATCHES.md).
SERVER_FILES=(
  middleware/auth.ts
  middleware/comment-only-key.ts
  routes/issues.ts
)

out="${1:?usage: server-overlay.sh <out-dir>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
esbuild="$REPO_ROOT/node_modules/.bin/esbuild"
[ -x "$esbuild" ] || { echo "esbuild missing: run pnpm install first" >&2; exit 1; }

for f in "${SERVER_FILES[@]}"; do
  "$esbuild" "$REPO_ROOT/server/src/$f" --format=esm --platform=node --target=es2023 \
    --log-level=warning --outfile="$out/${f%.ts}.js"
done
echo "${SERVER_FILES[@]/%.ts/.js}" | tr ' ' '\n' > "$out/.slashbin-overlay"
