#include <array>
#include <cstdint>

#include "sparse_guest_memory.h"

#if defined(__wasm__)
#define R360_WASM_EXPORT(name) __attribute__((used, export_name(name)))
#else
#define R360_WASM_EXPORT(name)
#endif

namespace render360::xenia_web {
namespace {

constexpr uint32_t kModuleXboxkrnl = 1;
constexpr uint32_t kModuleXam = 2;
constexpr uint32_t kStatusIdle = 0;
constexpr uint32_t kStatusSuccess = 1;
constexpr uint32_t kStatusUnsupported = 2;
constexpr uint32_t kStatusInvalid = 3;
constexpr uint32_t kTlsOutOfIndexes = 0xFFFFFFFFu;
constexpr uint32_t kMaxThreads = 32;
constexpr uint32_t kMaxTlsSlots = 64;
constexpr uint32_t kMaxVirtualAllocations = 128;
constexpr uint32_t kGuestTickFrequency = 50000000u;
constexpr uint32_t kGuestPageSize = 4096u;
constexpr uint32_t kGuestLargePageSize = 65536u;
// Match Xenia's guest virtual-memory split while keeping automatic allocations
// away from Render360's PCR/TLS and browser thread-stack arenas. The normal
// 4 KiB virtual heap occupies the low 1 GiB. Large-page allocations start in
// Xenia's 0x40000000 64 KiB virtual range, capped below the 0x50000000 PCR.
constexpr uint32_t kGuestVirtual4kBase = 0x10000000u;
constexpr uint32_t kGuestVirtual4kEnd = 0x40000000u;
constexpr uint32_t kGuestVirtual64kBase = 0x40000000u;
constexpr uint32_t kGuestVirtual64kEnd = 0x50000000u;
constexpr uint32_t kXMemCommit = 0x00001000u;
constexpr uint32_t kXMemReserve = 0x00002000u;
constexpr uint32_t kXMemDecommit = 0x00004000u;
constexpr uint32_t kXMemRelease = 0x00008000u;
constexpr uint32_t kXMemReset = 0x00080000u;
constexpr uint32_t kXMemTopDown = 0x00100000u;
constexpr uint32_t kXMemNoZero = 0x00800000u;
constexpr uint32_t kXMemLargePages = 0x20000000u;
constexpr uint32_t kXStatusSuccess = 0x00000000u;
constexpr uint32_t kXStatusUnsuccessful = 0xC0000001u;
constexpr uint32_t kXStatusInvalidParameter = 0xC000000Du;
constexpr uint32_t kXStatusNoMemory = 0xC0000017u;
constexpr uint32_t kXStatusMemoryNotAllocated = 0xC00000A0u;
// Browser guest stacks live in a dedicated 512 MiB sparse virtual arena below
// the normal 0x82000000 retail XEX image region. Each thread owns a 16 MiB
// slot, with the first page intentionally left unmapped as a downward-growing
// stack guard. Mapping is fail-closed: if a title already occupies a slot,
// thread creation fails rather than overwriting guest memory.
constexpr uint32_t kGuestStackArenaBase = 0x60000000u;
constexpr uint32_t kGuestStackSlotStride = 0x01000000u;
constexpr uint32_t kGuestStackGuardBytes = kGuestPageSize;
constexpr uint32_t kGuestStackDefaultBytes = 0x00040000u;  // 256 KiB.
constexpr uint32_t kGuestStackTopReserve = 0x100u;
constexpr uint32_t kBrowserMainThreadReservedSlot = 16u;
constexpr uint32_t kGuestStackMaxBytes =
    kGuestStackSlotStride - 2u * kGuestStackGuardBytes;

enum ThreadState : uint32_t {
  kThreadInvalid = 0,
  kThreadReady = 1,
  kThreadRunning = 2,
  kThreadSuspended = 3,
  kThreadTerminated = 4,
};

struct GuestThread {
  bool used = false;
  bool stack_mapped = false;
  uint16_t generation = 0;
  ThreadState state = kThreadInvalid;
  uint32_t entry = 0;
  uint32_t context = 0;
  uint32_t stack_size = 0;
  uint32_t stack_base = 0;
  uint32_t stack_top = 0;
  uint32_t flags = 0;
  uint32_t suspend_count = 0;
  uint32_t exit_code = 0;
  std::array<uint32_t, kMaxTlsSlots> tls{};
};

struct GuestVirtualAllocation {
  bool used = false;
  bool committed = false;
  uint32_t base = 0;
  uint32_t size = 0;
  uint32_t page_size = kGuestPageSize;
  uint32_t protection = 0;
};

std::array<GuestThread, kMaxThreads> g_threads{};
std::array<bool, kMaxTlsSlots> g_tls_allocated{};
std::array<GuestVirtualAllocation, kMaxVirtualAllocations> g_virtual_allocations{};
uint32_t g_virtual_4k_bottom = kGuestVirtual4kBase;
uint32_t g_virtual_4k_top = kGuestVirtual4kEnd;
uint32_t g_virtual_64k_bottom = kGuestVirtual64kBase;
uint32_t g_virtual_64k_top = kGuestVirtual64kEnd;
uint32_t g_current_thread = 0;
uint32_t g_scheduler_cursor = 0;
uint32_t g_runtime_status = kStatusIdle;
uint32_t g_service_status = kStatusIdle;
uint32_t g_service_calls = 0;
uint32_t g_last_module = 0;
uint32_t g_last_ordinal = 0;
uint32_t g_next_notify_handle = 0x37000001u;

uint32_t MakeHandle(uint32_t index, uint16_t generation) {
  return 0x36000000u | (uint32_t(generation) << 8) | (index + 1u);
}

bool DecodeHandle(uint32_t handle, uint32_t* index_out) {
  if ((handle & 0xFF000000u) != 0x36000000u) return false;
  const uint32_t low = handle & 0xFFu;
  if (low == 0 || low > kMaxThreads) return false;
  const uint32_t index = low - 1u;
  const uint16_t generation = uint16_t((handle >> 8) & 0xFFFFu);
  const auto& thread = g_threads[index];
  if (!thread.used || thread.generation != generation) return false;
  if (index_out) *index_out = index;
  return true;
}

GuestThread* LookupThread(uint32_t handle, bool allow_terminated = false) {
  uint32_t index = 0;
  if (!DecodeHandle(handle, &index)) return nullptr;
  auto& thread = g_threads[index];
  if (!allow_terminated && thread.state == kThreadTerminated) return nullptr;
  return &thread;
}

uint32_t ThreadHandleByIndex(uint32_t index) {
  if (index >= kMaxThreads || !g_threads[index].used) return 0;
  return MakeHandle(index, g_threads[index].generation);
}

void ReleaseThreadStack(GuestThread& thread) {
  if (thread.stack_mapped && thread.stack_base && thread.stack_size) {
    const uint32_t pages = thread.stack_size / kGuestPageSize;
    // Sparse memory may already have been reset independently. An absent old
    // mapping is harmless here; a subsequent allocation/map clears that fault.
    UnmapSparseGuestMemory(thread.stack_base, pages);
  }
  thread.stack_mapped = false;
}

bool AllocateThreadStack(uint32_t thread_index, uint32_t stack_size,
                         uint32_t* stack_base_out,
                         uint32_t* stack_top_out) {
  if (thread_index >= kMaxThreads || !stack_size ||
      stack_size > kGuestStackMaxBytes ||
      (stack_size & (kGuestPageSize - 1u))) {
    return false;
  }
  const uint64_t slot64 = uint64_t(kGuestStackArenaBase) +
                          uint64_t(thread_index) * kGuestStackSlotStride;
  const uint64_t base64 = slot64 + kGuestStackGuardBytes;
  const uint64_t end64 = base64 + stack_size;
  const uint64_t upper_guard_end64 = end64 + kGuestStackGuardBytes;
  if (upper_guard_end64 > uint64_t(UINT32_MAX) + 1u ||
      upper_guard_end64 > slot64 + kGuestStackSlotStride) {
    return false;
  }
  const uint32_t stack_base = static_cast<uint32_t>(base64);
  const uint32_t page_count = stack_size / kGuestPageSize;
  const uint32_t backing = AllocateSparseGuestBacking(page_count);
  if (!backing ||
      !MapSparseGuestMemory(stack_base, page_count, backing, 0,
                            kGuestRead | kGuestWrite)) {
    return false;
  }
  uint32_t stack_top = static_cast<uint32_t>(end64) - kGuestStackTopReserve;
  stack_top &= ~0xFu;
  if (stack_top <= stack_base) {
    UnmapSparseGuestMemory(stack_base, page_count);
    return false;
  }
  if (stack_base_out) *stack_base_out = stack_base;
  if (stack_top_out) *stack_top_out = stack_top;
  return true;
}

void ReleaseVirtualAllocations() {
  for (auto& allocation : g_virtual_allocations) {
    if (allocation.used && allocation.committed && allocation.base && allocation.size) {
      UnmapSparseGuestMemory(allocation.base, allocation.size / kGuestPageSize);
    }
    allocation = {};
  }
  g_virtual_4k_bottom = kGuestVirtual4kBase;
  g_virtual_4k_top = kGuestVirtual4kEnd;
  g_virtual_64k_bottom = kGuestVirtual64kBase;
  g_virtual_64k_top = kGuestVirtual64kEnd;
}

void ResetRuntime() {
  ReleaseVirtualAllocations();
  for (auto& thread : g_threads) {
    ReleaseThreadStack(thread);
    const uint16_t next_generation = uint16_t(thread.generation + 1u);
    thread = {};
    thread.generation = next_generation ? next_generation : 1u;
  }
  g_tls_allocated.fill(false);
  g_current_thread = 0;
  g_scheduler_cursor = 0;
  g_runtime_status = kStatusIdle;
}

uint32_t CreateThread(uint32_t entry, uint32_t context, uint32_t stack_size,
                      uint32_t flags) {
  if (!entry) {
    g_runtime_status = kStatusInvalid;
    return 0;
  }
  if (!stack_size) stack_size = kGuestStackDefaultBytes;
  const uint64_t aligned64 =
      (uint64_t(stack_size) + 0x3FFFu) & ~uint64_t(0x3FFFu);
  if (!aligned64 || aligned64 > kGuestStackMaxBytes) {
    g_runtime_status = kStatusInvalid;
    return 0;
  }
  stack_size = static_cast<uint32_t>(aligned64);
  for (uint32_t i = 0; i < kMaxThreads; ++i) {
    if (i == kBrowserMainThreadReservedSlot) continue;
    auto& thread = g_threads[i];
    if (thread.used && thread.state != kThreadTerminated) continue;
    ReleaseThreadStack(thread);
    uint32_t stack_base = 0;
    uint32_t stack_top = 0;
    if (!AllocateThreadStack(i, stack_size, &stack_base, &stack_top)) {
      g_runtime_status = kStatusInvalid;
      return 0;
    }
    uint16_t generation = uint16_t(thread.generation + 1u);
    if (!generation) generation = 1;
    thread = {};
    thread.used = true;
    thread.stack_mapped = true;
    thread.generation = generation;
    thread.state = kThreadReady;
    thread.entry = entry;
    thread.context = context;
    thread.stack_size = stack_size;
    thread.stack_base = stack_base;
    thread.stack_top = stack_top;
    thread.flags = flags;
    const uint32_t handle = MakeHandle(i, generation);
    if (!g_current_thread) {
      g_current_thread = handle;
      thread.state = kThreadRunning;
      g_scheduler_cursor = i;
    }
    g_runtime_status = kStatusSuccess;
    return handle;
  }
  g_runtime_status = kStatusInvalid;
  return 0;
}

bool SetCurrentThread(uint32_t handle) {
  uint32_t new_index = 0;
  if (!DecodeHandle(handle, &new_index)) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  auto& next = g_threads[new_index];
  if (next.state == kThreadTerminated || next.suspend_count ||
      !next.stack_mapped) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  uint32_t old_index = 0;
  if (DecodeHandle(g_current_thread, &old_index)) {
    auto& old = g_threads[old_index];
    if (old.state == kThreadRunning) old.state = kThreadReady;
  }
  next.state = kThreadRunning;
  g_current_thread = handle;
  g_scheduler_cursor = new_index;
  g_runtime_status = kStatusSuccess;
  return true;
}

uint32_t SuspendThread(uint32_t handle) {
  auto* thread = LookupThread(handle);
  if (!thread || thread->suspend_count == 0xFFFFFFFFu) {
    g_runtime_status = kStatusInvalid;
    return 0xFFFFFFFFu;
  }
  const uint32_t previous = thread->suspend_count++;
  thread->state = kThreadSuspended;
  if (handle == g_current_thread) g_current_thread = 0;
  g_runtime_status = kStatusSuccess;
  return previous;
}

uint32_t ResumeThread(uint32_t handle) {
  auto* thread = LookupThread(handle);
  if (!thread || !thread->suspend_count || !thread->stack_mapped) {
    g_runtime_status = kStatusInvalid;
    return 0xFFFFFFFFu;
  }
  const uint32_t previous = thread->suspend_count--;
  if (!thread->suspend_count) thread->state = kThreadReady;
  g_runtime_status = kStatusSuccess;
  return previous;
}

bool TerminateThread(uint32_t handle, uint32_t exit_code) {
  auto* thread = LookupThread(handle);
  if (!thread) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  thread->state = kThreadTerminated;
  thread->exit_code = exit_code;
  thread->suspend_count = 0;
  ReleaseThreadStack(*thread);
  if (handle == g_current_thread) g_current_thread = 0;
  g_runtime_status = kStatusSuccess;
  return true;
}

uint32_t NextRunnable() {
  for (uint32_t step = 1; step <= kMaxThreads; ++step) {
    const uint32_t index = (g_scheduler_cursor + step) % kMaxThreads;
    auto& thread = g_threads[index];
    if (!thread.used || thread.state == kThreadTerminated ||
        thread.suspend_count || !thread.stack_mapped) {
      continue;
    }
    const uint32_t handle = ThreadHandleByIndex(index);
    if (SetCurrentThread(handle)) return handle;
  }
  g_runtime_status = kStatusInvalid;
  return 0;
}

uint32_t TlsAlloc() {
  for (uint32_t i = 0; i < kMaxTlsSlots; ++i) {
    if (g_tls_allocated[i]) continue;
    g_tls_allocated[i] = true;
    for (auto& thread : g_threads) thread.tls[i] = 0;
    g_runtime_status = kStatusSuccess;
    return i;
  }
  g_runtime_status = kStatusInvalid;
  return kTlsOutOfIndexes;
}

bool TlsFree(uint32_t slot) {
  if (slot >= kMaxTlsSlots || !g_tls_allocated[slot]) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  g_tls_allocated[slot] = false;
  for (auto& thread : g_threads) thread.tls[slot] = 0;
  g_runtime_status = kStatusSuccess;
  return true;
}

bool TlsSet(uint32_t handle, uint32_t slot, uint32_t value) {
  auto* thread = LookupThread(handle);
  if (!thread || slot >= kMaxTlsSlots || !g_tls_allocated[slot]) {
    g_runtime_status = kStatusInvalid;
    return false;
  }
  thread->tls[slot] = value;
  g_runtime_status = kStatusSuccess;
  return true;
}

uint32_t TlsGet(uint32_t handle, uint32_t slot) {
  auto* thread = LookupThread(handle);
  if (!thread || slot >= kMaxTlsSlots || !g_tls_allocated[slot]) {
    g_runtime_status = kStatusInvalid;
    return 0;
  }
  g_runtime_status = kStatusSuccess;
  return thread->tls[slot];
}

bool ReadGuestBe32(uint32_t address, uint32_t* out) {
  if (!out) return false;
  uint8_t bytes[4] = {};
  if (!ReadSparseGuestMemory(address, bytes, sizeof(bytes))) return false;
  *out = (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) |
         (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);
  return true;
}

bool WriteGuestBe32(uint32_t address, uint32_t value) {
  const uint8_t bytes[4] = {
      static_cast<uint8_t>(value >> 24),
      static_cast<uint8_t>(value >> 16),
      static_cast<uint8_t>(value >> 8),
      static_cast<uint8_t>(value),
  };
  return WriteSparseGuestMemory(address, bytes, sizeof(bytes));
}

bool RoundUpGuestSize(uint32_t value, uint32_t alignment, uint32_t* out) {
  if (!out || !value || !alignment || (alignment & (alignment - 1u))) return false;
  const uint64_t rounded =
      (uint64_t(value) + alignment - 1u) & ~(uint64_t(alignment) - 1u);
  if (!rounded || rounded > UINT32_MAX) return false;
  *out = static_cast<uint32_t>(rounded);
  return true;
}

bool VirtualRangesOverlap(uint32_t a_base, uint32_t a_size,
                          uint32_t b_base, uint32_t b_size) {
  const uint64_t a_end = uint64_t(a_base) + a_size;
  const uint64_t b_end = uint64_t(b_base) + b_size;
  return uint64_t(a_base) < b_end && uint64_t(b_base) < a_end;
}

bool VirtualRangeAvailable(uint32_t base, uint32_t size,
                           const GuestVirtualAllocation* ignore = nullptr) {
  if (!size || uint64_t(base) + size > (uint64_t{1} << 32)) return false;
  for (const auto& allocation : g_virtual_allocations) {
    if (!allocation.used || &allocation == ignore) continue;
    if (VirtualRangesOverlap(base, size, allocation.base, allocation.size)) return false;
  }
  return true;
}

GuestVirtualAllocation* FindVirtualAllocation(uint32_t base, uint32_t size) {
  for (auto& allocation : g_virtual_allocations) {
    if (allocation.used && allocation.base == base && allocation.size == size) {
      return &allocation;
    }
  }
  return nullptr;
}

GuestVirtualAllocation* AcquireVirtualAllocationSlot() {
  for (auto& allocation : g_virtual_allocations) {
    if (!allocation.used) return &allocation;
  }
  return nullptr;
}

uint32_t SparseProtectionFromXPage(uint32_t protect) {
  uint32_t result = 0;
  if (protect & (0x02u | 0x04u | 0x08u | 0x20u | 0x40u | 0x80u)) {
    result |= kGuestRead;
  }
  if (protect & (0x04u | 0x08u | 0x40u | 0x80u)) result |= kGuestWrite;
  if (protect & (0x10u | 0x20u | 0x40u | 0x80u)) result |= kGuestExecute;
  return result;
}

bool CommitVirtualAllocation(GuestVirtualAllocation* allocation,
                             uint32_t protection) {
  if (!allocation || !allocation->used || !allocation->size) return false;
  if (allocation->committed) {
    allocation->protection = protection;
    return ProtectSparseGuestMemory(allocation->base,
                                    allocation->size / kGuestPageSize,
                                    protection);
  }
  const uint32_t pages = allocation->size / kGuestPageSize;
  const uint32_t backing = AllocateSparseGuestBacking(pages);
  if (!backing ||
      !MapSparseGuestMemory(allocation->base, pages, backing, 0, protection)) {
    return false;
  }
  allocation->committed = true;
  allocation->protection = protection;
  return true;
}

uint32_t NtAllocateVirtualMemory(uint32_t base_addr_ptr,
                                 uint32_t region_size_ptr,
                                 uint32_t alloc_type, uint32_t protect_bits,
                                 uint32_t debug_memory) {
  uint32_t requested_base = 0, requested_size = 0;
  if (!base_addr_ptr || !region_size_ptr || debug_memory != 0 ||
      !ReadGuestBe32(base_addr_ptr, &requested_base) ||
      !ReadGuestBe32(region_size_ptr, &requested_size) || !requested_size) {
    return kXStatusInvalidParameter;
  }
  if (!(alloc_type & (kXMemCommit | kXMemReset | kXMemReserve)) ||
      ((alloc_type & kXMemReset) && (alloc_type & ~kXMemReset))) {
    return kXStatusInvalidParameter;
  }
  // Xenia's current MEM_RESET path is intentionally unimplemented. Keep the
  // browser service fail-closed instead of pretending that reset semantics ran.
  if (alloc_type & kXMemReset) return kXStatusInvalidParameter;

  const uint32_t page_size =
      (alloc_type & kXMemLargePages) ? kGuestLargePageSize : kGuestPageSize;
  uint32_t adjusted_size = 0;
  if (!RoundUpGuestSize(requested_size, page_size, &adjusted_size)) {
    return kXStatusInvalidParameter;
  }

  uint32_t base = requested_base ? requested_base & ~(page_size - 1u) : 0u;
  GuestVirtualAllocation* allocation = nullptr;
  if (base) {
    allocation = FindVirtualAllocation(base, adjusted_size);
    if (!allocation) {
      const uint32_t range_begin =
          page_size == kGuestLargePageSize ? kGuestVirtual64kBase : 0x00010000u;
      const uint32_t range_end =
          page_size == kGuestLargePageSize ? 0x80000000u : kGuestVirtual4kEnd;
      if (base < range_begin || uint64_t(base) + adjusted_size > range_end ||
          !VirtualRangeAvailable(base, adjusted_size)) {
        return kXStatusNoMemory;
      }
      allocation = AcquireVirtualAllocationSlot();
      if (!allocation) return kXStatusNoMemory;
      *allocation = {true, false, base, adjusted_size, page_size, 0};
    }
  } else {
    uint32_t* bottom = page_size == kGuestLargePageSize
                           ? &g_virtual_64k_bottom
                           : &g_virtual_4k_bottom;
    uint32_t* top = page_size == kGuestLargePageSize
                        ? &g_virtual_64k_top
                        : &g_virtual_4k_top;
    if (alloc_type & kXMemTopDown) {
      if (*top < adjusted_size || *top - adjusted_size < *bottom) {
        return kXStatusNoMemory;
      }
      base = (*top - adjusted_size) & ~(page_size - 1u);
      if (base < *bottom || !VirtualRangeAvailable(base, adjusted_size)) {
        return kXStatusNoMemory;
      }
      *top = base;
    } else {
      base = (*bottom + page_size - 1u) & ~(page_size - 1u);
      if (uint64_t(base) + adjusted_size > *top ||
          !VirtualRangeAvailable(base, adjusted_size)) {
        return kXStatusNoMemory;
      }
      *bottom = base + adjusted_size;
    }
    allocation = AcquireVirtualAllocationSlot();
    if (!allocation) return kXStatusNoMemory;
    *allocation = {true, false, base, adjusted_size, page_size, 0};
  }

  if ((alloc_type & kXMemCommit) &&
      !CommitVirtualAllocation(allocation, SparseProtectionFromXPage(protect_bits))) {
    if (!allocation->committed) *allocation = {};
    return kXStatusNoMemory;
  }

  // Sparse backing pages are zero-created by AllocateSparseGuestBacking, which
  // matches Xenia's default committed-memory zeroing. X_MEM_NOZERO therefore
  // needs no extra work in this sparse implementation.
  (void)kXMemNoZero;
  if (!WriteGuestBe32(base_addr_ptr, base) ||
      !WriteGuestBe32(region_size_ptr, adjusted_size)) {
    return kXStatusInvalidParameter;
  }
  return kXStatusSuccess;
}

bool IsGuestVirtualHeapAddress(uint32_t address) {
  return (address >= 0x00010000u && address < kGuestVirtual4kEnd) ||
         (address >= kGuestVirtual64kBase && address < 0x80000000u);
}

uint32_t NtFreeVirtualMemory(uint32_t base_addr_ptr,
                             uint32_t region_size_ptr, uint32_t free_type,
                             uint32_t debug_memory) {
  uint32_t base_addr_value = 0, region_size_value = 0;
  if (!base_addr_ptr || !region_size_ptr || debug_memory != 0 ||
      !ReadGuestBe32(base_addr_ptr, &base_addr_value) ||
      !ReadGuestBe32(region_size_ptr, &region_size_value)) {
    return kXStatusInvalidParameter;
  }
  if (!base_addr_value) return kXStatusMemoryNotAllocated;

  GuestVirtualAllocation* allocation = nullptr;
  for (auto& candidate : g_virtual_allocations) {
    if (candidate.used && candidate.base == base_addr_value) {
      allocation = &candidate;
      break;
    }
  }
  if (!allocation) {
    return IsGuestVirtualHeapAddress(base_addr_value)
               ? kXStatusUnsuccessful
               : kXStatusInvalidParameter;
  }

  if (free_type == kXMemDecommit) {
    // Xenia permits range decommit. The browser allocator currently tracks one
    // commit state per reservation, so only the whole reservation can be
    // decommitted without lying about page state. Fail closed for partial
    // decommits until per-page reservation state is introduced.
    uint32_t adjusted_size = 0;
    if (!region_size_value ||
        !RoundUpGuestSize(region_size_value, allocation->page_size,
                          &adjusted_size) ||
        adjusted_size != allocation->size) {
      return kXStatusUnsuccessful;
    }
    if (allocation->committed) {
      if (!UnmapSparseGuestMemory(allocation->base,
                                  allocation->size / kGuestPageSize)) {
        return kXStatusUnsuccessful;
      }
      allocation->committed = false;
      allocation->protection = 0;
    }
    if (!WriteGuestBe32(base_addr_ptr, base_addr_value) ||
        !WriteGuestBe32(region_size_ptr, adjusted_size)) {
      return kXStatusInvalidParameter;
    }
    return kXStatusSuccess;
  }

  // Match Xenia BaseHeap::Release: the supplied address must be the reservation
  // base, the whole region is released, and RegionSize receives its real size.
  // Upstream treats every non-DECOMMIT FreeType through the release path.
  (void)kXMemRelease;
  const uint32_t released_size = allocation->size;
  if (allocation->committed &&
      !UnmapSparseGuestMemory(allocation->base,
                              allocation->size / kGuestPageSize)) {
    return kXStatusUnsuccessful;
  }
  *allocation = {};
  if (!WriteGuestBe32(base_addr_ptr, base_addr_value) ||
      !WriteGuestBe32(region_size_ptr, released_size)) {
    return kXStatusInvalidParameter;
  }
  return kXStatusSuccess;
}

// Match UserModule::GetOptHeader used by upstream xboxkrnl!
// RtlImageXexHeaderField. XEX optional-header keys encode how their value is
// represented in the low byte: 0 returns the inline dword, 1 returns the guest
// address of the optional-header value cell, and every other value treats the
// stored dword as an offset from the guest XEX header base.
bool ReadXexOptionalHeaderField(uint32_t xex_header, uint32_t field,
                                uint32_t* out) {
  if (!out || !xex_header) return false;
  *out = 0;

  uint32_t magic = 0, header_size = 0, header_count = 0;
  if (!ReadGuestBe32(xex_header + 0x00u, &magic) ||
      !ReadGuestBe32(xex_header + 0x08u, &header_size) ||
      !ReadGuestBe32(xex_header + 0x14u, &header_count)) {
    return false;
  }
  if (magic != 0x58455832u || header_size < 0x18u ||
      header_count > (header_size - 0x18u) / 8u || header_count > 4096u) {
    return false;
  }

  for (uint32_t i = 0; i < header_count; ++i) {
    const uint64_t entry64 = uint64_t(xex_header) + 0x18u + uint64_t(i) * 8u;
    if (entry64 + 7u > UINT32_MAX) return false;
    const uint32_t entry = static_cast<uint32_t>(entry64);
    uint32_t key = 0, value = 0;
    if (!ReadGuestBe32(entry, &key) || !ReadGuestBe32(entry + 4u, &value)) {
      return false;
    }
    if (key != field) continue;

    switch (key & 0xFFu) {
      case 0x00u:
        *out = value;
        return true;
      case 0x01u:
        *out = entry + 4u;
        return true;
      default: {
        const uint64_t result64 = uint64_t(xex_header) + value;
        if (result64 > UINT32_MAX) return false;
        *out = static_cast<uint32_t>(result64);
        return true;
      }
    }
  }

  // Xenia returns a null guest pointer when the optional header is absent.
  return true;
}

uint32_t ServiceCall(uint32_t module, uint32_t ordinal,
                     uint32_t r3, uint32_t r4, uint32_t r5, uint32_t r6,
                     uint32_t r7, uint32_t, uint32_t, uint32_t) {
  ++g_service_calls;
  g_last_module = module;
  g_last_ordinal = ordinal;
  g_service_status = kStatusSuccess;

  if (module == kModuleXboxkrnl) {
    switch (ordinal) {
      case 0x0083:  // KeQueryPerformanceFrequency
        return kGuestTickFrequency;
      case 0x00CC:  // NtAllocateVirtualMemory
        return NtAllocateVirtualMemory(r3, r4, r5, r6, r7);
      case 0x00DC:  // NtFreeVirtualMemory
        return NtFreeVirtualMemory(r3, r4, r5, r6);
      case 0x012B: {  // RtlImageXexHeaderField
        uint32_t value = 0;
        if (!ReadXexOptionalHeaderField(r3, r4, &value)) {
          g_service_status = kStatusInvalid;
          return 0;
        }
        return value;
      }
      case 0x0132: {  // RtlLowerChar
        const uint32_t c = r3 & 0xFFu;
        return c >= 'A' && c <= 'Z' ? (c ^ 0x20u) : c;
      }
      case 0x014A: {  // RtlUpperChar
        const uint32_t c = r3 & 0xFFu;
        return c >= 'a' && c <= 'z' ? (c ^ 0x20u) : c;
      }
      case 0x0152: {  // KeTlsAlloc
        const uint32_t slot = TlsAlloc();
        if (g_runtime_status != kStatusSuccess) g_service_status = kStatusInvalid;
        return slot;
      }
      case 0x0153: {  // KeTlsFree
        const bool ok = TlsFree(r3);
        if (!ok) g_service_status = kStatusInvalid;
        return ok ? 1u : 0u;
      }
      case 0x0154: {  // KeTlsGetValue
        if (!g_current_thread) {
          g_service_status = kStatusInvalid;
          return 0;
        }
        const uint32_t value = TlsGet(g_current_thread, r3);
        if (g_runtime_status != kStatusSuccess) g_service_status = kStatusInvalid;
        return value;
      }
      case 0x0155: {  // KeTlsSetValue
        if (!g_current_thread) {
          g_service_status = kStatusInvalid;
          return 0;
        }
        const bool ok = TlsSet(g_current_thread, r3, r4);
        if (!ok) g_service_status = kStatusInvalid;
        return ok ? 1u : 0u;
      }
      default:
        g_service_status = kStatusUnsupported;
        return 0;
    }
  }

  if (module == kModuleXam) {
    switch (ordinal) {
      case 0x028A: {  // XamNotifyCreateListener
        // Xenia returns a kernel object handle. The browser runtime does not
        // yet need queued dashboard notifications during title startup, but it
        // must return a stable non-zero listener handle so titles can poll it.
        const uint32_t handle = g_next_notify_handle++;
        if (!g_next_notify_handle) g_next_notify_handle = 0x37000001u;
        return handle;
      }
      case 0x028B: {  // XNotifyGetNext
        // Match Xenia's empty-queue behavior: zero optional param first, require
        // an id pointer for output, zero id, then report no dequeued event.
        // Guest pointers are Xbox virtual addresses, so use sparse guest memory
        // and preserve big-endian dword representation.
        const uint32_t zero = 0;
        if (r6 && !WriteSparseGuestMemory(r6, &zero, sizeof(zero))) {
          g_service_status = kStatusInvalid;
          return 0;
        }
        if (!r5) return 0;
        if (!WriteSparseGuestMemory(r5, &zero, sizeof(zero))) {
          g_service_status = kStatusInvalid;
          return 0;
        }
        return 0;
      }
      case 0x028C:  // XNotifyPositionUI - ignored by Xenia.
      case 0x028D:  // XNotifyDelayUI - ignored by Xenia.
        return 0;
      case 0x03CD:  // XGetLanguage - XLanguage::kEnglish in Xenia default path.
        return 1u;
      default:
        g_service_status = kStatusUnsupported;
        return 0;
    }
  }

  g_service_status = kStatusUnsupported;
  return 0;
}

}  // namespace
}  // namespace render360::xenia_web

extern "C" {

void r360_kernel_runtime_reset() {
  render360::xenia_web::ResetRuntime();
}

uint32_t r360_guest_thread_create(uint32_t entry, uint32_t context,
                                  uint32_t stack_size, uint32_t flags) {
  return render360::xenia_web::CreateThread(entry, context, stack_size, flags);
}
uint32_t r360_guest_thread_current() {
  return render360::xenia_web::g_current_thread;
}
uint32_t r360_guest_thread_set_current(uint32_t handle) {
  return render360::xenia_web::SetCurrentThread(handle) ? 1u : 0u;
}
uint32_t r360_guest_thread_suspend(uint32_t handle) {
  return render360::xenia_web::SuspendThread(handle);
}
uint32_t r360_guest_thread_resume(uint32_t handle) {
  return render360::xenia_web::ResumeThread(handle);
}
uint32_t r360_guest_thread_terminate(uint32_t handle, uint32_t exit_code) {
  return render360::xenia_web::TerminateThread(handle, exit_code) ? 1u : 0u;
}
uint32_t r360_guest_thread_next_runnable() {
  return render360::xenia_web::NextRunnable();
}
uint32_t r360_guest_thread_state(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? uint32_t(thread->state) : 0u;
}
uint32_t r360_guest_thread_exit_code(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->exit_code : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_entry")
uint32_t r360_guest_thread_entry(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->entry : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_context")
uint32_t r360_guest_thread_context(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->context : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_flags")
uint32_t r360_guest_thread_flags(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->flags : 0u;
}
uint32_t r360_guest_thread_stack_size(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->stack_size : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_stack_base")
uint32_t r360_guest_thread_stack_base(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->stack_base : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_stack_top")
uint32_t r360_guest_thread_stack_top(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread ? thread->stack_top : 0u;
}
R360_WASM_EXPORT("r360_guest_thread_stack_mapped")
uint32_t r360_guest_thread_stack_mapped(uint32_t handle) {
  auto* thread = render360::xenia_web::LookupThread(handle, true);
  return thread && thread->stack_mapped ? 1u : 0u;
}
uint32_t r360_guest_runtime_status() {
  return render360::xenia_web::g_runtime_status;
}

uint32_t r360_guest_tls_alloc() { return render360::xenia_web::TlsAlloc(); }
uint32_t r360_guest_tls_free(uint32_t slot) {
  return render360::xenia_web::TlsFree(slot) ? 1u : 0u;
}
uint32_t r360_guest_tls_set(uint32_t handle, uint32_t slot, uint32_t value) {
  return render360::xenia_web::TlsSet(handle, slot, value) ? 1u : 0u;
}
uint32_t r360_guest_tls_get(uint32_t handle, uint32_t slot) {
  return render360::xenia_web::TlsGet(handle, slot);
}

void r360_kernel_service_reset() {
  render360::xenia_web::g_service_status = render360::xenia_web::kStatusIdle;
  render360::xenia_web::g_service_calls = 0;
  render360::xenia_web::g_last_module = 0;
  render360::xenia_web::g_last_ordinal = 0;
}
uint32_t r360_kernel_service_call(uint32_t module, uint32_t ordinal,
                                  uint32_t r3, uint32_t r4, uint32_t r5,
                                  uint32_t r6, uint32_t r7, uint32_t r8,
                                  uint32_t r9, uint32_t r10) {
  return render360::xenia_web::ServiceCall(module, ordinal, r3, r4, r5, r6,
                                           r7, r8, r9, r10);
}
uint32_t r360_kernel_service_status() {
  return render360::xenia_web::g_service_status;
}
uint32_t r360_kernel_service_calls() {
  return render360::xenia_web::g_service_calls;
}
uint32_t r360_kernel_service_last_module() {
  return render360::xenia_web::g_last_module;
}
uint32_t r360_kernel_service_last_ordinal() {
  return render360::xenia_web::g_last_ordinal;
}

}  // extern "C"
