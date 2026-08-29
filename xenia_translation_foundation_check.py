#!/usr/bin/env python3
from pathlib import Path
import sys

# Render360 browser runtime sync point: changing this gate intentionally rebuilds
# and republishes the verified browser bootstrap so deployed JS/WASM stay aligned.
ROOT = Path(__file__).resolve().parent
XENIA = ROOT / 'upstream' / 'xenia'
BUILD = ROOT / 'build-xenia-ppc-bootstrap.sh'
LINK = ROOT / 'link-xenia-ppc-bootstrap.sh'
TEST = ROOT / 'test-xenia-ppc-translation-probe.mjs'

EXPECTED_UPSTREAM = [
    'src/xenia/cpu/ppc/ppc_context.cc',
    'src/xenia/cpu/ppc/ppc_opcode_table_gen.cc',
    'src/xenia/cpu/ppc/ppc_opcode_lookup_gen.cc',
    'src/xenia/cpu/ppc/ppc_opcode_disasm_gen.cc',
    'src/xenia/cpu/ppc/ppc_opcode_disasm.cc',
    'src/xenia/cpu/ppc/ppc_opcode_info.cc',
    'src/xenia/cpu/ppc/ppc_emit_alu.cc',
    'src/xenia/cpu/ppc/ppc_emit_control.cc',
    'src/xenia/cpu/ppc/ppc_emit_memory.cc',
    'src/xenia/cpu/ppc/ppc_emit_fpu.cc',
    'src/xenia/cpu/ppc/ppc_emit_altivec.cc',
    'src/xenia/cpu/ppc/ppc_scanner.cc',
    'src/xenia/cpu/ppc/ppc_hir_builder.cc',
    'src/xenia/cpu/ppc/ppc_translator.cc',
    'src/xenia/cpu/ppc/ppc_frontend.cc',
    'src/xenia/cpu/hir/opcodes.cc',
    'src/xenia/cpu/hir/block.cc',
    'src/xenia/cpu/hir/instr.cc',
    'src/xenia/cpu/hir/value.cc',
    'src/xenia/cpu/hir/hir_builder.cc',
    'src/xenia/cpu/compiler/compiler.cc',
    'src/xenia/cpu/compiler/compiler_pass.cc',
    'src/xenia/cpu/compiler/passes/conditional_group_pass.cc',
    'src/xenia/cpu/compiler/passes/conditional_group_subpass.cc',
    'src/xenia/cpu/compiler/passes/constant_propagation_pass.cc',
    'src/xenia/cpu/compiler/passes/context_promotion_pass.cc',
    'src/xenia/cpu/compiler/passes/control_flow_analysis_pass.cc',
    'src/xenia/cpu/compiler/passes/control_flow_simplification_pass.cc',
    'src/xenia/cpu/compiler/passes/data_flow_analysis_pass.cc',
    'src/xenia/cpu/compiler/passes/dead_code_elimination_pass.cc',
    'src/xenia/cpu/compiler/passes/finalization_pass.cc',
    'src/xenia/cpu/compiler/passes/memory_sequence_combination_pass.cc',
    'src/xenia/cpu/compiler/passes/register_allocation_pass.cc',
    'src/xenia/cpu/compiler/passes/simplification_pass.cc',
    'src/xenia/cpu/compiler/passes/validation_pass.cc',
    'src/xenia/cpu/compiler/passes/value_reduction_pass.cc',
]
EXPECTED_RENDER360 = [
    'src/xenia_web_bootstrap/browser_logging.cpp',
    'src/xenia_web_bootstrap/browser_threading_sleep.cpp',
    'src/xenia_web_bootstrap/hir_correctness_executor.cpp',
    'src/xenia_web_bootstrap/probe_backend.cpp',
    'src/xenia_web_bootstrap/ppc_translation_probe.cpp',
    'src/xenia_web_bootstrap/ppc_context_abi_probe.cpp',
]
REQUIRED_TEST_MARKERS = [
    'runtime-addi-r4-plus-5', 'branch-equal-taken',
    'stw-lwz-xenia-memory-roundtrip', 'ctr-bdnz-loop-three-iterations',
    'direct-bl-callee-blr-caller', 'nested-bl-two-level-call-return',
    'fpu-lfd-fadd-stfd-three', 'fpu-lfd-fsub-stfd-three',
    'fpu-lfd-fmul-stfd-three', 'vmx-lvx-vaddubm-stvx-bytes',
]


def fail(message: str) -> None:
    print(f'FAIL: {message}', file=sys.stderr)
    raise SystemExit(1)


if not XENIA.exists():
    fail('upstream Xenia is missing; run fetch-xenia.sh first')
for path in EXPECTED_UPSTREAM:
    if not (XENIA / path).is_file():
        fail(f'missing required upstream translation source: {path}')
for path in EXPECTED_RENDER360:
    if not (ROOT / path).is_file():
        fail(f'missing required browser translation source: {path}')

build_text = BUILD.read_text(encoding='utf-8')
for path in EXPECTED_UPSTREAM:
    if f'"{path}"' not in build_text:
        fail(f'build matrix no longer includes: {path}')
for path in EXPECTED_RENDER360:
    label = path.replace('src/xenia_web_bootstrap/', 'render360/')
    if label not in build_text:
        fail(f'build matrix no longer includes browser unit: {label}')

# V43 intentionally stopped mirroring the build object/API inventory in a
# second hand-written linker list. The link now discovers every externally
# defined r360_* symbol from the compiled objects, while a critical production
# set must be present before Emscripten is allowed to emit the browser WASM.
link_text = LINK.read_text(encoding='utf-8')
required_link_markers = [
    'ERROR_ON_UNDEFINED_SYMBOLS=1',
    'llvm-nm',
    'R360_SYMBOLS',
    'CRITICAL_EXPORTS',
    "grep -E '^r360_[A-Za-z0-9_]+$'",
    'r360_ppc_probe_set_execute_on_translate',
    'r360_ppc_probe_execute_on_translate',
    'r360_guest_thread_entry',
    'r360_guest_thread_context',
    'r360_guest_thread_stack_base',
    'r360_guest_thread_stack_top',
    'r360_guest_thread_stack_mapped',
    'r360_wasm_backend_cfg_continuation_slot_count',
    'r360_wasm_backend_cfg_continuation_state_size',
    'r360_wasm_backend_cfg_continuation_ptr',
    'r360_wasm_backend_cfg_continuation_status',
    'r360_wasm_backend_cfg_continuation_reset',
]
for marker in required_link_markers:
    if marker not in link_text:
        fail(f'strict synchronized link contract marker missing: {marker}')

# The old linker audit also repeated two compiler object filenames. Their
# authoritative coverage is the source matrix above; keep that single source of
# truth and verify the linker instead by its strict/discovered ABI contract.

test_text = TEST.read_text(encoding='utf-8')
for marker in REQUIRED_TEST_MARKERS:
    if marker not in test_text:
        fail(f'required end-to-end PPC runtime category disappeared: {marker}')

pass_dir = XENIA / 'src/xenia/cpu/compiler/passes'
upstream_passes = sorted(p.relative_to(XENIA).as_posix() for p in pass_dir.glob('*.cc'))
listed_passes = sorted(p for p in EXPECTED_UPSTREAM if '/compiler/passes/' in p)
missing_passes = [p for p in upstream_passes if p not in listed_passes]
extra_passes = [p for p in listed_passes if p not in upstream_passes]
if missing_passes:
    fail('new/untracked upstream compiler pass(es): ' + ', '.join(missing_passes))
if extra_passes:
    fail('foundation manifest references missing compiler pass(es): ' + ', '.join(extra_passes))

emitters = sorted(p.name for p in (XENIA / 'src/xenia/cpu/ppc').glob('ppc_emit_*.cc'))
required_emitters = sorted([
    'ppc_emit_alu.cc', 'ppc_emit_control.cc', 'ppc_emit_memory.cc',
    'ppc_emit_fpu.cc', 'ppc_emit_altivec.cc',
])
if any(name not in emitters for name in required_emitters):
    fail('one or more required PPC emitter categories disappeared from upstream Xenia')

print('PPC_TRANSLATION_FOUNDATION=PASS')
print(f'upstream_translation_units_manifested={len(EXPECTED_UPSTREAM)}')
print(f'browser_translation_units_manifested={len(EXPECTED_RENDER360)}')
print(f'compiler_passes_manifested={len(listed_passes)}')
print(f'end_to_end_runtime_categories={len(REQUIRED_TEST_MARKERS)}')
print('link_export_contract=auto-discovered-r360-symbols+critical-production-gate')
print('PASS: frontend, translator, scanner, all five PPC emit categories, HIR, every current upstream compiler-pass implementation, strict synchronized link contract, and representative real-PPC runtime categories are locked by drift detection.')
