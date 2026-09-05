#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "src/xenia_web_bootstrap/probe_backend.cpp"
s = PATH.read_text()

def one(old: str, new: str, label: str):
    global s
    if new in s:
        print(f"{label}: already applied")
        return
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count}")
    s = s.replace(old, new, 1)

one('#include "kernel_import_probe.h"\n',
    '#include "kernel_import_probe.h"\n#include "sparse_guest_memory.h"\n',
    'sparse memory include')

one('''bool IsInLoadedProbeWindow(uint32_t address) {
  const uint32_t base = r360_ppc_probe_guest_base();
  const uint64_t end = uint64_t(base) + r360_ppc_probe_loaded_size();
  return address >= base && uint64_t(address) < end;
}

bool TranslateNestedGuestAddress(uint32_t address, xe::cpu::Module* module) {
''', '''bool IsInLoadedProbeWindow(uint32_t address) {
  const uint32_t base = r360_ppc_probe_guest_base();
  const uint64_t end = uint64_t(base) + r360_ppc_probe_loaded_size();
  return address >= base && uint64_t(address) < end;
}

uint32_t ReadBigEndian32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
         (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

uint64_t ReadBigEndian64(const uint8_t* p) {
  return (uint64_t(ReadBigEndian32(p)) << 32) | ReadBigEndian32(p + 4);
}

bool ExecuteSharedEpilogReturn(uint32_t address) {
  auto* context = GetHIRCorrectnessActiveContext();
  if (!context) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER rejected target=0x%08X reason=no-context\\n",
                 address);
    return false;
  }

  // Microsoft __restgprlr_N helpers are canonical Xenia kEpilogReturn
  // functions. The entry instruction identifies N as an `ld rN,disp(r1)`;
  // the helper then restores rN..r31, restores LR from -8(r1), and returns.
  // Execute those semantics against the live caller PPCContext instead of
  // constructing a standalone HIR builder for an interior helper entry.
  uint8_t first_raw[4] = {};
  if (!ReadSparseGuestMemory(address, first_raw, sizeof(first_raw))) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER rejected target=0x%08X reason=code-unmapped fault=%u@0x%08X\\n",
                 address, SparseGuestLastFaultCode(), SparseGuestLastFaultAddress());
    return false;
  }
  const uint32_t first = ReadBigEndian32(first_raw);
  const uint32_t primary = first >> 26;
  const uint32_t first_gpr = (first >> 21) & 31u;
  const uint32_t ra = (first >> 16) & 31u;
  int32_t first_disp = static_cast<int32_t>(first & 0x0000FFFCu);
  if (first_disp & 0x00008000) first_disp |= static_cast<int32_t>(0xFFFF0000u);
  const int32_t expected_disp = -16 - int32_t(31u - first_gpr) * 8;
  if (primary != 58u || ra != 1u || first_gpr < 14u || first_gpr > 31u ||
      first_disp != expected_disp) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER rejected target=0x%08X insn=0x%08X rt=%u ra=%u disp=%d expected=%d\\n",
                 address, first, first_gpr, ra, first_disp, expected_disp);
    return false;
  }

  const uint32_t r1 = static_cast<uint32_t>(context->r[1]);
  for (uint32_t reg = first_gpr; reg <= 31u; ++reg) {
    const int32_t disp = -16 - int32_t(31u - reg) * 8;
    const uint32_t ea = r1 + static_cast<uint32_t>(disp);
    uint8_t raw[8] = {};
    if (!ReadSparseGuestMemory(ea, raw, sizeof(raw))) {
      std::fprintf(stderr,
                   "R360_EPILOG_HELPER load-fail target=0x%08X r%u ea=0x%08X fault=%u@0x%08X\\n",
                   address, reg, ea, SparseGuestLastFaultCode(),
                   SparseGuestLastFaultAddress());
      return false;
    }
    context->r[reg] = ReadBigEndian64(raw);
  }

  const uint32_t lr_ea = r1 - 8u;
  uint8_t lr_raw[8] = {};
  if (!ReadSparseGuestMemory(lr_ea, lr_raw, sizeof(lr_raw))) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER lr-fail target=0x%08X ea=0x%08X fault=%u@0x%08X\\n",
                 address, lr_ea, SparseGuestLastFaultCode(),
                 SparseGuestLastFaultAddress());
    return false;
  }
  context->lr = ReadBigEndian64(lr_raw);
  std::fprintf(stderr,
               "R360_EPILOG_HELPER executed target=0x%08X first_gpr=%u r1=0x%08X lr=0x%08X\\n",
               address, first_gpr, r1, static_cast<uint32_t>(context->lr));
  return true;
}

bool TranslateNestedGuestAddress(uint32_t address, xe::cpu::Module* module) {
''', 'epilog helper implementation')

one('''  const bool is_epilog_return =
      target_function &&
      target_function->behavior() == xe::cpu::Function::Behavior::kEpilogReturn;

  uint32_t fn_begin = address, fn_end = 0, prolog = 0;
''', '''  const bool is_epilog_return =
      target_function &&
      target_function->behavior() == xe::cpu::Function::Behavior::kEpilogReturn;

  if (is_tail && is_epilog_return) {
    const bool helper_ok = ExecuteSharedEpilogReturn(address);
    std::fprintf(stderr,
                 "R360_CALL_RESOLVE epilog-inline target=0x%08X flags=0x%X result=%u\\n",
                 address, call_flags, helper_ok ? 1u : 0u);
    return helper_ok;
  }

  uint32_t fn_begin = address, fn_end = 0, prolog = 0;
''', 'epilog helper fast path')

one('''  const uint32_t lr_ea = r1 - 8u;
  uint8_t lr_raw[4] = {};
  if (!ReadSparseGuestMemory(lr_ea, lr_raw, sizeof(lr_raw))) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER lr-fail target=0x%08X ea=0x%08X fault=%u@0x%08X\\n",
                 address, lr_ea, SparseGuestLastFaultCode(),
                 SparseGuestLastFaultAddress());
    return false;
  }
  context->lr = ReadBigEndian32(lr_raw);
''', '''  const uint32_t lr_ea = r1 - 8u;
  uint8_t lr_raw[8] = {};
  if (!ReadSparseGuestMemory(lr_ea, lr_raw, sizeof(lr_raw))) {
    std::fprintf(stderr,
                 "R360_EPILOG_HELPER lr-fail target=0x%08X ea=0x%08X fault=%u@0x%08X\\n",
                 address, lr_ea, SparseGuestLastFaultCode(),
                 SparseGuestLastFaultAddress());
    return false;
  }
  context->lr = ReadBigEndian64(lr_raw);
''', 'full 64-bit LR restore')

PATH.write_text(s)
print('R360_V58_EPILOG_INLINE_PATCH=PASS')

# Retriggered after the September 5 real-device report confirmed the browser
# UI said V58 while the published WASM provenance was still the V57 source.
