#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/build/xenia-ppc-bootstrap"
CXX="${CXX:-em++}"
LLVM_NM="${LLVM_NM:-llvm-nm}"
WASM="$OUT/xenia_ppc_bootstrap.wasm"
LOG="$OUT/link.log"
REPORT="$OUT/link-report.txt"

if [ ! -d "$OUT" ]; then
  echo "ERROR: compile output missing." >&2
  exit 2
fi
if ! command -v "$CXX" >/dev/null 2>&1; then
  echo "ERROR: $CXX not found." >&2
  exit 2
fi
if ! command -v "$LLVM_NM" >/dev/null 2>&1; then
  if [ -x /emsdk/upstream/bin/llvm-nm ]; then
    LLVM_NM=/emsdk/upstream/bin/llvm-nm
  else
    echo "ERROR: llvm-nm not found; cannot synchronize Render360 exports." >&2
    exit 2
  fi
fi

# The compile matrix writes only the objects that belong to this strict
# bootstrap into OUT. Discover them instead of maintaining a second, drifting
# copy of the object list here.
mapfile -t OBJECTS < <(find "$OUT" -maxdepth 1 -type f -name '*.o' -print | sort)
if [ "${#OBJECTS[@]}" -eq 0 ]; then
  echo "ERROR: no compiled bootstrap objects found." >&2
  exit 2
fi

# Every public browser/bootstrap ABI symbol is deliberately prefixed r360_.
# Discover those definitions directly from the just-built objects and feed that
# exact set to Emscripten. This makes a new C/C++ browser ABI export impossible
# to compile successfully yet silently disappear from the published WASM due to
# a stale hand-maintained EXPORTED_FUNCTIONS whitelist.
mapfile -t R360_SYMBOLS < <(
  "$LLVM_NM" -g --defined-only "${OBJECTS[@]}" 2>/dev/null |
    awk '{print $NF}' |
    grep -E '^r360_[A-Za-z0-9_]+$' |
    sort -u
)
if [ "${#R360_SYMBOLS[@]}" -eq 0 ]; then
  echo "ERROR: no r360_* bootstrap ABI symbols discovered." >&2
  exit 2
fi

# These are the production-threaded execution exports that previously existed
# in source but were absent from xenia_ppc_bootstrap.wasm. Fail the linker gate
# before publishing if any side of that contract ever drifts again.
CRITICAL_EXPORTS=(
  r360_ppc_probe_set_execute_on_translate
  r360_ppc_probe_execute_on_translate
  r360_guest_thread_entry
  r360_guest_thread_context
  r360_guest_thread_flags
  r360_guest_thread_stack_base
  r360_guest_thread_stack_top
  r360_guest_thread_stack_mapped
  r360_wasm_backend_cfg_continuation_slot_count
  r360_wasm_backend_cfg_continuation_state_size
  r360_wasm_backend_cfg_continuation_ptr
  r360_wasm_backend_cfg_continuation_status
  r360_wasm_backend_cfg_continuation_reset
)
for required in "${CRITICAL_EXPORTS[@]}"; do
  found=0
  for symbol in "${R360_SYMBOLS[@]}"; do
    if [ "$symbol" = "$required" ]; then found=1; break; fi
  done
  if [ "$found" -ne 1 ]; then
    echo "ERROR: required browser bootstrap export was not built: $required" >&2
    exit 3
  fi
done

EXPORTS=()
for symbol in "${R360_SYMBOLS[@]}"; do EXPORTS+=("_$symbol"); done
EXPORT_LIST="$(IFS=,; echo "${EXPORTS[*]}")"

# Xenos ExecuteBuffer has bounded nested command/constant scratch frames. Give
# wasm32 an explicit 2 MiB stack so those frames cannot overwrite the sparse
# guest-memory allocator while the source is being moved to static scratch.
LINK_ARGS=(
  -O0
  -sSTANDALONE_WASM=1
  -sERROR_ON_UNDEFINED_SYMBOLS=1
  -Wl,--no-entry
  -Wl,--export-memory
  -Wl,--error-limit=0
  -sINITIAL_MEMORY=33554432
  -sSTACK_SIZE=2097152
  -sALLOW_MEMORY_GROWTH=1
  "-sEXPORTED_FUNCTIONS=$EXPORT_LIST"
)

rm -f "$WASM" "$LOG" "$REPORT"
if "$CXX" "${LINK_ARGS[@]}" "${OBJECTS[@]}" -o "$WASM" >"$LOG" 2>&1; then
  {
    echo "status=LINKED"
    echo "wasm=$WASM"
    echo "objects=${#OBJECTS[@]}"
    echo "exports=${#EXPORTS[@]}"
    echo "critical_exports=${#CRITICAL_EXPORTS[@]}"
    echo "note=Render360 browser ABI exports are discovered from the compiled r360_* symbol set; production PPC translation, native guest-thread state, resumable CFG continuation, kernel/runtime, Xenos and frame APIs cannot drift out of the published WASM whitelist."
  } | tee "$REPORT"
  exit 0
fi

{
  echo "status=BLOCKED"
  echo "wasm=$WASM"
  echo "note=Strict full browser-runtime link exposed a live dependency closure; unresolved symbols are intentionally not stubbed."
  grep -E 'undefined symbol|wasm-ld: error|error: undefined' "$LOG" | head -n 500 || true
} | tee "$REPORT"
exit 1
