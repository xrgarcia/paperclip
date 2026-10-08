#!/usr/bin/env bash
# Install Slashbin's Paperclip build: the official npm release, with this fork's
# @paperclipai/shared and UI laid over it.
#
# Why an overlay and not a full source build: the full build compiles a Rust runner
# and a C native module, and our patches touch neither. They live only in
# packages/shared and ui (see slashbin/PATCHES.md), so the server, CLI and adapters
# run exactly as published.
#
# Usage:  slashbin/install.sh            # build + install into $PREFIX
# Then:   systemctl --user restart paperclip.service
set -euo pipefail

# Must match the tag the `slashbin` branch is based on. Bump both together.
VERSION="2026.1005.0"
PREFIX="${PAPERCLIP_PREFIX:-$HOME/.local/share/slashbin-paperclip}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

base_tag="v$VERSION"
if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$base_tag" HEAD 2>/dev/null; then
  echo "HEAD is not based on $base_tag; VERSION and the branch disagree" >&2
  exit 1
fi

echo "==> Building fork packages (shared, ui)"
cd "$REPO_ROOT"
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @paperclipai/shared build
corepack pnpm --filter @paperclipai/ui build

echo "==> Installing paperclipai@$VERSION into $PREFIX"
stage="$(mktemp -d "${PREFIX%/*}/.slashbin-paperclip.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
npm install --prefix "$stage" --no-audit --no-fund "paperclipai@$VERSION" >/dev/null

mods="$stage/node_modules/@paperclipai"
for target in "$mods/shared/dist" "$mods/server/ui-dist"; do
  [ -d "$target" ] || { echo "published layout changed: $target missing" >&2; exit 1; }
done

echo "==> Overlaying fork build"
rm -rf "$mods/shared/dist" "$mods/server/ui-dist"
cp -r packages/shared/dist "$mods/shared/dist"
cp -r ui/dist "$mods/server/ui-dist"
git rev-parse HEAD > "$stage/SLASHBIN_COMMIT"

rm -rf "$PREFIX.old"
[ -d "$PREFIX" ] && mv "$PREFIX" "$PREFIX.old"
mv "$stage" "$PREFIX"
trap - EXIT
echo "==> Installed $(cat "$PREFIX/SLASHBIN_COMMIT") at $PREFIX (previous kept at $PREFIX.old)"
