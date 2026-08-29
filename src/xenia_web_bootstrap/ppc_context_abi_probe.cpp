// Render360 V33 - browser CPU bootstrap ABI telemetry.
//
// This file does not implement PowerPC behavior. It exposes compile-time host
// layout facts for Xenia's real PPCContext after the wasm32 tail-padding
// overlay is applied. It also roots the resumable CFG continuation API with
// explicit WebAssembly export names so strict browser builds cannot silently
// publish an older non-resumable CPU ABI.

#include <cstddef>
#include <cstdint>

#include "xenia/cpu/ppc/ppc_context.h"

using xe::cpu::ppc::PPCContext;

static_assert(sizeof(PPCContext) % 64 == 0,
              "Render360 wasm32 PPCContext must preserve Xenia 64-byte padding");

#if defined(__wasm__)
#define R360_CFG_WASM_EXPORT(name) __attribute__((used, export_name(name)))
#else
#define R360_CFG_WASM_EXPORT(name)
#endif

extern "C" uint32_t r360_wasm_backend_cfg_continuation_slot_count();
extern "C" uint32_t r360_wasm_backend_cfg_continuation_state_size();
extern "C" uint32_t r360_wasm_backend_cfg_continuation_ptr(uint32_t slot);
extern "C" uint32_t r360_wasm_backend_cfg_continuation_status(uint32_t slot);
extern "C" void r360_wasm_backend_cfg_continuation_reset(uint32_t slot);

extern "C" uint32_t r360_ppc_context_size() {
  return static_cast<uint32_t>(sizeof(PPCContext));
}

extern "C" uint32_t r360_ppc_context_offset_gpr() {
  return static_cast<uint32_t>(offsetof(PPCContext, r));
}

extern "C" uint32_t r360_ppc_context_offset_fpr() {
  return static_cast<uint32_t>(offsetof(PPCContext, f));
}

extern "C" uint32_t r360_ppc_context_offset_vr() {
  return static_cast<uint32_t>(offsetof(PPCContext, v));
}

extern "C" uint32_t r360_ppc_context_offset_lr() {
  return static_cast<uint32_t>(offsetof(PPCContext, lr));
}

extern "C" uint32_t r360_ppc_context_offset_ctr() {
  return static_cast<uint32_t>(offsetof(PPCContext, ctr));
}

extern "C" uint32_t r360_ppc_context_offset_reserved_val() {
  return static_cast<uint32_t>(offsetof(PPCContext, reserved_val));
}

R360_CFG_WASM_EXPORT("r360_wasm_backend_cfg_continuation_slot_count")
extern "C" uint32_t r360_cfg_export_continuation_slot_count() {
  return r360_wasm_backend_cfg_continuation_slot_count();
}

R360_CFG_WASM_EXPORT("r360_wasm_backend_cfg_continuation_state_size")
extern "C" uint32_t r360_cfg_export_continuation_state_size() {
  return r360_wasm_backend_cfg_continuation_state_size();
}

R360_CFG_WASM_EXPORT("r360_wasm_backend_cfg_continuation_ptr")
extern "C" uint32_t r360_cfg_export_continuation_ptr(uint32_t slot) {
  return r360_wasm_backend_cfg_continuation_ptr(slot);
}

R360_CFG_WASM_EXPORT("r360_wasm_backend_cfg_continuation_status")
extern "C" uint32_t r360_cfg_export_continuation_status(uint32_t slot) {
  return r360_wasm_backend_cfg_continuation_status(slot);
}

R360_CFG_WASM_EXPORT("r360_wasm_backend_cfg_continuation_reset")
extern "C" void r360_cfg_export_continuation_reset(uint32_t slot) {
  r360_wasm_backend_cfg_continuation_reset(slot);
}
