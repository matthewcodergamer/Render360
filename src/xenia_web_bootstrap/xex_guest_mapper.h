#ifndef RENDER360_XENIA_WEB_BOOTSTRAP_XEX_GUEST_MAPPER_H_
#define RENDER360_XENIA_WEB_BOOTSTRAP_XEX_GUEST_MAPPER_H_

#include <cstdint>

namespace render360::xenia_web {

enum XexGuestMapperStatus : uint32_t {
  kXexMapperReset = 0,
  kXexMapperMapping = 1,
  kXexMapperFinalized = 2,
  kXexMapperInvalidArgument = 0x80000001u,
  kXexMapperMappingFailed = 0x80000002u,
  kXexMapperLoadFailed = 0x80000003u,
  kXexMapperEntryInvalid = 0x80000004u,
  kXexMapperFinalizationFailed = 0x80000005u,
  kXexMapperStagingAllocationFailed = 0x80000006u,
};

void ResetXexGuestMapper();
bool MapXexGuestSection(uint32_t virtual_address, uint32_t virtual_size,
                        uint32_t final_protection);
bool LoadXexGuestSectionData(uint32_t virtual_address, const void* data,
                             uint32_t size);
bool SetXexGuestEntry(uint32_t entry_address);
bool FinalizeXexGuestMapping();
bool PatchFinalizedXexGuestU32BE(uint32_t address, uint32_t value);
bool ReserveXexGuestInput(uint32_t required_capacity);
uint32_t XexGuestMapperStatusValue();
uint32_t XexGuestEntryAddress();
uint32_t XexGuestSectionCount();
uint32_t XexGuestMappedBytes();
uint8_t* XexGuestInputBuffer();
uint32_t XexGuestInputCapacity();
uint32_t XexGuestInputMaxCapacity();

}  // namespace render360::xenia_web

extern "C" {
void r360_xex_guest_mapper_reset();
uint32_t r360_xex_guest_mapper_map_section(uint32_t virtual_address,
                                           uint32_t virtual_size,
                                           uint32_t final_protection);
uint32_t r360_xex_guest_mapper_load(uint32_t virtual_address,
                                    uint32_t source_ptr, uint32_t size);
uint32_t r360_xex_guest_mapper_set_entry(uint32_t entry_address);
uint32_t r360_xex_guest_mapper_finalize();
uint32_t r360_xex_guest_mapper_patch_u32_be(uint32_t address, uint32_t value);
uint32_t r360_xex_guest_mapper_reserve_input(uint32_t required_capacity);
uint32_t r360_xex_guest_mapper_status();
uint32_t r360_xex_guest_mapper_entry_address();
uint32_t r360_xex_guest_mapper_section_count();
uint32_t r360_xex_guest_mapper_mapped_bytes();
uint32_t r360_xex_guest_mapper_input_buffer();
uint32_t r360_xex_guest_mapper_input_capacity();
uint32_t r360_xex_guest_mapper_input_max_capacity();
}

#endif
