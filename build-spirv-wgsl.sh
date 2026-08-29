#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
CRATE="$ROOT/tools/spirv-wgsl"
TARGET="wasm32-unknown-unknown"
OUT="$ROOT/build/spirv-wgsl"

command -v cargo >/dev/null 2>&1 || { echo 'ERROR: cargo is required' >&2; exit 2; }
command -v rustup >/dev/null 2>&1 || { echo 'ERROR: rustup is required' >&2; exit 2; }
rustup target add "$TARGET" >/dev/null
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  cargo install wasm-bindgen-cli --locked
fi
cargo build --manifest-path "$CRATE/Cargo.toml" --release --target "$TARGET"
rm -rf "$OUT"
mkdir -p "$OUT"
wasm-bindgen \
  "$CRATE/target/$TARGET/release/render360_spirv_wgsl.wasm" \
  --target web \
  --no-typescript \
  --out-dir "$OUT" \
  --out-name render360_spirv_wgsl

test -s "$OUT/render360_spirv_wgsl_bg.wasm"
test -s "$OUT/render360_spirv_wgsl.js"
echo "Built Render360 Naga SPIR-V -> WGSL converter: $OUT"
