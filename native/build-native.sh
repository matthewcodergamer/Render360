#!/usr/bin/env bash
# Native (non-wasm) build of the Render360 core as a static library.
#   R360_NATIVE_TARGET=macos-x86_64 | macos-arm64 | ios-arm64   (default: host macOS)
# Uses the exact same source list and overlays as the wasm build
# (xenia-ppc-sources.sh). bash 3.2 compatible.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
XENIA="$ROOT/upstream/xenia"
OVERLAY="$ROOT/build/xenia-web-overlay"
TARGET="${R360_NATIVE_TARGET:-macos-$(uname -m)}"
OUT="$ROOT/build/native-$TARGET"
JOBS="${R360_BUILD_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
R360_OPT="${R360_OPT:--O3}"
case "$TARGET" in
  macos-x86_64) SDK=macosx; ARCHFLAGS=(-arch x86_64 -mmacosx-version-min=12.0) ;;
  macos-arm64)  SDK=macosx; ARCHFLAGS=(-arch arm64 -mmacosx-version-min=12.0) ;;
  ios-arm64)    SDK=iphoneos; ARCHFLAGS=(-arch arm64 -miphoneos-version-min=16.0) ;;
  *) echo "ERROR: unknown R360_NATIVE_TARGET=$TARGET" >&2; exit 2 ;;
esac
SYSROOT="$(xcrun --sdk "$SDK" --show-sdk-path)"
CXX="$(xcrun --sdk "$SDK" -f clang++)"
CC="$(xcrun --sdk "$SDK" -f clang)"
[ -d "$XENIA/src/xenia" ] || { echo "ERROR: run fetch-xenia.sh first" >&2; exit 2; }

if [ "${R360_SKIP_OVERLAYS:-0}" != 1 ]; then  # R360_SKIP_OVERLAYS=1 reuses build/xenia-web-overlay
  git -C "$XENIA" checkout -- .
  # Same overlay order as build-xenia-ppc-bootstrap.sh.
  for s in $(sed -n 's#^python3 "\$ROOT/\(prepare-[a-z0-9-]*\.py\)"$#\1#p' "$ROOT/build-xenia-ppc-bootstrap.sh"); do
    python3 "$ROOT/$s" >/dev/null
  done
fi

NATIVE_DEFS=(-DR360_NATIVE=1 -DNDEBUG)
COMMON=(-std=c++20 "$R360_OPT" -g "${NATIVE_DEFS[@]}" "${ARCHFLAGS[@]}" -isysroot "$SYSROOT"
  -I"$ROOT/native/include" -I"$OVERLAY" -I"$ROOT/src/xenia_web_shims" -I"$ROOT/src/xenia_web_bootstrap"
  -I"$XENIA/src" -I"$XENIA" -I"$XENIA/third_party/mspack" -I"$XENIA/third_party/fmt/include"
  -I"$XENIA/third_party/utfcpp/source" -I"$XENIA/third_party/capstone/include"
  -I"$XENIA/third_party/cpptoml/include" -I"$XENIA/third_party/cxxopts/include" -I"$XENIA/third_party/glslang"
  -I"$XENIA/third_party/llvm/include" -include "$ROOT/native/include/r360_native_compat.h"
  -Wno-everything)
COMMON_C=("$R360_OPT" -g "${NATIVE_DEFS[@]}" "${ARCHFLAGS[@]}" -isysroot "$SYSROOT"
  -I"$XENIA/third_party/mspack" -I"$XENIA/third_party/crypto" -Wno-everything)

mkdir -p "$OUT"; rm -f "$OUT"/*.fail
# Fresh overlays rewrite every source, so rebuild everything; with
# R360_SKIP_OVERLAYS=1 only units whose source is newer than the object.
[ "${R360_SKIP_OVERLAYS:-0}" = 1 ] || rm -f "$OUT"/*.o "$OUT"/*.log
up_to_date() { [ "${R360_SKIP_OVERLAYS:-0}" = 1 ] && [ -f "$1" ] && [ "$1" -nt "$2" ] && [ ! "$2" -nt "$1" ]; }
obj_for() { printf '%s/%s.o' "$OUT" "$(printf '%s' "$1" | tr '/' '_')"; }
throttle() { while [ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$JOBS" ]; do sleep 0.2; done; }
cpp() { up_to_date "$(obj_for "$1")" "$2" && { : > "$(obj_for "$1").log"; return 0; }; throttle; ( o="$(obj_for "$1")"; "$CXX" "${COMMON[@]}" -c "$2" -o "$o" >"$o.log" 2>&1 || touch "$o.fail" ) & }
cc()  { up_to_date "$(obj_for "$1")" "$2" && { : > "$(obj_for "$1").log"; return 0; }; throttle; ( o="$(obj_for "$1")"; "$CC" "${COMMON_C[@]}" -c "$2" -o "$o" >"$o.log" 2>&1 || touch "$o.fail" ) & }
# Native-only translation units (fiber baton, C API, JIT stub).
native_units() {
  local f
  for f in "$ROOT"/native/src/*.cpp; do [ -e "$f" ] && "$1" "native/$(basename "$f")" "$f"; done
  return 0
}

source "$ROOT/xenia-ppc-sources.sh"
skip_wasm_only() {  # wasm-only units replaced by native/src equivalents
  case "$1" in render360/hir_wasm_jit.cpp) return 0 ;; esac
  return 1
}
cpp_filtered() { skip_wasm_only "$1" || cpp "$1" "$2"; }
r360_for_each_source cpp_filtered cc
native_units cpp
wait

fails=$(find "$OUT" -maxdepth 1 -name '*.fail' | wc -l | tr -d ' ')
total=$(find "$OUT" -maxdepth 1 -name '*.o.log' | wc -l | tr -d ' ')
echo "native $TARGET: $((total - fails))/$total compiled"
if [ "$fails" -ne 0 ]; then
  for f in "$OUT"/*.fail; do echo "----- ${f%.o.fail} -----"; grep -m5 'error:' "${f%.fail}.log" || head -5 "${f%.fail}.log"; done
  exit 1
fi
# Package core (render360_xenia_core.wasm: STFS mount/extract, XEX decode and
# image preparation; build-core.sh). It is a freestanding module whose names
# overlap the bootstrap's, so merge it into one relocatable object in which
# only its exports survive, renamed r360_* -> r360pkg_*.
PKG="$OUT/package-core"
rm -rf "$PKG"; mkdir -p "$PKG"
for f in "$ROOT/package-core.cpp" \
  "$ROOT"/src/xenia_web_bootstrap/xex_image_decoder.cpp "$ROOT"/src/xenia_web_bootstrap/xex_image_decoder_exports.cpp \
  "$ROOT"/src/xenia_web_bootstrap/xex_image_preparer.cpp "$ROOT"/src/xenia_web_bootstrap/xex_image_preparer_exports.cpp \
  "$ROOT"/src/xenia_web_bootstrap/xex_pe_image.cpp "$ROOT"/src/xenia_web_bootstrap/xex_pe_image_exports.cpp; do
  "$CXX" -std=c++20 -O2 -g -fno-builtin "${ARCHFLAGS[@]}" -isysroot "$SYSROOT" -I"$ROOT" -I"$ROOT/src/xenia_web_bootstrap" \
    -c "$f" -o "$PKG/$(basename "$f").o"
done
sed -n '/^EXPORTS=(/,/^)/p' "$ROOT/build-core.sh" | tr ' ' '\n' | grep '^r360_' | sort -u > "$PKG/names.txt"
awk '{print "_"$1" _r360pkg_"substr($1,6)}' "$PKG/names.txt" > "$PKG/aliases.txt"
awk '{print "_r360pkg_"substr($1,6)}' "$PKG/names.txt" > "$PKG/exports.txt"
xcrun --sdk "$SDK" ld -r "${ARCHFLAGS[@]:0:2}" "$PKG"/*.cpp.o -alias_list "$PKG/aliases.txt" \
  -exported_symbols_list "$PKG/exports.txt" -o "$OUT/zz_package_core.o"

rm -f "$OUT/librender360core.a"
xcrun --sdk "$SDK" libtool -static -o "$OUT/librender360core.a" "$OUT"/*.o 2>&1 | grep -v 'has no symbols' || true
echo "built $OUT/librender360core.a"

case "$TARGET" in
  macos-*)
    "$CXX" -std=c++20 "$R360_OPT" -g "${ARCHFLAGS[@]}" -isysroot "$SYSROOT" -I"$ROOT/native/include" \
      "$ROOT/native/tools/run_title.cpp" "$OUT/librender360core.a" -Wl,-dead_strip -o "$OUT/run-title"
    echo "built $OUT/run-title"
    ;;
esac
