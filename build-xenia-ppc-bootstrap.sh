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
python3 "$ROOT/prepare-vmx-executor-overlay.py"
python3 "$ROOT/prepare-title-runtime-memory-overlay.py"
# Keep the HIR frame-history overlay last: it instruments the fully patched
# call/return executor and must survive the fastlane optimization work.
python3 "$ROOT/prepare-hir-call-return-stack-overlay.py"
python3 "$ROOT/prepare-hir-return-metadata-v3-overlay.py"
python3 "$ROOT/prepare-hir-stack-history-overlay.py"
python3 "$ROOT/prepare-hir-tail-frame-overlay.py"
python3 "$ROOT/prepare-xenia-shader-interpreter-overlay.py"
python3 "$ROOT/prepare-xenia-shader-translator-overlay.py"
python3 "$ROOT/prepare-xenia-spirv-browser-overlay.py"
python3 "$ROOT/prepare-wasm-fpu-overlay.py"
python3 "$ROOT/prepare-wasm-backend-cfg-overlay.py"

COMMON=(-std=c++20 -O0 -g0 -I"$OVERLAY" -I"$ROOT/src/xenia_web_shims" -I"$ROOT/src/xenia_web_bootstrap" -I"$XENIA/src" -I"$XENIA" -I"$XENIA/third_party/mspack" -I"$XENIA/third_party/fmt/include" -I"$XENIA/third_party/utfcpp/source" -I"$XENIA/third_party/capstone/include" -I"$XENIA/third_party/cpptoml/include" -I"$XENIA/third_party/cxxopts/include" -I"$XENIA/third_party/glslang")
COMMON_C=(-O0 -g0 -I"$XENIA/third_party/mspack" -I"$XENIA/third_party/crypto")
LLVM_INCLUDE="$(llvm-config --includedir 2>/dev/null || true)"
if [ -n "$LLVM_INCLUDE" ] && [ -d "$LLVM_INCLUDE" ]; then
  COMMON+=("-I$LLVM_INCLUDE")
  echo "LLVM headers: $LLVM_INCLUDE"
fi

SOURCES=(
  "third_party/fmt/src/format.cc"
  "src/xenia/base/arena.cc" "src/xenia/base/cvar.cc" "src/xenia/base/utf8.cc" "src/xenia/base/filesystem_posix.cc" "src/xenia/base/memory.cc" "src/xenia/base/memory_posix.cc" "src/xenia/base/mapped_memory_posix.cc" "src/xenia/base/mutex.cc" "src/xenia/base/string.cc" "src/xenia/base/string_buffer.cc"
  "src/xenia/memory.cc" "src/xenia/cpu/cpu_flags.cc" "src/xenia/cpu/mmio_handler.cc" "src/xenia/cpu/entry_table.cc" "src/xenia/cpu/module.cc" "src/xenia/cpu/stack_walker_posix.cc" "src/xenia/cpu/thread_state.cc" "src/xenia/cpu/processor.cc" "src/xenia/cpu/lzx.cc"
  "src/xenia/cpu/backend/backend.cc" "src/xenia/cpu/backend/assembler.cc" "src/xenia/cpu/function.cc" "src/xenia/cpu/function_debug_info.cc"
  "src/xenia/cpu/hir/opcodes.cc" "src/xenia/cpu/hir/block.cc" "src/xenia/cpu/hir/instr.cc" "src/xenia/cpu/hir/value.cc" "src/xenia/cpu/hir/hir_builder.cc"
  "src/xenia/cpu/compiler/compiler.cc" "src/xenia/cpu/compiler/compiler_pass.cc"
  "src/xenia/cpu/compiler/passes/conditional_group_pass.cc" "src/xenia/cpu/compiler/passes/conditional_group_subpass.cc" "src/xenia/cpu/compiler/passes/constant_propagation_pass.cc" "src/xenia/cpu/compiler/passes/context_promotion_pass.cc" "src/xenia/cpu/compiler/passes/control_flow_analysis_pass.cc" "src/xenia/cpu/compiler/passes/control_flow_simplification_pass.cc" "src/xenia/cpu/compiler/passes/data_flow_analysis_pass.cc" "src/xenia/cpu/compiler/passes/dead_code_elimination_pass.cc" "src/xenia/cpu/compiler/passes/finalization_pass.cc" "src/xenia/cpu/compiler/passes/memory_sequence_combination_pass.cc" "src/xenia/cpu/compiler/passes/register_allocation_pass.cc" "src/xenia/cpu/compiler/passes/simplification_pass.cc" "src/xenia/cpu/compiler/passes/validation_pass.cc" "src/xenia/cpu/compiler/passes/value_reduction_pass.cc"
  "src/xenia/cpu/ppc/ppc_context.cc" "src/xenia/cpu/ppc/ppc_opcode_table_gen.cc" "src/xenia/cpu/ppc/ppc_opcode_lookup_gen.cc" "src/xenia/cpu/ppc/ppc_opcode_disasm_gen.cc" "src/xenia/cpu/ppc/ppc_opcode_disasm.cc" "src/xenia/cpu/ppc/ppc_opcode_info.cc" "src/xenia/cpu/ppc/ppc_emit_alu.cc" "src/xenia/cpu/ppc/ppc_emit_control.cc" "src/xenia/cpu/ppc/ppc_emit_memory.cc" "src/xenia/cpu/ppc/ppc_emit_fpu.cc" "src/xenia/cpu/ppc/ppc_emit_altivec.cc" "src/xenia/cpu/ppc/ppc_scanner.cc" "src/xenia/cpu/ppc/ppc_hir_builder.cc" "src/xenia/cpu/ppc/ppc_translator.cc" "src/xenia/cpu/ppc/ppc_frontend.cc"
  "src/xenia/gpu/gpu_flags.cc" "src/xenia/gpu/register_file.cc" "src/xenia/gpu/ucode.cc" "src/xenia/gpu/shader.cc" "src/xenia/gpu/shader_translator.cc" "src/xenia/gpu/shader_translator_disasm.cc" "src/xenia/gpu/shader_interpreter.cc" "src/xenia/gpu/spirv_builder.cc" "src/xenia/gpu/spirv_shader.cc" "src/xenia/gpu/spirv_shader_translator.cc"
  "third_party/glslang/SPIRV/SpvBuilder.cpp"
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
for rel in "${SOURCES[@]}"; do
  case "$rel" in
    "src/xenia/base/arena.cc") queue_cpp "$rel" "$OVERLAY/xenia/base/arena.cc" ;;
    "src/xenia/base/cvar.cc") queue_cpp "$rel" "$OVERLAY/xenia/base/cvar.cc" ;;
    "src/xenia/base/utf8.cc") queue_cpp "$rel" "$OVERLAY/xenia/base/utf8.cc" ;;
    "src/xenia/memory.cc") queue_cpp "$rel" "$OVERLAY/xenia/memory.cc" ;;
    "src/xenia/cpu/mmio_handler.cc") queue_cpp "$rel" "$OVERLAY/xenia/cpu/mmio_handler.cc" ;;
    "src/xenia/cpu/processor.cc") queue_cpp "$rel" "$OVERLAY/xenia/cpu/processor.cc" ;;
    "src/xenia/gpu/shader_translator.cc") queue_cpp "$rel" "$OVERLAY/xenia/gpu/shader_translator.cc" ;;
    "src/xenia/gpu/shader_interpreter.cc") queue_cpp "$rel" "$OVERLAY/xenia/gpu/shader_interpreter.cc" ;;
    *) queue_cpp "$rel" "$XENIA/$rel" ;;
  esac
done

queue_c "third_party/mspack/lzxd.c" "$XENIA/third_party/mspack/lzxd.c"
queue_c "third_party/crypto/rijndael-alg-fst.c" "$XENIA/third_party/crypto/rijndael-alg-fst.c"
queue_cpp "render360/browser_logging.cpp" "$ROOT/src/xenia_web_bootstrap/browser_logging.cpp"
queue_cpp "render360/browser_threading_sleep.cpp" "$ROOT/src/xenia_web_bootstrap/browser_threading_sleep.cpp"
queue_cpp "render360/hir_correctness_executor.cpp" "$OVERLAY/render360/hir_correctness_executor_vmx.cpp"
queue_cpp "render360/kernel_import_probe.cpp" "$ROOT/src/xenia_web_bootstrap/kernel_import_probe.cpp"
queue_cpp "render360/kernel_runtime_foundation.cpp" "$ROOT/src/xenia_web_bootstrap/kernel_runtime_foundation.cpp"
queue_cpp "render360/title_gpu_runtime.cpp" "$ROOT/src/xenia_web_bootstrap/title_gpu_runtime.cpp"
queue_cpp "render360/xenos_gpu_foundation.cpp" "$ROOT/src/xenia_web_bootstrap/xenos_gpu_foundation.cpp"
queue_cpp "render360/xenos_shader_interpreter_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xenos_shader_interpreter_probe.cpp"
queue_cpp "render360/xenos_spirv_translation_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xenos_spirv_translation_probe.cpp"
queue_cpp "render360/wasm_backend_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_probe.cpp"
queue_cpp "render360/wasm_backend_cfg_probe.cpp" "$OVERLAY/render360/wasm_backend_cfg_probe.cpp"
queue_cpp "render360/wasm_backend_memory_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_memory_probe.cpp"
queue_cpp "render360/wasm_backend_call_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_call_probe.cpp"
queue_cpp "render360/wasm_backend_fpu_probe.cpp" "$OVERLAY/render360/wasm_backend_fpu_probe_v2.cpp"
queue_cpp "render360/wasm_backend_vmx_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_vmx_probe.cpp"
queue_cpp "render360/sparse_guest_memory.cpp" "$ROOT/src/xenia_web_bootstrap/sparse_guest_memory.cpp"
queue_cpp "render360/xex_guest_mapper.cpp" "$ROOT/src/xenia_web_bootstrap/xex_guest_mapper.cpp"
queue_cpp "render360/xex_pe_image.cpp" "$ROOT/src/xenia_web_bootstrap/xex_pe_image.cpp"
queue_cpp "render360/xex_pe_guest_loader.cpp" "$ROOT/src/xenia_web_bootstrap/xex_pe_guest_loader.cpp"
queue_cpp "render360/xex_title_handoff.cpp" "$ROOT/src/xenia_web_bootstrap/xex_title_handoff.cpp"
queue_cpp "render360/xex_lzx_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xex_lzx_probe.cpp"
queue_cpp "render360/xex_crypto_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xex_crypto_probe.cpp"
queue_cpp "render360/probe_backend.cpp" "$ROOT/src/xenia_web_bootstrap/probe_backend.cpp"
queue_cpp "render360/ppc_translation_probe.cpp" "$ROOT/src/xenia_web_bootstrap/ppc_translation_probe.cpp"
queue_cpp "render360/ppc_context_abi_probe.cpp" "$ROOT/src/xenia_web_bootstrap/ppc_context_abi_probe.cpp"

wait || true

phase "Aggregating compile matrix"
printf 'source\tresult\tclassification\n' > "$OUT/report.tsv"
mapfile -t RESULT_FILES < <(find "$RESULT_DIR" -maxdepth 1 -type f -name '*.tsv' -print | sort)
for result in "${RESULT_FILES[@]}"; do
  cat "$result" >> "$OUT/report.tsv"
done

passed="$(awk -F '\t' '$2=="PASS"{n++} END{print n+0}' "$OUT/report.tsv")"
failed="$(awk -F '\t' '$2=="BLOCKED"{n++} END{print n+0}' "$OUT/report.tsv")"
expected=$(( ${#SOURCES[@]} + 2 + 25 ))
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
