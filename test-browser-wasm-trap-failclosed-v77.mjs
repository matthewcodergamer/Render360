import fs from 'node:fs';
import assert from 'node:assert/strict';

const read=name=>fs.readFileSync(name,'utf8');
const overlay=read('prepare-xenia-ppc-hir-failclosed-overlay.py');
const build=read('build-xenia-ppc-bootstrap.sh');
const probe=read('src/xenia_web_bootstrap/ppc_translation_probe.cpp');
const controller=read('render360-title-controller.mjs');
const releaseWorkflow=read('.github/workflows/apply-browser-wasm-trap-failclosed-v77.yml');

assert.match(overlay,/r360_ppc_probe_report_unimplemented/,'browser HIR overlay must report the exact unsupported PPC instruction');
assert.match(overlay,/#if defined\(__EMSCRIPTEN__\) \|\| defined\(XE_ARCH_WASM32\)[\s\S]*?return false;[\s\S]*?#else[\s\S]*?DebugBreak\(\);/,'wasm32 must fail translation before the native DebugBreak path');
assert.doesNotMatch(overlay,/-DNDEBUG/,'V77 must not hide Xenia invariants by globally disabling assertions');

assert.match(build,/prepare-xenia-ppc-hir-failclosed-overlay\.py/,'build must generate the browser HIR overlay');
assert.match(build,/"src\/xenia\/cpu\/ppc\/ppc_hir_builder\.cc"\) queue_cpp "\$rel" "\$OVERLAY\/xenia\/cpu\/ppc\/ppc_hir_builder\.cc"/,'build must compile the patched HIR builder');

for(const marker of [
  'g_unimplemented_ppc_address',
  'g_unimplemented_ppc_code',
  'r360_ppc_probe_report_unimplemented',
  'r360_ppc_probe_unimplemented_address',
  'r360_ppc_probe_unimplemented_code',
])assert.ok(probe.includes(marker),`PPC probe missing ${marker}`);

assert.match(controller,/R360_TITLE_ENTRY_WASM_TRAP/,'title controller must turn a raw WebAssembly trap into a structured Render360 error');
assert.match(controller,/r360_ppc_probe_unimplemented_address/,'title controller must include unsupported PPC address telemetry');
assert.match(controller,/r360_ppc_probe_unimplemented_code/,'title controller must include unsupported PPC opcode telemetry');
assert.match(controller,/catch\(cause\)/,'title controller must catch scanned-entry wasm traps');

assert.ok(releaseWorkflow.includes('test-browser-wasm-trap-failclosed-v77.mjs'),'V77 release gate must run the trap regression contract');
assert.ok(releaseWorkflow.includes('test-title-scanned-entry-runtime.mjs'),'V77 release gate must execute the scanned-entry runtime test against the freshly linked wasm');

console.log('R360_V77_BROWSER_WASM_TRAP_FAILCLOSED=PASS');
