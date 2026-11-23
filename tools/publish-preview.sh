#!/usr/bin/env bash
# Publish a branch into the gh-pages worktree:  main -> site root,  any other branch -> site/branch/<safe-name>/
# usage: publish-preview.sh <branch> <src-dir> <site-dir>      (delete: publish-preview.sh --delete <branch> <site-dir>)
set -euo pipefail
safe() { local s; s=$(printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/-/g'); case "$s" in ""|.|..) echo "bad branch name" >&2; exit 1;; esac; printf '%s' "$s"; }
if [ "$1" = "--delete" ]; then
  s=$(safe "$2"); rm -rf "${3:?}/branch/$s"; exit 0
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
