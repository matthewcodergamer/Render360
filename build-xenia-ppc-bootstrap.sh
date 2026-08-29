#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; XENIA="$ROOT/upstream/xenia"; OVERLAY="$ROOT/build/xenia-web-overlay"; OUT="$ROOT/build/xenia-ppc-bootstrap"; CXX="${CXX:-em++}"; CC="${CC:-emcc}"; mkdir -p "$OUT"
if [ ! -d "$XENIA/src/xenia" ]; then echo "ERROR: upstream Xenia missing. Run ./fetch-xenia.sh first." >&2; exit 2; fi
if ! command -v "$CXX" >/dev/null 2>&1; then echo "ERROR: $CXX not found. Run inside Emscripten/emsdk." >&2; exit 2; fi
if ! command -v "$CC" >/dev/null 2>&1; then echo "ERROR: $CC not found. Run inside Emscripten/emsdk." >&2; exit 2; fi
python3 "$ROOT/prepare-xenia-web-overlay.py"
python3 "$ROOT/prepare-xenia-relocatable-probe-memory-overlay.py"
python3 "$ROOT/prepare-xenia-arena-overlay.py"
python3 "$ROOT/prepare-xenia-mmio-overlay.py"
python3 "$ROOT/prepare-xenia-compiler-overlay.py"
python3 "$ROOT/prepare-vmx-executor-overlay.py"
python3 "$ROOT/prepare-wasm-fpu-overlay.py"
COMMON=(-std=c++20 -O0 -g0 -I"$OVERLAY" -I"$ROOT/src/xenia_web_shims" -I"$ROOT/src/xenia_web_bootstrap" -I"$XENIA/src" -I"$XENIA" -I"$XENIA/third_party/mspack" -I"$XENIA/third_party/fmt/include" -I"$XENIA/third_party/utfcpp/source" -I"$XENIA/third_party/capstone/include" -I"$XENIA/third_party/cpptoml/include" -I"$XENIA/third_party/cxxopts/include")
COMMON_C=(-O0 -g0 -I"$XENIA/third_party/mspack" -I"$XENIA/third_party/crypto")
LLVM_INCLUDE="$(llvm-config --includedir 2>/dev/null || true)"
if [ -n "$LLVM_INCLUDE" ] && [ -d "$LLVM_INCLUDE" ]; then COMMON+=("-I$LLVM_INCLUDE"); echo "LLVM headers: $LLVM_INCLUDE"; fi
SOURCES=(
  "third_party/fmt/src/format.cc"
  "src/xenia/base/arena.cc" "src/xenia/base/cvar.cc" "src/xenia/base/utf8.cc" "src/xenia/base/filesystem_posix.cc" "src/xenia/base/memory_posix.cc" "src/xenia/base/mapped_memory_posix.cc" "src/xenia/base/mutex.cc" "src/xenia/base/string.cc" "src/xenia/base/string_buffer.cc"
  "src/xenia/memory.cc" "src/xenia/cpu/cpu_flags.cc" "src/xenia/cpu/mmio_handler.cc" "src/xenia/cpu/entry_table.cc" "src/xenia/cpu/module.cc" "src/xenia/cpu/stack_walker_posix.cc" "src/xenia/cpu/thread_state.cc" "src/xenia/cpu/processor.cc" "src/xenia/cpu/lzx.cc"
  "src/xenia/cpu/backend/backend.cc" "src/xenia/cpu/backend/assembler.cc" "src/xenia/cpu/function.cc" "src/xenia/cpu/function_debug_info.cc"
  "src/xenia/cpu/hir/opcodes.cc" "src/xenia/cpu/hir/block.cc" "src/xenia/cpu/hir/instr.cc" "src/xenia/cpu/hir/value.cc" "src/xenia/cpu/hir/hir_builder.cc"
  "src/xenia/cpu/compiler/compiler.cc" "src/xenia/cpu/compiler/compiler_pass.cc"
  "src/xenia/cpu/compiler/passes/conditional_group_pass.cc" "src/xenia/cpu/compiler/passes/conditional_group_subpass.cc" "src/xenia/cpu/compiler/passes/constant_propagation_pass.cc" "src/xenia/cpu/compiler/passes/context_promotion_pass.cc" "src/xenia/cpu/compiler/passes/control_flow_analysis_pass.cc" "src/xenia/cpu/compiler/passes/control_flow_simplification_pass.cc" "src/xenia/cpu/compiler/passes/data_flow_analysis_pass.cc" "src/xenia/cpu/compiler/passes/dead_code_elimination_pass.cc" "src/xenia/cpu/compiler/passes/finalization_pass.cc" "src/xenia/cpu/compiler/passes/memory_sequence_combination_pass.cc" "src/xenia/cpu/compiler/passes/register_allocation_pass.cc" "src/xenia/cpu/compiler/passes/simplification_pass.cc" "src/xenia/cpu/compiler/passes/validation_pass.cc" "src/xenia/cpu/compiler/passes/value_reduction_pass.cc"
  "src/xenia/cpu/ppc/ppc_context.cc" "src/xenia/cpu/ppc/ppc_opcode_table_gen.cc" "src/xenia/cpu/ppc/ppc_opcode_lookup_gen.cc" "src/xenia/cpu/ppc/ppc_opcode_disasm_gen.cc" "src/xenia/cpu/ppc/ppc_opcode_disasm.cc" "src/xenia/cpu/ppc/ppc_opcode_info.cc" "src/xenia/cpu/ppc/ppc_emit_alu.cc" "src/xenia/cpu/ppc/ppc_emit_control.cc" "src/xenia/cpu/ppc/ppc_emit_memory.cc" "src/xenia/cpu/ppc/ppc_emit_fpu.cc" "src/xenia/cpu/ppc/ppc_emit_altivec.cc" "src/xenia/cpu/ppc/ppc_scanner.cc" "src/xenia/cpu/ppc/ppc_hir_builder.cc" "src/xenia/cpu/ppc/ppc_translator.cc" "src/xenia/cpu/ppc/ppc_frontend.cc"
)

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

passed=0
failed=0
: > "$OUT/report.tsv"
printf 'source\tresult\tclassification\n' >> "$OUT/report.tsv"

compile_one() {
  local label="$1"
  local src="$2"
  local obj="$OUT/$(echo "$label" | tr '/' '_').o"
  local log="$obj.log"
  printf '[WASM32] %-64s ' "$label"
  if "$CXX" "${COMMON[@]}" -c "$src" -o "$obj" >"$log" 2>&1; then
    echo PASS
    printf '%s\tPASS\tPORTABLE\n' "$label" >> "$OUT/report.tsv"
    passed=$((passed + 1))
  else
    local category
    category="$(classify_failure "$log")"
    echo "BLOCKED ($category)"
    printf '%s\tBLOCKED\t%s\n' "$label" "$category" >> "$OUT/report.tsv"
    failed=$((failed + 1))
  fi
}

compile_c() {
  local label="$1"
  local src="$2"
  local obj="$OUT/$(echo "$label" | tr '/' '_').o"
  local log="$obj.log"
  printf '[WASM32] %-64s ' "$label"
  if "$CC" "${COMMON_C[@]}" -c "$src" -o "$obj" >"$log" 2>&1; then
    echo PASS
    printf '%s\tPASS\tPORTABLE\n' "$label" >> "$OUT/report.tsv"
    passed=$((passed + 1))
  else
    local category
    category="$(classify_failure "$log")"
    echo "BLOCKED ($category)"
    printf '%s\tBLOCKED\t%s\n' "$label" "$category" >> "$OUT/report.tsv"
    failed=$((failed + 1))
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
compile_c "third_party/mspack/lzxd.c" "$XENIA/third_party/mspack/lzxd.c"
compile_c "third_party/crypto/rijndael-alg-fst.c" "$XENIA/third_party/crypto/rijndael-alg-fst.c"
compile_one "render360/browser_logging.cpp" "$ROOT/src/xenia_web_bootstrap/browser_logging.cpp"
compile_one "render360/browser_threading_sleep.cpp" "$ROOT/src/xenia_web_bootstrap/browser_threading_sleep.cpp"
compile_one "render360/hir_correctness_executor.cpp" "$OVERLAY/render360/hir_correctness_executor_vmx.cpp"
compile_one "render360/wasm_backend_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_probe.cpp"
compile_one "render360/wasm_backend_cfg_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_cfg_probe.cpp"
compile_one "render360/wasm_backend_memory_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_memory_probe.cpp"
compile_one "render360/wasm_backend_call_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_call_probe.cpp"
compile_one "render360/wasm_backend_fpu_probe.cpp" "$OVERLAY/render360/wasm_backend_fpu_probe_v2.cpp"
compile_one "render360/wasm_backend_vmx_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_vmx_probe.cpp"
compile_one "render360/sparse_guest_memory.cpp" "$ROOT/src/xenia_web_bootstrap/sparse_guest_memory.cpp"
compile_one "render360/xex_guest_mapper.cpp" "$ROOT/src/xenia_web_bootstrap/xex_guest_mapper.cpp"
compile_one "render360/xex_pe_image.cpp" "$ROOT/src/xenia_web_bootstrap/xex_pe_image.cpp"
compile_one "render360/xex_pe_guest_loader.cpp" "$ROOT/src/xenia_web_bootstrap/xex_pe_guest_loader.cpp"
compile_one "render360/xex_title_handoff.cpp" "$ROOT/src/xenia_web_bootstrap/xex_title_handoff.cpp"
compile_one "render360/xex_lzx_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xex_lzx_probe.cpp"
compile_one "render360/xex_crypto_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xex_crypto_probe.cpp"
compile_one "render360/probe_backend.cpp" "$ROOT/src/xenia_web_bootstrap/probe_backend.cpp"
compile_one "render360/ppc_translation_probe.cpp" "$ROOT/src/xenia_web_bootstrap/ppc_translation_probe.cpp"
compile_one "render360/ppc_context_abi_probe.cpp" "$ROOT/src/xenia_web_bootstrap/ppc_context_abi_probe.cpp"

echo
echo "Xenia PPC/HIR wasm32 compile matrix: $passed passed, $failed blocked"
echo "Report: $OUT/report.tsv"
if [ "$failed" -ne 0 ]; then exit 1; fi
if [ "$passed" -eq 0 ]; then exit 1; fi
