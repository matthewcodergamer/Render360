import fs from 'node:fs';
import {WASI} from 'node:wasi';
const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const controller=fs.readFileSync('render360-title-controller.mjs','utf8');
const isoController=fs.readFileSync('render360-iso-title-controller.mjs','utf8');
const titleRuntime=fs.readFileSync('render360-browser-title-runtime.mjs','utf8');
for(const marker of ["const lowMemoryPages=0x10000/pageSize","map(0,lowMemoryPages,lowMemoryBacking,0,readWrite)","lowMemoryCompatBytes:lowMemoryPages*pageSize","applyInitialGprs(bootstrap,{1:mainThreadContext.stackTop,13:mainThreadContext.pcrAddress})","r360_ppc_probe_page_sparse_code","xenia-main-thread-context"]) if(!controller.includes(marker)) throw new Error(`missing Braid startup invariant: ${marker}`);
if(!isoController.includes("handoffDefaultXex({...handoffArgs,prepareMainThreadContext:true})")) throw new Error('production HIR fallback does not enable the Xenia main-thread context');
if(!titleRuntime.includes("PPC_BOOTSTRAP_URL='./xenia_ppc_bootstrap.wasm'")) throw new Error('canonical browser bootstrap URL is missing');
if(!titleRuntime.includes("PPC_BOOTSTRAP_META_URL='./xenia_ppc_bootstrap.meta.json'")) throw new Error('browser bootstrap provenance URL is missing');
if(!titleRuntime.includes("Symbol.for('render360.ppc.bootstrap.singleton')")) throw new Error('browser bootstrap singleton is missing');
if(titleRuntime.includes('?v=')) throw new Error('versioned module/runtime URLs can create duplicate PPC loader state');
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod)){if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};}}
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);
const e=instance.exports,p=n=>e[n]??e[`_${n}`];
for(const n of ['r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc','r360_sparse_guest_memory_map','r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_input_buffer','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3','r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be','r360_kernel_service_call','r360_kernel_service_status']) if(typeof p(n)!=='function') throw new Error(`missing Braid critic export ${n}`);
p('r360_sparse_guest_memory_reset')();p('r360_ppc_probe_reset')();
const lowPages=16;
const lowBacking=p('r360_sparse_guest_memory_alloc')(lowPages)>>>0;
if(!lowBacking||(p('r360_sparse_guest_memory_map')(0,lowPages,lowBacking,0,3)>>>0)!==1)throw new Error('LOW_64K_APERTURE_MAPPED failed');
if((p('r360_ppc_probe_set_initial_gpr')(1,BigInt(0x7007ff50))>>>0)!==1)throw new Error('MAIN_THREAD_R1_VALID failed');
if((p('r360_ppc_probe_set_initial_gpr')(13,BigInt(0x50000000))>>>0)!==1)throw new Error('MAIN_THREAD_R13_VALID failed');
const words=[0x38600000,0x80830000,0x38640000,0x4E800020];
const code=Uint8Array.from(words.flatMap(w=>[w>>>24,(w>>>16)&255,(w>>>8)&255,w&255]));
const input=p('r360_ppc_probe_input_buffer')()>>>0;new Uint8Array(e.memory.buffer,input,code.length).set(code);
if((p('r360_ppc_probe_load_at')(0x80000000,input,code.length)>>>0)!==code.length)throw new Error('entry fixture load failed');
if(!(p('r360_ppc_probe_translate')()>>>0))throw new Error('entry fixture translation failed');
let status=p('r360_ppc_probe_correctness_status')()>>>0;let r3=Number(BigInt.asUintN(32,p('r360_ppc_probe_correctness_r3')()))>>>0;
if(status!==3||r3!==0)throw new Error(`ENTRY_LOAD_ZERO_PAGE failed status=${status} r3=0x${r3.toString(16)}`);

// Real-device Braid blocker: 0x817F46C0 = lwz r11,0x46C0(r31), with r31=0.
// Verify the exact effective address is inside the bounded low-memory aperture
// and that native HIR can carry the loaded value through to a visible GPR.
p('r360_ppc_probe_reset')();
if((p('r360_ppc_probe_set_initial_gpr')(31,0n)>>>0)!==1)throw new Error('BRAID_R31_ZERO_SETUP failed');
if((p('r360_ppc_probe_write_guest_u32_be')(0x46C0,0x12345678)>>>0)!==1)throw new Error('BRAID_46C0_SENTINEL_WRITE failed');
const braidWords=[0x817F46C0,0x386B0000,0x4E800020]; // lwz r11,0x46C0(r31); addi r3,r11,0; blr
const braidCode=Uint8Array.from(braidWords.flatMap(w=>[w>>>24,(w>>>16)&255,(w>>>8)&255,w&255]));
const braidInput=p('r360_ppc_probe_input_buffer')()>>>0;new Uint8Array(e.memory.buffer,braidInput,braidCode.length).set(braidCode);
if((p('r360_ppc_probe_load_at')(0x80000000,braidInput,braidCode.length)>>>0)!==braidCode.length)throw new Error('BRAID_46C0 fixture load failed');
if(!(p('r360_ppc_probe_translate')()>>>0))throw new Error('BRAID_46C0 fixture translation failed');
status=p('r360_ppc_probe_correctness_status')()>>>0;r3=Number(BigInt.asUintN(32,p('r360_ppc_probe_correctness_r3')()))>>>0;
if(status!==3||r3!==0x12345678)throw new Error(`BRAID_46C0_LOAD failed status=${status} r3=0x${r3.toString(16)}`);

const notifyBacking=p('r360_sparse_guest_memory_alloc')(1)>>>0;const notifyBase=0x30000000;if(!notifyBacking||(p('r360_sparse_guest_memory_map')(notifyBase,1,notifyBacking,0,3)>>>0)!==1)throw new Error('XAM_028B notify output page map failed');p('r360_ppc_probe_write_guest_u32_be')(notifyBase,0xDEADBEEF);p('r360_ppc_probe_write_guest_u32_be')(notifyBase+4,0xCAFEBABE);const dequeued=p('r360_kernel_service_call')(2,0x28B,0,0,notifyBase,notifyBase+4,0,0,0,0)>>>0;const svc=p('r360_kernel_service_status')()>>>0;const notifyId=p('r360_ppc_probe_read_guest_u32_be')(notifyBase)>>>0;const notifyParam=p('r360_ppc_probe_read_guest_u32_be')(notifyBase+4)>>>0;
if(svc!==1||dequeued!==0||notifyId!==0||notifyParam!==0)throw new Error(`XAM_028B_REACHED failed service_status=${svc} dequeued=${dequeued} id=0x${notifyId.toString(16)} param=0x${notifyParam.toString(16)}`);
console.log('LOW_64K_APERTURE_MAPPED=PASS');console.log('MAIN_THREAD_R1_VALID=PASS');console.log('MAIN_THREAD_R13_VALID=PASS');console.log('ENTRY_LOAD_ZERO_PAGE=PASS');console.log('BRAID_46C0_LOAD=PASS');console.log('XAM_028B_REACHED=PASS');console.log('BRAID_STARTUP_INTEGRATION_CRITIC=PASS');
