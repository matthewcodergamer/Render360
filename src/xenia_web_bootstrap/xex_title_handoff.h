#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_XEX_TITLE_HANDOFF_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_XEX_TITLE_HANDOFF_H_

#include <cstdint>

namespace render360::xenia_web {

enum PreparedEntryHandoffStatus : uint32_t {
  kPreparedEntryHandoffIdle = 0,
  kPreparedEntryHandoffPass = 1,
  kPreparedEntryHandoffInvalidState = 0x82000001u,
  kPreparedEntryHandoffInvalidSize = 0x82000002u,
  kPreparedEntryHandoffReadFailed = 0x82000003u,
  kPreparedEntryHandoffLoadFailed = 0x82000004u,
  kPreparedEntryHandoffTranslateFailed = 0x82000005u,
};

void ResetPreparedEntryHandoff();
uint32_t TranslatePreparedPeEntry(uint32_t byte_count);
uint32_t PreparedEntryHandoffStatusValue();
uint32_t PreparedEntryHandoffAddress();
uint32_t PreparedEntryHandoffBytes();
uint32_t PreparedEntryHandoffHIRInstructions();

}  // namespace render360::xenia_web

extern "C" {
void r360_title_handoff_reset();
uint32_t r360_title_handoff_translate_entry(uint32_t byte_count);
uint32_t r360_title_handoff_status();
uint32_t r360_title_handoff_entry_address();
uint32_t r360_title_handoff_bytes();
uint32_t r360_title_handoff_hir_instructions();
}

#endif
