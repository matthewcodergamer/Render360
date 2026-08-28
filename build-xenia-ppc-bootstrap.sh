#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
XENIA="$ROOT/upstream/xenia"
OUT="$ROOT/build/xenia-ppc-bootstrap"
CXX="${CXX:-em++}"
mkdir -p "$OUT"

if [ ! -d "$XENIA/src/xenia" ]; then
  echo "ERROR: upstream Xenia missing. Run ./fetch-xenia.sh first." >&2
  exit 2
fi
if ! command -v "$CXX" >/dev/null 2>&1; then
  echo "ERROR: $CXX not found. Run inside Emscripten/emsdk." >&2
  exit 2
fi

COMMON=(
  -std=c++20
  -O0
  -g0
  -fno-rtti
  -I"$ROOT/src/xenia_web_shims"
  -I"$XENIA/src"
  -I"$XENIA"
  -I"$XENIA/third_party/fmt/include"
  -I"$XENIA/third_party/utfcpp/source"
  -I"$XENIA/third_party/capstone/include"
)

# Compile real upstream Xenia translation units separately. The Render360
# include overlay only supplies browser host primitives (platform + atomics).
# Xbox semantics stay in upstream Xenia source.
SOURCES=(
  "src/xenia/cpu/hir/opcodes.cc"
  "src/xenia/cpu/hir/block.cc"
  "src/xenia/cpu/hir/instr.cc"
  "src/xenia/cpu/hir/value.cc"
  "src/xenia/cpu/ppc/ppc_context.cc"
  "src/xenia/cpu/compiler/compiler_pass.cc"
  "src/xenia/cpu/ppc/ppc_hir_builder.cc"
  "src/xenia/cpu/ppc/ppc_translator.cc"
  "src/xenia/cpu/ppc/ppc_frontend.cc"
)

classify_failure() {
  local log="$1"
  if grep -Eqi 'static assertion.*64b padded|sizeof\(PPCContext\)' "$log"; then
    echo PPC_CONTEXT_ABI_DEPENDENCY
  elif grep -Eqi 'x64|amd64|avx|sse|m128|m256|xbyak|executable.*memory|code.?cache' "$log"; then
    echo HOST_ARCH_DEPENDENCY
  elif grep -Eqi 'windows\.h|win32|CreateFile|VirtualAlloc|pthread|unistd|mach/|sys/mman|mmap' "$log"; then
    echo HOST_OS_OR_MEMORY_DEPENDENCY
  elif grep -Eqi 'mutex|thread|condition_variable|atomic_wait|semaphore' "$log"; then
    echo THREADING_DEPENDENCY
  elif grep -Eqi 'fmt/|utf8|capstone|third_party|not found|file not found|no such file' "$log"; then
    echo PORTABLE_OR_THIRD_PARTY_DEPENDENCY
  else
    echo CXX_OR_PORTABILITY_DEPENDENCY
  fi
}

passed=0
failed=0
: > "$OUT/report.tsv"
printf 'source\tresult\tclassification\n' >> "$OUT/report.tsv"

for rel in "${SOURCES[@]}"; do
  src="$XENIA/$rel"
  obj="$OUT/$(echo "$rel" | tr '/' '_').o"
  log="$obj.log"
  printf '[WASM32] %-48s ' "$rel"
  if "$CXX" "${COMMON[@]}" -c "$src" -o "$obj" >"$log" 2>&1; then
    echo PASS
    printf '%s\tPASS\tPORTABLE\n' "$rel" >> "$OUT/report.tsv"
    passed=$((passed + 1))
  else
    category="$(classify_failure "$log")"
    echo "BLOCKED ($category)"
    printf '%s\tBLOCKED\t%s\n' "$rel" "$category" >> "$OUT/report.tsv"
    failed=$((failed + 1))
  fi
done

echo
echo "Xenia PPC/HIR wasm32 compile matrix: $passed passed, $failed blocked"
echo "Report: $OUT/report.tsv"

if [ "$passed" -eq 0 ]; then
  echo "ERROR: no real Xenia CPU/HIR translation unit compiled for wasm32." >&2
  exit 1
fi
