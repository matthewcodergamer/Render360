#!/usr/bin/env python3
"""Generate the browser-only PPC HIR builder fail-closed overlay.

Desktop Xenia intentionally breaks into a host debugger when a PPC instruction
has no HIR emitter. In standalone wasm32 there is no native debugger to resume,
so Emscripten lowers that DebugBreak path to a WebAssembly trap. Safari then
surfaces only "Unreachable code should not be executed", losing the guest PPC
address that actually needs implementation.

Render360 must never silently skip an unsupported guest instruction. For the
browser target, report the exact PPC address/opcode and fail translation cleanly
instead. Native Xenia behavior is left unchanged.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "upstream/xenia/src/xenia/cpu/ppc/ppc_hir_builder.cc"
DEST = ROOT / "build/xenia-web-overlay/xenia/cpu/ppc/ppc_hir_builder.cc"

if not SOURCE.exists():
    raise SystemExit("Run ./fetch-xenia.sh first; upstream ppc_hir_builder.cc is missing")

text = SOURCE.read_text(errors="strict")

namespace_anchor = "namespace xe {\n"
reporter_decl = (
    'extern "C" void r360_ppc_probe_report_unimplemented(uint32_t address, '\
    'uint32_t code);\n\n'
)
if namespace_anchor not in text:
    raise SystemExit("Upstream ppc_hir_builder.cc namespace anchor drifted")
if reporter_decl not in text:
    text = text.replace(namespace_anchor, reporter_decl + namespace_anchor, 1)

old = '''      if (cvars::break_on_unimplemented_instructions) {
        DebugBreak();
      }
'''
new = '''#if defined(__EMSCRIPTEN__) || defined(XE_ARCH_WASM32)
      // Render360 browser: a host DebugBreak becomes an unrecoverable wasm
      // `unreachable` trap. Preserve correctness by stopping this translation
      // and publishing the exact guest instruction instead of skipping it.
      r360_ppc_probe_report_unimplemented(address, code);
      return false;
#else
      if (cvars::break_on_unimplemented_instructions) {
        DebugBreak();
      }
#endif
'''
if old not in text:
    if new not in text:
        raise SystemExit("Upstream PPC unimplemented-instruction block drifted")
else:
    text = text.replace(old, new, 1)

DEST.parent.mkdir(parents=True, exist_ok=True)
DEST.write_text(text)
print(f"Generated browser PPC HIR fail-closed overlay: {DEST}")
print("PPC rule: unsupported guest instructions report address/code and return translation failure; wasm never DebugBreaks")
