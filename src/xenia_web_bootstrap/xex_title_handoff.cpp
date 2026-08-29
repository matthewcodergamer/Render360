#include "xex_title_handoff.h"

#include <cstdint>

#include "sparse_guest_memory.h"
#include "xex_pe_guest_loader.h"

extern "C" {
void r360_ppc_probe_reset();
uint32_t r360_ppc_probe_input_buffer();
uint32_t r360_ppc_probe_input_capacity();
uint32_t r360_ppc_probe_load_at(uint32_t address, const uint8_t* bytes,
                                uint32_t length);
uint32_t r360_ppc_probe_translate();
}

namespace render360::xenia_web {
namespace {
uint32_t g_status = kPreparedEntryHandoffIdle;
uint32_t g_entry = 0;
uint32_t g_bytes = 0;
uint32_t g_hir = 0;
}  // namespace

void ResetPreparedEntryHandoff() {
  g_status = kPreparedEntryHandoffIdle;
  g_entry = 0;
  g_bytes = 0;
  g_hir = 0;
}

uint32_t TranslatePreparedPeEntry(uint32_t byte_count) {
  ResetPreparedEntryHandoff();
  if (PreparedPeGuestLoadStatus() != kPeGuestPass) {
    g_status = kPreparedEntryHandoffInvalidState;
    return 0;
  }
  if (!byte_count || (byte_count & 3u) ||
      byte_count > r360_ppc_probe_input_capacity()) {
    g_status = kPreparedEntryHandoffInvalidSize;
    return 0;
  }

  const uint32_t entry = PreparedPeGuestEntryAddress();
  const uint32_t input_ptr = r360_ppc_probe_input_buffer();
  auto* input = reinterpret_cast<uint8_t*>(static_cast<uintptr_t>(input_ptr));
  if (!input || !ReadSparseGuestMemory(entry, input, byte_count)) {
    g_status = kPreparedEntryHandoffReadFailed;
    return 0;
  }

  r360_ppc_probe_reset();
  const uint32_t loaded = r360_ppc_probe_load_at(entry, input, byte_count);
  if (loaded != byte_count) {
    g_status = kPreparedEntryHandoffLoadFailed;
    return 0;
  }

  const uint32_t hir = r360_ppc_probe_translate();
  if (!hir) {
    g_status = kPreparedEntryHandoffTranslateFailed;
    return 0;
  }

  g_entry = entry;
  g_bytes = byte_count;
  g_hir = hir;
  g_status = kPreparedEntryHandoffPass;
  return hir;
}

uint32_t PreparedEntryHandoffStatusValue() { return g_status; }
uint32_t PreparedEntryHandoffAddress() { return g_entry; }
uint32_t PreparedEntryHandoffBytes() { return g_bytes; }
uint32_t PreparedEntryHandoffHIRInstructions() { return g_hir; }

}  // namespace render360::xenia_web

extern "C" {
void r360_title_handoff_reset() {
  render360::xenia_web::ResetPreparedEntryHandoff();
}
uint32_t r360_title_handoff_translate_entry(uint32_t byte_count) {
  return render360::xenia_web::TranslatePreparedPeEntry(byte_count);
}
uint32_t r360_title_handoff_status() {
  return render360::xenia_web::PreparedEntryHandoffStatusValue();
}
uint32_t r360_title_handoff_entry_address() {
  return render360::xenia_web::PreparedEntryHandoffAddress();
}
uint32_t r360_title_handoff_bytes() {
  return render360::xenia_web::PreparedEntryHandoffBytes();
}
uint32_t r360_title_handoff_hir_instructions() {
  return render360::xenia_web::PreparedEntryHandoffHIRInstructions();
}
}
