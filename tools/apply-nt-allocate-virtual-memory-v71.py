#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 71


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    if new in text:
        print(f"{label}: already applied")
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count} in {path}")
    path.write_text(text.replace(old, new, 1))
    print(f"{label}: applied")


kernel = ROOT / "src/xenia_web_bootstrap/kernel_runtime_foundation.cpp"

old_constants = """constexpr uint32_t kMaxThreads = 32;\nconstexpr uint32_t kMaxTlsSlots = 64;\nconstexpr uint32_t kGuestTickFrequency = 50000000u;\nconstexpr uint32_t kGuestPageSize = 4096u;\n"""
new_constants = """constexpr uint32_t kMaxThreads = 32;\nconstexpr uint32_t kMaxTlsSlots = 64;\nconstexpr uint32_t kMaxVirtualAllocations = 128;\nconstexpr uint32_t kGuestTickFrequency = 50000000u;\nconstexpr uint32_t kGuestPageSize = 4096u;\nconstexpr uint32_t kGuestLargePageSize = 65536u;\n// Match Xenia's guest virtual-memory split while keeping automatic allocations\n// away from Render360's PCR/TLS and browser thread-stack arenas. The normal\n// 4 KiB virtual heap occupies the low 1 GiB. Large-page allocations start in\n// Xenia's 0x40000000 64 KiB virtual range, capped below the 0x50000000 PCR.\nconstexpr uint32_t kGuestVirtual4kBase = 0x10000000u;\nconstexpr uint32_t kGuestVirtual4kEnd = 0x40000000u;\nconstexpr uint32_t kGuestVirtual64kBase = 0x40000000u;\nconstexpr uint32_t kGuestVirtual64kEnd = 0x50000000u;\nconstexpr uint32_t kXMemCommit = 0x00001000u;\nconstexpr uint32_t kXMemReserve = 0x00002000u;\nconstexpr uint32_t kXMemReset = 0x00080000u;\nconstexpr uint32_t kXMemTopDown = 0x00100000u;\nconstexpr uint32_t kXMemNoZero = 0x00800000u;\nconstexpr uint32_t kXMemLargePages = 0x20000000u;\nconstexpr uint32_t kXStatusSuccess = 0x00000000u;\nconstexpr uint32_t kXStatusInvalidParameter = 0xC000000Du;\nconstexpr uint32_t kXStatusNoMemory = 0xC0000017u;\n"""
replace_once(kernel, old_constants, new_constants, "V71 virtual-memory constants")

old_globals = """std::array<GuestThread, kMaxThreads> g_threads{};\nstd::array<bool, kMaxTlsSlots> g_tls_allocated{};\nuint32_t g_current_thread = 0;\n"""
new_globals = """struct GuestVirtualAllocation {\n  bool used = false;\n  bool committed = false;\n  uint32_t base = 0;\n  uint32_t size = 0;\n  uint32_t page_size = kGuestPageSize;\n  uint32_t protection = 0;\n};\n\nstd::array<GuestThread, kMaxThreads> g_threads{};\nstd::array<bool, kMaxTlsSlots> g_tls_allocated{};\nstd::array<GuestVirtualAllocation, kMaxVirtualAllocations> g_virtual_allocations{};\nuint32_t g_virtual_4k_bottom = kGuestVirtual4kBase;\nuint32_t g_virtual_4k_top = kGuestVirtual4kEnd;\nuint32_t g_virtual_64k_bottom = kGuestVirtual64kBase;\nuint32_t g_virtual_64k_top = kGuestVirtual64kEnd;\nuint32_t g_current_thread = 0;\n"""
replace_once(kernel, old_globals, new_globals, "V71 virtual-memory state")

old_reset = """void ResetRuntime() {\n  for (auto& thread : g_threads) {\n"""
new_reset = """void ReleaseVirtualAllocations() {\n  for (auto& allocation : g_virtual_allocations) {\n    if (allocation.used && allocation.committed && allocation.base && allocation.size) {\n      UnmapSparseGuestMemory(allocation.base, allocation.size / kGuestPageSize);\n    }\n    allocation = {};\n  }\n  g_virtual_4k_bottom = kGuestVirtual4kBase;\n  g_virtual_4k_top = kGuestVirtual4kEnd;\n  g_virtual_64k_bottom = kGuestVirtual64kBase;\n  g_virtual_64k_top = kGuestVirtual64kEnd;\n}\n\nvoid ResetRuntime() {\n  ReleaseVirtualAllocations();\n  for (auto& thread : g_threads) {\n"""
replace_once(kernel, old_reset, new_reset, "V71 virtual-memory reset")

old_read = """bool ReadGuestBe32(uint32_t address, uint32_t* out) {\n  if (!out) return false;\n  uint8_t bytes[4] = {};\n  if (!ReadSparseGuestMemory(address, bytes, sizeof(bytes))) return false;\n  *out = (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) |\n         (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);\n  return true;\n}\n\n"""
new_read = """bool ReadGuestBe32(uint32_t address, uint32_t* out) {\n  if (!out) return false;\n  uint8_t bytes[4] = {};\n  if (!ReadSparseGuestMemory(address, bytes, sizeof(bytes))) return false;\n  *out = (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) |\n         (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);\n  return true;\n}\n\nbool WriteGuestBe32(uint32_t address, uint32_t value) {\n  const uint8_t bytes[4] = {\n      static_cast<uint8_t>(value >> 24),\n      static_cast<uint8_t>(value >> 16),\n      static_cast<uint8_t>(value >> 8),\n      static_cast<uint8_t>(value),\n  };\n  return WriteSparseGuestMemory(address, bytes, sizeof(bytes));\n}\n\nbool RoundUpGuestSize(uint32_t value, uint32_t alignment, uint32_t* out) {\n  if (!out || !value || !alignment || (alignment & (alignment - 1u))) return false;\n  const uint64_t rounded =\n      (uint64_t(value) + alignment - 1u) & ~(uint64_t(alignment) - 1u);\n  if (!rounded || rounded > UINT32_MAX) return false;\n  *out = static_cast<uint32_t>(rounded);\n  return true;\n}\n\nbool VirtualRangesOverlap(uint32_t a_base, uint32_t a_size,\n                          uint32_t b_base, uint32_t b_size) {\n  const uint64_t a_end = uint64_t(a_base) + a_size;\n  const uint64_t b_end = uint64_t(b_base) + b_size;\n  return uint64_t(a_base) < b_end && uint64_t(b_base) < a_end;\n}\n\nbool VirtualRangeAvailable(uint32_t base, uint32_t size,\n                           const GuestVirtualAllocation* ignore = nullptr) {\n  if (!size || uint64_t(base) + size > (uint64_t{1} << 32)) return false;\n  for (const auto& allocation : g_virtual_allocations) {\n    if (!allocation.used || &allocation == ignore) continue;\n    if (VirtualRangesOverlap(base, size, allocation.base, allocation.size)) return false;\n  }\n  return true;\n}\n\nGuestVirtualAllocation* FindVirtualAllocation(uint32_t base, uint32_t size) {\n  for (auto& allocation : g_virtual_allocations) {\n    if (allocation.used && allocation.base == base && allocation.size == size) {\n      return &allocation;\n    }\n  }\n  return nullptr;\n}\n\nGuestVirtualAllocation* AcquireVirtualAllocationSlot() {\n  for (auto& allocation : g_virtual_allocations) {\n    if (!allocation.used) return &allocation;\n  }\n  return nullptr;\n}\n\nuint32_t SparseProtectionFromXPage(uint32_t protect) {\n  uint32_t result = 0;\n  if (protect & (0x02u | 0x04u | 0x08u | 0x20u | 0x40u | 0x80u)) {\n    result |= kGuestRead;\n  }\n  if (protect & (0x04u | 0x08u | 0x40u | 0x80u)) result |= kGuestWrite;\n  if (protect & (0x10u | 0x20u | 0x40u | 0x80u)) result |= kGuestExecute;\n  return result;\n}\n\nbool CommitVirtualAllocation(GuestVirtualAllocation* allocation,\n                             uint32_t protection) {\n  if (!allocation || !allocation->used || !allocation->size) return false;\n  if (allocation->committed) {\n    allocation->protection = protection;\n    return ProtectSparseGuestMemory(allocation->base,\n                                    allocation->size / kGuestPageSize,\n                                    protection);\n  }\n  const uint32_t pages = allocation->size / kGuestPageSize;\n  const uint32_t backing = AllocateSparseGuestBacking(pages);\n  if (!backing ||\n      !MapSparseGuestMemory(allocation->base, pages, backing, 0, protection)) {\n    return false;\n  }\n  allocation->committed = true;\n  allocation->protection = protection;\n  return true;\n}\n\nuint32_t NtAllocateVirtualMemory(uint32_t base_addr_ptr,\n                                 uint32_t region_size_ptr,\n                                 uint32_t alloc_type, uint32_t protect_bits,\n                                 uint32_t debug_memory) {\n  uint32_t requested_base = 0, requested_size = 0;\n  if (!base_addr_ptr || !region_size_ptr || debug_memory != 0 ||\n      !ReadGuestBe32(base_addr_ptr, &requested_base) ||\n      !ReadGuestBe32(region_size_ptr, &requested_size) || !requested_size) {\n    return kXStatusInvalidParameter;\n  }\n  if (!(alloc_type & (kXMemCommit | kXMemReset | kXMemReserve)) ||\n      ((alloc_type & kXMemReset) && (alloc_type & ~kXMemReset))) {\n    return kXStatusInvalidParameter;\n  }\n  // Xenia's current MEM_RESET path is intentionally unimplemented. Keep the\n  // browser service fail-closed instead of pretending that reset semantics ran.\n  if (alloc_type & kXMemReset) return kXStatusInvalidParameter;\n\n  const uint32_t page_size =\n      (alloc_type & kXMemLargePages) ? kGuestLargePageSize : kGuestPageSize;\n  uint32_t adjusted_size = 0;\n  if (!RoundUpGuestSize(requested_size, page_size, &adjusted_size)) {\n    return kXStatusInvalidParameter;\n  }\n\n  uint32_t base = requested_base ? requested_base & ~(page_size - 1u) : 0u;\n  GuestVirtualAllocation* allocation = nullptr;\n  if (base) {\n    allocation = FindVirtualAllocation(base, adjusted_size);\n    if (!allocation) {\n      const uint32_t range_begin =\n          page_size == kGuestLargePageSize ? kGuestVirtual64kBase : 0x00010000u;\n      const uint32_t range_end =\n          page_size == kGuestLargePageSize ? 0x80000000u : kGuestVirtual4kEnd;\n      if (base < range_begin || uint64_t(base) + adjusted_size > range_end ||\n          !VirtualRangeAvailable(base, adjusted_size)) {\n        return kXStatusNoMemory;\n      }\n      allocation = AcquireVirtualAllocationSlot();\n      if (!allocation) return kXStatusNoMemory;\n      *allocation = {true, false, base, adjusted_size, page_size, 0};\n    }\n  } else {\n    uint32_t* bottom = page_size == kGuestLargePageSize\n                           ? &g_virtual_64k_bottom\n                           : &g_virtual_4k_bottom;\n    uint32_t* top = page_size == kGuestLargePageSize\n                        ? &g_virtual_64k_top\n                        : &g_virtual_4k_top;\n    if (alloc_type & kXMemTopDown) {\n      if (*top < adjusted_size || *top - adjusted_size < *bottom) {\n        return kXStatusNoMemory;\n      }\n      base = (*top - adjusted_size) & ~(page_size - 1u);\n      if (base < *bottom || !VirtualRangeAvailable(base, adjusted_size)) {\n        return kXStatusNoMemory;\n      }\n      *top = base;\n    } else {\n      base = (*bottom + page_size - 1u) & ~(page_size - 1u);\n      if (uint64_t(base) + adjusted_size > *top ||\n          !VirtualRangeAvailable(base, adjusted_size)) {\n        return kXStatusNoMemory;\n      }\n      *bottom = base + adjusted_size;\n    }\n    allocation = AcquireVirtualAllocationSlot();\n    if (!allocation) return kXStatusNoMemory;\n    *allocation = {true, false, base, adjusted_size, page_size, 0};\n  }\n\n  if ((alloc_type & kXMemCommit) &&\n      !CommitVirtualAllocation(allocation, SparseProtectionFromXPage(protect_bits))) {\n    if (!allocation->committed) *allocation = {};\n    return kXStatusNoMemory;\n  }\n\n  // Sparse backing pages are zero-created by AllocateSparseGuestBacking, which\n  // matches Xenia's default committed-memory zeroing. X_MEM_NOZERO therefore\n  // needs no extra work in this sparse implementation.\n  (void)kXMemNoZero;\n  if (!WriteGuestBe32(base_addr_ptr, base) ||\n      !WriteGuestBe32(region_size_ptr, adjusted_size)) {\n    return kXStatusInvalidParameter;\n  }\n  return kXStatusSuccess;\n}\n\n"""
replace_once(kernel, old_read, new_read, "V71 NtAllocateVirtualMemory service")

old_signature = """uint32_t ServiceCall(uint32_t module, uint32_t ordinal,\n                     uint32_t r3, uint32_t r4, uint32_t r5, uint32_t r6,\n                     uint32_t, uint32_t, uint32_t, uint32_t) {\n"""
new_signature = """uint32_t ServiceCall(uint32_t module, uint32_t ordinal,\n                     uint32_t r3, uint32_t r4, uint32_t r5, uint32_t r6,\n                     uint32_t r7, uint32_t, uint32_t, uint32_t) {\n"""
replace_once(kernel, old_signature, new_signature, "V71 kernel r7 ABI")

old_case = """    switch (ordinal) {\n      case 0x0083:  // KeQueryPerformanceFrequency\n        return kGuestTickFrequency;\n"""
new_case = """    switch (ordinal) {\n      case 0x0083:  // KeQueryPerformanceFrequency\n        return kGuestTickFrequency;\n      case 0x00CC:  // NtAllocateVirtualMemory\n        return NtAllocateVirtualMemory(r3, r4, r5, r6, r7);\n"""
replace_once(kernel, old_case, new_case, "V71 xboxkrnl ordinal 0xCC dispatch")

(ROOT / "VERSION").write_text(f"{RELEASE}\n")

runtime = ROOT / "runtime/render360-runtime.js"
replace_once(runtime, "const RENDER360_RELEASE=70;", "const RENDER360_RELEASE=71;", "V71 runtime release")
replace_once(runtime, "const CONTENT_BRIDGE={release:70,", "const CONTENT_BRIDGE={release:71,", "V71 content bridge release")

index = ROOT / "index.html"
text = index.read_text()
text = text.replace("Render360 70", "Render360 71")
old_ui = '<span>UI Release</span><span class="value">70</span>'
new_ui = '<span>UI Release</span><span class="value">71</span>'
if new_ui not in text:
    if old_ui not in text:
        raise SystemExit("V71 UI Release anchor missing")
    text = text.replace(old_ui, new_ui, 1)
index.write_text(text)

sw = ROOT / "render360-sw.js"
text = sw.read_text()
text, count = re.subn(r"const VERSION='\d+';", "const VERSION='71';", text, count=1)
if count != 1:
    raise SystemExit("V71 service worker version anchor missing")
sw.write_text(text)

print("R360_V71_NT_ALLOCATE_VIRTUAL_MEMORY_PATCH=PASS")
