#!/usr/bin/env python3
"""Generate browser-only overlays for compiling upstream Xenia on wasm32.

The overlays preserve upstream Xbox/PPC behavior. They adapt only host ABI and
compiler-language seams needed by Emscripten. Generated files live under
build/ and are never committed as a forked copy of upstream Xenia.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
XENIA = ROOT / "upstream" / "xenia"
OVERLAY = ROOT / "build" / "xenia-web-overlay"

PPC_CONTEXT_SOURCE = XENIA / "src/xenia/cpu/ppc/ppc_context.h"
PPC_CONTEXT_DEST = OVERLAY / "xenia/cpu/ppc/ppc_context.h"
CVAR_SOURCE = XENIA / "src/xenia/base/cvar.cc"
CVAR_DEST = OVERLAY / "xenia/base/cvar.cc"
UTF8_SOURCE = XENIA / "src/xenia/base/utf8.cc"
UTF8_DEST = OVERLAY / "xenia/base/utf8.cc"
MEMORY_HEADER_SOURCE = XENIA / "src/xenia/memory.h"
MEMORY_HEADER_DEST = OVERLAY / "xenia/memory.h"
MEMORY_SOURCE = XENIA / "src/xenia/memory.cc"
MEMORY_DEST = OVERLAY / "xenia/memory.cc"
PROCESSOR_SOURCE = XENIA / "src/xenia/cpu/processor.cc"
PROCESSOR_DEST = OVERLAY / "xenia/cpu/processor.cc"

for path, label in (
    (PPC_CONTEXT_SOURCE, "PPCContext header"),
    (CVAR_SOURCE, "cvar.cc"),
    (UTF8_SOURCE, "utf8.cc"),
    (MEMORY_HEADER_SOURCE, "memory.h"),
    (MEMORY_SOURCE, "memory.cc"),
    (PROCESSOR_SOURCE, "processor.cc"),
):
    if not path.exists():
        raise SystemExit(f"Run ./fetch-xenia.sh first; upstream {label} is missing")

# PPCContext: wasm32 host pointers are 32-bit, making the upstream context 16
# bytes short of Xenia's existing 64-byte size invariant. Add tail-only padding
# after the final data member so every existing architectural/runtime offset is
# unchanged.
text = PPC_CONTEXT_SOURCE.read_text(errors="strict")
needle = "  // Value of last reserved load\n  uint64_t reserved_val;\n"
if needle not in text:
    raise SystemExit("Upstream PPCContext layout drifted: reserved_val anchor not found")
replacement = needle + (
    "\n#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)\n"
    "  // Render360 web ABI: compensate for 32-bit host pointers without\n"
    "  // moving any existing PPCContext field. Keep this as tail padding.\n"
    "  uint8_t render360_wasm32_tail_padding[16];\n"
    "#endif\n"
)
text = text.replace(needle, replacement, 1)
PPC_CONTEXT_DEST.parent.mkdir(parents=True, exist_ok=True)
PPC_CONTEXT_DEST.write_text(text)

# This pinned Xenia revision predates C++20 char8_t semantics in two base
# utilities. Their u8 literals are narrow UTF-8 byte strings consumed through
# std::string/std::string_view<char>. Removing only the u8 prefix preserves the
# exact byte payload while keeping the real Xenia implementations intact.
def write_narrow_utf8_overlay(source: Path, dest: Path, label: str) -> int:
    source_text = source.read_text(errors="strict")
    count = source_text.count('u8"')
    if count == 0:
        raise SystemExit(f"Upstream {label} UTF-8 literal pattern drifted: no u8 literals found")
    source_text = source_text.replace('u8"', '"')
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(source_text)
    return count

cvar_u8_count = write_narrow_utf8_overlay(CVAR_SOURCE, CVAR_DEST, "cvar.cc")
utf8_u8_count = write_narrow_utf8_overlay(UTF8_SOURCE, UTF8_DEST, "utf8.cc")

# memory.h / memory.cc: desktop Xenia reserves a 4.5 GiB host file mapping with
# fixed aliased views. wasm32 cannot represent that host address-space model.
# Expose only one bounded 64 KiB decoder window, while keeping Xenia's heap
# descriptors/page sizes valid for translation-time protection queries. Real
# title data remains authoritative in Render360 sparse guest memory.
memory_h = MEMORY_HEADER_SOURCE.read_text(errors="strict")
translate_anchor = '''  template <typename T = uint8_t*>
  inline T TranslateVirtual(uint32_t guest_address) const {
    uint8_t* host_address = virtual_membase_ + guest_address;
    const auto heap = LookupHeap(guest_address);
    if (heap) {
      host_address += heap->host_address_offset();
    }
    return reinterpret_cast<T>(host_address);
  }
'''
if translate_anchor not in memory_h:
    raise SystemExit("Upstream memory.h TranslateVirtual block drifted")
translate_replacement = '''  template <typename T = uint8_t*>
  inline T TranslateVirtual(uint32_t guest_address) const {
#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)
    constexpr uint32_t kRender360ProbeGuestBase = 0x80000000u;
    constexpr uint32_t kRender360ProbeGuestSize = 64u * 1024u;
    if (guest_address < kRender360ProbeGuestBase ||
        guest_address >= kRender360ProbeGuestBase + kRender360ProbeGuestSize ||
        render360_wasm32_probe_code_window_.empty()) {
      return static_cast<T>(nullptr);
    }
    return reinterpret_cast<T>(render360_wasm32_probe_code_window_.data() +
                               (guest_address - kRender360ProbeGuestBase));
#else
    uint8_t* host_address = virtual_membase_ + guest_address;
    const auto heap = LookupHeap(guest_address);
    if (heap) {
      host_address += heap->host_address_offset();
    }
    return reinterpret_cast<T>(host_address);
#endif
  }
'''
memory_h = memory_h.replace(translate_anchor, translate_replacement, 1)
private_anchor = "  uint8_t* virtual_membase_ = nullptr;\n  uint8_t* physical_membase_ = nullptr;\n"
if private_anchor not in memory_h:
    raise SystemExit("Upstream memory.h membase field anchor drifted")
private_replacement = private_anchor + (
    "#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)\n"
    "  // Translation-probe-only guest code backing. Full sparse Xbox memory\n"
    "  // is a separate browser host implementation stage. Mutable preserves\n"
    "  // Xenia's const TranslateVirtual API, which intentionally returns a\n"
    "  // writable guest pointer even when called through const Memory.\n"
    "  mutable std::vector<uint8_t> render360_wasm32_probe_code_window_;\n"
    "#endif\n"
)
memory_h = memory_h.replace(private_anchor, private_replacement, 1)
MEMORY_HEADER_DEST.parent.mkdir(parents=True, exist_ok=True)
MEMORY_HEADER_DEST.write_text(memory_h)

memory_cc = MEMORY_SOURCE.read_text(errors="strict")
ctor_anchor = '''Memory::Memory() {
  system_page_size_ = uint32_t(xe::memory::page_size());
  system_allocation_granularity_ =
      uint32_t(xe::memory::allocation_granularity());
  assert_zero(active_memory_);
  active_memory_ = this;
}
'''
ctor_replacement = '''Memory::Memory() {
#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)
  // Probe-only wasm32 host values. No desktop fixed-address mapping exists.
  system_page_size_ = 64u * 1024u;
  system_allocation_granularity_ = 64u * 1024u;
#else
  system_page_size_ = uint32_t(xe::memory::page_size());
  system_allocation_granularity_ =
      uint32_t(xe::memory::allocation_granularity());
#endif
  assert_zero(active_memory_);
  active_memory_ = this;
}
'''
if ctor_anchor not in memory_cc:
    raise SystemExit("Upstream Memory constructor block drifted")
memory_cc = memory_cc.replace(ctor_anchor, ctor_replacement, 1)

dtor_anchor = '''Memory::~Memory() {
  assert_true(active_memory_ == this);
  active_memory_ = nullptr;

  // Uninstall the MMIO handler, as we won't be able to service more
  // requests.
  mmio_handler_.reset();

  for (auto invalidation_callback : physical_memory_invalidation_callbacks_) {
    delete invalidation_callback;
  }

  heaps_.v00000000.Dispose();
  heaps_.v40000000.Dispose();
  heaps_.v80000000.Dispose();
  heaps_.v90000000.Dispose();
  heaps_.vA0000000.Dispose();
  heaps_.vC0000000.Dispose();
  heaps_.vE0000000.Dispose();
  heaps_.physical.Dispose();

  // Unmap all views and close mapping.
  if (mapping_ != xe::memory::kFileMappingHandleInvalid) {
    UnmapViews();
    xe::memory::CloseFileMappingHandle(mapping_, file_name_);
    mapping_base_ = nullptr;
    mapping_ = xe::memory::kFileMappingHandleInvalid;
  }

  virtual_membase_ = nullptr;
  physical_membase_ = nullptr;
}
'''
dtor_replacement = '''Memory::~Memory() {
  assert_true(active_memory_ == this);
  active_memory_ = nullptr;
#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)
  render360_wasm32_probe_code_window_.clear();
  virtual_membase_ = nullptr;
  physical_membase_ = nullptr;
#else
  // Uninstall the MMIO handler, as we won't be able to service more requests.
  mmio_handler_.reset();
  for (auto invalidation_callback : physical_memory_invalidation_callbacks_) {
    delete invalidation_callback;
  }
  heaps_.v00000000.Dispose();
  heaps_.v40000000.Dispose();
  heaps_.v80000000.Dispose();
  heaps_.v90000000.Dispose();
  heaps_.vA0000000.Dispose();
  heaps_.vC0000000.Dispose();
  heaps_.vE0000000.Dispose();
  heaps_.physical.Dispose();
  if (mapping_ != xe::memory::kFileMappingHandleInvalid) {
    UnmapViews();
    xe::memory::CloseFileMappingHandle(mapping_, file_name_);
    mapping_base_ = nullptr;
    mapping_ = xe::memory::kFileMappingHandleInvalid;
  }
  virtual_membase_ = nullptr;
  physical_membase_ = nullptr;
#endif
}
'''
if dtor_anchor not in memory_cc:
    raise SystemExit("Upstream Memory destructor block drifted")
memory_cc = memory_cc.replace(dtor_anchor, dtor_replacement, 1)

init_start = memory_cc.find("bool Memory::Initialize() {\n")
map_info_start = memory_cc.find("static const struct {\n", init_start)
if init_start < 0 or map_info_start < 0:
    raise SystemExit("Upstream Memory::Initialize boundaries drifted")
upstream_init = memory_cc[init_start:map_info_start]
wasm_init = '''bool Memory::Initialize() {
#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)
  constexpr size_t kRender360ProbeGuestSize = 64u * 1024u;
  render360_wasm32_probe_code_window_.assign(kRender360ProbeGuestSize, 0);
  virtual_membase_ = render360_wasm32_probe_code_window_.data();
  physical_membase_ = nullptr;
  mapping_base_ = nullptr;
  mapping_ = xe::memory::kFileMappingHandleInvalid;

  // Preserve Xenia's guest address classification and page-size contracts even
  // though wasm32 cannot reserve the desktop 4.5 GiB host mapping. Translation
  // passes query these heaps (for example QueryProtect) while lowering guest
  // loads/stores. Leaving page_size_ at zero causes a wasm integer divide trap.
  // The page tables are metadata only and begin unallocated/no-access; actual
  // browser title bytes and permissions remain owned by sparse guest memory.
  heaps_.v00000000.Initialize(this, virtual_membase_, HeapType::kGuestVirtual,
                              0x00000000, 0x40000000, 4096);
  heaps_.v40000000.Initialize(this, virtual_membase_, HeapType::kGuestVirtual,
                              0x40000000, 0x40000000 - 0x01000000, 64 * 1024);
  heaps_.v80000000.Initialize(this, virtual_membase_, HeapType::kGuestXex,
                              0x80000000, 0x10000000, 64 * 1024);
  heaps_.v90000000.Initialize(this, virtual_membase_, HeapType::kGuestXex,
                              0x90000000, 0x10000000, 4096);
  heaps_.physical.Initialize(this, physical_membase_, HeapType::kGuestPhysical,
                             0x00000000, 0x20000000, 4096);
  heaps_.vA0000000.Initialize(this, virtual_membase_, HeapType::kGuestPhysical,
                              0xA0000000, 0x20000000, 64 * 1024,
                              &heaps_.physical);
  heaps_.vC0000000.Initialize(this, virtual_membase_, HeapType::kGuestPhysical,
                              0xC0000000, 0x20000000, 16 * 1024 * 1024,
                              &heaps_.physical);
  heaps_.vE0000000.Initialize(this, virtual_membase_, HeapType::kGuestPhysical,
                              0xE0000000, 0x1FD00000, 4096,
                              &heaps_.physical);
  return true;
#else
'''
desktop_body = upstream_init[len("bool Memory::Initialize() {\n"):]
last_close = desktop_body.rfind("}\n")
if last_close < 0:
    raise SystemExit("Upstream Memory::Initialize closing brace drifted")
desktop_body_without_close = desktop_body[:last_close]
wasm_init += desktop_body_without_close + "#endif\n}\n\n"
memory_cc = memory_cc[:init_start] + wasm_init + memory_cc[map_info_start:]
MEMORY_DEST.parent.mkdir(parents=True, exist_ok=True)
MEMORY_DEST.write_text(memory_cc)

# processor.cc: the debugger exception-resume path knows how to restore a
# native AMD64 RIP or ARM64 PC. The translation-only wasm32 backend has no
# native host instruction stream to resume, so this host-debugging branch must
# compile as an intentional no-op. All Processor setup/function-resolution/
# builtin/frontend behavior remains the real upstream implementation.
processor_text = PROCESSOR_SOURCE.read_text(errors="strict")
processor_anchor = (
    "#if XE_ARCH_AMD64\n"
    "  ex->set_resume_pc(thread_info->host_context.rip);\n"
    "#elif XE_ARCH_ARM64\n"
    "  ex->set_resume_pc(thread_info->host_context.pc);\n"
    "#else\n"
    "#error Instruction pointer not specified for the target CPU architecture.\n"
    "#endif  // XE_ARCH\n"
)
if processor_anchor not in processor_text:
    raise SystemExit("Upstream processor.cc debug-resume architecture block drifted")
processor_replacement = (
    "#if XE_ARCH_AMD64\n"
    "  ex->set_resume_pc(thread_info->host_context.rip);\n"
    "#elif XE_ARCH_ARM64\n"
    "  ex->set_resume_pc(thread_info->host_context.pc);\n"
    "#elif XE_ARCH_WASM32\n"
    "  // Render360 translation-only backend has no native host PC. Guest HIR\n"
    "  // translation does not enter this exception-resume path.\n"
    "  (void)ex;\n"
    "#else\n"
    "#error Instruction pointer not specified for the target CPU architecture.\n"
    "#endif  // XE_ARCH\n"
)
processor_text = processor_text.replace(processor_anchor, processor_replacement, 1)
PROCESSOR_DEST.parent.mkdir(parents=True, exist_ok=True)
PROCESSOR_DEST.write_text(processor_text)

print(f"Generated web PPCContext overlay: {PPC_CONTEXT_DEST}")
print("ABI rule: upstream field offsets unchanged; wasm32 tail padded by 16 bytes")
print(f"Generated web cvar source overlay: {CVAR_DEST}")
print(f"cvar UTF-8 rule: normalized {cvar_u8_count} legacy u8 literals to identical narrow byte literals")
print(f"Generated web utf8 source overlay: {UTF8_DEST}")
print(f"utf8 UTF-8 rule: normalized {utf8_u8_count} legacy u8 literals to identical narrow byte literals")
print(f"Generated web memory header/source overlay: {MEMORY_HEADER_DEST}, {MEMORY_DEST}")
print("Memory rule: wasm32 keeps one 64 KiB decoder window plus valid Xenia heap metadata; no fake full 4.5 GiB host mapping")
print(f"Generated web processor source overlay: {PROCESSOR_DEST}")
print("Processor rule: wasm32 has no native exception-resume PC; translation/runtime logic is unchanged")
