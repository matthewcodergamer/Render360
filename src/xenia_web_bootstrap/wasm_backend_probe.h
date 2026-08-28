#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_WASM_BACKEND_PROBE_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_WASM_BACKEND_PROBE_H_

#include <cstdint>

namespace xe::cpu::hir {
class HIRBuilder;
}

namespace render360::xenia_web {

// V35 first hot-backend slice. This consumes finalized Xenia HIR and emits a
// standalone child WebAssembly module for a deliberately small scalar INT64
// dataflow subset. Unsupported HIR fails closed and remains on the correctness
// executor path while the backend is expanded.
void ResetWasmBackendProbe();
bool BuildWasmBackendProbe(xe::cpu::hir::HIRBuilder* builder);

uint32_t GetWasmBackendProbeStatus();
uint32_t GetWasmBackendProbeModuleSize();
uint32_t GetWasmBackendProbeLoweredInstructions();
uint8_t* GetWasmBackendProbeModuleData();
uint8_t* GetWasmBackendProbeContextData();

}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_wasm_backend_status();
uint32_t r360_wasm_backend_module_ptr();
uint32_t r360_wasm_backend_module_size();
uint32_t r360_wasm_backend_lowered_instructions();
uint32_t r360_wasm_backend_context_ptr();
}

#endif  // RENDER360_XENIA_WEB_BOOTSTRAP_WASM_BACKEND_PROBE_H_
