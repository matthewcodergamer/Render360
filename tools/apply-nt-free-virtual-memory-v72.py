#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 72


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

replace_once(
    kernel,
    """constexpr uint32_t kXMemCommit = 0x00001000u;\nconstexpr uint32_t kXMemReserve = 0x00002000u;\nconstexpr uint32_t kXMemReset = 0x00080000u;\n""",
    """constexpr uint32_t kXMemCommit = 0x00001000u;\nconstexpr uint32_t kXMemReserve = 0x00002000u;\nconstexpr uint32_t kXMemDecommit = 0x00004000u;\nconstexpr uint32_t kXMemRelease = 0x00008000u;\nconstexpr uint32_t kXMemReset = 0x00080000u;\n""",
    "V72 virtual-free flags",
)

replace_once(
    kernel,
    """constexpr uint32_t kXStatusSuccess = 0x00000000u;\nconstexpr uint32_t kXStatusInvalidParameter = 0xC000000Du;\nconstexpr uint32_t kXStatusNoMemory = 0xC0000017u;\n""",
    """constexpr uint32_t kXStatusSuccess = 0x00000000u;\nconstexpr uint32_t kXStatusUnsuccessful = 0xC0000001u;\nconstexpr uint32_t kXStatusInvalidParameter = 0xC000000Du;\nconstexpr uint32_t kXStatusNoMemory = 0xC0000017u;\nconstexpr uint32_t kXStatusMemoryNotAllocated = 0xC00000A0u;\n""",
    "V72 virtual-free NTSTATUS constants",
)

old_free_anchor = """  return kXStatusSuccess;\n}\n\n// Match UserModule::GetOptHeader used by upstream xboxkrnl!\n"""
new_free_anchor = """  return kXStatusSuccess;\n}\n\nbool IsGuestVirtualHeapAddress(uint32_t address) {\n  return (address >= 0x00010000u && address < kGuestVirtual4kEnd) ||\n         (address >= kGuestVirtual64kBase && address < 0x80000000u);\n}\n\nuint32_t NtFreeVirtualMemory(uint32_t base_addr_ptr,\n                             uint32_t region_size_ptr, uint32_t free_type,\n                             uint32_t debug_memory) {\n  uint32_t base_addr_value = 0, region_size_value = 0;\n  if (!base_addr_ptr || !region_size_ptr || debug_memory != 0 ||\n      !ReadGuestBe32(base_addr_ptr, &base_addr_value) ||\n      !ReadGuestBe32(region_size_ptr, &region_size_value)) {\n    return kXStatusInvalidParameter;\n  }\n  if (!base_addr_value) return kXStatusMemoryNotAllocated;\n\n  GuestVirtualAllocation* allocation = nullptr;\n  for (auto& candidate : g_virtual_allocations) {\n    if (candidate.used && candidate.base == base_addr_value) {\n      allocation = &candidate;\n      break;\n    }\n  }\n  if (!allocation) {\n    return IsGuestVirtualHeapAddress(base_addr_value)\n               ? kXStatusUnsuccessful\n               : kXStatusInvalidParameter;\n  }\n\n  if (free_type == kXMemDecommit) {\n    // Xenia permits range decommit. The browser allocator currently tracks one\n    // commit state per reservation, so only the whole reservation can be\n    // decommitted without lying about page state. Fail closed for partial\n    // decommits until per-page reservation state is introduced.\n    uint32_t adjusted_size = 0;\n    if (!region_size_value ||\n        !RoundUpGuestSize(region_size_value, allocation->page_size,\n                          &adjusted_size) ||\n        adjusted_size != allocation->size) {\n      return kXStatusUnsuccessful;\n    }\n    if (allocation->committed) {\n      if (!UnmapSparseGuestMemory(allocation->base,\n                                  allocation->size / kGuestPageSize)) {\n        return kXStatusUnsuccessful;\n      }\n      allocation->committed = false;\n      allocation->protection = 0;\n    }\n    if (!WriteGuestBe32(base_addr_ptr, base_addr_value) ||\n        !WriteGuestBe32(region_size_ptr, adjusted_size)) {\n      return kXStatusInvalidParameter;\n    }\n    return kXStatusSuccess;\n  }\n\n  // Match Xenia BaseHeap::Release: the supplied address must be the reservation\n  // base, the whole region is released, and RegionSize receives its real size.\n  // Upstream treats every non-DECOMMIT FreeType through the release path.\n  (void)kXMemRelease;\n  const uint32_t released_size = allocation->size;\n  if (allocation->committed &&\n      !UnmapSparseGuestMemory(allocation->base,\n                              allocation->size / kGuestPageSize)) {\n    return kXStatusUnsuccessful;\n  }\n  *allocation = {};\n  if (!WriteGuestBe32(base_addr_ptr, base_addr_value) ||\n      !WriteGuestBe32(region_size_ptr, released_size)) {\n    return kXStatusInvalidParameter;\n  }\n  return kXStatusSuccess;\n}\n\n// Match UserModule::GetOptHeader used by upstream xboxkrnl!\n"""
replace_once(kernel, old_free_anchor, new_free_anchor, "V72 NtFreeVirtualMemory service")

replace_once(
    kernel,
    """      case 0x00CC:  // NtAllocateVirtualMemory\n        return NtAllocateVirtualMemory(r3, r4, r5, r6, r7);\n      case 0x012B: {  // RtlImageXexHeaderField\n""",
    """      case 0x00CC:  // NtAllocateVirtualMemory\n        return NtAllocateVirtualMemory(r3, r4, r5, r6, r7);\n      case 0x00DC:  // NtFreeVirtualMemory\n        return NtFreeVirtualMemory(r3, r4, r5, r6);\n      case 0x012B: {  // RtlImageXexHeaderField\n""",
    "V72 xboxkrnl ordinal 0xDC dispatch",
)

fastlane = ROOT / ".github/workflows/xenia-browser-bootstrap-fastlane.yml"
replace_once(
    fastlane,
    """      - 'test-kernel-nt-allocate-virtual-memory.mjs'\n      - 'test-xex-guest-mapper.mjs'\n""",
    """      - 'test-kernel-nt-allocate-virtual-memory.mjs'\n      - 'test-kernel-nt-free-virtual-memory.mjs'\n      - 'test-xex-guest-mapper.mjs'\n""",
    "V72 fastlane free-memory trigger",
)
replace_once(
    fastlane,
    """      - name: Verify NtAllocateVirtualMemory kernel service\n        run: timeout 90s node ./test-kernel-nt-allocate-virtual-memory.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify browser bootstrap runtime contract\n""",
    """      - name: Verify NtAllocateVirtualMemory kernel service\n        run: timeout 90s node ./test-kernel-nt-allocate-virtual-memory.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify NtFreeVirtualMemory kernel service\n        run: timeout 90s node ./test-kernel-nt-free-virtual-memory.mjs build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm\n\n      - name: Verify browser bootstrap runtime contract\n""",
    "V72 fastlane free-memory regression",
)

(ROOT / "VERSION").write_text(f"{RELEASE}\n")

runtime = ROOT / "runtime/render360-runtime.js"
replace_once(runtime, "const RENDER360_RELEASE=71;", "const RENDER360_RELEASE=72;", "V72 runtime release")
replace_once(runtime, "const CONTENT_BRIDGE={release:71,", "const CONTENT_BRIDGE={release:72,", "V72 content bridge release")

index = ROOT / "index.html"
index_text = index.read_text()
if "Render360 72" not in index_text:
    if "Render360 71" not in index_text:
        raise SystemExit("V72 index release label: Render360 71 anchor missing")
    index_text = index_text.replace("Render360 71", "Render360 72")
if '<span>UI Release</span><span class="value">72</span>' not in index_text:
    old_ui = '<span>UI Release</span><span class="value">71</span>'
    if old_ui not in index_text:
        raise SystemExit("V72 index UI Release anchor missing")
    index_text = index_text.replace(old_ui, '<span>UI Release</span><span class="value">72</span>', 1)
index.write_text(index_text)
print("V72 index release: applied/current")

sw = ROOT / "render360-sw.js"
replace_once(sw, "const VERSION='71';", "const VERSION='72';", "V72 service-worker release")

print("V72 NtFreeVirtualMemory updater complete")
