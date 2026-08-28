#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/build/xenia-ppc-bootstrap"
CXX="${CXX:-em++}"
WASM="$OUT/xenia_ppc_bootstrap.wasm"
LOG="$OUT/link.log"
REPORT="$OUT/link-report.txt"

if [ ! -d "$OUT" ]; then echo "ERROR: compile output missing. Run build-xenia-ppc-bootstrap.sh first." >&2; exit 2; fi
if ! command -v "$CXX" >/dev/null 2>&1; then echo "ERROR: $CXX not found. Run inside Emscripten/emsdk." >&2; exit 2; fi

OBJECTS=(
  "$OUT/third_party_fmt_src_format.cc.o"
  "$OUT/src_xenia_base_arena.cc.o"
  "$OUT/src_xenia_base_cvar.cc.o"
  "$OUT/src_xenia_base_utf8.cc.o"
  "$OUT/src_xenia_base_filesystem_posix.cc.o"
  "$OUT/src_xenia_base_memory_posix.cc.o"
  "$OUT/src_xenia_base_mapped_memory_posix.cc.o"
  "$OUT/src_xenia_base_mutex.cc.o"
  "$OUT/src_xenia_base_string.cc.o"
  "$OUT/src_xenia_base_string_buffer.cc.o"
  "$OUT/src_xenia_memory.cc.o"
  "$OUT/src_xenia_cpu_cpu_flags.cc.o"
  "$OUT/src_xenia_cpu_mmio_handler.cc.o"
  "$OUT/src_xenia_cpu_entry_table.cc.o"
  "$OUT/src_xenia_cpu_module.cc.o"
  "$OUT/src_xenia_cpu_stack_walker_posix.cc.o"
  "$OUT/src_xenia_cpu_thread_state.cc.o"
  "$OUT/src_xenia_cpu_processor.cc.o"
  "$OUT/src_xenia_cpu_backend_backend.cc.o"
  "$OUT/src_xenia_cpu_backend_assembler.cc.o"
  "$OUT/src_xenia_cpu_function.cc.o"
  "$OUT/src_xenia_cpu_function_debug_info.cc.o"
  "$OUT/src_xenia_cpu_hir_opcodes.cc.o"
  "$OUT/src_xenia_cpu_hir_block.cc.o"
  "$OUT/src_xenia_cpu_hir_instr.cc.o"
  "$OUT/src_xenia_cpu_hir_value.cc.o"
  "$OUT/src_xenia_cpu_hir_hir_builder.cc.o"
  "$OUT/src_xenia_cpu_compiler_compiler.cc.o"
  "$OUT/src_xenia_cpu_compiler_compiler_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_conditional_group_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_conditional_group_subpass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_constant_propagation_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_context_promotion_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_control_flow_analysis_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_control_flow_simplification_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_dead_code_elimination_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_finalization_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_memory_sequence_combination_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_register_allocation_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_simplification_pass.cc.o"
  "$OUT/src_xenia_cpu_compiler_passes_validation_pass.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_context.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_opcode_table_gen.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_opcode_lookup_gen.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_opcode_disasm_gen.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_opcode_disasm.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_opcode_info.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_alu.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_control.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_memory.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_fpu.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_emit_altivec.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_scanner.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_hir_builder.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_translator.cc.o"
  "$OUT/src_xenia_cpu_ppc_ppc_frontend.cc.o"
  "$OUT/render360_browser_logging.cpp.o"
  "$OUT/render360_browser_threading_sleep.cpp.o"
  "$OUT/render360_probe_backend.cpp.o"
  "$OUT/render360_ppc_translation_probe.cpp.o"
  "$OUT/render360_ppc_context_abi_probe.cpp.o"
)

missing=0
for obj in "${OBJECTS[@]}"; do if [ ! -f "$obj" ]; then echo "MISSING object: $obj" >&2; missing=1; fi; done
if [ "$missing" -ne 0 ]; then exit 2; fi

EXPORTS=(
  _r360_ppc_context_size _r360_ppc_context_offset_gpr _r360_ppc_context_offset_fpr
  _r360_ppc_context_offset_vr _r360_ppc_context_offset_lr _r360_ppc_context_offset_ctr
  _r360_ppc_context_offset_reserved_val
  _r360_ppc_probe_assembled_functions _r360_ppc_probe_hir_block_count
  _r360_ppc_probe_hir_instruction_count _r360_ppc_probe_last_guest_address
  _r360_ppc_probe_reset _r360_ppc_probe_input_buffer _r360_ppc_probe_input_capacity
  _r360_ppc_probe_load _r360_ppc_probe_translate
  _r360_ppc_probe_status _r360_ppc_probe_guest_base _r360_ppc_probe_loaded_size
)
EXPORT_LIST="$(IFS=,; echo "${EXPORTS[*]}")"

LINK_ARGS=(
  -O0 -sSTANDALONE_WASM=1 -sERROR_ON_UNDEFINED_SYMBOLS=1
  -Wl,--no-entry -Wl,--export-memory -Wl,--error-limit=0
  -sINITIAL_MEMORY=33554432 -sALLOW_MEMORY_GROWTH=1
  "-sEXPORTED_FUNCTIONS=$EXPORT_LIST"
)

rm -f "$WASM" "$LOG" "$REPORT"
if "$CXX" "${LINK_ARGS[@]}" "${OBJECTS[@]}" -o "$WASM" >"$LOG" 2>&1; then
  {
    echo "status=LINKED"
    echo "wasm=$WASM"
    echo "exports=${#EXPORTS[@]}"
    echo "note=The live Xenia translation driver linked with the complete exported probe ABI. Runtime PPC-to-HIR still must pass the CI gate before PPC TRANSLATION READY."
  } | tee "$REPORT"
  exit 0
fi

{
  echo "status=BLOCKED"
  echo "wasm=$WASM"
  echo "note=Strict full-export translation probe exposed the next live Xenia dependency closure; unresolved symbols are intentionally not stubbed."
  echo
  echo "Unresolved-symbol diagnostics:"
  grep -E 'undefined symbol|wasm-ld: error|error: undefined' "$LOG" | head -n 500 || true
} | tee "$REPORT"
exit 0
