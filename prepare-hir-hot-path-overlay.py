#!/usr/bin/env python3
"""Hot-path fixes for the HIR executor overlay (applied after the JIT overlay).

ExecuteHIRCorrectnessProbe runs for every guest call, compiled or not. It
declared `PPCContext local_context{}` unconditionally, zero-filling a whole
PPC register file (GPRs, FPRs, 128 vector registers) per call although only
the outermost call of a thread uses it. The storage stays on the stack (each
fiber's outermost call needs its own), but it is only initialised there.
"""
from pathlib import Path

path = Path(__file__).resolve().parent / 'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
s = path.read_text()
marker = 'R360_HOT_PATH_OVERLAY'
if marker not in s:
    old = '  xe::cpu::ppc::PPCContext local_context{};\n  if (outermost) {\n'
    new = ('  // ' + marker + ': initialised only by the outermost call (see\n'
           '  // prepare-hir-hot-path-overlay.py).\n'
           '  alignas(xe::cpu::ppc::PPCContext) unsigned char\n'
           '      local_context_storage[sizeof(xe::cpu::ppc::PPCContext)];\n'
           '  xe::cpu::ppc::PPCContext& local_context =\n'
           '      *reinterpret_cast<xe::cpu::ppc::PPCContext*>(local_context_storage);\n'
           '  if (outermost) {\n'
           '    new (&local_context) xe::cpu::ppc::PPCContext{};\n')
    if s.count(old) != 1:
        raise SystemExit('prepare-hir-hot-path-overlay: PPCContext anchor not found exactly once')
    s = s.replace(old, new, 1)
    if '#include <new>' not in s:
        s = '#include <new>\n' + s
    path.write_text(s)

# The interpreter (ExecuteBuilder) runs well under 1% of guest instructions
# once the JIT is warm, but it was inlined into ExecuteHIRCorrectnessProbe,
# the per-call entry, which made every call pay for its frame.
s = path.read_text()
noinline_marker = 'R360_HOT_PATH_NOINLINE'
if noinline_marker not in s:
    old = 'HIRCorrectnessResult ExecuteBuilder(xe::cpu::hir::HIRBuilder* builder,\n'
    if s.count(old) != 1:
        raise SystemExit('prepare-hir-hot-path-overlay: ExecuteBuilder anchor not found exactly once')
    s = s.replace(old, '// ' + noinline_marker + ': kept out of the per-call entry.\n'
                  '__attribute__((noinline)) ' + old, 1)
    path.write_text(s)
print('R360_HOT_PATH_OVERLAY applied')
