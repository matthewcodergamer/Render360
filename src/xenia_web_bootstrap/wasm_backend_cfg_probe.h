#ifndef RENDER360_XENIA_WEB_WASM_BACKEND_CFG_PROBE_H_
#define RENDER360_XENIA_WEB_WASM_BACKEND_CFG_PROBE_H_

#include <cstdint>

namespace xe::cpu::hir {
class HIRBuilder;
}

namespace render360::xenia_web {

void ResetWasmBackendCfgProbe();
bool BuildWasmBackendCfgProbe(xe::cpu::hir::HIRBuilder* builder);
uint32_t GetWasmBackendCfgProbeStatus();
uint32_t GetWasmBackendCfgProbeModuleSize();
uint32_t GetWasmBackendCfgProbeLoweredInstructions();
uint8_t* GetWasmBackendCfgProbeModuleData();
uint8_t* GetWasmBackendCfgProbeContextData();

}  // namespace render360::xenia_web

#endif  // RENDER360_XENIA_WEB_WASM_BACKEND_CFG_PROBE_H_
