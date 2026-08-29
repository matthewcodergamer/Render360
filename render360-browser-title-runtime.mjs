import {installRender360Buffer} from './render360-byte-buffer.mjs';
installRender360Buffer();

const REQUIRED_BOOTSTRAP_EXPORTS=[
  'memory','r360_ppc_probe_load_at','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity',
  'r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be',
  'r360_ppc_probe_translate','r360_ppc_probe_correctness_status',
  'r360_pe_guest_load','r360_pe_guest_entry_address','r360_title_handoff_translate_entry',
  'r360_kernel_import_register','r360_kernel_service_call','r360_guest_thread_create','r360_guest_tls_alloc',
  'r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_submit','r360_xenos_frame_generation','r360_xenos_frame_hash'
];
const pick=(e,n)=>e[n]??e[`_${n}`];

export function validateBrowserBootstrap(instance){
  if(!instance?.exports?.memory)throw new Error('Render360 browser bootstrap has no exported memory');
  const missing=REQUIRED_BOOTSTRAP_EXPORTS.filter(n=>n!=='memory'&&typeof pick(instance.exports,n)!=='function');
  if(missing.length)throw new Error(`Render360 browser bootstrap missing exports: ${missing.join(', ')}`);
  return {ok:true,exports:REQUIRED_BOOTSTRAP_EXPORTS.length,memoryBytes:instance.exports.memory.buffer.byteLength};
}

export async function loadRender360Bootstrap({url='./xenia_ppc_bootstrap.wasm',fetchImpl=globalThis.fetch}={}){
  if(typeof WebAssembly!=='object')throw new Error('WebAssembly is unavailable');
  if(typeof fetchImpl!=='function')throw new Error('fetch is unavailable');
  const response=await fetchImpl(url,{cache:'no-store'});
  if(!response?.ok)throw new Error(`Render360 bootstrap fetch failed: HTTP ${response?.status??0}`);
  let result;
  try{result=await WebAssembly.instantiateStreaming(response.clone(),{});}catch{result=await WebAssembly.instantiate(await response.arrayBuffer(),{});}
  validateBrowserBootstrap(result.instance);
  return result.instance;
}

export async function mountXboxIsoBrowser(file){
  if(!file||typeof file.slice!=='function'||!Number.isSafeInteger(Number(file.size)))throw new TypeError('Xbox ISO must be a browser File/Blob-like object');
  const {mountXdvdfs}=await import('./render360-xdvdfs.mjs');
  const volume=await mountXdvdfs(file);
  const node=await volume.stat('/default.xex');
  return {volume,defaultXex:node,layout:volume.layout,partitionOffset:volume.partitionOffset,telemetry:volume.telemetry};
}

export async function handoffXboxIsoBrowser({core,file,bootstrap=null,bootstrapUrl='./xenia_ppc_bootstrap.wasm',...options}){
  if(!core?.exports)throw new Error('Render360 package/XEX core is not initialized');
  const runtime=bootstrap??await loadRender360Bootstrap({url:bootstrapUrl});
  const {handoffXboxIso}=await import('./render360-iso-title-controller.mjs');
  const result=await handoffXboxIso({core,bootstrap:runtime,isoSource:file,...options});
  return {bootstrap:runtime,result};
}

export function browserTitleRuntimeContract(){return {bootstrapUrl:'./xenia_ppc_bootstrap.wasm',requiredExports:[...REQUIRED_BOOTSTRAP_EXPORTS],input:'File/Blob XDVDFS ISO',wholeIsoCopy:false,titleHle:'relocated PPC ABI shims'};}
