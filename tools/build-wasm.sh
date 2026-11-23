#!/usr/bin/env bash
# Build every Rust app in rust-apps/ to WebAssembly and copy the .wasm files to <out>/apps/ (default: repo root).
# CI runs this for every branch preview. Locally you need rustup and the wasm32-unknown-unknown target.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd); out=${1:-$root}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$root/rust-apps/target}   # keep build output out of the published tree
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
( cd "$root/rust-apps" && cargo build --release --locked --target wasm32-unknown-unknown --workspace )
mkdir -p "$out/apps"
n=0
for f in "$CARGO_TARGET_DIR"/wasm32-unknown-unknown/release/*.wasm; do
  [ -e "$f" ] || continue; cp "$f" "$out/apps/"; n=$((n+1)); echo "apps/$(basename "$f") $(wc -c < "$f") bytes"
done
[ "$n" -gt 0 ] || { echo "no .wasm produced" >&2; exit 1; }
