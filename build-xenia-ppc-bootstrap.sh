#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
XENIA="$ROOT/upstream/xenia"
OVERLAY="$ROOT/build/xenia-web-overlay"
OUT="$ROOT/build/xenia-ppc-bootstrap"
CXX="${CXX:-em++}"
mkdir -p "$OUT"

if [ ! -d "$XENIA/src/xenia" ]; then echo "ERROR: upstream Xenia missing. Run ./fetch-xenia.sh first." >&2; exit 2; fi
if ! command -v "$CXX" >/dev/null 2>&1; then echo "ERROR: $CXX not found. Run inside Emscripten/emsdk." >&2; exit 2; fi
python3 "$ROOT/prepare-xenia-web-overlay.py"
python3 "$ROOT/prepare-xenia-arena-overlay.py"
python3 "$ROOT/prepare-xenia-mmio-overlay.py"
python3 "$ROOT/prepare-xenia-compiler-overlay.py"
python3 "$ROOT/prepare-vmx-executor-overlay.py"
python3 "$ROOT/prepare-wasm-backend-cfg-overlay.py"

COMMON=(
  -std=c++20 -O0 -g0
  -I"$OVERLAY" -I"$ROOT/src/xenia_web_shims" -I"$ROOT/src/xenia_web_bootstrap"
  -I"$XENIA/src" -I"$XENIA"
  -I"$XENIA/third_party/fmt/include" -I"$XENIA/third_party/utfcpp/source"
  -I"$XENIA/third_party/capstone/include" -I"$XENIA/third_party/cpptoml/include"
  -I"$XENIA/third_party/cxxopts/include"
)
LLVM_INCLUDE="$(llvm-config --includedir 2>/dev/null || true)"
if [ -n "$LLVM_INCLUDE" ] && [ -d "$LLVM_INCLUDE" ]; then COMMON+=("-I$LLVM_INCLUDE"); echo "LLVM headers: $LLVM_INCLUDE"; fi

SOURCES=(
  "third_party/fmt/src/format.cc"
  "src/xenia/base/arena.cc"
  "src/xenia/base/cvar.cc"
  "src/xenia/base/utf8.cc"
  "src/xenia/base/filesystem_posix.cc"
  "src/xenia/base/memory_posix.cc"
  "src/xenia/base/mapped_memory_posix.cc"
  "src/xenia/base/mutex.cc"
  "src/xenia/base/string.cc"
  "src/xenia/base/string_buffer.cc"
  "src/xenia/memory.cc"
  "src/xenia/cpu/cpu_flags.cc"
  "src/xenia/cpu/mmio_handler.cc"
  "src/xenia/cpu/entry_table.cc"
  "src/xenia/cpu/module.cc"
  "src/xenia/cpu/stack_walker_posix.cc"
  "src/xenia/cpu/thread_state.cc"
  "src/xenia/cpu/processor.cc"
  "src/xenia/cpu/backend/backend.cc"
  "src/xenia/cpu/backend/assembler.cc"
  "src/xenia/cpu/function.cc"
  "src/xenia/cpu/function_debug_info.cc"
  "src/xenia/cpu/hir/opcodes.cc"
  "src/xenia/cpu/hir/block.cc"
  "src/xenia/cpu/hir/instr.cc"
  "src/xenia/cpu/hir/value.cc"
  "src/xenia/cpu/hir/hir_builder.cc"
  "src/xenia/cpu/compiler/compiler.cc"
  "src/xenia/cpu/compiler/compiler_pass.cc"
  "src/xenia/cpu/compiler/passes/conditional_group_pass.cc"
  "src/xenia/cpu/compiler/passes/conditional_group_subpass.cc"
  "src/xenia/cpu/compiler/passes/constant_propagation_pass.cc"
  "src/xenia/cpu/compiler/passes/context_promotion_pass.cc"
  "src/xenia/cpu/compiler/passes/control_flow_analysis_pass.cc"
  "src/xenia/cpu/compiler/passes/control_flow_simplification_pass.cc"
  "src/xenia/cpu/compiler/passes/data_flow_analysis_pass.cc"
  "src/xenia/cpu/compiler/passes/dead_code_elimination_pass.cc"
  "src/xenia/cpu/compiler/passes/finalization_pass.cc"
  "src/xenia/cpu/compiler/passes/memory_sequence_combination_pass.cc"
  "src/xenia/cpu/compiler/passes/register_allocation_pass.cc"
  "src/xenia/cpu/compiler/passes/simplification_pass.cc"
  "src/xenia/cpu/compiler/passes/validation_pass.cc"
  "src/xenia/cpu/compiler/passes/value_reduction_pass.cc"
  "src/xenia/cpu/ppc/ppc_context.cc"
  "src/xenia/cpu/ppc/ppc_opcode_table_gen.cc"
  "src/xenia/cpu/ppc/ppc_opcode_lookup_gen.cc"
  "src/xenia/cpu/ppc/ppc_opcode_disasm_gen.cc"
  "src/xenia/cpu/ppc/ppc_opcode_disasm.cc"
  "src/xenia/cpu/ppc/ppc_opcode_info.cc"
  "src/xenia/cpu/ppc/ppc_emit_alu.cc"
  "src/xenia/cpu/ppc/ppc_emit_control.cc"
  "src/xenia/cpu/ppc/ppc_emit_memory.cc"
  "src/xenia/cpu/ppc/ppc_emit_fpu.cc"
  "src/xenia/cpu/ppc/ppc_emit_altivec.cc"
  "src/xenia/cpu/ppc/ppc_scanner.cc"
  "src/xenia/cpu/ppc/ppc_hir_builder.cc"
  "src/xenia/cpu/ppc/ppc_translator.cc"
  "src/xenia/cpu/ppc/ppc_frontend.cc"
)

classify_failure() {
  local log="$1"
  if grep -Eqi 'Instruction pointer not specified|target CPU architecture|x64_backend|x64|amd64|avx|sse|m128|m256|xbyak|executable.*memory|code.?cache' "$log"; then echo HOST_ARCH_DEPENDENCY
  elif grep -Eqi 'static assertion.*64b padded|sizeof\(PPCContext\)' "$log"; then echo PPC_CONTEXT_ABI_DEPENDENCY
  elif grep -Eqi 'CreateFileMapping|MapView|file.?mapping|4gb|address space|windows\.h|win32|VirtualAlloc|sys/mman|mmap|shm_open|ftruncate64|mprotect|munmap' "$log"; then echo HOST_MEMORY_MAPPING_DEPENDENCY
  elif grep -Eqi 'error:.*char8_t|no viable.*char8_t|u8 literal' "$log"; then echo UTF8_LITERAL_ABI_DEPENDENCY
  elif grep -Eqi 'llvm/ADT|llvm/' "$log"; then echo LLVM_HEADER_DEPENDENCY
  elif grep -Eqi 'pthread|unistd|mach/' "$log"; then echo HOST_OS_DEPENDENCY
  elif grep -Eqi 'mutex|thread|condition_variable|atomic_wait|semaphore|threading\.h|chrono\.h' "$log"; then echo THREADING_DEPENDENCY
  elif grep -Eqi 'fmt/|utf8|capstone|cpptoml|cxxopts|third_party/date|third_party|not found|file not found|no such file' "$log"; then echo PORTABLE_OR_THIRD_PARTY_DEPENDENCY
  else echo CXX_OR_PORTABILITY_DEPENDENCY
  fi
}

passed=0; failed=0
: > "$OUT/report.tsv"; printf 'source\tresult\tclassification\n' >> "$OUT/report.tsv"
compile_one() {
  local label="$1"; local src="$2"; local obj="$OUT/$(echo "$label" | tr '/' '_').o"; local log="$obj.log"
  printf '[WASM32] %-64s ' "$label"
  if "$CXX" "${COMMON[@]}" -c "$src" -o "$obj" >"$log" 2>&1; then
    echo PASS; printf '%s\tPASS\tPORTABLE\n' "$label" >> "$OUT/report.tsv"; passed=$((passed + 1))
  else
    local category; category="$(classify_failure "$log")"; echo "BLOCKED ($category)"
    printf '%s\tBLOCKED\t%s\n' "$label" "$category" >> "$OUT/report.tsv"; failed=$((failed + 1))
  fi
}

for rel in "${SOURCES[@]}"; do
  case "$rel" in
    "src/xenia/base/arena.cc") compile_one "$rel" "$OVERLAY/xenia/base/arena.cc" ;;
    "src/xenia/base/cvar.cc") compile_one "$rel" "$OVERLAY/xenia/base/cvar.cc" ;;
    "src/xenia/base/utf8.cc") compile_one "$rel" "$OVERLAY/xenia/base/utf8.cc" ;;
    "src/xenia/memory.cc") compile_one "$rel" "$OVERLAY/xenia/memory.cc" ;;
    "src/xenia/cpu/mmio_handler.cc") compile_one "$rel" "$OVERLAY/xenia/cpu/mmio_handler.cc" ;;
    "src/xenia/cpu/processor.cc") compile_one "$rel" "$OVERLAY/xenia/cpu/processor.cc" ;;
    *) compile_one "$rel" "$XENIA/$rel" ;;
  esac
done
compile_one "render360/browser_logging.cpp" "$ROOT/src/xenia_web_bootstrap/browser_logging.cpp"
compile_one "render360/browser_threading_sleep.cpp" "$ROOT/src/xenia_web_bootstrap/browser_threading_sleep.cpp"
# V34 VMX correctness extends the committed canonical executor through a
# deterministic generated overlay. The overlay script fails if the canonical
# source contract drifts, so CI cannot silently build against stale semantics.
compile_one "render360/hir_correctness_executor.cpp" "$OVERLAY/render360/hir_correctness_executor_vmx.cpp"
# V35 hot-backend work consumes the same compiler-finalized Xenia HIR and emits
# child WebAssembly modules. Scalar dataflow and CFG/control flow are separate
# translation units and separate runtime gates so unsupported behavior remains
# fail-closed instead of being hidden inside one broad backend claim. The CFG
# overlay preserves finalized-HIR in-block conditional fallthrough exactly.
compile_one "render360/wasm_backend_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_probe.cpp"
compile_one "render360/wasm_backend_cfg_probe.cpp" "$OVERLAY/render360/wasm_backend_cfg_probe.cpp"
compile_one "render360/probe_backend.cpp" "$ROOT/src/xenia_web_bootstrap/probe_backend.cpp"
compile_one "render360/ppc_translation_probe.cpp" "$ROOT/src/xenia_web_bootstrap/ppc_translation_probe.cpp"
compile_one "render360/ppc_context_abi_probe.cpp" "$ROOT/src/xenia_web_bootstrap/ppc_context_abi_probe.cpp"

echo; echo "Xenia PPC/HIR wasm32 compile matrix: $passed passed, $failed blocked"; echo "Report: $OUT/report.tsv"
if [ "$failed" -ne 0 ]; then echo "ERROR: wasm32 compile matrix contains blocked units." >&2; exit 1; fi
if [ "$passed" -eq 0 ]; then echo "ERROR: no real Xenia CPU/HIR translation unit compiled for wasm32." >&2; exit 1; fi
