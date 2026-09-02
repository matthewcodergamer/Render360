import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`missing bootstrap ${wasmPath}`);
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const item of WebAssembly.Module.imports(module)){
  if(item.module==='env'&&item.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(module,imports);wasi.initialize(instance);
const pick=name=>instance.exports[name]??instance.exports[`_${name}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_set_execute_on_translate','r360_ppc_probe_input_buffer','r360_ppc_probe_load_at','r360_ppc_probe_translate_scanned_at','r360_ppc_probe_status','r360_ppc_probe_scan_diagnostic','r360_ppc_probe_scan_address','r360_ppc_probe_scan_window_end','r360_ppc_probe_scan_function_end','r360_ppc_probe_scan_hir_instructions','r360_ppc_probe_assembled_functions','r360_ppc_probe_hir_block_count'];
for(const name of required)if(typeof pick(name)!=='function')throw new Error(`missing scan diagnostic export ${name}`);

const base=0x80000000;
const bytes=Uint8Array.from([0x38,0x60,0x00,0x01,0x4E,0x80,0x00,0x20]); // li r3,1; blr
const input=pick('r360_ppc_probe_input_buffer')()>>>0;
const load=()=>{
  new Uint8Array(instance.exports.memory.buffer,input,bytes.length).set(bytes);
  if((pick('r360_ppc_probe_load_at')(base,input,bytes.length)>>>0)!==bytes.length)throw new Error('diagnostic fixture load failed');
};

pick('r360_ppc_probe_reset')();
pick('r360_ppc_probe_set_execute_on_translate')(0);
load();
const hir=pick('r360_ppc_probe_translate_scanned_at')(base)>>>0;
if(!hir)throw new Error(`valid scanned function failed diag=${pick('r360_ppc_probe_scan_diagnostic')()>>>0}`);
if((pick('r360_ppc_probe_scan_diagnostic')()>>>0)!==5)throw new Error('successful scan did not report translated diagnostic');
if((pick('r360_ppc_probe_scan_address')()>>>0)!==base)throw new Error('scan address telemetry mismatch');
if((pick('r360_ppc_probe_scan_window_end')()>>>0)!==base+4)throw new Error('scan window end telemetry mismatch');
if((pick('r360_ppc_probe_scan_function_end')()>>>0)!==base+4)throw new Error('scanner-discovered function end telemetry mismatch');
if((pick('r360_ppc_probe_assembled_functions')()>>>0)<1)throw new Error('successful scan did not assemble a function');
if((pick('r360_ppc_probe_hir_block_count')()>>>0)<1)throw new Error('successful scan did not produce HIR blocks');
if((pick('r360_ppc_probe_scan_hir_instructions')()>>>0)!==hir)throw new Error('scan HIR telemetry mismatch');
if((pick('r360_ppc_probe_status')()>>>0)!==3)throw new Error('successful scan probe status mismatch');
console.log('PPC_SCAN_DIAGNOSTIC_SUCCESS=PASS');

pick('r360_ppc_probe_reset')();
pick('r360_ppc_probe_set_execute_on_translate')(0);
load();
if((pick('r360_ppc_probe_translate_scanned_at')(base+2)>>>0)!==0)throw new Error('misaligned scan unexpectedly succeeded');
if((pick('r360_ppc_probe_scan_diagnostic')()>>>0)!==1)throw new Error('misaligned scan did not report guard-rejected');
if((pick('r360_ppc_probe_scan_address')()>>>0)!==base+2)throw new Error('guard-rejected scan address telemetry mismatch');
if((pick('r360_ppc_probe_status')()>>>0)!==0xE003)throw new Error('guard-rejected scan did not report probe input error');
console.log('PPC_SCAN_DIAGNOSTIC_GUARD=PASS');

const probeSource=fs.readFileSync('src/xenia_web_bootstrap/ppc_translation_probe.cpp','utf8');
for(const token of ['kProbeScanScannerFailed','kProbeScanDefineFailed','kProbeScanZeroHIR','g_scan_function_end = function.end_address();','g_status = kProbeErrorTranslate;'])if(!probeSource.includes(token))throw new Error(`missing scan source contract ${token}`);
const controller=fs.readFileSync('render360-title-controller.mjs','utf8');
for(const token of ['scanner-failed','define-function-failed','zero-hir','scanFunctionEnd','assembledFunctions','hirBlocks','R360_TITLE_ENTRY_HANDOFF_FAILED','ppc-entry-translation-failure'])if(!controller.includes(token))throw new Error(`missing title-controller diagnostic ${token}`);
const bridge=fs.readFileSync('render360-browser-modern-content-bridge.mjs','utf8');
if(!bridge.includes("stage(onStage,'blocked',error?.message||String(error),{blocker})"))throw new Error('modern content bridge does not propagate translation blocker');
console.log('PPC_SCAN_DIAGNOSTIC_BROWSER_PROPAGATION=PASS');
console.log('PPC_SCAN_DIAGNOSTICS=PASS');
