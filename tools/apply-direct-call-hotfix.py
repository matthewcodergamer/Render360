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

ui_path = Path('render360-xenios-ui.mjs')
ui = ui_path.read_text()
old_color = "ctx.strokeStyle=guestPresented?'#30d158':'#5ac8fa';"
if old_color not in ui:
    raise SystemExit('V44.18 HUD graph color selector was not found')
ui = ui.replace(old_color, "ctx.strokeStyle='#30d158';", 1).replace('44.18', '44.19')
ui_path.write_text(ui)

patch_path = Path('app-v42-patch.js')
patch = patch_path.read_text()
if "render360-xenios-ui.mjs?v=44.18" not in patch:
    raise SystemExit('V44.18 XeniOS import was not found')
patch_path.write_text(patch.replace('render360-xenios-ui.mjs?v=44.18', 'render360-xenios-ui.mjs?v=44.19', 1))

ui_test_path = Path('test-xenios-ui-contract.mjs')
ui_test = ui_test_path.read_text().replace('44.18', '44.19')
marker = "assert.ok(!ui.includes('Math.random'),'HUD activity graph must never synthesize fake movement/noise');"
if marker not in ui_test:
    raise SystemExit('truthful HUD assertion marker was not found')
ui_test = ui_test.replace(marker, marker + "\nassert.ok(ui.includes(\"ctx.strokeStyle='#30d158'\"),'measured HUD activity line must use the Xenia-style green trace');")
ui_test_path.write_text(ui_test)

assert 'if (instr->src1.symbol) {' in cpp
assert 'if (instr->src2.symbol) {' in cpp
assert 'R360_DIRECT_CALL_FALLBACK' in cpp
assert 'blocked.kernelCalls!==1' in test
assert 'TITLE_DIRECT_CALL_SINGLE_KERNEL_RESOLUTION=PASS' in test
assert 'UNRESOLVED_RETRY' not in test
assert "ctx.strokeStyle='#30d158'" in ui
assert 'Math.random' not in ui
print('DIRECT_CALL_AND_HUD_HOTFIX=PASS')
