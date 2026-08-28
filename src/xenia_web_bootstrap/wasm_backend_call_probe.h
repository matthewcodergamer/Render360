#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_WASM_BACKEND_CALL_PROBE_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_WASM_BACKEND_CALL_PROBE_H_

#include <cstdint>

namespace xe::cpu {
class GuestFunction;
namespace hir { class HIRBuilder; }
}  // namespace xe::cpu

namespace render360::xenia_web {

void ResetWasmBackendCallProbe();
bool RegisterWasmBackendCallFunction(xe::cpu::GuestFunction* function,
                                     xe::cpu::hir::HIRBuilder* builder);
uint32_t GetWasmBackendCallStatus();
uint32_t GetWasmBackendCallFunctionCount();
uint32_t GetWasmBackendCallFunctionAddress(uint32_t index);
uint8_t* GetWasmBackendCallFunctionModuleData(uint32_t index);
uint32_t GetWasmBackendCallFunctionModuleSize(uint32_t index);
uint32_t GetWasmBackendCallFunctionLowered(uint32_t index);
uint8_t* GetWasmBackendCallContextData();

}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_wasm_backend_call_status();
uint32_t r360_wasm_backend_call_function_count();
uint32_t r360_wasm_backend_call_function_address(uint32_t index);
uint32_t r360_wasm_backend_call_module_ptr(uint32_t index);
uint32_t r360_wasm_backend_call_module_size(uint32_t index);
uint32_t r360_wasm_backend_call_lowered_instructions(uint32_t index);
uint32_t r360_wasm_backend_call_context_ptr();
}

#endif
