#include "xex_pe_guest_loader.h"

#include <cstdint>
#include <map>

#include "sparse_guest_memory.h"
#include "xex_guest_mapper.h"
#include "xex_pe_image.h"

namespace render360::xenia_web {
namespace {

constexpr uint32_t kPeMemExecute = 0x20000000u;
constexpr uint32_t kPeMemRead = 0x40000000u;
constexpr uint32_t kPeMemWrite = 0x80000000u;
constexpr uint32_t kGuestPageSize = 4096u;
constexpr uint32_t kGuestPageMask = kGuestPageSize - 1u;

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

bool AddPagesForSpan(std::map<uint32_t, uint32_t>* pages, uint32_t address,
                     uint32_t size, uint32_t protection) {
  if (!pages || !size || !protection) return false;
  const uint64_t end = uint64_t(address) + uint64_t(size);
  if (end > (uint64_t{1} << 32)) return false;

  const uint64_t first_page = uint64_t(address & ~kGuestPageMask);
  const uint64_t last_page = (end - 1u) & ~uint64_t(kGuestPageMask);
  for (uint64_t page = first_page; page <= last_page; page += kGuestPageSize) {
    (*pages)[static_cast<uint32_t>(page)] |= protection;
  }
  return true;
}

bool MapPreparedPePages(const std::map<uint32_t, uint32_t>& pages) {
  if (pages.empty()) return false;

  auto it = pages.begin();
  uint32_t range_start = it->first;
  uint32_t range_protection = it->second;
  uint64_t range_end = uint64_t(it->first) + kGuestPageSize;
  ++it;

  auto flush = [&]() -> bool {
    const uint64_t size = range_end - uint64_t(range_start);
    if (!size || size > UINT32_MAX) return false;
    return MapXexGuestSection(range_start, static_cast<uint32_t>(size),
                              range_protection);
  };

  for (; it != pages.end(); ++it) {
    const uint32_t page = it->first;
    const uint32_t protection = it->second;
    if (uint64_t(page) == range_end && protection == range_protection) {
      range_end += kGuestPageSize;
      continue;
    }
    if (!flush()) return false;
    range_start = page;
    range_protection = protection;
    range_end = uint64_t(page) + kGuestPageSize;
  }
  return flush();
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

  // Build a page-level mapping plan before touching guest memory. PE section
  // alignment is not guaranteed to equal our 4 KiB sparse-memory page size.
  // Real titles may place multiple sections in one guest page. Mapping each PE
  // section independently would then either reject an unaligned address or try
  // to map the same page twice. Merge every section onto guest pages first and
  // union permissions only on pages that are genuinely shared.
  std::map<uint32_t, uint32_t> page_protections;
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
    if (!AddPagesForSpan(&page_protections, guest_address, virtual_span,
                         protection)) {
      return Fail(kPeGuestAddressOverflow);
    }
  }

  if (!MapPreparedPePages(page_protections)) return Fail(kPeGuestMapFailed);

  // Copy the original section bytes only after all required pages are mapped.
  // LoadXexGuestSectionData accepts spans covered by multiple adjacent mapping
  // ranges, so a single PE section may cross page-protection boundaries safely.
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
