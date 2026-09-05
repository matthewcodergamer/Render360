#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "src/xenia_web_bootstrap/probe_backend.cpp"
s = PATH.read_text()


def replace_once(old: str, new: str, label: str):
    global s
    if new in s:
        print(f"{label}: already applied")
        return
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count}")
    s = s.replace(old, new, 1)
    print(f"{label}: applied")


if '#include "sparse_guest_memory.h"\n' not in s:
    replace_once(
        '#include "kernel_import_probe.h"\n',
        '#include "kernel_import_probe.h"\n#include "sparse_guest_memory.h"\n',
        'sparse memory include',
    )

if 'bool ExecuteSharedEpilogReturn(uint32_t address)' not in s:
    raise SystemExit('V58 base epilog bridge is missing; refusing to guess source layout')

# Xenia's canonical __restgprlr_N tail is `lwz r12,-8(r1); mtlr r12; blr`.
# LR is therefore a 32-bit spill here. Correct only the two unique helper lines
# so harmless source formatting changes cannot break this patch.
if 'uint8_t lr_raw[8] = {};' in s:
    replace_once('uint8_t lr_raw[8] = {};', 'uint8_t lr_raw[4] = {};',
                 '32-bit LR buffer')
elif 'uint8_t lr_raw[4] = {};' not in s:
    raise SystemExit('32-bit LR buffer: helper declaration not found')
else:
    print('32-bit LR buffer: already correct')

if 'context->lr = ReadBigEndian64(lr_raw);' in s:
    replace_once('context->lr = ReadBigEndian64(lr_raw);',
                 'context->lr = ReadBigEndian32(lr_raw);',
                 '32-bit LR decode')
elif 'context->lr = ReadBigEndian32(lr_raw);' not in s:
    raise SystemExit('32-bit LR decode: helper assignment not found')
else:
    print('32-bit LR decode: already correct')

# Braid branches to an interior __restgprlr_N label (0x8234F5AC). Depending on
# registration timing, QueryFunction(address) may not expose kEpilogReturn for
# that exact interior label. Recognize the canonical helper from its complete
# PPC instruction signature as a strict, fail-closed fallback.
if 'bool MatchSharedEpilogReturnSignature(' not in s:
    anchor = '''uint64_t ReadBigEndian64(const uint8_t* p) {
  return (uint64_t(ReadBigEndian32(p)) << 32) | ReadBigEndian32(p + 4);
}

bool ExecuteSharedEpilogReturn(uint32_t address) {
'''
    insertion = '''uint64_t ReadBigEndian64(const uint8_t* p) {
  return (uint64_t(ReadBigEndian32(p)) << 32) | ReadBigEndian32(p + 4);
}

bool MatchSharedEpilogReturnSignature(uint32_t address,
                                      uint32_t* first_gpr_out) {
  auto read_word = [](uint32_t code_address, uint32_t* out) {
    if (!out) return false;
    uint8_t raw[4] = {};
    if (!ReadSparseGuestMemory(code_address, raw, sizeof(raw))) return false;
    *out = ReadBigEndian32(raw);
    return true;
  };

  uint32_t first = 0;
  if (!read_word(address, &first)) return false;
  const uint32_t first_gpr = (first >> 21) & 31u;
  if (first_gpr < 14u || first_gpr > 31u) return false;

  for (uint32_t reg = first_gpr; reg <= 31u; ++reg) {
    const uint32_t code_address = address + (reg - first_gpr) * 4u;
    uint32_t word = 0;
    if (!read_word(code_address, &word)) return false;
    const uint32_t primary = word >> 26;
    const uint32_t rt = (word >> 21) & 31u;
    const uint32_t ra = (word >> 16) & 31u;
    const uint32_t xo = word & 3u;
    int32_t disp = static_cast<int32_t>(word & 0x0000FFFCu);
    if (disp & 0x00008000) disp |= static_cast<int32_t>(0xFFFF0000u);
    const int32_t expected_disp = -16 - int32_t(31u - reg) * 8;
    if (primary != 58u || rt != reg || ra != 1u || xo != 0u ||
        disp != expected_disp) {
      return false;
    }
  }

  const uint32_t tail = address + (32u - first_gpr) * 4u;
  constexpr uint32_t kExpectedTail[] = {
      0x8181FFF8u,  // lwz r12,-8(r1)
      0x7D8803A6u,  // mtlr r12
      0x4E800020u,  // blr
  };
  for (uint32_t i = 0; i < 3u; ++i) {
    uint32_t word = 0;
    if (!read_word(tail + i * 4u, &word) || word != kExpectedTail[i]) {
      return false;
    }
  }

  if (first_gpr_out) *first_gpr_out = first_gpr;
  return true;
}

bool ExecuteSharedEpilogReturn(uint32_t address) {
'''
    replace_once(anchor, insertion, 'strict shared-epilog signature matcher')
else:
    print('strict shared-epilog signature matcher: already applied')

old_detection = '''  auto* target_function = g_probe_backend->processor()->QueryFunction(address);
  const bool is_epilog_return =
      target_function &&
      target_function->behavior() == xe::cpu::Function::Behavior::kEpilogReturn;

  if (is_tail && is_epilog_return) {
    const bool helper_ok = ExecuteSharedEpilogReturn(address);
    std::fprintf(stderr,
                 "R360_CALL_RESOLVE epilog-inline target=0x%08X flags=0x%X result=%u\\n",
                 address, call_flags, helper_ok ? 1u : 0u);
    return helper_ok;
  }
'''
new_detection = '''  auto* target_function = g_probe_backend->processor()->QueryFunction(address);
  const bool epilog_by_metadata =
      target_function &&
      target_function->behavior() == xe::cpu::Function::Behavior::kEpilogReturn;
  uint32_t signature_first_gpr = 0;
  const bool epilog_by_signature =
      is_tail && MatchSharedEpilogReturnSignature(address, &signature_first_gpr);
  const bool is_epilog_return = epilog_by_metadata || epilog_by_signature;

  if (is_tail && is_epilog_return) {
    const bool helper_ok = ExecuteSharedEpilogReturn(address);
    std::fprintf(stderr,
                 "R360_CALL_RESOLVE epilog-inline target=0x%08X flags=0x%X meta=%u signature=%u first_gpr=%u result=%u\\n",
                 address, call_flags, epilog_by_metadata ? 1u : 0u,
                 epilog_by_signature ? 1u : 0u, signature_first_gpr,
                 helper_ok ? 1u : 0u);
    return helper_ok;
  }
'''
if old_detection in s:
    replace_once(old_detection, new_detection, 'signature fallback routing')
elif new_detection in s:
    print('signature fallback routing: already applied')
else:
    raise SystemExit('signature fallback routing: expected resolver block not found')

PATH.write_text(s)
print('R360_V58_EPILOG_INLINE_PATCH=PASS')
