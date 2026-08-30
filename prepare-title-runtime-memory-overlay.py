#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
path = root / 'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
text = path.read_text()

include_anchor = '#include "hir_correctness_executor.h"\n'
include_replacement = '''#include "hir_correctness_executor.h"\n\n#include "sparse_guest_memory.h"\n#include "title_gpu_runtime.h"\n\nextern "C" uint32_t r360_ppc_probe_guest_base();\n'''
if 'include "sparse_guest_memory.h"' not in text:
    if include_anchor not in text:
        raise SystemExit('title runtime memory overlay: include anchor changed')
    text = text.replace(include_anchor, include_replacement, 1)

# Replace the complete guest-memory implementation by function boundaries rather
# than matching an old source snapshot. This intentionally survives changes in
# the base executor such as adding LOAD_STORE_BYTE_SWAP support.
start = text.find('bool LoadGuestValue(xe::Memory* memory, Value* destination,')
end = text.find('\nbool ExecuteIndirect(', start)
if start < 0 or end < 0:
    raise SystemExit('title runtime memory overlay: guest load/store boundaries changed')

replacement = r'''bool LoadGuestValue(xe::Memory* memory, Value* destination,
                    const Value* address, const Value* offset,
                    const RuntimeValues& values, RuntimeValues& out_values,
                    uint32_t flags) {
  if ((flags & ~xe::cpu::hir::LOAD_STORE_BYTE_SWAP) != 0 || !destination) {
    return false;
  }
  uint32_t guest_address = 0;
  if (!ResolveGuestAddress(address, offset, values, &guest_address)) return false;
  const size_t size = xe::cpu::hir::GetTypeSize(destination->type);
  RuntimeValue loaded;
  loaded.type = destination->type;
  loaded.value = {};

  // Xenos MMIO exposes logical register values. Convert to the raw host-side
  // byte representation first, then apply the HIR load byte-swap flag exactly
  // once below just as we do for ordinary Xbox big-endian guest RAM.
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

  // The wasm32 Xenia Memory object only owns the movable 64 KiB translation
  // window. Title memory outside it is authoritative in SparseGuestMemory.
  const uint32_t probe_base = r360_ppc_probe_guest_base();
  const uint64_t probe_end = uint64_t(probe_base) + 64u * 1024u;
  const uint64_t access_end = uint64_t(guest_address) + size;
  const bool in_probe_window = guest_address >= probe_base &&
                               access_end <= probe_end &&
                               access_end <= 0x100000000ull;
  uint8_t* host = nullptr;
  if (in_probe_window && TranslateGuestRange(memory, guest_address, size, &host)) {
    std::memcpy(&loaded.value, host, size);
  } else if (!ReadSparseGuestMemory(guest_address, &loaded.value,
                                    static_cast<uint32_t>(size))) {
    return false;
  }

  if ((flags & xe::cpu::hir::LOAD_STORE_BYTE_SWAP) &&
      !ByteSwapRuntimeValue(&loaded)) {
    return false;
  }
  out_values[destination] = loaded;
  return true;
}

bool StoreGuestValue(xe::Memory* memory, const Value* address,
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

  // Convert the logical PPC value to the raw big-endian memory representation
  // before dispatching to MMIO or writing guest RAM.
  if ((flags & xe::cpu::hir::LOAD_STORE_BYTE_SWAP) &&
      !ByteSwapRuntimeValue(&stored)) {
    return false;
  }

  if (size == 4 && source->type == xe::cpu::hir::INT32_TYPE) {
    const uint32_t logical_value = static_cast<uint32_t>(
        ByteSwapUnsigned(stored.value.u32, xe::cpu::hir::INT32_TYPE));
    if (WriteTitleGpuMmio(guest_address, logical_value)) return true;
  }

  const uint32_t probe_base = r360_ppc_probe_guest_base();
  const uint64_t probe_end = uint64_t(probe_base) + 64u * 1024u;
  const uint64_t access_end = uint64_t(guest_address) + size;
  const bool in_probe_window = guest_address >= probe_base &&
                               access_end <= probe_end &&
                               access_end <= 0x100000000ull;
  uint8_t* host = nullptr;
  if (in_probe_window && TranslateGuestRange(memory, guest_address, size, &host)) {
    std::memcpy(host, &stored.value, size);
    WriteSparseGuestMemory(guest_address, &stored.value,
                           static_cast<uint32_t>(size));
    return true;
  }

  return WriteSparseGuestMemory(guest_address, &stored.value,
                                static_cast<uint32_t>(size));
}
'''

text = text[:start] + replacement + text[end:]
path.write_text(text)
print('TITLE_RUNTIME_ENDIAN_SPARSE_MMIO_OVERLAY=PASS')
