#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "src/xenia_web_bootstrap/probe_backend.cpp"
s = PATH.read_text()

def one(old: str, new: str, label: str):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, got {count}")
    s = s.replace(old, new, 1)

one('#include "xenia/cpu/function_debug_info.h"\n',
    '#include "xenia/cpu/function.h"\n#include "xenia/cpu/function_debug_info.h"\n',
    'function include')

one('''  const uint32_t call_flags = GetHIRCorrectnessCurrentCallFlags();
  const bool is_tail = (call_flags & xe::cpu::hir::CALL_TAIL) != 0;

  uint32_t fn_begin = address, fn_end = 0, prolog = 0;
''', '''  const uint32_t call_flags = GetHIRCorrectnessCurrentCallFlags();
  const bool is_tail = (call_flags & xe::cpu::hir::CALL_TAIL) != 0;

  // Xenia explicitly registers the Microsoft shared __restgprlr_* entries as
  // kEpilogReturn functions. They are valid tail-call entry points in their own
  // right: the caller has already restored r1 before branching into the helper,
  // and the helper consumes that live caller frame. Do not remap one of these
  // entries back to an enclosing .pdata owner and then jump into the middle of
  // the owner's HIR. Doing that skips HIR value definitions emitted before the
  // SOURCE_OFFSET marker and turns a valid stack load into a fake
  // guest-memory-dependency with faultAddress == 0.
  auto* target_function = g_probe_backend->processor()->QueryFunction(address);
  const bool is_epilog_return =
      target_function &&
      target_function->behavior() == xe::cpu::Function::Behavior::kEpilogReturn;

  uint32_t fn_begin = address, fn_end = 0, prolog = 0;
''', 'epilog detection')

one('''  // Only tail branches inherit the owning .pdata function. A linked call (`bl`)
  // is an ABI function-entry call, so preserve its exact target even if a
  // malformed/overlapping .pdata range happens to contain it. This restores
  // the working direct-call behavior while keeping V55's interior-tail fix.
  const bool use_owner = is_tail && pdata;
''', '''  // Ordinary tail fragments may inherit the owning .pdata function, but Xenia
  // shared epilog helpers are already canonical function entries. Keep those
  // exact, just like linked calls, while retaining the owner/interior route for
  // real compiler-generated tail fragments such as Braid's 0x8236EB74 path.
  const bool use_owner = is_tail && pdata && !is_epilog_return;
''', 'owner selection')

one('''               "R360_CALL_RESOLVE target=0x%08X function=0x%08X flags=0x%X "
               "tail=%u pdata=%u owner=%u prolog=%u\\n",
               address, fn_begin, call_flags, is_tail ? 1u : 0u,
               pdata ? 1u : 0u, use_owner ? 1u : 0u, prolog);
''', '''               "R360_CALL_RESOLVE target=0x%08X function=0x%08X flags=0x%X "
               "tail=%u epilog=%u pdata=%u owner=%u prolog=%u\\n",
               address, fn_begin, call_flags, is_tail ? 1u : 0u,
               is_epilog_return ? 1u : 0u, pdata ? 1u : 0u,
               use_owner ? 1u : 0u, prolog);
''', 'resolver telemetry')

PATH.write_text(s)
print('R360_V57_EPILOG_TAIL_PATCH=PASS')
