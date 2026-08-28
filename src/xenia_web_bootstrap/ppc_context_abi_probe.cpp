// Render360 V33 - browser CPU bootstrap ABI telemetry.
//
// This file does not implement PowerPC behavior. It exposes compile-time host
// layout facts for Xenia's real PPCContext after the wasm32 tail-padding
// overlay is applied.

#include <cstddef>
#include <cstdint>

#include "xenia/cpu/ppc/ppc_context.h"

using xe::cpu::ppc::PPCContext;

static_assert(sizeof(PPCContext) % 64 == 0,
              "Render360 wasm32 PPCContext must preserve Xenia 64-byte padding");

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
