#ifndef RENDER360_XENIA_WEB_WASM_BACKEND_FPU_PROBE_H_
#define RENDER360_XENIA_WEB_WASM_BACKEND_FPU_PROBE_H_

#include <cstdint>

namespace xe::cpu::hir { class HIRBuilder; }

namespace render360::xenia_web {
void ResetWasmBackendFpuProbe();
bool BuildWasmBackendFpuProbe(xe::cpu::hir::HIRBuilder* builder,
                              uint8_t* guest_host_base,
                              uint32_t guest_base,
                              uint32_t guest_size);
uint32_t GetWasmBackendFpuProbeStatus();
uint32_t GetWasmBackendFpuProbeModuleSize();
uint32_t GetWasmBackendFpuProbeLoweredInstructions();
uint8_t* GetWasmBackendFpuProbeModuleData();
uint8_t* GetWasmBackendFpuProbeContextData();
}

#endif
