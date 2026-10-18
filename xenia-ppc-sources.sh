# Render360 Xenia PPC bootstrap source list, shared by the wasm build
# (build-xenia-ppc-bootstrap.sh) and the native macOS/iOS build
# (native/build-native.sh) so the two can never drift apart.
# Requires ROOT, XENIA and OVERLAY to be set. bash 3.2 compatible (macOS).

SOURCES=(
  "third_party/fmt/src/format.cc"
  "src/xenia/base/arena.cc" "src/xenia/base/cvar.cc" "src/xenia/base/utf8.cc" "src/xenia/base/filesystem_posix.cc" "src/xenia/base/memory.cc" "src/xenia/base/memory_posix.cc" "src/xenia/base/mapped_memory_posix.cc" "src/xenia/base/mutex.cc" "src/xenia/base/string.cc" "src/xenia/base/string_buffer.cc"
  "src/xenia/memory.cc" "src/xenia/cpu/cpu_flags.cc" "src/xenia/cpu/mmio_handler.cc" "src/xenia/cpu/entry_table.cc" "src/xenia/cpu/module.cc" "src/xenia/cpu/stack_walker_posix.cc" "src/xenia/cpu/thread_state.cc" "src/xenia/cpu/processor.cc" "src/xenia/cpu/lzx.cc"
  "src/xenia/cpu/backend/backend.cc" "src/xenia/cpu/backend/assembler.cc" "src/xenia/cpu/function.cc" "src/xenia/cpu/function_debug_info.cc"
  "src/xenia/cpu/hir/opcodes.cc" "src/xenia/cpu/hir/block.cc" "src/xenia/cpu/hir/instr.cc" "src/xenia/cpu/hir/value.cc" "src/xenia/cpu/hir/hir_builder.cc"
  "src/xenia/cpu/compiler/compiler.cc" "src/xenia/cpu/compiler/compiler_pass.cc"
  "src/xenia/cpu/compiler/passes/conditional_group_pass.cc" "src/xenia/cpu/compiler/passes/conditional_group_subpass.cc" "src/xenia/cpu/compiler/passes/constant_propagation_pass.cc" "src/xenia/cpu/compiler/passes/context_promotion_pass.cc" "src/xenia/cpu/compiler/passes/control_flow_analysis_pass.cc" "src/xenia/cpu/compiler/passes/control_flow_simplification_pass.cc" "src/xenia/cpu/compiler/passes/data_flow_analysis_pass.cc" "src/xenia/cpu/compiler/passes/dead_code_elimination_pass.cc" "src/xenia/cpu/compiler/passes/finalization_pass.cc" "src/xenia/cpu/compiler/passes/memory_sequence_combination_pass.cc" "src/xenia/cpu/compiler/passes/register_allocation_pass.cc" "src/xenia/cpu/compiler/passes/simplification_pass.cc" "src/xenia/cpu/compiler/passes/validation_pass.cc" "src/xenia/cpu/compiler/passes/value_reduction_pass.cc"
  "src/xenia/cpu/ppc/ppc_context.cc" "src/xenia/cpu/ppc/ppc_opcode_table_gen.cc" "src/xenia/cpu/ppc/ppc_opcode_lookup_gen.cc" "src/xenia/cpu/ppc/ppc_opcode_disasm_gen.cc" "src/xenia/cpu/ppc/ppc_opcode_disasm.cc" "src/xenia/cpu/ppc/ppc_opcode_info.cc" "src/xenia/cpu/ppc/ppc_emit_alu.cc" "src/xenia/cpu/ppc/ppc_emit_control.cc" "src/xenia/cpu/ppc/ppc_emit_memory.cc" "src/xenia/cpu/ppc/ppc_emit_fpu.cc" "src/xenia/cpu/ppc/ppc_emit_altivec.cc" "src/xenia/cpu/ppc/ppc_scanner.cc" "src/xenia/cpu/ppc/ppc_hir_builder.cc" "src/xenia/cpu/ppc/ppc_translator.cc" "src/xenia/cpu/ppc/ppc_frontend.cc"
  "src/xenia/kernel/util/xdbf_utils.cc" "src/xenia/gpu/gpu_flags.cc" "src/xenia/gpu/register_file.cc" "src/xenia/gpu/ucode.cc" "src/xenia/gpu/shader.cc" "src/xenia/gpu/shader_translator.cc" "src/xenia/gpu/shader_translator_disasm.cc" "src/xenia/gpu/shader_interpreter.cc" "src/xenia/gpu/draw_util.cc" "src/xenia/gpu/registers.cc" "src/xenia/gpu/xenos.cc" "src/xenia/gpu/texture_util.cc" "src/xenia/gpu/texture_info.cc" "src/xenia/gpu/texture_info_formats.cc" "src/xenia/ui/graphics_util.cc" "src/xenia/gpu/spirv_builder.cc" "src/xenia/gpu/spirv_shader.cc" "src/xenia/gpu/spirv_shader_translator.cc"
  "third_party/glslang/SPIRV/SpvBuilder.cpp"
)

# r360_for_each_source CPP_FN C_FN: calls CPP_FN/C_FN with "label" "path" for
# every translation unit of the bootstrap, in build order.
r360_for_each_source() {
  local queue_cpp="$1" queue_c="$2" rel
  for rel in "${SOURCES[@]}"; do
    case "$rel" in
      "src/xenia/base/arena.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/base/arena.cc" ;;
      "src/xenia/base/cvar.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/base/cvar.cc" ;;
      "src/xenia/base/utf8.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/base/utf8.cc" ;;
      "src/xenia/memory.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/memory.cc" ;;
      "src/xenia/cpu/mmio_handler.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/cpu/mmio_handler.cc" ;;
      "src/xenia/cpu/processor.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/cpu/processor.cc" ;;
      "src/xenia/cpu/hir/value.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/cpu/hir/value.cc" ;;
      "src/xenia/cpu/ppc/ppc_scanner.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/cpu/ppc/ppc_scanner.cc" ;;
      "src/xenia/cpu/ppc/ppc_translator.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/cpu/ppc/ppc_translator.cc" ;;
      "src/xenia/gpu/draw_util.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/gpu/draw_util.cc" ;;
      "src/xenia/gpu/shader_translator.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/gpu/shader_translator.cc" ;;
      "src/xenia/gpu/shader_interpreter.cc") "$queue_cpp" "$rel" "$OVERLAY/xenia/gpu/shader_interpreter.cc" ;;
      *) "$queue_cpp" "$rel" "$XENIA/$rel" ;;
    esac
  done
  
  "$queue_c" "third_party/mspack/lzxd.c" "$XENIA/third_party/mspack/lzxd.c"
  "$queue_c" "third_party/crypto/rijndael-alg-fst.c" "$XENIA/third_party/crypto/rijndael-alg-fst.c"
  "$queue_cpp" "render360/browser_logging.cpp" "$ROOT/src/xenia_web_bootstrap/browser_logging.cpp"
  "$queue_cpp" "render360/browser_threading_sleep.cpp" "$ROOT/src/xenia_web_bootstrap/browser_threading_sleep.cpp"
  "$queue_cpp" "render360/hir_correctness_executor.cpp" "$OVERLAY/render360/hir_correctness_executor_vmx.cpp"
  "$queue_cpp" "render360/kernel_import_probe.cpp" "$ROOT/src/xenia_web_bootstrap/kernel_import_probe.cpp"
  "$queue_cpp" "render360/kernel_runtime_foundation.cpp" "$ROOT/src/xenia_web_bootstrap/kernel_runtime_foundation.cpp"
  "$queue_cpp" "render360/guest_fibers.cpp" "$ROOT/src/xenia_web_bootstrap/guest_fibers.cpp"
  "$queue_cpp" "render360/hir_wasm_jit.cpp" "$ROOT/src/xenia_web_bootstrap/hir_wasm_jit.cpp"
  "$queue_cpp" "render360/xenos_soft_renderer.cpp" "$ROOT/src/xenia_web_bootstrap/xenos_soft_renderer.cpp"
  "$queue_cpp" "render360/webgpu_backend.cpp" "$ROOT/src/xenia_web_bootstrap/webgpu_backend.cpp"
  "$queue_cpp" "render360/webgpu_draws.cpp" "$ROOT/src/xenia_web_bootstrap/webgpu_draws.cpp"
  "$queue_cpp" "render360/webgpu_textures.cpp" "$ROOT/src/xenia_web_bootstrap/webgpu_textures.cpp"
  "$queue_cpp" "render360/kernel_xboxkrnl_services.cpp" "$ROOT/src/xenia_web_bootstrap/kernel_xboxkrnl_services.cpp"
  "$queue_cpp" "render360/xam_xdbf.cpp" "$ROOT/src/xenia_web_bootstrap/xam_xdbf.cpp"
  "$queue_cpp" "render360/title_gpu_runtime.cpp" "$ROOT/src/xenia_web_bootstrap/title_gpu_runtime.cpp"
  "$queue_cpp" "render360/xenos_gpu_foundation.cpp" "$ROOT/src/xenia_web_bootstrap/xenos_gpu_foundation.cpp"
  "$queue_cpp" "render360/xenos_shader_interpreter_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xenos_shader_interpreter_probe.cpp"
  "$queue_cpp" "render360/xenos_spirv_translation_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xenos_spirv_translation_probe.cpp"
  "$queue_cpp" "render360/wasm_backend_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_probe.cpp"
  "$queue_cpp" "render360/wasm_backend_cfg_probe.cpp" "$OVERLAY/render360/wasm_backend_cfg_probe.cpp"
  "$queue_cpp" "render360/wasm_backend_memory_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_memory_probe.cpp"
  "$queue_cpp" "render360/wasm_backend_call_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_call_probe.cpp"
  "$queue_cpp" "render360/wasm_backend_fpu_probe.cpp" "$OVERLAY/render360/wasm_backend_fpu_probe_v2.cpp"
  "$queue_cpp" "render360/wasm_backend_vmx_probe.cpp" "$ROOT/src/xenia_web_bootstrap/wasm_backend_vmx_probe.cpp"
  "$queue_cpp" "render360/sparse_guest_memory.cpp" "$ROOT/src/xenia_web_bootstrap/sparse_guest_memory.cpp"
  "$queue_cpp" "render360/xex_guest_mapper.cpp" "$ROOT/src/xenia_web_bootstrap/xex_guest_mapper.cpp"
  "$queue_cpp" "render360/xex_pe_image.cpp" "$ROOT/src/xenia_web_bootstrap/xex_pe_image.cpp"
  "$queue_cpp" "render360/xex_pe_guest_loader.cpp" "$ROOT/src/xenia_web_bootstrap/xex_pe_guest_loader.cpp"
  "$queue_cpp" "render360/xex_title_handoff.cpp" "$ROOT/src/xenia_web_bootstrap/xex_title_handoff.cpp"
  "$queue_cpp" "render360/xex_lzx_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xex_lzx_probe.cpp"
  "$queue_cpp" "render360/xex_crypto_probe.cpp" "$ROOT/src/xenia_web_bootstrap/xex_crypto_probe.cpp"
  "$queue_cpp" "render360/probe_backend.cpp" "$ROOT/src/xenia_web_bootstrap/probe_backend.cpp"
  "$queue_cpp" "render360/ppc_translation_probe.cpp" "$ROOT/src/xenia_web_bootstrap/ppc_translation_probe.cpp"
  "$queue_cpp" "render360/ppc_context_abi_probe.cpp" "$ROOT/src/xenia_web_bootstrap/ppc_context_abi_probe.cpp"
}

# Number of r360_for_each_source callbacks (SOURCES + 2 C files + Render360 TUs).
r360_source_count() {
  R360_SOURCE_COUNT=0
  _r360_count() { R360_SOURCE_COUNT=$((R360_SOURCE_COUNT + 1)); }
  r360_for_each_source _r360_count _r360_count
}
