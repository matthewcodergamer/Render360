#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
path = root / 'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
text = path.read_text()

include_anchor = '#include "hir_correctness_executor.h"\n'
include_replacement = '''#include "hir_correctness_executor.h"\n\n#include "sparse_guest_memory.h"\n#include "title_gpu_runtime.h"\n\nextern "C" uint32_t r360_ppc_probe_guest_base();\n'''
if include_anchor not in text:
    raise SystemExit('title runtime memory overlay: include anchor changed')
text = text.replace(include_anchor, include_replacement, 1)

old = r'''bool LoadGuestValue(xe::Memory* memory, Value* destination,
                    const Value* address, const Value* offset,
                    const RuntimeValues& values, RuntimeValues& out_values,
                    uint32_t flags) {
  if (flags != 0 || !destination) return false;
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(destination->type);
  uint8_t* host = nullptr;
  if (!TranslateGuestRange(memory, guest_address, size, &host)) return false;
  RuntimeValue loaded;
  loaded.type = destination->type;
  std::memcpy(&loaded.value, host, size);
  out_values[destination] = loaded;
  return true;
}

bool StoreGuestValue(xe::Memory* memory, const Value* address,
                     const Value* offset, const Value* source,
                     const RuntimeValues& values, uint32_t flags) {
  if (flags != 0 || !source) return false;
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(source->type);
  uint8_t* host = nullptr;
  if (!TranslateGuestRange(memory, guest_address, size, &host)) return false;
  return StoreResolvedValue(source, values, host, size);
}
'''

new = r'''bool LoadGuestValue(xe::Memory* memory, Value* destination,
                    const Value* address, const Value* offset,
                    const RuntimeValues& values, RuntimeValues& out_values,
                    uint32_t flags) {
  if (flags != 0 || !destination) return false;
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(destination->type);
  RuntimeValue loaded;
  loaded.type = destination->type;
  loaded.value = {};

  // Match Xenia's GPU MMIO aperture before ordinary guest RAM. The HIR memory
  // path stores big-endian guest bytes in little-endian host integers, so MMIO
  // logical register values are byte-swapped into the same representation and
  // the normal PPC BYTE_SWAP HIR remains authoritative.
  if (size == 4 && destination->type == xe::cpu::hir::INT32_TYPE) {
    uint32_t mmio_value = 0;
    if (ReadTitleGpuMmio(guest_address, &mmio_value)) {
      loaded.value.u32 = static_cast<uint32_t>(
          ByteSwapUnsigned(mmio_value, xe::cpu::hir::INT32_TYPE));
      out_values[destination] = loaded;
      return true;
    }
  }

  // Memory::TranslateVirtual is deliberately backed by only one movable 64 KiB
  // wasm32 window. Calling it with arbitrary Xbox virtual addresses is not a
  // harmless miss: the bounded overlay may trap while translating an address
  // that doesn't belong to the current window. Check the guest range first and
  // go directly to sparse title RAM everywhere else.
  const uint32_t probe_base = r360_ppc_probe_guest_base();
  const uint64_t probe_end = uint64_t(probe_base) + 64u * 1024u;
  const uint64_t access_end = uint64_t(guest_address) + size;
  const bool in_probe_window = guest_address >= probe_base &&
                               access_end <= probe_end &&
                               access_end <= 0x100000000ull;
  uint8_t* host = nullptr;
  if (in_probe_window &&
      TranslateGuestRange(memory, guest_address, size, &host)) {
    std::memcpy(&loaded.value, host, size);
    out_values[destination] = loaded;
    return true;
  }

  // The PE/XEX mapper already owns an authoritative sparse 32-bit guest address
  // space. Falling back to it removes the old 64 KiB data-access wall without
  // allocating a 4 GiB browser heap.
  if (!ReadSparseGuestMemory(guest_address, &loaded.value,
                             static_cast<uint32_t>(size))) {
    return false;
  }
  out_values[destination] = loaded;
  return true;
}

bool StoreGuestValue(xe::Memory* memory, const Value* address,
                     const Value* offset, const Value* source,
                     const RuntimeValues& values, uint32_t flags) {
  if (flags != 0 || !source) return false;
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(source->type);
  RuntimeValue resolved;
  if (!ResolveRuntimeValue(source, values, &resolved) ||
      resolved.type != source->type) {
    return false;
  }

  if (size == 4 && source->type == xe::cpu::hir::INT32_TYPE) {
    const uint32_t logical_value = static_cast<uint32_t>(
        ByteSwapUnsigned(resolved.value.u32, xe::cpu::hir::INT32_TYPE));
    if (WriteTitleGpuMmio(guest_address, logical_value)) return true;
  }

  const uint32_t probe_base = r360_ppc_probe_guest_base();
  const uint64_t probe_end = uint64_t(probe_base) + 64u * 1024u;
  const uint64_t access_end = uint64_t(guest_address) + size;
  const bool in_probe_window = guest_address >= probe_base &&
                               access_end <= probe_end &&
                               access_end <= 0x100000000ull;
  uint8_t* host = nullptr;
  if (in_probe_window &&
      TranslateGuestRange(memory, guest_address, size, &host)) {
    std::memcpy(host, &resolved.value, size);
    // Keep mapped PE/sparse aliases coherent when this address also exists in
    // sparse guest RAM. Synthetic probe-only addresses are allowed to have no
    // sparse mapping, so a failed mirror is not itself a store failure.
    WriteSparseGuestMemory(guest_address, &resolved.value,
                           static_cast<uint32_t>(size));
    return true;
  }

  return WriteSparseGuestMemory(guest_address, &resolved.value,
                                static_cast<uint32_t>(size));
}
'''

if old not in text:
    raise SystemExit('title runtime memory overlay: guest load/store source contract changed')
text = text.replace(old, new, 1)
path.write_text(text)
print('Title runtime memory overlay: bounded code window + sparse guest RAM + Xenos MMIO enabled')
