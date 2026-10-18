#include "sparse_guest_memory.h"

#include <cstddef>

#include <array>
#include <cstdint>
#include <cstring>
#include <map>
#include <set>
#include <vector>

#include "wasm_backend_call_probe.h"
#include <cstdio>

extern "C" __attribute__((weak)) uint32_t r360_debug_watch_address() { return 0; }
extern "C" __attribute__((weak)) uint32_t r360_guest_thread_current() { return 0; }
extern "C" __attribute__((weak)) uint32_t r360_hir_last_source() { return 0; }

#if defined(R360_NATIVE) && defined(__APPLE__)
#include <mach/mach.h>
#include <sys/mman.h>
#define R360_FLAT_GUEST_MEMORY 1
#endif

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

#if defined(R360_FLAT_GUEST_MEMORY)
// Native flat guest memory (Xenia's Memory layout, as XeniOS on 16 KiB-page
// Apple hosts): the 4 GiB guest space plus 0x1000 is one reservation at
// g_flat_base; 0x00000000-0x9FFFFFFF is plain host memory and the three
// physical views 0xA0000000 / 0xC0000000 / 0xE0000000 map one 512 MiB
// physical object. The E0 view's 4 KiB physical offset is applied on the CPU
// side (Xenia's host_address_offset): guest E0000000+x lives at host
// base + E0000000 + x + 0x1000. Every guest page then has a fixed host
// address (base + address [+ 0x1000]), which statically recompiled code
// (XenonRecomp: base + address) needs. Page table, protection and watches
// are unchanged.
uint8_t* g_flat_base = nullptr;
constexpr uint64_t kFlatReserve = 0x100000000ull + 0x10000ull;
constexpr uint64_t kPhysicalSize = 0x20000000ull;

inline uint8_t* FlatHost(uint32_t address) {
  return g_flat_base + address + (address >= 0xE0000000u ? 0x1000u : 0u);
}

bool MapPhysicalView(mach_port_t entry, uint64_t guest) {
  // vm_map (mach_vm_map is not in the iOS SDK; addresses are 64-bit on arm64).
  vm_address_t at = vm_address_t(g_flat_base + guest);
  const kern_return_t kr = vm_map(mach_task_self(), &at, vm_size_t(kPhysicalSize), 0, VM_FLAGS_FIXED | VM_FLAGS_OVERWRITE,
                                       entry, 0, FALSE, VM_PROT_READ | VM_PROT_WRITE, VM_PROT_READ | VM_PROT_WRITE,
                                       VM_INHERIT_NONE);
  if (kr != KERN_SUCCESS) std::fprintf(stderr, "R360_FLAT_MEMORY view 0x%llX: mach_vm_map %d\n", (unsigned long long)guest, kr);
  return kr == KERN_SUCCESS;
}

// (Re)creates the layout: fresh zeroed memory everywhere.
bool CreateFlatGuestMemory() {
  if (g_flat_base) munmap(g_flat_base, kFlatReserve);
  g_flat_base = nullptr;
  void* base = mmap(nullptr, kFlatReserve, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (base == MAP_FAILED) {
    std::fprintf(stderr, "R360_FLAT_MEMORY reserve failed\n");
    return false;
  }
  g_flat_base = static_cast<uint8_t*>(base);
  // One named (shareable) memory object for the 512 MiB of physical memory.
  memory_object_size_t size = kPhysicalSize;
  mach_port_t entry = MACH_PORT_NULL;
  const kern_return_t kr = mach_make_memory_entry_64(mach_task_self(), &size, 0,
                                                     MAP_MEM_NAMED_CREATE | VM_PROT_READ | VM_PROT_WRITE, &entry,
                                                     MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    std::fprintf(stderr, "R360_FLAT_MEMORY physical object: %d\n", kr);
    return false;
  }
  const bool ok = MapPhysicalView(entry, 0xA0000000ull) && MapPhysicalView(entry, 0xC0000000ull) &&
                  MapPhysicalView(entry, 0xE0000000ull);
  mach_port_deallocate(mach_task_self(), entry);  // the views keep the object
  if (!ok) std::fprintf(stderr, "R360_FLAT_MEMORY failed to map the physical views\n");
  return ok;
}

// Zeroes guest pages that are no longer mapped (fresh backings start zeroed).
void ZeroFlatPages(uint32_t address, uint32_t page_count) {
  if (!g_flat_base) return;
  std::memset(FlatHost(address), 0, size_t(page_count) * kPageSize);
}
#endif

struct Backing {
  // Browser build: the backing's own pages. Native flat build: unused (every
  // guest page has its fixed host address), only page_count matters.
  std::vector<std::array<uint8_t, kPageSize>> pages;
  uint32_t page_count = 0;
  // Number of executable virtual aliases of each backing page. Sized once at
  // allocation so page-table entries can hold stable pointers into it.
  std::vector<uint32_t> executable_aliases;
  // GPU shared-memory watch (Xenia SharedMemory invalidation): bumped by the
  // first guest write after SparseGuestGpuWatch armed the page.
  std::vector<uint32_t> gpu_generation;
};
// Bit 31 of a backing page's alias word arms the GPU write watch. Generated
// code takes the helper path for any store to a page whose word is non-zero,
// so a watched page costs one slow store, as a Xenia write-watch fault does.
constexpr uint32_t kGpuWatchBit = 0x80000000u;

// One guest virtual page. `host` is null for unmapped pages. Every emulated
// load/store resolves through this entry, so it holds the host byte pointer
// directly (as Xenia's host-mapped membase does) instead of re-deriving it.
struct PageEntry {
  uint8_t* host = nullptr;
  uint32_t* executable_aliases = nullptr;
  uint32_t backing_id = 0;
  uint32_t backing_page = 0;
  uint32_t protection = 0;
};

// Two-level page table over the 32-bit guest address space: 1024 directory
// slots, each covering 4 MiB with a lazily allocated 1024-entry table. Lookup
// is two indexed loads, replacing an ordered-map search per guest byte. The
// directory is constant-initialized (the standalone module never runs global
// constructors).
constexpr uint32_t kTableBits = 10;
constexpr uint32_t kTableEntries = 1u << kTableBits;
constexpr uint32_t kDirectoryShift = kPageShift + kTableBits;
constexpr uint32_t kDirectoryEntries = 1u << (32u - kDirectoryShift);

std::vector<Backing> g_backings;
std::array<PageEntry*, kDirectoryEntries> g_page_directory{};
// Generated guest code (hir_wasm_jit.cpp) walks this table inline. The
// native build has no wasm JIT and 64-bit host pointers.
#if !defined(R360_NATIVE)
static_assert(sizeof(PageEntry) == 20 && offsetof(PageEntry, host) == 0 &&
                  offsetof(PageEntry, executable_aliases) == 4 &&
                  offsetof(PageEntry, protection) == 16,
              "guest JIT inline page walk layout");
#endif
uint32_t g_mapped_pages = 0;
// Executable virtual pages aliasing each physical sparse backing page. Guest
// RAM writes are extremely hot; they check the per-page alias count and only
// consult this index when a written page is also mapped executable.
std::map<std::pair<uint32_t, uint32_t>, std::set<uint32_t>> g_executable_aliases;
// This is the authoritative executable-byte content generation. It is sparse
// across the full 32-bit Xbox virtual address space and is intentionally
// independent of permission/mapping invalidation and the legacy backend epoch.
// Two-level table (same split as g_page_directory): translation-cache lookups
// read two generations per guest call, so this must be a couple of loads.
// A zero entry means the default generation 1.
std::array<uint32_t*, kDirectoryEntries> g_executable_content_generations{};
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
  const uint32_t* table = g_executable_content_generations[page >> kTableBits];
  if (!table) return 1u;
  const uint32_t generation = table[page & (kTableEntries - 1u)];
  return generation ? generation : 1u;
}

// Bumped with every content generation change (and on reset), so a cache of
// generation checks can tell nothing has been rewritten.
uint32_t g_executable_content_epoch = 1;

void BumpContentGeneration(uint32_t page) {
  ++g_executable_content_epoch;
  uint32_t*& table = g_executable_content_generations[page >> kTableBits];
  if (!table) table = new uint32_t[kTableEntries]();
  uint32_t& generation = table[page & (kTableEntries - 1u)];
  generation = (generation ? generation : 1u) + 1u;
  if (generation == 0) generation = 1u;
}

Backing* GetBacking(uint32_t backing_id) {
  if (!backing_id || backing_id > g_backings.size()) return nullptr;
  return &g_backings[backing_id - 1u];
}

inline PageEntry* LookupPage(uint32_t page) {
  PageEntry* table = g_page_directory[page >> kTableBits];
  if (!table) return nullptr;
  PageEntry* entry = &table[page & (kTableEntries - 1u)];
  return entry->host ? entry : nullptr;
}

PageEntry* EnsurePageSlot(uint32_t page) {
  PageEntry*& table = g_page_directory[page >> kTableBits];
  if (!table) table = new PageEntry[kTableEntries]();
  return &table[page & (kTableEntries - 1u)];
}

void AddExecutableAlias(const PageEntry& entry, uint32_t virtual_page) {
  ++*entry.executable_aliases;  // count in bits 0..30
  g_executable_aliases[std::make_pair(entry.backing_id, entry.backing_page)]
      .insert(virtual_page);
}

void RemoveExecutableAlias(const PageEntry& entry, uint32_t virtual_page) {
  if (*entry.executable_aliases & ~kGpuWatchBit) --*entry.executable_aliases;
  auto it = g_executable_aliases.find(
      std::make_pair(entry.backing_id, entry.backing_page));
  if (it == g_executable_aliases.end()) return;
  it->second.erase(virtual_page);
  if (it->second.empty()) g_executable_aliases.erase(it);
}

void GpuWatchHit(const PageEntry& entry) {
  *entry.executable_aliases &= ~kGpuWatchBit;
  if (Backing* backing = GetBacking(entry.backing_id)) {
    uint32_t& generation = backing->gpu_generation[entry.backing_page];
    if (++generation == 0) generation = 1;
  }
}

void InvalidateExecutableAliases(uint32_t backing_id, uint32_t backing_page) {
  const auto it =
      g_executable_aliases.find(std::make_pair(backing_id, backing_page));
  if (it == g_executable_aliases.end()) return;
  // Copy: invalidation callbacks must not observe a set being iterated.
  const std::vector<uint32_t> pages(it->second.begin(), it->second.end());
  for (const uint32_t virtual_page : pages) {
    MarkWasmBackendExecutableContentChangedRange(virtual_page << kPageShift,
                                                 kPageSize);
  }
}

// Validates [address, address + size) page by page, faulting at the first
// unmapped/protected page (at `address` for the first page, otherwise at the
// page base), exactly as the byte-granular implementation reported.
bool ValidateSpan(uint32_t address, uint32_t size, uint32_t protection,
                  uint32_t protection_fault) {
  if (!size) return true;
  const uint64_t end = uint64_t(address) + uint64_t(size) - 1u;
  if (end > UINT32_MAX) return Fault(address, kFaultInvalidArgument);
  uint32_t current = address;
  for (;;) {
    const PageEntry* entry = LookupPage(current >> kPageShift);
    if (!entry) return Fault(current, kFaultUnmapped);
    if ((entry->protection & protection) != protection) {
      return Fault(current, protection_fault);
    }
    const uint32_t page_end = (current | kPageMask);
    if (uint64_t(page_end) >= end) break;
    current = page_end + 1u;
  }
  return true;
}

}  // namespace

uint32_t SparseGuestGpuWatch(uint32_t virtual_address) {
  const PageEntry* entry = LookupPage(virtual_address >> kPageShift);
  if (!entry) return 0;
  *entry->executable_aliases |= kGpuWatchBit;
  const Backing* backing = GetBacking(entry->backing_id);
  return backing ? backing->gpu_generation[entry->backing_page] : 0u;
}

uint32_t SparseGuestGpuGeneration(uint32_t virtual_address) {
  const PageEntry* entry = LookupPage(virtual_address >> kPageShift);
  if (!entry) return 0;
  const Backing* backing = GetBacking(entry->backing_id);
  return backing ? backing->gpu_generation[entry->backing_page] : 0u;
}

const uint8_t* SparseGuestPageHost(uint32_t virtual_address) {
  const PageEntry* entry = LookupPage(virtual_address >> kPageShift);
  return entry ? entry->host : nullptr;
}

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

uint32_t GetWasmBackendExecutableContentEpoch() { return g_executable_content_epoch; }
uint32_t GetWasmBackendExecutableContentGeneration(uint32_t address) {
  return ContentGeneration(address);
}

void ResetSparseGuestMemory() {
  ++g_executable_content_epoch;
  for (PageEntry*& table : g_page_directory) {
    delete[] table;
    table = nullptr;
  }
  g_mapped_pages = 0;
  g_backings.clear();
#if defined(R360_FLAT_GUEST_MEMORY)
  if (g_flat_base) CreateFlatGuestMemory();
#endif
  g_executable_aliases.clear();
  for (uint32_t*& table : g_executable_content_generations) {
    delete[] table;
    table = nullptr;
  }
  ClearFault();
}

uint32_t AllocateSparseGuestBacking(uint32_t page_count) {
  ClearFault();
  if (!page_count) {
    Fault(0, kFaultInvalidArgument);
    return 0;
  }
  Backing backing;
  backing.page_count = page_count;
#if defined(R360_FLAT_GUEST_MEMORY)
  if (!g_flat_base && !CreateFlatGuestMemory()) {
    Fault(0, kFaultInvalidArgument);
    return 0;
  }
#else
  // resize() value-initializes: every page starts zero-filled.
  backing.pages.resize(page_count);
#endif
  backing.executable_aliases.resize(page_count);
  backing.gpu_generation.assign(page_count, 1u);
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
                      backing->page_count) {
    return Fault(virtual_address, kFaultInvalidArgument);
  }
  const uint32_t first_page = virtual_address >> kPageShift;
  for (uint32_t i = 0; i < page_count; ++i) {
    if (LookupPage(first_page + i)) {
      return Fault((first_page + i) << kPageShift, kFaultAlreadyMapped);
    }
  }
  for (uint32_t i = 0; i < page_count; ++i) {
    const uint32_t backing_page = backing_page_offset + i;
    PageEntry* entry = EnsurePageSlot(first_page + i);
#if defined(R360_FLAT_GUEST_MEMORY)
    entry->host = FlatHost((first_page + i) << kPageShift);
    // A fresh backing reads zeros: clear plain memory and the first (A0)
    // physical view; the C0 / E0 views of the same pages alias it.
    if (((first_page + i) << kPageShift) < 0xC0000000u) std::memset(entry->host, 0, kPageSize);
#else
    entry->host = backing->pages[backing_page].data();
#endif
    entry->executable_aliases = &backing->executable_aliases[backing_page];
    entry->backing_id = backing_id;
    entry->backing_page = backing_page;
    entry->protection = protection;
    ++g_mapped_pages;
    if (protection & kGuestExecute) AddExecutableAlias(*entry, first_page + i);
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
    if (!LookupPage(first_page + i)) {
      return Fault((first_page + i) << kPageShift, kFaultUnmapped);
    }
  }
  for (uint32_t i = 0; i < page_count; ++i) {
    PageEntry& entry = *LookupPage(first_page + i);
    const bool was_executable = (entry.protection & kGuestExecute) != 0;
    const bool now_executable = (protection & kGuestExecute) != 0;
    if (was_executable != now_executable) {
      if (now_executable) AddExecutableAlias(entry, first_page + i);
      else RemoveExecutableAlias(entry, first_page + i);
    }
    entry.protection = protection;
    if (was_executable != now_executable) {
      InvalidateWasmBackendExecutableRange((first_page + i) << kPageShift,
                                           kPageSize);
    }
  }
  return true;
}

bool SparseGuestMemoryPageMapped(uint32_t virtual_address) {
  return LookupPage(virtual_address >> kPageShift) != nullptr;
}

bool SparseGuestMemoryPageProtection(uint32_t virtual_address,
                                     uint32_t* protection) {
  const PageEntry* entry = LookupPage(virtual_address >> kPageShift);
  if (!entry) return false;
  if (protection) *protection = entry->protection;
  return true;
}

bool UnmapSparseGuestMemory(uint32_t virtual_address, uint32_t page_count) {
  ClearFault();
  if (!PageRangeValid(virtual_address, page_count)) {
    return Fault(virtual_address, kFaultInvalidArgument);
  }
  const uint32_t first_page = virtual_address >> kPageShift;
  for (uint32_t i = 0; i < page_count; ++i) {
    if (!LookupPage(first_page + i)) {
      return Fault((first_page + i) << kPageShift, kFaultUnmapped);
    }
  }
  for (uint32_t i = 0; i < page_count; ++i) {
    PageEntry& entry = *LookupPage(first_page + i);
    if (entry.protection & kGuestExecute) {
      RemoveExecutableAlias(entry, first_page + i);
      InvalidateWasmBackendExecutableRange((first_page + i) << kPageShift,
                                           kPageSize);
    }
#if defined(R360_FLAT_GUEST_MEMORY)
    // Physical views alias: only plain virtual memory is cleared on unmap
    // (the next allocation there must read zeros).
    if (((first_page + i) << kPageShift) < 0xA0000000u) ZeroFlatPages((first_page + i) << kPageShift, 1);
#endif
    entry = PageEntry{};
    --g_mapped_pages;
  }
  return true;
}

bool ReadSparseGuestMemory(uint32_t virtual_address, void* out, uint32_t size) {
  ClearFault();
  if (!size) return true;
  if (!out) return Fault(virtual_address, kFaultInvalidArgument);
  const uint32_t offset = virtual_address & kPageMask;
  if (size <= kPageSize - offset) {
    // Single-page access: the common case for every emulated load.
    const PageEntry* entry = LookupPage(virtual_address >> kPageShift);
    if (!entry) return Fault(virtual_address, kFaultUnmapped);
    if (!(entry->protection & kGuestRead)) {
      return Fault(virtual_address, kFaultReadProtection);
    }
    std::memcpy(out, entry->host + offset, size);
    return true;
  }
  if (!ValidateSpan(virtual_address, size, kGuestRead, kFaultReadProtection)) {
    return false;
  }
  uint8_t* dst = static_cast<uint8_t*>(out);
  uint32_t address = virtual_address;
  uint32_t remaining = size;
  while (remaining) {
    const uint32_t page_offset = address & kPageMask;
    const uint32_t chunk = remaining < kPageSize - page_offset
                               ? remaining
                               : kPageSize - page_offset;
    std::memcpy(dst, LookupPage(address >> kPageShift)->host + page_offset,
                chunk);
    dst += chunk;
    address += chunk;
    remaining -= chunk;
  }
  return true;
}

bool WriteSparseGuestMemory(uint32_t virtual_address, const void* data,
                            uint32_t size) {
  ClearFault();
  if (!size) return true;
  if (!data) return Fault(virtual_address, kFaultInvalidArgument);
  if (const uint32_t watch = r360_debug_watch_address()) {
    // Matches any alias of the watched byte's backing page (views of
    // physical memory), not only the watched virtual address.
    const PageEntry* watched = LookupPage(watch >> kPageShift);
    const PageEntry* written = LookupPage(virtual_address >> kPageShift);
    const bool same_page = watched && written && watched->backing_id == written->backing_id &&
                           watched->backing_page == written->backing_page;
    const uint32_t alias = same_page ? (virtual_address & ~kPageMask) | (watch & kPageMask) : watch;
    if (alias - virtual_address < size) {
      uint32_t v = 0;
      std::memcpy(&v, data, size < 4 ? size : 4);
      std::fprintf(stderr, "R360_WATCH sparse address=0x%08X size=%u bytes=0x%08X thread=0x%08X pc=0x%08X\n",
                   virtual_address, size, __builtin_bswap32(v), r360_guest_thread_current(), r360_hir_last_source());
    }
  }
  const uint32_t offset = virtual_address & kPageMask;
  if (size <= kPageSize - offset) {
    // Single-page access: the common case for every emulated store.
    const PageEntry* entry = LookupPage(virtual_address >> kPageShift);
    if (!entry) return Fault(virtual_address, kFaultUnmapped);
    if (!(entry->protection & kGuestWrite)) {
      return Fault(virtual_address, kFaultWriteProtection);
    }
    std::memcpy(entry->host + offset, data, size);
    if (const uint32_t aliases = *entry->executable_aliases) {
      if (aliases & kGpuWatchBit) GpuWatchHit(*entry);
      if (aliases & ~kGpuWatchBit) {
        InvalidateExecutableAliases(entry->backing_id, entry->backing_page);
      }
    }
    return true;
  }
  if (!ValidateSpan(virtual_address, size, kGuestWrite, kFaultWriteProtection)) {
    return false;
  }
  const uint8_t* src = static_cast<const uint8_t*>(data);
  std::vector<std::pair<uint32_t, uint32_t>> touched_executable;
  uint32_t address = virtual_address;
  uint32_t remaining = size;
  while (remaining) {
    const uint32_t page_offset = address & kPageMask;
    const uint32_t chunk = remaining < kPageSize - page_offset
                               ? remaining
                               : kPageSize - page_offset;
    const PageEntry* entry = LookupPage(address >> kPageShift);
    std::memcpy(entry->host + page_offset, src, chunk);
    if (*entry->executable_aliases & kGpuWatchBit) GpuWatchHit(*entry);
    if (*entry->executable_aliases & ~kGpuWatchBit) {
      const std::pair<uint32_t, uint32_t> key{entry->backing_id,
                                              entry->backing_page};
      bool seen = false;
      for (const auto& existing : touched_executable) {
        if (existing == key) {
          seen = true;
          break;
        }
      }
      if (!seen) touched_executable.push_back(key);
    }
    src += chunk;
    address += chunk;
    remaining -= chunk;
  }
  for (const auto& [backing_id, backing_page] : touched_executable) {
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
    const PageEntry* entry =
        LookupPage(static_cast<uint32_t>(current) >> kPageShift);
    if (!entry || (entry->protection & (kGuestRead | kGuestExecute)) !=
                      (kGuestRead | kGuestExecute)) {
      break;
    }
    const uint64_t page_end = (current | uint64_t(kPageMask)) + 1u;
    current = page_end < end ? page_end : end;
  }
  return static_cast<uint32_t>(current - uint64_t(virtual_address));
}

uint32_t SparseGuestMappedPageCount() { return g_mapped_pages; }

uint32_t SparseGuestBackingPageCount() {
  uint64_t total = 0;
  for (const auto& backing : g_backings) total += backing.page_count;
  return total > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(total);
}

uint32_t SparseGuestLastFaultAddress() { return g_last_fault_address; }
uint32_t SparseGuestLastFaultCode() { return g_last_fault_code; }

}  // namespace render360::xenia_web

namespace {
uint32_t g_generated_guest_load_status = 0;

uint64_t GeneratedGuestLoadScalar(uint32_t virtual_address, uint32_t size,
                                  uint32_t flags) {
  g_generated_guest_load_status = 0;
  if ((flags & ~1u) != 0 ||
      (size != 1u && size != 2u && size != 4u && size != 8u)) {
    return 0;
  }
  uint64_t value = 0;
  if (!render360::xenia_web::ReadSparseGuestMemory(virtual_address, &value,
                                                    size)) {
    return 0;
  }
  if ((flags & 1u) && size > 1u) {
    uint64_t swapped = 0;
    for (uint32_t i = 0; i < size; ++i) {
      swapped |= ((value >> (i * 8u)) & 0xFFu)
                 << ((size - 1u - i) * 8u);
    }
    value = swapped;
  }
  g_generated_guest_load_status = 1;
  return value;
}
}  // namespace

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
uint64_t r360_generated_guest_load_scalar(uint32_t virtual_address,
                                           uint32_t size, uint32_t flags) {
  return GeneratedGuestLoadScalar(virtual_address, size, flags);
}
uint32_t r360_generated_guest_load_status() {
  return g_generated_guest_load_status;
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

namespace render360::xenia_web {
// Address of the two-level guest page directory (1024 PageEntry* slots, each
// table 1024 x 20-byte entries: host, executable_aliases, backing id/page,
// protection), for the guest JIT's inline loads and stores.
#if defined(R360_FLAT_GUEST_MEMORY)
uint8_t* SparseGuestFlatBase() { return g_flat_base; }
#else
uint8_t* SparseGuestFlatBase() { return nullptr; }
#endif
uint32_t SparseGuestPageDirectoryAddress() {
  return uint32_t(reinterpret_cast<uintptr_t>(g_page_directory.data()));
}
}  // namespace render360::xenia_web

extern "C" uintptr_t r360_flat_guest_base() {
  return reinterpret_cast<uintptr_t>(render360::xenia_web::SparseGuestFlatBase());
}
