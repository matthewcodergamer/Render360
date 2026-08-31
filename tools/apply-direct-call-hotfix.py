from pathlib import Path

cpp_path = Path('src/xenia_web_bootstrap/hir_correctness_executor.cpp')
cpp = cpp_path.read_text()

old_call = """          supported = g_call_resolver && instr->src1.symbol &&
                      g_call_resolver(instr->src1.symbol);
          if (!supported && g_address_resolver) {"""
new_call = """          if (instr->src1.symbol) {
            // A real HIR symbol is authoritative. If its resolver rejects the
            // target, do not retry the same call through the address resolver.
            supported = g_call_resolver && g_call_resolver(instr->src1.symbol);
          } else if (g_address_resolver) {"""

old_call_true = """            supported = g_call_resolver && instr->src2.symbol &&
                        g_call_resolver(instr->src2.symbol);
            if (!supported && g_address_resolver) {"""
new_call_true = """            if (instr->src2.symbol) {
              // The PPC decoder below is only for direct calls that have no HIR
              // symbol. Known symbols stay on the authoritative call resolver.
              supported = g_call_resolver && g_call_resolver(instr->src2.symbol);
            } else if (g_address_resolver) {"""

if cpp.count(old_call) != 1:
    raise SystemExit(f'expected one OPCODE_CALL resolver block, found {cpp.count(old_call)}')
if cpp.count(old_call_true) != 1:
    raise SystemExit(f'expected one OPCODE_CALL_TRUE resolver block, found {cpp.count(old_call_true)}')
cpp = cpp.replace(old_call, new_call, 1).replace(old_call_true, new_call_true, 1)
cpp_path.write_text(cpp)

test_path = Path('test-title-kernel-import-integration.mjs')
test = test_path.read_text()
if 'blocked.kernelCalls!==2' not in test:
    raise SystemExit('expected duplicate kernel-call test state was not found')
test = test.replace('blocked.kernelCalls!==2', 'blocked.kernelCalls!==1', 1)
test = test.replace("console.log('TITLE_DIRECT_CALL_FALLBACK_UNRESOLVED_RETRY=PASS');", "console.log('TITLE_DIRECT_CALL_SINGLE_KERNEL_RESOLUTION=PASS');")
test_path.write_text(test)

ui = Path('render360-xenios-ui.mjs').read_text()
assert 'recordHudActivity' in ui and 'drawActivityGraph' in ui
assert "ctx.strokeStyle='rgba(48,209,88,.92)'" in ui
assert 'Math.random' not in ui
assert 'if (instr->src1.symbol) {' in cpp
assert 'if (instr->src2.symbol) {' in cpp
assert 'R360_DIRECT_CALL_FALLBACK' in cpp
assert 'blocked.kernelCalls!==1' in test
assert 'TITLE_DIRECT_CALL_SINGLE_KERNEL_RESOLUTION=PASS' in test
assert 'UNRESOLVED_RETRY' not in test
print('DIRECT_CALL_HOTFIX=PASS')
print('TRUTHFUL_GREEN_ACTIVITY_HUD=PASS')
