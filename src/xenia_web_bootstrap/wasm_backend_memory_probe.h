#ifndef RENDER360_XENIA_WEB_WASM_BACKEND_MEMORY_PROBE_H_
#define RENDER360_XENIA_WEB_WASM_BACKEND_MEMORY_PROBE_H_

#include <cstdint>

namespace xe::cpu::hir { class HIRBuilder; }

namespace render360::xenia_web {
void ResetWasmBackendMemoryProbe();
bool BuildWasmBackendMemoryProbe(xe::cpu::hir::HIRBuilder* builder,
                                 uint8_t* guest_host_base,
                                 uint32_t guest_base,
                                 uint32_t guest_size);
uint32_t GetWasmBackendMemoryProbeStatus();
uint32_t GetWasmBackendMemoryProbeModuleSize();
uint32_t GetWasmBackendMemoryProbeLoweredInstructions();
uint8_t* GetWasmBackendMemoryProbeModuleData();
uint8_t* GetWasmBackendMemoryProbeContextData();
}

extern "C" {
uint32_t r360_wasm_backend_memory_status();
uint32_t r360_wasm_backend_memory_module_ptr();
uint32_t r360_wasm_backend_memory_module_size();
uint32_t r360_wasm_backend_memory_lowered_instructions();
uint32_t r360_wasm_backend_memory_context_ptr();
}
#endif
