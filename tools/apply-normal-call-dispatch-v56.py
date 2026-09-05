#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


def write(path, text):
    (ROOT / path).write_text(text)


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count}")
    return text.replace(old, new, 1)


def between(text, start, end, replacement, label):
    i = text.find(start)
    j = text.find(end, i + len(start))
    if i < 0 or j < 0:
        raise SystemExit(f"{label}: boundary missing")
    return text[:i] + replacement + text[j:]


# V56: .pdata ownership is needed for non-linking tail branches that may land in
# compiler-generated interior fragments. A normal linked PPC `bl`, however,
# names the callee entry directly and must retain the pre-V55 exact-target path.
# Applying owning-function remapping to every call regressed Braid's first
# linked call (0x8236EF40 -> 0x8236CD50) to an unresolved guest call.

header_path = "src/xenia_web_bootstrap/hir_correctness_executor.h"
h = read(header_path)
h = one(
    h,
    "void SetHIRCorrectnessExecutionEntry(uint32_t guest_address);\nbool IsHIRCorrectnessExecutionActive();",
    "void SetHIRCorrectnessExecutionEntry(uint32_t guest_address);\n"
    "uint32_t GetHIRCorrectnessCurrentCallFlags();\n"
    "bool IsHIRCorrectnessExecutionActive();",
    "HIR current-call-flags API",
)
write(header_path, h)

backend_path = "src/xenia_web_bootstrap/probe_backend.cpp"
s = read(backend_path)
s = one(
    s,
    '#include "xenia/cpu/hir/instr.h"\n',
    '#include "xenia/cpu/hir/instr.h"\n#include "xenia/cpu/hir/opcodes.h"\n',
    "backend HIR opcode include",
)
start = "  uint32_t fn_begin=address,fn_end=0,prolog=0;\n"
end = "}\nbool ResolveNestedGuestCall"
replacement = r'''  const uint32_t call_flags = GetHIRCorrectnessCurrentCallFlags();
  const bool is_tail = (call_flags & xe::cpu::hir::CALL_TAIL) != 0;

  uint32_t fn_begin = address, fn_end = 0, prolog = 0;
  bool pdata = PreparedPeGuestFindRuntimeFunction(address, &fn_begin, &fn_end,
                                                  &prolog);
  if (pdata &&
      (fn_end <= fn_begin || uint64_t(fn_end) - fn_begin > kProbeGuestSize)) {
    pdata = false;
    fn_begin = address;
    fn_end = 0;
    prolog = 0;
  }

  // Only tail branches inherit the owning .pdata function. A linked call (`bl`)
  // is an ABI function-entry call, so preserve its exact target even if a
  // malformed/overlapping .pdata range happens to contain it. This restores
  // the working direct-call behavior while keeping V55's interior-tail fix.
  const bool use_owner = is_tail && pdata;
  if (!use_owner) {
    fn_begin = address;
    fn_end = 0;
    prolog = 0;
  }

  auto loaded = [&]() {
    return IsInLoadedProbeWindow(fn_begin) &&
           (!use_owner ||
            (fn_end >= fn_begin + 4 && IsInLoadedProbeWindow(fn_end - 4)));
  };
  std::fprintf(stderr,
               "R360_CALL_RESOLVE target=0x%08X function=0x%08X flags=0x%X "
               "tail=%u pdata=%u owner=%u prolog=%u\n",
               address, fn_begin, call_flags, is_tail ? 1u : 0u,
               pdata ? 1u : 0u, use_owner ? 1u : 0u, prolog);

  if (!loaded()) {
    const uint32_t paged = r360_ppc_probe_page_sparse_code(fn_begin);
    if (!paged || !loaded()) {
      std::fprintf(stderr,
                   "R360_CALL_RESOLVE rejected: target/function unavailable "
                   "target=0x%08X function=0x%08X owner=%u\n",
                   address, fn_begin, use_owner ? 1u : 0u);
      return false;
    }
  }

  ProbeGuestFunction nested_function(module, fn_begin);
  const uint32_t loaded_base = r360_ppc_probe_guest_base();
  const uint32_t loaded_size = r360_ppc_probe_loaded_size();
  if (loaded_size < 4) return false;
  const uint32_t scan_end =
      use_owner ? fn_end - 4 : loaded_base + loaded_size - 4;
  nested_function.set_end_address(scan_end);

  xe::cpu::ppc::PPCScanner scanner(frontend);
  if (!scanner.Scan(&nested_function, nullptr)) {
    std::fprintf(stderr,
                 "R360_CALL_RESOLVE scan failed target=0x%08X function=0x%08X "
                 "owner=%u\n",
                 address, fn_begin, use_owner ? 1u : 0u);
    return false;
  }
  if (use_owner && nested_function.end_address() < address) {
    nested_function.set_end_address(scan_end);
  }

  const uint32_t interior_entry =
      use_owner && address != fn_begin ? address : 0u;
  SetHIRCorrectnessExecutionEntry(interior_entry);
  const bool translated = frontend->DefineFunction(&nested_function, 0);
  SetHIRCorrectnessExecutionEntry(0u);
  std::fprintf(stderr,
               "R360_CALL_RESOLVE translated target=0x%08X function=0x%08X "
               "end=0x%08X flags=0x%X owner=%u interior=0x%08X result=%u\n",
               address, fn_begin, nested_function.end_address(), call_flags,
               use_owner ? 1u : 0u, interior_entry, translated ? 1u : 0u);
  return translated;
'''
s = between(s, start, end, replacement, "nested call dispatch")
write(backend_path, s)

# The HIR executor already receives CALL_TAIL flags before invoking the resolver.
# Preserve those flags as thread-local one-shot call context so ProbeBackend can
# choose exact-entry vs owning-function translation without changing the public
# resolver callback signatures.
overlay_path = "prepare-hir-tail-frame-overlay.py"
o = read(overlay_path)
o = one(
    o,
    "thread_local uint32_t g_requested_execution_entry=0;\nuint32_t CurrentLogicalGuestDepth();",
    "thread_local uint32_t g_requested_execution_entry=0;\n"
    "thread_local uint32_t g_current_call_flags=0;\n"
    "uint32_t CurrentLogicalGuestDepth();",
    "overlay call-flags state",
)
o = one(
    o,
    "void PrepareNestedLogicalDepth(uint32_t flags){const uint32_t d=CurrentLogicalGuestDepth();g_pending_logical_depth=d+((flags&xe::cpu::hir::CALL_TAIL)?0u:1u);if(!g_pending_logical_depth)g_pending_logical_depth=1;g_pending_logical_depth_valid=true;}",
    "void PrepareNestedLogicalDepth(uint32_t flags){g_current_call_flags=flags;const uint32_t d=CurrentLogicalGuestDepth();g_pending_logical_depth=d+((flags&xe::cpu::hir::CALL_TAIL)?0u:1u);if(!g_pending_logical_depth)g_pending_logical_depth=1;g_pending_logical_depth_valid=true;}",
    "overlay capture call flags",
)
o = one(
    o,
    "void SetHIRCorrectnessExecutionEntry(uint32_t guest_address){g_requested_execution_entry=guest_address;}\n\nbool IsHIRCorrectnessExecutionActive()",
    "void SetHIRCorrectnessExecutionEntry(uint32_t guest_address){g_requested_execution_entry=guest_address;}\n"
    "uint32_t GetHIRCorrectnessCurrentCallFlags(){return g_current_call_flags;}\n\n"
    "bool IsHIRCorrectnessExecutionActive()",
    "overlay call-flags getter",
)
write(overlay_path, o)

print("NORMAL_CALL_DISPATCH_V56=PASS")
