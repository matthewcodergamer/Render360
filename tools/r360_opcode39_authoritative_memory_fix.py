#!/usr/bin/env python3
from pathlib import Path


def replace_between(text: str, start_marker: str, end_marker: str, replacement: str, label: str) -> str:
    start = text.find(start_marker)
    end = text.find(end_marker, start + len(start_marker))
    if start < 0 or end < 0:
        raise SystemExit(f'{label}: function boundaries changed')
    return text[:start] + replacement + text[end:]


# Base correctness executor. Keep this correct even though production also runs
# a VMX/title-memory overlay during the wasm32 build.
p = Path('src/xenia_web_bootstrap/hir_correctness_executor.cpp')
s = p.read_text()
if '#include <cstdio>' not in s:
    s = s.replace('#include <cmath>\n', '#include <cmath>\n#include <cstdio>\n', 1)
if '#include "sparse_guest_memory.h"' not in s:
    s = s.replace('#include "xenia/memory.h"\n', '#include "xenia/memory.h"\n#include "sparse_guest_memory.h"\n#include "title_gpu_runtime.h"\n', 1)

load_impl = r'''bool LoadGuestValue(xe::Memory* memory, Value* destination,
                    const Value* address, const Value* offset,
                    const RuntimeValues& values, RuntimeValues& out_values,
                    uint32_t flags) {
  if ((flags & ~xe::cpu::hir::LOAD_STORE_BYTE_SWAP) != 0 || !destination) {
    return false;
  }
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) {
    std::fprintf(stderr, "R360_HIR_MEMORY_FAIL op=resolve-load source=0x%08X\n",
                 guest_address);
    return false;
  }
  const size_t size = xe::cpu::hir::GetTypeSize(destination->type);
  RuntimeValue loaded;
  loaded.type = destination->type;
  loaded.value = {};

  // Xenos MMIO is not ordinary sparse RAM.
  if (size == 4 && destination->type == xe::cpu::hir::INT32_TYPE) {
    uint32_t mmio_value = 0;
    if (ReadTitleGpuMmio(guest_address, &mmio_value)) {
      loaded.value.u32 = static_cast<uint32_t>(
          ByteSwapUnsigned(mmio_value, xe::cpu::hir::INT32_TYPE));
      if ((flags & xe::cpu::hir::LOAD_STORE_BYTE_SWAP) &&
          !ByteSwapRuntimeValue(&loaded)) {
        return false;
      }
      out_values[destination] = loaded;
      return true;
    }
  }

  // SparseGuestMemory is the authoritative Xbox address space. xe::Memory is
  // only the movable 64 KiB decoder window and may be used solely as a fallback
  // for synthetic probe fixtures that don't have a sparse mapping.
  if (!ReadSparseGuestMemory(guest_address, &loaded.value,
                             static_cast<uint32_t>(size))) {
    const uint32_t sparse_fault = SparseGuestLastFaultCode();
    const uint32_t sparse_fault_address = SparseGuestLastFaultAddress();
    uint8_t* host = nullptr;
    if (!TranslateGuestRange(memory, guest_address, size, &host)) {
      std::fprintf(stderr,
                   "R360_HIR_MEMORY_FAIL op=load address=0x%08X fault=%u fault_address=0x%08X size=%u\n",
                   guest_address, sparse_fault, sparse_fault_address,
                   static_cast<unsigned>(size));
      return false;
    }
    std::memcpy(&loaded.value, host, size);
  }
  if ((flags & xe::cpu::hir::LOAD_STORE_BYTE_SWAP) &&
      !ByteSwapRuntimeValue(&loaded)) {
    return false;
  }
  out_values[destination] = loaded;
  return true;
}

'''
store_impl = r'''bool StoreGuestValue(xe::Memory* memory, const Value* address,
                     const Value* offset, const Value* source,
                     const RuntimeValues& values, uint32_t flags) {
  if ((flags & ~xe::cpu::hir::LOAD_STORE_BYTE_SWAP) != 0 || !source) {
    return false;
  }
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(source->type);
  RuntimeValue stored;
  if (!ResolveRuntimeValue(source, values, &stored) || stored.type != source->type) {
    return false;
  }
  if ((flags & xe::cpu::hir::LOAD_STORE_BYTE_SWAP) &&
      !ByteSwapRuntimeValue(&stored)) {
    return false;
  }

  if (size == 4 && source->type == xe::cpu::hir::INT32_TYPE) {
    const uint32_t logical_value = static_cast<uint32_t>(
        ByteSwapUnsigned(stored.value.u32, xe::cpu::hir::INT32_TYPE));
    if (WriteTitleGpuMmio(guest_address, logical_value)) return true;
  }

  if (WriteSparseGuestMemory(guest_address, &stored.value,
                             static_cast<uint32_t>(size))) {
    return true;
  }
  const uint32_t sparse_fault = SparseGuestLastFaultCode();
  const uint32_t sparse_fault_address = SparseGuestLastFaultAddress();
  uint8_t* host = nullptr;
  if (!TranslateGuestRange(memory, guest_address, size, &host)) {
    std::fprintf(stderr,
                 "R360_HIR_MEMORY_FAIL op=store address=0x%08X fault=%u fault_address=0x%08X size=%u\n",
                 guest_address, sparse_fault, sparse_fault_address,
                 static_cast<unsigned>(size));
    return false;
  }
  std::memcpy(host, &stored.value, size);
  return true;
}

'''
s = replace_between(s, 'bool LoadGuestValue(xe::Memory* memory, Value* destination,', '\nbool StoreGuestValue(', load_impl, 'base LOAD')
s = replace_between(s, 'bool StoreGuestValue(xe::Memory* memory, const Value* address,', '\nbool ExecuteIndirect(', store_impl, 'base STORE')
p.write_text(s)

# Production title-memory overlay. This is the path that previously reintroduced
# decoder-window-first behavior after the base executor had been fixed.
p = Path('prepare-title-runtime-memory-overlay.py')
s = p.read_text()
start = s.find("replacement = r'''bool LoadGuestValue")
end = s.find("'''\n\ntext = text[:start] + replacement + text[end:]", start)
if start < 0 or end < 0:
    raise SystemExit('title runtime overlay replacement boundaries changed')
production_impl = load_impl + store_impl
new_block = "replacement = r'''" + production_impl + "'''"
s = s[:start] + new_block + s[end + 3:]
p.write_text(s)

# The compatibility path must instantiate the decoder/runtime first, then create
# the title's sparse main-thread stack and PCR, and finally apply r1/r13. This
# keeps lazy Xenia setup from racing title-thread memory initialization.
p = Path('render360-title-controller.mjs')
s = p.read_text()
old = "  pick(bootstrap,'r360_title_handoff_reset')();\n  const mainThreadContext=prepareMainThreadContext?prepareBrowserMainThreadContext(bootstrap):null;"
new = "  pick(bootstrap,'r360_title_handoff_reset')();\n  if(prepareMainThreadContext){const warm=maybe(bootstrap,'r360_ppc_probe_page_sparse_code');if(typeof warm==='function'&&(warm(entry)>>>0)===0)throw new Error('unable to initialize Xenia title decoder before main-thread context');pick(bootstrap,'r360_title_handoff_reset')();}\n  const mainThreadContext=prepareMainThreadContext?prepareBrowserMainThreadContext(bootstrap):null;"
if old in s:
    s = s.replace(old, new, 1)
elif 'unable to initialize Xenia title decoder before main-thread context' not in s:
    raise SystemExit('title controller main-thread warmup anchor changed')
p.write_text(s)

# Cache-bust the complete browser import chain and the Wasm URL. Safari can keep
# module scripts alive across ordinary reloads even though the wasm fetch itself
# uses cache:no-store.
versions = {
    'render360-browser-modern-content-bridge.mjs': [
        ('render360-browser-title-runtime.mjs?v=44.5', 'render360-browser-title-runtime.mjs?v=44.7'),
        ('render360-title-controller.mjs?v=44.6', 'render360-title-controller.mjs?v=44.7'),
    ],
    'runtime/render360-runtime.js': [
        ('render360-browser-modern-content-bridge.mjs?v=44.6', 'render360-browser-modern-content-bridge.mjs?v=44.7'),
    ],
    'app-v41.js': [
        ('runtime/render360-runtime.js?v=44.6', 'runtime/render360-runtime.js?v=44.7'),
    ],
    'index.html': [
        ('app-v41.js?v=44.6', 'app-v41.js?v=44.7'),
        ('app-v42-patch.js?v=44.6', 'app-v42-patch.js?v=44.7'),
    ],
    'render360-browser-title-runtime.mjs': [
        ('xenia_ppc_bootstrap.wasm?v=44.5', 'xenia_ppc_bootstrap.wasm?v=44.7'),
    ],
}
for name, pairs in versions.items():
    p = Path(name)
    t = p.read_text()
    for old_v, new_v in pairs:
        t = t.replace(old_v, new_v)
    p.write_text(t)

# Fail closed if the patcher accidentally stopped touching the production path.
checks = {
    'src/xenia_web_bootstrap/hir_correctness_executor.cpp': [
        'R360_HIR_MEMORY_FAIL op=load', 'ReadSparseGuestMemory', 'WriteSparseGuestMemory'],
    'prepare-title-runtime-memory-overlay.py': [
        'R360_HIR_MEMORY_FAIL op=load', 'ReadSparseGuestMemory', 'WriteSparseGuestMemory'],
    'render360-title-controller.mjs': [
        'unable to initialize Xenia title decoder before main-thread context'],
    'render360-browser-title-runtime.mjs': ['xenia_ppc_bootstrap.wasm?v=44.7'],
}
for name, needles in checks.items():
    text = Path(name).read_text()
    missing = [needle for needle in needles if needle not in text]
    if missing:
        raise SystemExit(f'{name}: missing {missing}')

print('R360_OPCODE39_AUTHORITATIVE_SPARSE_MEMORY=PATCHED')
print('R360_OPCODE39_EFFECTIVE_ADDRESS_TELEMETRY=PATCHED')
print('R360_MAIN_THREAD_RUNTIME_ORDER=PATCHED')
print('R360_BROWSER_CACHE_CHAIN=44.7')
