#!/usr/bin/env bash
# Publish a branch into the gh-pages worktree:  main -> site root,  any other branch -> site/branch/<safe-name>/
# usage: publish-preview.sh <branch> <src-dir> <site-dir>
#        publish-preview.sh --prune <site-dir> <live-branches-file>   remove previews whose branch no longer exists
set -euo pipefail
safe() { local s; s=$(printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/-/g'); case "$s" in ""|.|..) echo "bad branch name" >&2; exit 1;; esac; printf '%s' "$s"; }
if [ "$1" = "--prune" ]; then
  site=${2:?}; live=${3:?}; keep=$(mktemp)
  while IFS= read -r b; do [ -n "$b" ] && printf '%s\n' "$(safe "$b")"; done < "$live" > "$keep"
  for d in "$site"/branch/*/; do
    [ -d "$d" ] || continue; n=$(basename "$d")
    grep -qxF -- "$n" "$keep" || { echo "pruned preview: $n"; rm -rf "$d"; }
  done
  rmdir "$site/branch" 2>/dev/null || true; exit 0
fi
branch=$1; src=$2; site=$3
mkdir -p "$site"; touch "$site/.nojekyll"
copy() { tar -C "$src" --exclude=./.git --exclude=./.github -cf - . | tar -C "$1" -xf -; }   # no rsync dependency
if [ "$branch" = "main" ]; then
  # replace the site root but keep gh-pages' own .git, the .nojekyll marker and every branch preview
  find "$site" -mindepth 1 -maxdepth 1 ! -name .git ! -name .nojekyll ! -name branch -exec rm -rf {} +
  copy "$site"
else
  s=$(safe "$branch"); rm -rf "$site/branch/$s"; mkdir -p "$site/branch/$s"
  copy "$site/branch/$s"
fi
