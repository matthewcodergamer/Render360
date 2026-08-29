#include "sparse_guest_memory.h"

#include <array>
#include <cstdint>
#include <cstring>
#include <map>
#include <vector>

#include "wasm_backend_call_probe.h"

namespace render360::xenia_web {
namespace {

constexpr uint32_t kPageShift = 12;
constexpr uint32_t kPageSize = 1u << kPageShift;
constexpr uint32_t kPageMask = kPageSize - 1u;
constexpr uint32_t kValidProtection = kGuestRead | kGuestWrite | kGuestExecute;

enum FaultCode : uint32_t {
  kFaultNone = 0,
  kFaultUnmapped = 1,
  kFaultReadProtection = 2,
  kFaultWriteProtection = 3,
  kFaultInvalidArgument = 4,
  kFaultAlreadyMapped = 5,
};

struct Backing {
  std::vector<std::array<uint8_t, kPageSize>> pages;
};

struct Mapping {
  uint32_t backing_id = 0;
  uint32_t backing_page = 0;
  uint32_t protection = 0;
};

std::vector<Backing> g_backings;
std::map<uint32_t, Mapping> g_pages;
// Number of executable virtual aliases for each physical sparse backing page.
// Guest RAM writes are extremely hot; they must not scan the entire virtual
// mapping tree just to discover that an ordinary RW data/stack page has no
// executable alias.
std::map<std::pair<uint32_t, uint32_t>, uint32_t> g_executable_alias_counts;
// This is the authoritative executable-byte content generation. It is sparse
// across the full 32-bit Xbox virtual address space and is intentionally
// independent of permission/mapping invalidation and the legacy backend epoch.
std::map<uint32_t, uint32_t> g_executable_content_generations;
uint32_t g_last_fault_address = 0;
uint32_t g_last_fault_code = kFaultNone;

void ClearFault() {
  g_last_fault_address = 0;
  g_last_fault_code = kFaultNone;
}

bool Fault(uint32_t address, uint32_t code) {
  g_last_fault_address = address;
  g_last_fault_code = code;
  return false;
}

bool IsPageAligned(uint32_t address) { return (address & kPageMask) == 0; }

bool PageRangeValid(uint32_t address, uint32_t page_count) {
  if (!page_count || !IsPageAligned(address)) return false;
  const uint64_t bytes = uint64_t(page_count) * kPageSize;
  return uint64_t(address) + bytes <= (uint64_t{1} << 32);
}

uint32_t ContentGeneration(uint32_t address) {
  const uint32_t page = address >> kPageShift;
  auto it = g_executable_content_generations.find(page);
  return it == g_executable_content_generations.end() ? 1u : it->second;
}

void BumpContentGeneration(uint32_t page) {
  auto [it, inserted] = g_executable_content_generations.emplace(page, 1u);
  ++it->second;
  if (it->second == 0) it->second = 1u;
}

Backing* GetBacking(uint32_t backing_id) {
  if (!backing_id || backing_id > g_backings.size()) return nullptr;
  return &g_backings[backing_id - 1u];
}

const Mapping* Resolve(uint32_t address, uint32_t required_protection,
                       uint32_t protection_fault) {
  auto it = g_pages.find(address >> kPageShift);
  if (it == g_pages.end()) {
    Fault(address, kFaultUnmapped);
    return nullptr;
  }
  if ((it->second.protection & required_protection) != required_protection) {
    Fault(address, protection_fault);
    return nullptr;
  }
  return &it->second;
}

uint8_t* ResolveBackingByte(const Mapping& mapping, uint32_t address) {
  Backing* backing = GetBacking(mapping.backing_id);
  if (!backing || mapping.backing_page >= backing->pages.size()) return nullptr;
  return &backing->pages[mapping.backing_page][address & kPageMask];
}

void InvalidateExecutableAliases(uint32_t backing_id, uint32_t backing_page) {
  const auto alias_key = std::make_pair(backing_id, backing_page);
  const auto count_it = g_executable_alias_counts.find(alias_key);
  if (count_it == g_executable_alias_counts.end() || !count_it->second) return;
  for (const auto& [virtual_page, mapping] : g_pages) {
    if (mapping.backing_id == backing_id &&
        mapping.backing_page == backing_page &&
        (mapping.protection & kGuestExecute)) {
      MarkWasmBackendExecutableContentChangedRange(
          virtual_page << kPageShift, kPageSize);
    }
  }
}

bool ValidateSpan(uint32_t address, uint32_t size, uint32_t protection,
                  uint32_t protection_fault) {
  if (!size) return true;
  const uint64_t end = uint64_t(address) + uint64_t(size) - 1u;
  if (end > UINT32_MAX) return Fault(address, kFaultInvalidArgument);
  uint32_t current = address;
  for (;;) {
    if (!Resolve(current, protection, protection_fault)) return false;
    const uint32_t page_end = (current | kPageMask);
    if (uint64_t(page_end) >= end) break;
    current = page_end + 1u;
  }
  return true;
}

}  // namespace

void MarkWasmBackendExecutableContentChangedRange(uint32_t address,
                                                  uint32_t size) {
  if (!size) return;
  const uint64_t end64 = uint64_t(address) + uint64_t(size) - 1u;
  const uint32_t end_address =
      end64 > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(end64);
  const uint32_t first_page = address >> kPageShift;
  const uint32_t last_page = end_address >> kPageShift;
  for (uint32_t page = first_page;; ++page) {
    BumpContentGeneration(page);
    if (page == last_page) break;
  }
  InvalidateWasmBackendExecutableRange(address, size);
}

uint32_t GetWasmBackendExecutableContentGeneration(uint32_t address) {
  return ContentGeneration(address);
}

void ResetSparseGuestMemory() {
  g_backings.clear();
  g_pages.clear();
  g_executable_alias_counts.clear();
  g_executable_content_generations.clear();
  ClearFault();
}

uint32_t AllocateSparseGuestBacking(uint32_t page_count) {
  ClearFault();
  if (!page_count) {
    Fault(0, kFaultInvalidArgument);
    return 0;
  }
  Backing backing;
  backing.pages.resize(page_count);
  for (auto& page : backing.pages) page.fill(0);
  g_backings.push_back(std::move(backing));
  return static_cast<uint32_t>(g_backings.size());
}

bool MapSparseGuestMemory(uint32_t virtual_address, uint32_t page_count,
                          uint32_t backing_id, uint32_t backing_page_offset,
                          uint32_t protection) {
  ClearFault();
  if (!PageRangeValid(virtual_address, page_count) ||
      (protection & ~kValidProtection)) {
    return Fault(virtual_address, kFaultInvalidArgument);
  }
  Backing* backing = GetBacking(backing_id);
  if (!backing || uint64_t(backing_page_offset) + page_count >
                      backing->pages.size()) {
    return Fault(virtual_address, kFaultInvalidArgument);
  }
  const uint32_t first_page = virtual_address >> kPageShift;
  for (uint32_t i = 0; i < page_count; ++i) {
    if (g_pages.find(first_page + i) != g_pages.end()) {
      return Fault((first_page + i) << kPageShift, kFaultAlreadyMapped);
    }
  }
  for (uint32_t i = 0; i < page_count; ++i) {
    const Mapping mapping{backing_id, backing_page_offset + i, protection};
    g_pages.emplace(first_page + i, mapping);
    if (protection & kGuestExecute) {
      ++g_executable_alias_counts[
          std::make_pair(mapping.backing_id, mapping.backing_page)];
    }
  }
  return true;
}

bool ProtectSparseGuestMemory(uint32_t virtual_address, uint32_t page_count,
                              uint32_t protection) {
  ClearFault();
  if (!PageRangeValid(virtual_address, page_count) ||
      (protection & ~kValidProtection)) {
    return Fault(virtual_address, kFaultInvalidArgument);
  }
  const uint32_t first_page = virtual_address >> kPageShift;
  for (uint32_t i = 0; i < page_count; ++i) {
    if (g_pages.find(first_page + i) == g_pages.end()) {
      return Fault((first_page + i) << kPageShift, kFaultUnmapped);
    }
  }
  for (uint32_t i = 0; i < page_count; ++i) {
    Mapping& mapping = g_pages[first_page + i];
    const bool was_executable = (mapping.protection & kGuestExecute) != 0;
    const bool now_executable = (protection & kGuestExecute) != 0;
    if (was_executable != now_executable) {
      const auto alias_key =
          std::make_pair(mapping.backing_id, mapping.backing_page);
      if (now_executable) {
        ++g_executable_alias_counts[alias_key];
      } else {
        auto alias_it = g_executable_alias_counts.find(alias_key);
        if (alias_it != g_executable_alias_counts.end()) {
          if (alias_it->second > 1) --alias_it->second;
          else g_executable_alias_counts.erase(alias_it);
        }
      }
    }
    mapping.protection = protection;
    if (was_executable != now_executable) {
      InvalidateWasmBackendExecutableRange((first_page + i) << kPageShift,
                                           kPageSize);
    }
  }
  return true;
}

bool UnmapSparseGuestMemory(uint32_t virtual_address, uint32_t page_count) {
  ClearFault();
  if (!PageRangeValid(virtual_address, page_count)) {
    return Fault(virtual_address, kFaultInvalidArgument);
  }
  const uint32_t first_page = virtual_address >> kPageShift;
  for (uint32_t i = 0; i < page_count; ++i) {
    if (g_pages.find(first_page + i) == g_pages.end()) {
      return Fault((first_page + i) << kPageShift, kFaultUnmapped);
    }
  }
  for (uint32_t i = 0; i < page_count; ++i) {
    auto it = g_pages.find(first_page + i);
    if (it->second.protection & kGuestExecute) {
      const auto alias_key =
          std::make_pair(it->second.backing_id, it->second.backing_page);
      auto alias_it = g_executable_alias_counts.find(alias_key);
      if (alias_it != g_executable_alias_counts.end()) {
        if (alias_it->second > 1) --alias_it->second;
        else g_executable_alias_counts.erase(alias_it);
      }
      InvalidateWasmBackendExecutableRange((first_page + i) << kPageShift,
                                           kPageSize);
    }
    g_pages.erase(it);
  }
  return true;
}

bool ReadSparseGuestMemory(uint32_t virtual_address, void* out, uint32_t size) {
  ClearFault();
  if (size && !out) return Fault(virtual_address, kFaultInvalidArgument);
  if (!ValidateSpan(virtual_address, size, kGuestRead, kFaultReadProtection)) {
    return false;
  }
  uint8_t* dst = static_cast<uint8_t*>(out);
  for (uint32_t i = 0; i < size; ++i) {
    const Mapping* mapping = Resolve(virtual_address + i, kGuestRead,
                                     kFaultReadProtection);
    uint8_t* byte = mapping ? ResolveBackingByte(*mapping, virtual_address + i)
                            : nullptr;
    if (!byte) return Fault(virtual_address + i, kFaultInvalidArgument);
    dst[i] = *byte;
  }
  return true;
}

bool WriteSparseGuestMemory(uint32_t virtual_address, const void* data,
                            uint32_t size) {
  ClearFault();
  if (size && !data) return Fault(virtual_address, kFaultInvalidArgument);
  if (!ValidateSpan(virtual_address, size, kGuestWrite, kFaultWriteProtection)) {
    return false;
  }
  const uint8_t* src = static_cast<const uint8_t*>(data);
  std::vector<std::pair<uint32_t, uint32_t>> touched_backing_pages;
  for (uint32_t i = 0; i < size; ++i) {
    const uint32_t address = virtual_address + i;
    const Mapping* mapping = Resolve(address, kGuestWrite, kFaultWriteProtection);
    uint8_t* byte = mapping ? ResolveBackingByte(*mapping, address) : nullptr;
    if (!byte) return Fault(address, kFaultInvalidArgument);
    *byte = src[i];
    const std::pair<uint32_t, uint32_t> key{mapping->backing_id,
                                            mapping->backing_page};
    bool seen = false;
    for (const auto& existing : touched_backing_pages) {
      if (existing == key) {
        seen = true;
        break;
      }
    }
    if (!seen) touched_backing_pages.push_back(key);
  }
  for (const auto& [backing_id, backing_page] : touched_backing_pages) {
    InvalidateExecutableAliases(backing_id, backing_page);
  }
  return true;
}

uint32_t SparseGuestExecutableSpan(uint32_t virtual_address,
                                   uint32_t max_size) {
  if (!max_size) return 0;
  const uint64_t end64 = uint64_t(virtual_address) + uint64_t(max_size);
  const uint64_t end = end64 > (uint64_t{1} << 32)
                           ? (uint64_t{1} << 32)
                           : end64;
  uint64_t current = virtual_address;
  while (current < end) {
    const auto it = g_pages.find(static_cast<uint32_t>(current) >> kPageShift);
    if (it == g_pages.end() ||
        (it->second.protection & (kGuestRead | kGuestExecute)) !=
            (kGuestRead | kGuestExecute)) {
      break;
    }
    const uint64_t page_end = (current | uint64_t(kPageMask)) + 1u;
    current = page_end < end ? page_end : end;
  }
  return static_cast<uint32_t>(current - uint64_t(virtual_address));
}

uint32_t SparseGuestMappedPageCount() {
  return static_cast<uint32_t>(g_pages.size());
}

uint32_t SparseGuestBackingPageCount() {
  uint64_t total = 0;
  for (const auto& backing : g_backings) total += backing.pages.size();
  return total > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(total);
}

uint32_t SparseGuestLastFaultAddress() { return g_last_fault_address; }
uint32_t SparseGuestLastFaultCode() { return g_last_fault_code; }

}  // namespace render360::xenia_web

extern "C" {
void r360_sparse_guest_memory_reset() {
  render360::xenia_web::ResetSparseGuestMemory();
}
uint32_t r360_sparse_guest_memory_alloc(uint32_t page_count) {
  return render360::xenia_web::AllocateSparseGuestBacking(page_count);
}
uint32_t r360_sparse_guest_memory_map(uint32_t virtual_address,
                                      uint32_t page_count,
                                      uint32_t backing_id,
                                      uint32_t backing_page_offset,
                                      uint32_t protection) {
  return render360::xenia_web::MapSparseGuestMemory(
             virtual_address, page_count, backing_id, backing_page_offset,
             protection)
             ? 1u
             : 0u;
}
uint32_t r360_sparse_guest_memory_protect(uint32_t virtual_address,
                                          uint32_t page_count,
                                          uint32_t protection) {
  return render360::xenia_web::ProtectSparseGuestMemory(
             virtual_address, page_count, protection)
             ? 1u
             : 0u;
}
uint32_t r360_sparse_guest_memory_unmap(uint32_t virtual_address,
                                        uint32_t page_count) {
  return render360::xenia_web::UnmapSparseGuestMemory(virtual_address,
                                                       page_count)
             ? 1u
             : 0u;
}
uint32_t r360_sparse_guest_memory_read_u8(uint32_t virtual_address) {
  uint8_t value = 0;
  if (!render360::xenia_web::ReadSparseGuestMemory(virtual_address, &value, 1)) {
    return 0;
  }
  return value;
}
uint32_t r360_sparse_guest_memory_write_u8(uint32_t virtual_address,
                                           uint32_t value) {
  const uint8_t byte = static_cast<uint8_t>(value);
  return render360::xenia_web::WriteSparseGuestMemory(virtual_address, &byte, 1)
             ? 1u
             : 0u;
}
uint32_t r360_sparse_guest_memory_read_u32_be(uint32_t virtual_address,
                                              uint32_t* out_value) {
  uint8_t bytes[4] = {};
  if (!out_value || !render360::xenia_web::ReadSparseGuestMemory(
                        virtual_address, bytes, sizeof(bytes))) {
    return 0u;
  }
  *out_value = (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) |
               (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);
  return 1u;
}
uint32_t r360_sparse_guest_memory_write_u32_be(uint32_t virtual_address,
                                               uint32_t value) {
  const uint8_t bytes[4] = {static_cast<uint8_t>(value >> 24),
                            static_cast<uint8_t>(value >> 16),
                            static_cast<uint8_t>(value >> 8),
                            static_cast<uint8_t>(value)};
  return render360::xenia_web::WriteSparseGuestMemory(virtual_address, bytes,
                                                       sizeof(bytes))
             ? 1u
             : 0u;
}
uint32_t r360_sparse_guest_memory_mapped_pages() {
  return render360::xenia_web::SparseGuestMappedPageCount();
}
uint32_t r360_sparse_guest_memory_backing_pages() {
  return render360::xenia_web::SparseGuestBackingPageCount();
}
uint32_t r360_sparse_guest_memory_last_fault_address() {
  return render360::xenia_web::SparseGuestLastFaultAddress();
}
uint32_t r360_sparse_guest_memory_last_fault_code() {
  return render360::xenia_web::SparseGuestLastFaultCode();
}
uint32_t r360_wasm_backend_executable_content_generation(uint32_t address) {
  return render360::xenia_web::GetWasmBackendExecutableContentGeneration(address);
}
void r360_wasm_backend_mark_executable_content_changed_range(uint32_t address,
                                                             uint32_t size) {
  render360::xenia_web::MarkWasmBackendExecutableContentChangedRange(address,
                                                                     size);
}
}
