#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
XENIA="$ROOT/upstream/xenia"
OVERLAY="$ROOT/build/xenia-web-overlay"
OUT="$ROOT/build/xenia-ppc-bootstrap"
CXX="${CXX:-em++}"
CC="${CC:-emcc}"
JOBS="${R360_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"

case "$JOBS" in
  ''|*[!0-9]*) JOBS=2 ;;
esac
if [ "$JOBS" -lt 1 ]; then JOBS=1; fi
# GitHub's standard Linux runner has limited RAM. More than four concurrent
# em++ frontends can be slower due to memory pressure, so keep this bounded.
if [ "$JOBS" -gt 4 ]; then JOBS=4; fi

mkdir -p "$OUT"
START_SECONDS=$SECONDS

phase() {
  printf '\n[R360_BUILD] t=%ss %s\n' "$((SECONDS - START_SECONDS))" "$*"
}

if [ ! -d "$XENIA/src/xenia" ]; then
  echo "ERROR: upstream Xenia missing. Run ./fetch-xenia.sh first." >&2
  exit 2
fi
if ! command -v "$CXX" >/dev/null 2>&1; then
  echo "ERROR: $CXX not found. Install/activate Emscripten first." >&2
  exit 2
fi
if ! command -v "$CC" >/dev/null 2>&1; then
  echo "ERROR: $CC not found. Install/activate Emscripten first." >&2
  exit 2
fi

phase "Applying Render360/Xenia overlays"
python3 "$ROOT/prepare-xenia-web-overlay.py"
python3 "$ROOT/prepare-xenia-relocatable-probe-memory-overlay.py"
python3 "$ROOT/prepare-xenia-arena-overlay.py"
python3 "$ROOT/prepare-xenia-mmio-overlay.py"
python3 "$ROOT/prepare-xenia-compiler-overlay.py"
python3 "$ROOT/prepare-xenia-hir-value-overlay.py"
python3 "$ROOT/prepare-xenia-ppc-scanner-overlay.py"
python3 "$ROOT/prepare-xenia-ppc-translator-overlay.py"
python3 "$ROOT/prepare-xenia-draw-util-overlay.py"
python3 "$ROOT/prepare-vmx-executor-overlay.py"
python3 "$ROOT/prepare-title-runtime-memory-overlay.py"
# Keep the HIR frame-history overlay last: it instruments the fully patched
# call/return executor and must survive the fastlane optimization work.
python3 "$ROOT/prepare-hir-call-return-stack-overlay.py"
python3 "$ROOT/prepare-hir-return-metadata-v3-overlay.py"
python3 "$ROOT/prepare-hir-stack-history-overlay.py"
python3 "$ROOT/prepare-hir-tail-frame-overlay.py"
python3 "$ROOT/prepare-hir-fiber-locals-overlay.py"
python3 "$ROOT/prepare-hir-jit-overlay.py"
python3 "$ROOT/prepare-hir-hot-path-overlay.py"
python3 "$ROOT/prepare-xenia-shader-interpreter-overlay.py"
python3 "$ROOT/prepare-xenia-shader-translator-overlay.py"
python3 "$ROOT/prepare-xenia-spirv-browser-overlay.py"
python3 "$ROOT/prepare-wasm-fpu-overlay.py"
python3 "$ROOT/prepare-wasm-backend-cfg-overlay.py"

# Optimization level for the browser CPU runtime (-O3: ~4% faster guest code
# than -O2 on Banjo-Tooie). -O0 made the HIR executor,
# sparse memory and kernel services several times slower on phones.
# Override with R360_OPT=-O0 when bisecting a suspected miscompile.
R360_OPT="${R360_OPT:--O3}"
case "$R360_OPT" in -O0|-O1|-O2|-O3|-Os|-Oz) ;; *) echo "ERROR: invalid R360_OPT=$R360_OPT" >&2; exit 2 ;; esac
# Xenia ships Release builds with NDEBUG ("We rely on assert being compiled out
# in NDEBUG", xenia/base/assert.h). Debug-only asserts fire on real retail code
# and, in wasm, abort() is an "unreachable" trap that kills the whole core.
COMMON=(-std=c++20 "$R360_OPT" -DNDEBUG -g0 -I"$OVERLAY" -I"$ROOT/src/xenia_web_shims" -I"$ROOT/src/xenia_web_bootstrap" -I"$XENIA/src" -I"$XENIA" -I"$XENIA/third_party/mspack" -I"$XENIA/third_party/fmt/include" -I"$XENIA/third_party/utfcpp/source" -I"$XENIA/third_party/capstone/include" -I"$XENIA/third_party/cpptoml/include" -I"$XENIA/third_party/cxxopts/include" -I"$XENIA/third_party/glslang")
COMMON_C=("$R360_OPT" -DNDEBUG -g0 -I"$XENIA/third_party/mspack" -I"$XENIA/third_party/crypto")
LLVM_INCLUDE="$(llvm-config --includedir 2>/dev/null || true)"
if [ -n "$LLVM_INCLUDE" ] && [ -d "$LLVM_INCLUDE" ]; then
  COMMON+=("-I$LLVM_INCLUDE")
  echo "LLVM headers: $LLVM_INCLUDE"
fi

source "$ROOT/xenia-ppc-sources.sh"

classify_failure() {
  local log="$1"
  if grep -Eqi 'Instruction pointer not specified|target CPU architecture|x64_backend|x64|amd64|avx|sse|m128|m256|xbyak|executable.*memory|code.?cache' "$log"; then
    echo HOST_ARCH_DEPENDENCY
  elif grep -Eqi 'static assertion.*64b padded|sizeof\(PPCContext\)' "$log"; then
    echo PPC_CONTEXT_ABI_DEPENDENCY
  elif grep -Eqi 'CreateFileMapping|MapView|file.?mapping|4gb|address space|windows\.h|win32|VirtualAlloc|sys/mman|mmap|shm_open|ftruncate64|mprotect|munmap' "$log"; then
    echo HOST_MEMORY_MAPPING_DEPENDENCY
  else
    echo CXX_OR_PORTABILITY_DEPENDENCY
  fi
}

RESULT_DIR="$OUT/.compile-results"
rm -rf "$RESULT_DIR"
mkdir -p "$RESULT_DIR"
# Never let objects left from an interrupted job be linked into the next build.
rm -f "$OUT"/*.o "$OUT"/*.o.log

safe_name() {
  printf '%s' "$1" | tr '/. ' '___'
}

compile_cpp_worker() {
  local label="$1"
  local src="$2"
  local safe obj log result category
  safe="$(safe_name "$label")"
  obj="$OUT/$(printf '%s' "$label" | tr '/' '_').o"
  log="$obj.log"
  result="$RESULT_DIR/$safe.tsv"
  if "$CXX" "${COMMON[@]}" -c "$src" -o "$obj" >"$log" 2>&1; then
    printf '%s\tPASS\tPORTABLE\n' "$label" >"$result"
    printf '[WASM32] PASS    %s\n' "$label"
  else
    category="$(classify_failure "$log")"
    printf '%s\tBLOCKED\t%s\n' "$label" "$category" >"$result"
    printf '[WASM32] BLOCKED %-52s (%s)\n' "$label" "$category" >&2
  fi
}

compile_c_worker() {
  local label="$1"
  local src="$2"
  local safe obj log result category
  safe="$(safe_name "$label")"
  obj="$OUT/$(printf '%s' "$label" | tr '/' '_').o"
  log="$obj.log"
  result="$RESULT_DIR/$safe.tsv"
  if "$CC" "${COMMON_C[@]}" -c "$src" -o "$obj" >"$log" 2>&1; then
    printf '%s\tPASS\tPORTABLE\n' "$label" >"$result"
    printf '[WASM32] PASS    %s\n' "$label"
  else
    category="$(classify_failure "$log")"
    printf '%s\tBLOCKED\t%s\n' "$label" "$category" >"$result"
    printf '[WASM32] BLOCKED %-52s (%s)\n' "$label" "$category" >&2
  fi
}

wait_for_slot() {
  while [ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$JOBS" ]; do
    wait -n || true
  done
}

queue_cpp() {
  wait_for_slot
  compile_cpp_worker "$1" "$2" &
}

queue_c() {
  wait_for_slot
  compile_c_worker "$1" "$2" &
}

phase "Compiling wasm32 source matrix with $JOBS parallel job(s)"
r360_for_each_source queue_cpp queue_c

wait || true

phase "Aggregating compile matrix"
printf 'source\tresult\tclassification\n' > "$OUT/report.tsv"
mapfile -t RESULT_FILES < <(find "$RESULT_DIR" -maxdepth 1 -type f -name '*.tsv' -print | sort)
for result in "${RESULT_FILES[@]}"; do
  cat "$result" >> "$OUT/report.tsv"
done

passed="$(awk -F '\t' '$2=="PASS"{n++} END{print n+0}' "$OUT/report.tsv")"
failed="$(awk -F '\t' '$2=="BLOCKED"{n++} END{print n+0}' "$OUT/report.tsv")"
r360_source_count
expected=$R360_SOURCE_COUNT
actual=$(( passed + failed ))

echo
printf 'Xenia PPC/HIR wasm32 compile matrix: %s passed, %s blocked (%s/%s results)\n' "$passed" "$failed" "$actual" "$expected"
echo "Report: $OUT/report.tsv"

if [ "$actual" -ne "$expected" ]; then
  echo "ERROR: compile worker result count mismatch; expected $expected got $actual" >&2
  exit 1
fi
if [ "$failed" -ne 0 ]; then
  echo "----- blocked compiler diagnostics -----" >&2
  while IFS=$'\t' read -r label result category; do
    [ "$result" = "BLOCKED" ] || continue
    log="$OUT/$(printf '%s' "$label" | tr '/' '_').o.log"
    echo "----- $label ($category) -----" >&2
    cat "$log" >&2 || true
  done < <(tail -n +2 "$OUT/report.tsv")
  echo "----- end blocked compiler diagnostics -----" >&2
  exit 1
fi
if [ "$passed" -eq 0 ]; then
  exit 1
fi

phase "Compile phase complete"
