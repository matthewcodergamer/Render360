#include "xex_guest_mapper.h"

#include <cstdint>
#include <cstdlib>
#include <vector>

#include "sparse_guest_memory.h"

namespace render360::xenia_web {
namespace {

constexpr uint32_t kPageSize = 4096u;
constexpr uint32_t kPageMask = kPageSize - 1u;
constexpr uint32_t kValidProtection = kGuestRead | kGuestWrite | kGuestExecute;
constexpr uint32_t kInitialInputCapacity = 64u * 1024u;
constexpr uint32_t kInputGrowthQuantum = 64u * 1024u;
// Keep the staging ceiling aligned with the browser title-controller's bounded
// default.xex limit. Memory is committed lazily via realloc, so an iPhone only
// pays for the prepared image it actually launches rather than a giant static
// Wasm data segment on every boot.
constexpr uint32_t kMaxInputCapacity = 256u * 1024u * 1024u;

struct XexMappedSection {
  uint32_t address = 0;
  uint32_t virtual_size = 0;
  uint32_t page_count = 0;
  uint32_t final_protection = 0;
};

std::vector<XexMappedSection> g_sections;
uint8_t* g_input = nullptr;
uint32_t g_input_capacity = 0;
uint32_t g_status = kXexMapperReset;
uint32_t g_entry_address = 0;
bool g_entry_set = false;
uint32_t g_mapped_bytes = 0;

bool Fail(uint32_t status) {
  g_status = status;
  return false;
}

bool IsPageAligned(uint32_t address) { return (address & kPageMask) == 0; }

bool IsValidSectionRange(uint32_t address, uint32_t size) {
  if (!size || !IsPageAligned(address)) return false;
  const uint64_t end = uint64_t(address) + uint64_t(size);
  return end <= (uint64_t{1} << 32);
}

bool SpanInsideMappedSections(uint32_t address, uint32_t size) {
  if (!size) return true;
  const uint64_t end = uint64_t(address) + uint64_t(size);
  if (end > (uint64_t{1} << 32)) return false;

  // A PE section may cross multiple mapper ranges after page-level permission
  // coalescing. Validate continuous coverage rather than requiring the whole
  // copy to fit inside one original mapping record.
  uint64_t current = address;
  while (current < end) {
    uint64_t covered_until = current;
    for (const auto& section : g_sections) {
      const uint64_t section_start = section.address;
      const uint64_t section_end =
          section_start + uint64_t(section.virtual_size);
      if (current >= section_start && current < section_end &&
          section_end > covered_until) {
        covered_until = section_end;
      }
    }
    if (covered_until == current) return false;
    current = covered_until < end ? covered_until : end;
  }
  return true;
}

bool EntryInsideExecutableSection() {
  if (!g_entry_set) return false;
  for (const auto& section : g_sections) {
    if (!(section.final_protection & kGuestExecute)) continue;
    const uint64_t end =
        uint64_t(section.address) + uint64_t(section.virtual_size);
    if (uint64_t(g_entry_address) >= section.address &&
        uint64_t(g_entry_address) < end) {
      return true;
    }
  }
  return false;
}

uint32_t RoundInputCapacity(uint32_t required_capacity) {
  const uint64_t rounded =
      (uint64_t(required_capacity) + kInputGrowthQuantum - 1u) &
      ~uint64_t(kInputGrowthQuantum - 1u);
  if (!rounded || rounded > kMaxInputCapacity) return 0;
  return static_cast<uint32_t>(rounded);
}

}  // namespace

void ResetXexGuestMapper() {
  ResetSparseGuestMemory();
  g_sections.clear();
  // g_input is caller-facing staging memory. Mapping reset must not erase or
  // shrink it: higher-level loaders may stage a prepared image here and then
  // reset only the guest mapping state before decoding/copying those bytes.
  g_status = kXexMapperReset;
  g_entry_address = 0;
  g_entry_set = false;
  g_mapped_bytes = 0;
}

bool ReserveXexGuestInput(uint32_t required_capacity) {
  if (!required_capacity || required_capacity > kMaxInputCapacity) {
    return Fail(kXexMapperInvalidArgument);
  }
  if (g_input && g_input_capacity >= required_capacity) return true;

  const uint32_t target = RoundInputCapacity(
      required_capacity < kInitialInputCapacity ? kInitialInputCapacity
                                                : required_capacity);
  if (!target) return Fail(kXexMapperInvalidArgument);

  void* resized = std::realloc(g_input, target);
  if (!resized) return Fail(kXexMapperStagingAllocationFailed);
  g_input = static_cast<uint8_t*>(resized);
  g_input_capacity = target;
  return true;
}

bool MapXexGuestSection(uint32_t virtual_address, uint32_t virtual_size,
                        uint32_t final_protection) {
  if (g_status == kXexMapperFinalized) return Fail(kXexMapperInvalidArgument);
  if (!IsValidSectionRange(virtual_address, virtual_size) ||
      !final_protection || (final_protection & ~kValidProtection) ||
      !(final_protection & kGuestRead)) {
    return Fail(kXexMapperInvalidArgument);
  }

  const uint64_t rounded = uint64_t(virtual_size) + kPageMask;
  const uint32_t page_count = static_cast<uint32_t>(rounded / kPageSize);
  if (!page_count || uint64_t(page_count) * kPageSize > UINT32_MAX) {
    return Fail(kXexMapperInvalidArgument);
  }

  const uint32_t backing = AllocateSparseGuestBacking(page_count);
  if (!backing) return Fail(kXexMapperMappingFailed);

  // Sections are writable only during image loading. Finalize applies the real
  // RX/R/RW contract atomically enough for this single-threaded bring-up path.
  if (!MapSparseGuestMemory(virtual_address, page_count, backing, 0,
                            kGuestRead | kGuestWrite)) {
    return Fail(kXexMapperMappingFailed);
  }

  g_sections.push_back(
      XexMappedSection{virtual_address, virtual_size, page_count,
                       final_protection});
  const uint64_t total =
      uint64_t(g_mapped_bytes) + uint64_t(page_count) * kPageSize;
  g_mapped_bytes =
      total > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(total);
  g_status = kXexMapperMapping;
  return true;
}

bool LoadXexGuestSectionData(uint32_t virtual_address, const void* data,
                             uint32_t size) {
  if (g_status == kXexMapperFinalized) return Fail(kXexMapperInvalidArgument);
  if ((size && !data) || !SpanInsideMappedSections(virtual_address, size)) {
    return Fail(kXexMapperInvalidArgument);
  }
  if (!WriteSparseGuestMemory(virtual_address, data, size)) {
    return Fail(kXexMapperLoadFailed);
  }
  g_status = kXexMapperMapping;
  return true;
}

bool SetXexGuestEntry(uint32_t entry_address) {
  if (g_status == kXexMapperFinalized) return Fail(kXexMapperInvalidArgument);
  g_entry_address = entry_address;
  g_entry_set = true;
  if (g_status == kXexMapperReset) g_status = kXexMapperMapping;
  return true;
}

bool FinalizeXexGuestMapping() {
  if (g_status == kXexMapperFinalized) return true;
  if (g_sections.empty() || !EntryInsideExecutableSection()) {
    return Fail(kXexMapperEntryInvalid);
  }

  for (const auto& section : g_sections) {
    if (!ProtectSparseGuestMemory(section.address, section.page_count,
                                  section.final_protection)) {
      return Fail(kXexMapperFinalizationFailed);
    }
  }

  g_status = kXexMapperFinalized;
  return true;
}

uint32_t XexGuestMapperStatusValue() { return g_status; }
uint32_t XexGuestEntryAddress() { return g_entry_address; }
uint32_t XexGuestSectionCount() {
  return static_cast<uint32_t>(g_sections.size());
}
uint32_t XexGuestMappedBytes() { return g_mapped_bytes; }
uint8_t* XexGuestInputBuffer() {
  if (!g_input && !ReserveXexGuestInput(kInitialInputCapacity)) return nullptr;
  return g_input;
}
uint32_t XexGuestInputCapacity() {
  if (!g_input && !ReserveXexGuestInput(kInitialInputCapacity)) return 0;
  return g_input_capacity;
}
uint32_t XexGuestInputMaxCapacity() { return kMaxInputCapacity; }

}  // namespace render360::xenia_web

extern "C" {
void r360_xex_guest_mapper_reset() {
  render360::xenia_web::ResetXexGuestMapper();
}
uint32_t r360_xex_guest_mapper_map_section(uint32_t virtual_address,
                                           uint32_t virtual_size,
                                           uint32_t final_protection) {
  return render360::xenia_web::MapXexGuestSection(
             virtual_address, virtual_size, final_protection)
             ? 1u
             : 0u;
}
uint32_t r360_xex_guest_mapper_load(uint32_t virtual_address,
                                    uint32_t source_ptr, uint32_t size) {
  const void* source = reinterpret_cast<const void*>(uintptr_t(source_ptr));
  return render360::xenia_web::LoadXexGuestSectionData(virtual_address, source,
                                                        size)
             ? 1u
             : 0u;
}
uint32_t r360_xex_guest_mapper_set_entry(uint32_t entry_address) {
  return render360::xenia_web::SetXexGuestEntry(entry_address) ? 1u : 0u;
}
uint32_t r360_xex_guest_mapper_finalize() {
  return render360::xenia_web::FinalizeXexGuestMapping() ? 1u : 0u;
}
uint32_t r360_xex_guest_mapper_reserve_input(uint32_t required_capacity) {
  return render360::xenia_web::ReserveXexGuestInput(required_capacity) ? 1u
                                                                       : 0u;
}
uint32_t r360_xex_guest_mapper_status() {
  return render360::xenia_web::XexGuestMapperStatusValue();
}
uint32_t r360_xex_guest_mapper_entry_address() {
  return render360::xenia_web::XexGuestEntryAddress();
}
uint32_t r360_xex_guest_mapper_section_count() {
  return render360::xenia_web::XexGuestSectionCount();
}
uint32_t r360_xex_guest_mapper_mapped_bytes() {
  return render360::xenia_web::XexGuestMappedBytes();
}
uint32_t r360_xex_guest_mapper_input_buffer() {
  return static_cast<uint32_t>(
      reinterpret_cast<uintptr_t>(render360::xenia_web::XexGuestInputBuffer()));
}
uint32_t r360_xex_guest_mapper_input_capacity() {
  return render360::xenia_web::XexGuestInputCapacity();
}
uint32_t r360_xex_guest_mapper_input_max_capacity() {
  return render360::xenia_web::XexGuestInputMaxCapacity();
}
}
