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
// Mapping/protection invalidation evicts cached code without changing the
// executable-byte content generation.
void InvalidateWasmBackendExecutableRange(uint32_t address, uint32_t size);
// Actual executable-byte mutation advances content generations and evicts code.
void MarkWasmBackendExecutableContentChangedRange(uint32_t address,
                                                  uint32_t size);
uint32_t GetWasmBackendExecutablePageGeneration(uint32_t address);
uint32_t GetWasmBackendCallStatus();
uint32_t GetWasmBackendCallFunctionCount();
uint32_t GetWasmBackendCallFunctionAddress(uint32_t index);
uint32_t GetWasmBackendCallFunctionGeneration(uint32_t index);
uint8_t* GetWasmBackendCallFunctionModuleData(uint32_t index);
uint32_t GetWasmBackendCallFunctionModuleSize(uint32_t index);
uint32_t GetWasmBackendCallFunctionLowered(uint32_t index);
uint8_t* GetWasmBackendCallContextData();
uint32_t GetWasmBackendCallCacheHits();
uint32_t GetWasmBackendCallCacheMisses();
uint32_t GetWasmBackendCallCacheRebuilds();
uint32_t GetWasmBackendCallInvalidations();

}  // namespace render360::xenia_web

extern "C" {
uint32_t r360_wasm_backend_call_status();
uint32_t r360_wasm_backend_call_function_count();
uint32_t r360_wasm_backend_call_function_address(uint32_t index);
uint32_t r360_wasm_backend_call_function_generation(uint32_t index);
uint32_t r360_wasm_backend_call_module_ptr(uint32_t index);
uint32_t r360_wasm_backend_call_module_size(uint32_t index);
uint32_t r360_wasm_backend_call_lowered_instructions(uint32_t index);
uint32_t r360_wasm_backend_call_context_ptr();
uint32_t r360_wasm_backend_call_cache_hits();
uint32_t r360_wasm_backend_call_cache_misses();
uint32_t r360_wasm_backend_call_cache_rebuilds();
uint32_t r360_wasm_backend_call_invalidations();
uint32_t r360_wasm_backend_executable_page_generation(uint32_t address);
void r360_wasm_backend_invalidate_executable_range(uint32_t address,
                                                   uint32_t size);
void r360_wasm_backend_mark_executable_content_changed_range(uint32_t address,
                                                             uint32_t size);
}

#endif
