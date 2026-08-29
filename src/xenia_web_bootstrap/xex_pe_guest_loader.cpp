#include "xex_pe_guest_loader.h"

#include <cstdint>

#include "sparse_guest_memory.h"
#include "xex_guest_mapper.h"
#include "xex_pe_image.h"

namespace render360::xenia_web {
namespace {

constexpr uint32_t kPeMemExecute = 0x20000000u;
constexpr uint32_t kPeMemRead = 0x40000000u;
constexpr uint32_t kPeMemWrite = 0x80000000u;

uint32_t g_status = kPeGuestIdle;
uint32_t g_entry = 0;
uint32_t g_sections = 0;
uint32_t g_raw_bytes = 0;

bool Fail(uint32_t status) {
  g_status = status;
  return false;
}

bool Add32(uint32_t a, uint32_t b, uint32_t* out) {
  const uint64_t value = uint64_t(a) + uint64_t(b);
  if (value > UINT32_MAX) return false;
  *out = static_cast<uint32_t>(value);
  return true;
}

uint32_t ProtectionFromCharacteristics(uint32_t characteristics) {
  uint32_t protection = 0;
  if (characteristics & kPeMemRead) protection |= kGuestRead;
  if (characteristics & kPeMemWrite) protection |= kGuestWrite;
  if (characteristics & kPeMemExecute) protection |= kGuestExecute;
  return protection;
}

}  // namespace

void ResetPreparedPeGuestLoad() {
  g_status = kPeGuestIdle;
  g_entry = 0;
  g_sections = 0;
  g_raw_bytes = 0;
  ResetXexGuestMapper();
}

bool LoadPreparedPeImageToGuest(const uint8_t* image, uint32_t length) {
  ResetPreparedPeGuestLoad();
  if (!image || !length) return Fail(kPeGuestInvalidArgument);

  render360::xex::PEImageMetadata metadata{};
  if (render360::xex::DecodePE(image, length, &metadata) !=
      render360::xex::kPEPass) {
    return Fail(kPeGuestDecodeFailed);
  }

  for (uint32_t i = 0; i < metadata.section_count; ++i) {
    const auto& section = metadata.sections[i];
    const uint32_t virtual_span =
        section.virtual_size > section.raw_size ? section.virtual_size
                                                : section.raw_size;
    if (!virtual_span) continue;

    uint32_t guest_address = 0;
    if (!Add32(metadata.image_base, section.virtual_address, &guest_address)) {
      return Fail(kPeGuestAddressOverflow);
    }

    const uint32_t protection =
        ProtectionFromCharacteristics(section.characteristics);
    // The strict guest mapper requires readable final mappings. Xbox PE
    // executable/data sections used by titles should describe read access
    // explicitly; do not silently widen malformed section permissions.
    if (!(protection & kGuestRead)) return Fail(kPeGuestProtectionInvalid);

    if (!MapXexGuestSection(guest_address, virtual_span, protection)) {
      return Fail(kPeGuestMapFailed);
    }

    if (section.raw_size) {
      if (!LoadXexGuestSectionData(guest_address, image + section.raw_address,
                                   section.raw_size)) {
        return Fail(kPeGuestLoadFailed);
      }
      const uint64_t total = uint64_t(g_raw_bytes) + section.raw_size;
      g_raw_bytes = total > UINT32_MAX ? UINT32_MAX
                                      : static_cast<uint32_t>(total);
    }
    ++g_sections;
  }

  uint32_t entry = 0;
  if (!Add32(metadata.image_base, metadata.entry_rva, &entry)) {
    return Fail(kPeGuestAddressOverflow);
  }
  if (!SetXexGuestEntry(entry)) return Fail(kPeGuestEntryFailed);
  if (!FinalizeXexGuestMapping()) return Fail(kPeGuestFinalizeFailed);

  g_entry = entry;
  g_status = kPeGuestPass;
  return true;
}

uint32_t PreparedPeGuestLoadStatus() { return g_status; }
uint32_t PreparedPeGuestEntryAddress() { return g_entry; }
uint32_t PreparedPeGuestSectionCount() { return g_sections; }
uint32_t PreparedPeGuestRawBytes() { return g_raw_bytes; }

}  // namespace render360::xenia_web

extern "C" {
void r360_pe_guest_reset() { render360::xenia_web::ResetPreparedPeGuestLoad(); }
uint32_t r360_pe_guest_load(uint32_t source_ptr, uint32_t length) {
  const auto* source =
      reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(source_ptr));
  return render360::xenia_web::LoadPreparedPeImageToGuest(source, length) ? 1u
                                                                         : 0u;
}
uint32_t r360_pe_guest_status() {
  return render360::xenia_web::PreparedPeGuestLoadStatus();
}
uint32_t r360_pe_guest_entry_address() {
  return render360::xenia_web::PreparedPeGuestEntryAddress();
}
uint32_t r360_pe_guest_section_count() {
  return render360::xenia_web::PreparedPeGuestSectionCount();
}
uint32_t r360_pe_guest_raw_bytes() {
  return render360::xenia_web::PreparedPeGuestRawBytes();
}
}
