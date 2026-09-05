#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/build/xenia-ppc-bootstrap"
CXX="${CXX:-em++}"
LLVM_NM="${LLVM_NM:-llvm-nm}"
WASM="$OUT/xenia_ppc_bootstrap.wasm"
LOG="$OUT/link.log"
REPORT="$OUT/link-report.txt"
CRITICAL_FILE="$OUT/critical-exports.txt"

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

# Discover the full Render360 symbol surface first. This is the authoritative
# source-built inventory used by the critical ABI gate below.
mapfile -t ALL_R360_SYMBOLS < <(
  "$LLVM_NM" -g --defined-only "${OBJECTS[@]}" 2>/dev/null |
    awk '{print $NF}' |
    grep -E '^r360_[A-Za-z0-9_]+$' |
    sort -u
)
if [ "${#ALL_R360_SYMBOLS[@]}" -eq 0 ]; then
  echo "ERROR: no r360_* bootstrap ABI symbols discovered." >&2
  exit 2
fi

# These are production execution exports that must exist in the deployed Wasm.
# Portal scanned-entry diagnostics are part of that deployed browser ABI, not
# optional debug-only symbols, so a stale bootstrap must fail the link gate.
# In particular, the PE staging reserve pair prevents commercial prepared XEX
# images from being incorrectly constrained by the historical 64 KiB scratch
# buffer used by early bring-up tests.
CRITICAL_EXPORTS=(
  r360_ppc_probe_set_initial_lr
  r360_ppc_probe_correctness_gpr
  r360_ppc_probe_set_execute_on_translate
  r360_ppc_probe_execute_on_translate
  r360_ppc_probe_scan_diagnostic
  r360_ppc_probe_scan_address
  r360_ppc_probe_scan_window_end
  r360_ppc_probe_scan_function_end
  r360_ppc_probe_scan_hir_instructions
  r360_xex_guest_mapper_reserve_input
  r360_xex_guest_mapper_patch_u32_be
  r360_xex_guest_mapper_input_max_capacity
  r360_pe_guest_runtime_function_begin
  r360_pe_guest_runtime_function_end
  r360_pe_guest_runtime_function_prolog_bytes
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
printf '%s\n' "${CRITICAL_EXPORTS[@]}" > "$CRITICAL_FILE"
for required in "${CRITICAL_EXPORTS[@]}"; do
  found=0
  for symbol in "${ALL_R360_SYMBOLS[@]}"; do
    if [ "$symbol" = "$required" ]; then found=1; break; fi
  done
  if [ "$found" -ne 1 ]; then
    echo "ERROR: required browser bootstrap export was not built: $required" >&2
    exit 3
  fi
done

# Clang's wasm export_name attribute creates an internal source symbol and a
# public Wasm export alias. The resumable-CFG overlay also has ordinary C ABI
# accessors with the same public names. Feeding both sides back through
# EXPORTED_FUNCTIONS caused the generated module to contain duplicate public
# continuation exports, while trying to force-export the internal alias (for
# example r360_cfg_export_continuation_ptr) produced an undefined-export error.
#
# Keep discovering the entire source surface, but do not force-export compiler
# alias helpers or the five continuation targets already owned by export_name.
# Everything else is explicitly rooted so new Render360 APIs cannot disappear
# merely because the linker considers them otherwise unreferenced.
is_attribute_owned_public_export() {
  case "$1" in
    r360_wasm_backend_cfg_continuation_slot_count|\
    r360_wasm_backend_cfg_continuation_state_size|\
    r360_wasm_backend_cfg_continuation_ptr|\
    r360_wasm_backend_cfg_continuation_status|\
    r360_wasm_backend_cfg_continuation_reset) return 0 ;;
    *) return 1 ;;
  esac
}

R360_SYMBOLS=()
ATTRIBUTE_HELPERS=0
ATTRIBUTE_TARGETS=0
for symbol in "${ALL_R360_SYMBOLS[@]}"; do
  case "$symbol" in
    r360_*_export_*) ATTRIBUTE_HELPERS=$((ATTRIBUTE_HELPERS + 1)); continue ;;
  esac
  if is_attribute_owned_public_export "$symbol"; then
    ATTRIBUTE_TARGETS=$((ATTRIBUTE_TARGETS + 1))
    continue
  fi
  R360_SYMBOLS+=("$symbol")
done
if [ "${#R360_SYMBOLS[@]}" -eq 0 ]; then
  echo "ERROR: synchronized export filter removed the entire browser ABI." >&2
  exit 3
fi

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
if ! "$CXX" "${LINK_ARGS[@]}" "${OBJECTS[@]}" -o "$WASM" >"$LOG" 2>&1; then
  {
    echo "status=BLOCKED"
    echo "wasm=$WASM"
    echo "note=Strict full browser-runtime link exposed a live dependency closure; unresolved symbols are intentionally not stubbed."
    grep -E 'undefined symbol|undefined exported symbol|wasm-ld: error|error: undefined' "$LOG" | head -n 500 || true
  } | tee "$REPORT"
  exit 1
fi

# Validate the actual module, not merely the linker exit code. This catches the
# duplicate-export failure class that produced a file on disk but could not be
# instantiated by Safari/Node. Every critical production export must exist
# exactly once in the final Wasm export namespace.
if command -v node >/dev/null 2>&1; then
  node - "$WASM" "$CRITICAL_FILE" <<'NODE'
const fs=require('fs');
const wasmPath=process.argv[2];
const criticalPath=process.argv[3];
const bytes=fs.readFileSync(wasmPath);
let mod;
try{mod=new WebAssembly.Module(bytes);}catch(error){
  console.error(`ERROR: linked browser bootstrap is not a valid WebAssembly module: ${error.message}`);
  process.exit(4);
}
const exports=WebAssembly.Module.exports(mod).map(x=>x.name);
const counts=new Map();
for(const name of exports)counts.set(name,(counts.get(name)||0)+1);
const duplicates=[...counts].filter(([,count])=>count!==1);
if(duplicates.length){
  console.error(`ERROR: duplicate Wasm exports: ${duplicates.map(([name,count])=>`${name} x${count}`).join(', ')}`);
  process.exit(5);
}
const critical=fs.readFileSync(criticalPath,'utf8').split(/\r?\n/).filter(Boolean);
const missing=critical.filter(name=>counts.get(name)!==1);
if(missing.length){
  console.error(`ERROR: linked browser bootstrap is missing critical exports: ${missing.join(', ')}`);
  process.exit(6);
}
console.log(`WASM_EXPORT_VALIDATION=PASS exports=${exports.length} critical=${critical.length}`);
NODE
else
  echo "ERROR: node is required to validate the linked browser bootstrap." >&2
  exit 4
fi

{
  echo "status=LINKED"
  echo "wasm=$WASM"
  echo "objects=${#OBJECTS[@]}"
  echo "source_r360_symbols=${#ALL_R360_SYMBOLS[@]}"
  echo "explicit_exports=${#EXPORTS[@]}"
  echo "attribute_helpers_skipped=$ATTRIBUTE_HELPERS"
  echo "attribute_targets_skipped=$ATTRIBUTE_TARGETS"
  echo "critical_exports=${#CRITICAL_EXPORTS[@]}"
  echo "note=Render360 browser ABI roots are discovered from compiled r360_* symbols, export_name aliases are deduplicated, and the final Wasm module is instantiated and checked for unique critical production exports before publish."
} | tee "$REPORT"
exit 0
