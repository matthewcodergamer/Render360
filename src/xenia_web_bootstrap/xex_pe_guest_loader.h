#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_XEX_PE_GUEST_LOADER_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_XEX_PE_GUEST_LOADER_H_

#include <cstdint>

namespace render360::xenia_web {

enum PeGuestLoadStatus : uint32_t {
  kPeGuestIdle = 0,
  kPeGuestPass = 1,
  kPeGuestInvalidArgument = 0x81000001u,
  kPeGuestDecodeFailed = 0x81000002u,
  kPeGuestAddressOverflow = 0x81000003u,
  kPeGuestProtectionInvalid = 0x81000004u,
  kPeGuestMapFailed = 0x81000005u,
  kPeGuestLoadFailed = 0x81000006u,
  kPeGuestEntryFailed = 0x81000007u,
  kPeGuestFinalizeFailed = 0x81000008u,
};

void ResetPreparedPeGuestLoad();
bool LoadPreparedPeImageToGuest(const uint8_t* image, uint32_t length);
bool LoadPreparedPeImageToGuestAtEntry(const uint8_t* image, uint32_t length,
                                       uint32_t entry_address);
uint32_t PreparedPeGuestLoadStatus();
uint32_t PreparedPeGuestEntryAddress();
uint32_t PreparedPeGuestPeEntryAddress();
uint32_t PreparedPeGuestSectionCount();
uint32_t PreparedPeGuestRawBytes();
bool PreparedPeGuestFindRuntimeFunction(uint32_t address, uint32_t* begin,
                                        uint32_t* end_exclusive,
                                        uint32_t* prolog_bytes);

}  // namespace render360::xenia_web

extern "C" {
void r360_pe_guest_reset();
uint32_t r360_pe_guest_load(uint32_t source_ptr, uint32_t length);
uint32_t r360_pe_guest_load_at_entry(uint32_t source_ptr, uint32_t length,
                                      uint32_t entry_address);
uint32_t r360_pe_guest_status();
uint32_t r360_pe_guest_entry_address();
uint32_t r360_pe_guest_pe_entry_address();
uint32_t r360_pe_guest_section_count();
uint32_t r360_pe_guest_raw_bytes();
}

#endif
