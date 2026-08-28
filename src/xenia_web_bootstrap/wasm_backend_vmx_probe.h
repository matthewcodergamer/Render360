#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_WASM_BACKEND_VMX_PROBE_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_WASM_BACKEND_VMX_PROBE_H_

#include <cstdint>

namespace xe::cpu::hir { class HIRBuilder; }

namespace render360::xenia_web {

void ResetWasmBackendVmxProbe();
bool BuildWasmBackendVmxProbe(xe::cpu::hir::HIRBuilder* builder,
                              uint8_t* guest_host_base,
                              uint32_t guest_base,
                              uint32_t guest_size);
uint32_t GetWasmBackendVmxProbeStatus();
uint32_t GetWasmBackendVmxProbeModuleSize();
uint32_t GetWasmBackendVmxProbeLoweredInstructions();
uint32_t GetWasmBackendVmxProbeModulePtr();
uint32_t GetWasmBackendVmxProbeContextPtr();
uint32_t GetWasmBackendVmxProbeVectorOps();
uint32_t GetWasmBackendVmxProbeNativeSimdOps();
uint32_t GetWasmBackendVmxProbeScalarizedLaneOps();

}  // namespace render360::xenia_web

#endif
