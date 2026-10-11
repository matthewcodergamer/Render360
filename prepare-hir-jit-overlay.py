#!/usr/bin/env python3
"""Render360 guest JIT hook for the HIR executor overlay.

ExecuteHIRCorrectnessProbe runs a builder through compiled WebAssembly
(src/xenia_web_bootstrap/hir_wasm_jit.cpp) when the translation cache has
compiled code for it, and through ExecuteBuilder otherwise. Interior entries
and context-provenance recovery always use ExecuteBuilder. The helpers the
generated code calls (hir_jit_glue.inc) are appended to this translation unit
so they share the executor's state and semantics.
"""
from pathlib import Path

root = Path(__file__).resolve().parent
path = root / 'build/xenia-web-overlay/render360/hir_correctness_executor_vmx.cpp'
text = path.read_text()
if 'R360_GUEST_JIT_HOOK' in text:
    raise SystemExit(0)

def replace_once(old, new, label):
    global text
    if old not in text:
        raise SystemExit(f'guest JIT overlay: {label} anchor changed')
    text = text.replace(old, new, 1)

replace_once('#include "hir_correctness_executor.h"\n',
             '#include "hir_correctness_executor.h"\n#include "hir_wasm_jit.h"\n#include "kernel_xboxkrnl_services.h"\n#include "guest_fibers.h"\n',
             'include')
replace_once('HIRCorrectnessResult ExecuteHIRCorrectnessProbe(\n',
             '// R360_GUEST_JIT_HOOK\nbool JitTryExecute(xe::cpu::hir::HIRBuilder* builder, xe::Memory* memory,\n'
             '                   xe::cpu::ppc::PPCContext& context, HIRCorrectnessResult* result);\n'
             'void JitProfileInterpreted(xe::cpu::hir::HIRBuilder* builder, uint32_t reason, uint32_t instructions);\n'
             'HIRCorrectnessResult ExecuteHIRCorrectnessProbe(\n',
             'probe declaration')
replace_once('  result = ExecuteBuilder(builder, memory, *g_active_context, execution_entry);\n',
             '  if (execution_entry ||\n'
             '      !JitTryExecute(builder, memory, *g_active_context, &result)) {\n'
             '    const uint32_t jit_decision = execution_entry ? 0u : JitLastDecision();\n'
             '    result = ExecuteBuilder(builder, memory, *g_active_context, execution_entry);\n'
             '    JitProfileInterpreted(builder, jit_decision, result.instructions_executed);\n'
             '  }\n',
             'ExecuteBuilder call')
# The guest JIT runs every non-control-flow instruction it does not lower
# natively through ExecuteBuilder's own per-instruction dispatch, so vector
# (VMX) and other rare HIR keeps the executor's exact semantics. Extract that
# dispatch into a function of its own.
builder_at = text.index('HIRCorrectnessResult ExecuteBuilder(')
start_marker = '      if (ExecuteFlaggedOperation(instr, values, &supported)) {\n'
end_marker = '      if (!supported && result.blocker_kind == kHIRBlockerNone) {\n'
start = text.index(start_marker, builder_at)
end = text.index(end_marker, start)
dispatch = text[start:end]
single = ('// Generated from ExecuteBuilder (prepare-hir-jit-overlay.py): one HIR\n'
          '// instruction with the executor\'s semantics, for guest JIT helpers.\n'
          'bool JitExecuteSingle(xe::cpu::hir::Instr* instr, RuntimeValues& values,\n'
          '                      xe::Memory* memory, xe::cpu::ppc::PPCContext& context) {\n'
          '  HIRCorrectnessResult result;\n'
          '  bool supported = true;\n'
          '  bool reached_return = false;\n'
          '  bool block_terminated = false;\n'
          '  uint32_t current_source_address = g_current_source_address;\n'
          '  xe::cpu::hir::Block* next_block = nullptr;\n'
          '  do {\n' + dispatch + '  } while (false);\n'
          '  (void)result; (void)reached_return; (void)block_terminated; (void)next_block;\n'
          '  (void)current_source_address;\n'
          '  return supported;\n'
          '}\n\n')
hook = '// R360_GUEST_JIT_HOOK\n'
text = text.replace(hook, single + hook, 1)
text += (root / 'src/xenia_web_bootstrap/hir_jit_glue.inc').read_text()
path.write_text(text)
print('Guest JIT hook: compiled HIR runs in place of ExecuteBuilder for plain entries')
