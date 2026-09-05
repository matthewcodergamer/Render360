#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'prepare-hir-return-metadata-v3-overlay.py'
text = path.read_text()

old = r'''reset_old = '''void ResetHIRCorrectnessInitialState() { g_initial_gprs.fill(0); }

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}
'''
reset_new = '''void ResetHIRCorrectnessInitialState() {
  g_initial_gprs.fill(0);
  g_initial_lr = 0;
}

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

bool SetHIRCorrectnessInitialLR(uint64_t value) {
  g_initial_lr = value;
  return true;
}

uint64_t GetHIRCorrectnessInitialLR() { return g_initial_lr; }
'''
replace_once(reset_old, reset_new, 'initial LR API implementation')
'''

new = r'''reset_old = '''void ResetHIRCorrectnessInitialState() { g_initial_gprs.fill(0); }

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}
'''
reset_new = '''void ResetHIRCorrectnessInitialState() {
  g_initial_gprs.fill(0);
  g_initial_lr = 0;
}

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

bool SetHIRCorrectnessInitialLR(uint64_t value) {
  g_initial_lr = value;
  return true;
}

uint64_t GetHIRCorrectnessInitialLR() { return g_initial_lr; }
'''

# V65 source records the final architectural GPR snapshot for indexed-memory
# diagnostics. The return-metadata overlay runs after the VMX overlay has copied
# that source, so accept the V65 reset/getter shape while preserving the snapshot.
reset_v65_old = '''void ResetHIRCorrectnessInitialState() {
  g_initial_gprs.fill(0);
  g_last_gprs.fill(0);
}

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

uint64_t GetHIRCorrectnessLastGPR(uint32_t index) {
  return index < g_last_gprs.size() ? g_last_gprs[index] : 0;
}
'''
reset_v65_new = '''void ResetHIRCorrectnessInitialState() {
  g_initial_gprs.fill(0);
  g_last_gprs.fill(0);
  g_initial_lr = 0;
}

bool SetHIRCorrectnessInitialGPR(uint32_t index, uint64_t value) {
  if (index >= g_initial_gprs.size()) return false;
  g_initial_gprs[index] = value;
  return true;
}

uint64_t GetHIRCorrectnessLastGPR(uint32_t index) {
  return index < g_last_gprs.size() ? g_last_gprs[index] : 0;
}

bool SetHIRCorrectnessInitialLR(uint64_t value) {
  g_initial_lr = value;
  return true;
}

uint64_t GetHIRCorrectnessInitialLR() { return g_initial_lr; }
'''
if reset_v65_old in text:
    replace_once(reset_v65_old, reset_v65_new, 'initial LR API implementation V65')
else:
    replace_once(reset_old, reset_new, 'initial LR API implementation')
'''

if new in text:
    print('V65 HIR return overlay compatibility already current')
elif old in text:
    path.write_text(text.replace(old, new, 1))
    print('V65 HIR return overlay compatibility applied')
else:
    raise SystemExit('V65 HIR return overlay patch anchor changed')
