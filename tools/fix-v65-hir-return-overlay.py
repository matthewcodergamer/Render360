#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'prepare-hir-return-metadata-v3-overlay.py'
text = path.read_text()

target = "replace_once(reset_old, reset_new, 'initial LR API implementation')"
replacement = r"""# V65 source records the final architectural GPR snapshot for indexed-memory
# diagnostics. The return-metadata overlay runs after the VMX overlay has copied
# that source, so accept the V65 reset/getter shape while preserving the snapshot.
reset_v65_old = reset_old.replace(
    'void ResetHIRCorrectnessInitialState() { g_initial_gprs.fill(0); }',
    'void ResetHIRCorrectnessInitialState() {\n'
    '  g_initial_gprs.fill(0);\n'
    '  g_last_gprs.fill(0);\n'
    '}'
) + (
    '\nuint64_t GetHIRCorrectnessLastGPR(uint32_t index) {\n'
    '  return index < g_last_gprs.size() ? g_last_gprs[index] : 0;\n'
    '}\n'
)
reset_v65_new = reset_new.replace(
    '  g_initial_gprs.fill(0);\n  g_initial_lr = 0;',
    '  g_initial_gprs.fill(0);\n  g_last_gprs.fill(0);\n  g_initial_lr = 0;'
).replace(
    '\nbool SetHIRCorrectnessInitialLR(uint64_t value) {',
    '\nuint64_t GetHIRCorrectnessLastGPR(uint32_t index) {\n'
    '  return index < g_last_gprs.size() ? g_last_gprs[index] : 0;\n'
    '}\n\n'
    'bool SetHIRCorrectnessInitialLR(uint64_t value) {'
)
if reset_v65_old in text:
    replace_once(reset_v65_old, reset_v65_new, 'initial LR API implementation V65')
else:
    replace_once(reset_old, reset_new, 'initial LR API implementation')
"""

if replacement in text:
    print('V65 HIR return overlay compatibility already current')
elif target in text:
    path.write_text(text.replace(target, replacement, 1))
    print('V65 HIR return overlay compatibility applied')
else:
    raise SystemExit('V65 HIR return overlay patch anchor changed')
