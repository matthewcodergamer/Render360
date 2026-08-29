import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const wasm=await readFile(new URL('./xenia_ppc_bootstrap.wasm',import.meta.url));
const meta=JSON.parse(await readFile(new URL('./xenia_ppc_bootstrap.meta.json',import.meta.url),'utf8'));
assert.ok(wasm.length>0,'deployed bootstrap is empty');
assert.equal(wasm.length,meta.bytes,'deployed bootstrap byte count differs from publisher provenance');
assert.equal(createHash('sha256').update(wasm).digest('hex'),meta.sha256,'deployed bootstrap hash differs from verified artifact provenance');
assert.match(meta.sourceCommit,/^[0-9a-f]{40}$/,'publisher provenance source commit invalid');
assert.match(String(meta.sourceRun),/^\d+$/,'publisher provenance source run invalid');

const module=await WebAssembly.compile(wasm);
const exported=new Set(WebAssembly.Module.exports(module).map(e=>e.name));
const required=[
  'memory','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_correctness_status',
  'r360_pe_guest_load','r360_pe_guest_entry_address','r360_title_handoff_translate_entry',
  'r360_kernel_import_register','r360_kernel_service_call','r360_guest_thread_create','r360_guest_tls_alloc',
  'r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_submit','r360_xenos_frame_generation','r360_xenos_frame_hash'
];
for(const name of required)assert.ok(exported.has(name)||exported.has(`_${name}`),`deployed bootstrap missing ${name}`);

console.log('DEPLOYED_BROWSER_BOOTSTRAP_CRITIC=PASS');
console.log(`DEPLOYED_BROWSER_BOOTSTRAP_BYTES=${wasm.length}`);
console.log(`DEPLOYED_BROWSER_BOOTSTRAP_SHA256=${meta.sha256}`);
console.log(`DEPLOYED_BROWSER_BOOTSTRAP_SOURCE_RUN=${meta.sourceRun}`);
console.log('DEPLOYED_BROWSER_BOOTSTRAP_PPC_KERNEL_XENOS_EXPORTS=PASS');
