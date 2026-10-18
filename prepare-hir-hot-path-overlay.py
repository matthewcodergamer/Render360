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

# On-stack replacement (hir_wasm_jit.h JitOsrFunction): a run that has
# interpreted many instructions, or an interior entry, continues in compiled
# code at the next block head. Without it a function entered once that loops
# (a thread's main loop, a wait loop) was interpreted for its whole life.
s = path.read_text()
osr_marker = 'R360_HOT_PATH_OSR'
if osr_marker not in s:
    builder_at = s.index('HIRCorrectnessResult ExecuteBuilder(xe::cpu::hir::HIRBuilder* builder,\n')
    decl_at = s.rindex('\n', 0, s.rindex('// R360_HOT_PATH_NOINLINE', 0, builder_at)) + 1
    s = (s[:decl_at] +
         '// ' + osr_marker + ' (prepare-hir-hot-path-overlay.py; defined in hir_jit_glue.inc).\n'
         '}  // namespace\n'
         'bool JitTryOsr(xe::cpu::hir::HIRBuilder* builder, JitSlot* slot,\n'
         '               const xe::cpu::hir::Block* block, bool hot, xe::Memory* memory,\n'
         '               xe::cpu::ppc::PPCContext& context, HIRCorrectnessResult* result);\n'
         'namespace {\n'
         '// Interpreted instructions in one run before it moves to compiled code.\n'
         'constexpr uint32_t kOsrInstructions = 1000;\n\n' + s[decl_at:])
    builder_at = s.index('HIRCorrectnessResult ExecuteBuilder(xe::cpu::hir::HIRBuilder* builder,\n')
    values = '  RuntimeValues values;\n'
    at = s.index(values, builder_at) + len(values)
    s = s[:at] + '  JitSlot* const osr_slot = JitTakeOsrSlot(builder);\n  bool osr_tried = false;\n' + s[at:]
    loop = '  while (block && supported && !reached_return) {\n    auto* next_block = block->next;\n'
    at = s.index(loop, builder_at)
    if s.count(loop) != 1:
        raise SystemExit('prepare-hir-hot-path-overlay: interpreter loop anchor not found exactly once')
    hook = ('  while (block && supported && !reached_return) {\n'
            '    if (osr_slot) {\n'
            '      // An interior entry starts at a block head: run it compiled once\n'
            '      // the owner is hot; a long run moves over at its next block.\n'
            '      const bool interior = first_execution_block && entry_instr;\n'
            '      const bool hot = !osr_tried && result.instructions_executed >= kOsrInstructions;\n'
            '      if (interior || hot) {\n'
            '        if (hot) osr_tried = true;\n'
            '        HIRCorrectnessResult compiled;\n'
            '        if (JitTryOsr(builder, osr_slot, block, hot, memory, context, &compiled)) {\n'
            '          compiled.instructions_executed = result.instructions_executed;\n'
            '          return compiled;\n'
            '        }\n'
            '      }\n'
            '    }\n'
            '    auto* next_block = block->next;\n')
    s = s[:at] + hook + s[at + len(loop):]
    path.write_text(s)
print('R360_HOT_PATH_OVERLAY applied')
