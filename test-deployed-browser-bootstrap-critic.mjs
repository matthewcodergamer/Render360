import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRender360BrowserImports,attachRender360BrowserInstance,validateRender360BrowserImports} from './render360-browser-wasi.mjs';

const wasm=await readFile(new URL('./xenia_ppc_bootstrap.wasm',import.meta.url));
const meta=JSON.parse(await readFile(new URL('./xenia_ppc_bootstrap.meta.json',import.meta.url),'utf8'));
assert.ok(wasm.length>0,'deployed bootstrap is empty');
assert.equal(wasm.length,meta.bytes,'deployed bootstrap byte count differs from publisher provenance');
assert.equal(createHash('sha256').update(wasm).digest('hex'),meta.sha256,'deployed bootstrap hash differs from verified artifact provenance');
assert.match(meta.sourceCommit,/^[0-9a-f]{40}$/,'publisher provenance source commit invalid');
assert.match(String(meta.sourceRun),/^\d+$/,'publisher provenance source run invalid');

const module=await WebAssembly.compile(wasm);
const importCheck=validateRender360BrowserImports(module);
assert.ok(importCheck.ok,'browser import contract failed');
const host=createRender360BrowserImports({onStdout:()=>{},onStderr:()=>{}});
const instance=await WebAssembly.instantiate(module,host.imports);
attachRender360BrowserInstance(host,instance);
assert.ok(instance?.exports?.memory instanceof WebAssembly.Memory,'exact deployed bootstrap did not initialize with exported browser memory');
const exported=new Set(WebAssembly.Module.exports(module).map(e=>e.name));
const required=[
  'memory','r360_hir_opcode_count','r360_hir_opcode_name','r360_hir_correctness_supports_opcode','r360_hir_correctness_supported_opcode_count',
  'r360_wasm_backend_supports_hir_opcode','r360_wasm_backend_supported_opcode_count',
  'r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_translate_scanned_at','r360_ppc_probe_correctness_status',
  'r360_pe_guest_load','r360_pe_guest_entry_address','r360_title_handoff_translate_entry','r360_title_handoff_translate_scanned_entry',
  'r360_kernel_import_register','r360_kernel_service_call','r360_guest_thread_create','r360_guest_tls_alloc',
  'r360_title_gpu_ring_base','r360_title_gpu_write_pointer','r360_title_gpu_ring_word',
  'r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_submit','r360_xenos_swaps','r360_xenos_real_title_frame_ready',
  'r360_xenos_shader_dwords','r360_xenos_shader_interpreter_reset','r360_xenos_shader_interpreter_analyze','r360_xenos_shader_interpreter_execute','r360_xenos_shader_interpreter_status',
  'r360_xenos_spirv_reset','r360_xenos_spirv_translate','r360_xenos_spirv_status','r360_xenos_spirv_buffer','r360_xenos_spirv_size','r360_xenos_spirv_word',
  'r360_xenos_frontbuffer_snapshot_capture','r360_xenos_frontbuffer_snapshot_status','r360_xenos_frontbuffer_snapshot_buffer','r360_xenos_frontbuffer_snapshot_size',
  'r360_xenos_frontbuffer_snapshot_width','r360_xenos_frontbuffer_snapshot_height','r360_xenos_frontbuffer_snapshot_hash','r360_xenos_frontbuffer_snapshot_generation',
  'r360_xenos_frontbuffer_snapshot_format','r360_xenos_frontbuffer_snapshot_tiled','r360_xenos_frontbuffer_snapshot_pitch','r360_xenos_frontbuffer_snapshot_source_address','r360_xenos_frontbuffer_snapshot_source_bytes',
  'r360_xenos_frame_generation','r360_xenos_frame_hash'
];
for(const name of required)assert.ok(exported.has(name)||exported.has(`_${name}`),`deployed bootstrap missing ${name}`);

console.log('DEPLOYED_BROWSER_BOOTSTRAP_CRITIC=PASS');
console.log('DEPLOYED_BROWSER_BOOTSTRAP_WASI_HOST=PASS');
console.log('DEPLOYED_BROWSER_BOOTSTRAP_INITIALIZE=PASS');
console.log('DEPLOYED_BROWSER_BOOTSTRAP_REAL_TITLE_SHADER_EXPORTS=PASS');
console.log('DEPLOYED_BROWSER_BOOTSTRAP_XENOS_SPIRV_EXPORTS=PASS');
console.log('DEPLOYED_BROWSER_BOOTSTRAP_REAL_VDSWAP_FRONTBUFFER_EXPORTS=PASS');
console.log(`DEPLOYED_BROWSER_BOOTSTRAP_BYTES=${wasm.length}`);
console.log(`DEPLOYED_BROWSER_BOOTSTRAP_SHA256=${meta.sha256}`);
console.log(`DEPLOYED_BROWSER_BOOTSTRAP_SOURCE_RUN=${meta.sourceRun}`);
console.log('DEPLOYED_BROWSER_BOOTSTRAP_PPC_KERNEL_XENOS_EXPORTS=PASS');
