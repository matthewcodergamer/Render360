#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/build/xenia-ppc-bootstrap"
CXX="${CXX:-em++}"
WASM="$OUT/xenia_ppc_bootstrap.wasm"
LOG="$OUT/link.log"
REPORT="$OUT/link-report.txt"

if [ ! -d "$OUT" ]; then
  echo "ERROR: compile output missing. Run build-xenia-ppc-bootstrap.sh first." >&2
  exit 2
fi
if ! command -v "$CXX" >/dev/null 2>&1; then
  echo "ERROR: $CXX not found. Run inside Emscripten/emsdk." >&2
  exit 2
fi

OBJECTS=(
  "$OUT/src_xenia_cpu_hir_opcodes.cc.o"
  "$OUT/src_xenia_cpu_hir_block.cc.o"
  "$OUT/src_xenia_cpu_hir_instr.cc.o"
  "$OUT/src_xenia_cpu_hir_value.cc.o"
  "$OUT/src_xenia_cpu_compiler_compiler_pass.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_context.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_alu.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_control.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_memory.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_fpu.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_altivec.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_hir_builder.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_translator.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_frontend.cc.o"
  "$OUT/render360_ppc_context_abi_probe.cpp.o"
)

missing=0
for obj in "${OBJECTS[@]}"; do
  if [ ! -f "$obj" ]; then
    echo "MISSING object: $obj" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 2
fi

EXPORTS=(
  _r360_ppc_context_size
  _r360_ppc_context_offset_gpr
  _r360_ppc_context_offset_fpr
  _r360_ppc_context_offset_vr
  _r360_ppc_context_offset_lr
  _r360_ppc_context_offset_ctr
  _r360_ppc_context_offset_reserved_val
)

LINK_ARGS=(
  -O0
  -sSTANDALONE_WASM=1
  -sERROR_ON_UNDEFINED_SYMBOLS=1
  -Wl,--no-entry
  -Wl,--export-memory
  -sINITIAL_MEMORY=33554432
  -sALLOW_MEMORY_GROWTH=1
)
for symbol in "${EXPORTS[@]}"; do
  LINK_ARGS+=("-sEXPORTED_FUNCTIONS=$symbol")
done

rm -f "$WASM" "$LOG" "$REPORT"

# This link is intentionally strict. A failure is a useful result: it exposes
# the exact additional Xenia translation units / host boundaries required to
# turn the compile-only CPU surface into one real wasm module. Never suppress
# unresolved symbols merely to produce a misleading .wasm file.
if "$CXX" "${LINK_ARGS[@]}" "${OBJECTS[@]}" -o "$WASM" >"$LOG" 2>&1; then
  {
    echo "status=LINKED"
    echo "wasm=$WASM"
    echo "note=Real selected Xenia PPC/HIR objects linked into a standalone wasm module. This still does not mean PPC translation or execution is ready."
  } | tee "$REPORT"
  exit 0
fi

{
  echo "status=BLOCKED"
  echo "wasm=$WASM"
  echo "note=Strict link failed. See link.log for the real unresolved Xenia dependency boundary."
  echo
  echo "First unresolved-symbol diagnostics:"
  grep -E 'undefined symbol|wasm-ld: error|error: undefined' "$LOG" | head -n 80 || true
} | tee "$REPORT"

# Dependency discovery is the expected outcome of this stage, so keep CI alive
# and publish the report/log. The status remains explicitly BLOCKED.
exit 0
