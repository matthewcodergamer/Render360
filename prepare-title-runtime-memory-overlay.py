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

# Xenia's guest memory backend addresses memory through the low 32 bits of the
# PPC effective address. LOAD_OFFSET / STORE_OFFSET offsets are signed 64-bit
# constants in HIR (for example -4), but the effective Xbox virtual address is
# computed modulo 2^32. The compatibility executor used to add the operands as
# uint64_t and reject values above UINT32_MAX, which turns every negative D-form
# displacement into a false memory failure. Mirror Xenia's x64 backend: discard
# garbage/high bits from the base and perform the add in 32-bit address space.
address_old = '''  const uint64_t effective = base + displacement;\n  if (effective > std::numeric_limits<uint32_t>::max()) return false;\n  *guest_address = static_cast<uint32_t>(effective);\n  return true;\n'''
address_new = '''  const uint32_t base32 = static_cast<uint32_t>(base);\n  const uint32_t displacement32 = static_cast<uint32_t>(displacement);\n  *guest_address = base32 + displacement32;\n  return true;\n'''
address_source_fixed = '''  const uint32_t effective = static_cast<uint32_t>(base) +\n                             static_cast<uint32_t>(displacement);\n  *guest_address = effective;\n  return true;\n'''
if address_old in text:
    text = text.replace(address_old, address_new, 1)
elif address_source_fixed in text:
    # The authoritative source now carries the same PPC modulo-2^32 rule.
    # Normalize the generated overlay without requiring the legacy buggy form.
    text = text.replace(address_source_fixed, address_new, 1)
elif address_new not in text:
    raise SystemExit('title runtime memory overlay: ResolveGuestAddress anchor changed')

# Replace only the guest-memory implementation. The source may insert runtime
# helpers (for example the direct PPC branch decoder used by the HIR CALL
# fallback) between StoreGuestValue and ExecuteIndirect. Those helpers are part
# of the CPU runtime and must survive this overlay pass.
start = text.find('bool LoadGuestValue(xe::Memory* memory, Value* destination,')
helper_boundary = text.find('\nbool DecodeDirectBranchTarget(', start)
execute_boundary = text.find('\nbool ExecuteIndirect(', start)
end = helper_boundary if helper_boundary >= 0 else execute_boundary
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

text = text[:start] + replacement + text[end:]

# The authoritative executor now declares probe helpers in an extern "C" block,
# while the call/return ABI surgery originally targeted the older single-line
# declaration. Normalize only the generated overlay so that the next pass is
# compatible with both source layouts without duplicating a declaration.
modern_probe_decls = '''extern "C" {
uint32_t r360_ppc_probe_guest_base();
uint32_t r360_ppc_probe_loaded_size();
}
'''
legacy_probe_decl = 'extern "C" uint32_t r360_ppc_probe_guest_base();\n'
if modern_probe_decls in text:
    text = text.replace(modern_probe_decls, legacy_probe_decl, 1)

path.write_text(text)
print('TITLE_RUNTIME_ENDIAN_SPARSE_MMIO_OVERLAY=PASS')

# Overlay orchestration intentionally lives in build-xenia-ppc-bootstrap.sh.
# Do not invoke the HIR call/return or return-metadata passes from this script:
# applying them both here and from the build driver mutates the same generated
# translation unit twice and breaks exact-anchor instrumentation such as the
# initial-r1 trace. The build driver applies, in order, title memory ->
# call/return -> return metadata -> frame history exactly once each.
