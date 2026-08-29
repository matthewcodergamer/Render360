import fs from 'node:fs';
import {WASI} from 'node:wasi';
import {createPersistentPpcSession} from './render360-browser-ppc-session.mjs';
import {createGuestThreadScheduler} from './render360-browser-thread-scheduler.mjs';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`Thread scheduler bootstrap WASM not found: ${wasmPath}`);
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const entry of WebAssembly.Module.imports(module)){
  if(entry.module==='env'&&entry.name==='emscripten_notify_memory_growth'){
    imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const bootstrap=await WebAssembly.instantiate(module,imports);wasi.initialize(bootstrap);
const pick=name=>bootstrap.exports[name]??bootstrap.exports[`_${name}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_kernel_runtime_reset','r360_guest_thread_state','r360_guest_thread_exit_code','r360_guest_thread_stack_mapped'];
for(const name of required)if(typeof pick(name)!=='function')throw new Error(`Missing thread scheduler fixture export ${name}`);

const words=(...values)=>Uint8Array.from(values.flatMap(w=>[w>>>24,(w>>>16)&255,(w>>>8)&255,w&255]));
const input=pick('r360_ppc_probe_input_buffer')()>>>0;
const capacity=pick('r360_ppc_probe_input_capacity')()>>>0;
const translateAt=(address,program)=>{
  if(program.length>capacity)throw new Error('Thread scheduler fixture exceeds PPC input capacity');
  new Uint8Array(bootstrap.exports.memory.buffer,input,program.length).set(program);
  if((pick('r360_ppc_probe_load_at')(address,input,program.length)>>>0)!==program.length)throw new Error(`Could not load PPC thread fixture at 0x${address.toString(16)}`);
  if(!(pick('r360_ppc_probe_translate')()>>>0))throw new Error(`Could not translate PPC thread fixture at 0x${address.toString(16)}`);
};

pick('r360_ppc_probe_reset')();
pick('r360_kernel_runtime_reset')();
const entryA=0x80000000;
const entryB=0x80010000;
// Thread A: addi r3,r3,1 ; blr. Thread B: addi r3,r3,2 ; blr.
translateAt(entryA,words(0x38630001,0x4E800020));
translateAt(entryB,words(0x38630002,0x4E800020));

const session=await createPersistentPpcSession({bootstrap});
const scheduler=await createGuestThreadScheduler({bootstrap,session,maxSlicesPerPump:2});
const a=scheduler.createThread({entry:entryA,context:10,stackSize:0x4000,flags:1});
const b=scheduler.createThread({entry:entryB,context:20,stackSize:0x8000,flags:2});
if(!a.stackMapped||!b.stackMapped||a.stackBase===b.stackBase||a.stackTop===b.stackTop)throw new Error('Scheduler threads do not own independent native sparse stacks');

const report=await scheduler.pumpOnce({maxSlices:2});
if(report.slices.length!==2)throw new Error(`Scheduler ran ${report.slices.length} slices, expected 2`);
const byHandle=new Map(report.slices.map(result=>[result.handle,result]));
const resultA=byHandle.get(a.handle);const resultB=byHandle.get(b.handle);
if(!resultA||!resultB)throw new Error('Round-robin scheduler did not execute both native thread handles');
if(resultA.r3!==11n||resultB.r3!==22n)throw new Error(`Per-thread PPCContext isolation failed: A=${resultA.r3} B=${resultB.r3}`);
if((pick('r360_guest_thread_state')(a.handle)>>>0)!==4||(pick('r360_guest_thread_state')(b.handle)>>>0)!==4)throw new Error('Returned guest thread entries were not terminated');
if((pick('r360_guest_thread_exit_code')(a.handle)>>>0)!==11||(pick('r360_guest_thread_exit_code')(b.handle)>>>0)!==22)throw new Error('Thread return values were not propagated to exit codes');
if((pick('r360_guest_thread_stack_mapped')(a.handle)>>>0)!==0||(pick('r360_guest_thread_stack_mapped')(b.handle)>>>0)!==0)throw new Error('Completed scheduler threads retained sparse stacks');
const state=scheduler.inspect();
if(state.trackedContexts!==2||state.sliceCount!==2||state.completedThreads!==2)throw new Error('Scheduler telemetry did not track independent thread contexts');
if(state.contract.midFunctionPreemption!==false||state.contract.fullXboxThreadScheduler!==false)throw new Error('Scheduler contract overstates current preemption coverage');

console.log('BROWSER_THREAD_SCHEDULER_NATIVE_REGISTRY=PASS');
console.log('BROWSER_THREAD_SCHEDULER_PPC_CONTEXT_ISOLATION=PASS');
console.log('BROWSER_THREAD_SCHEDULER_SPARSE_STACKS=PASS');
console.log('BROWSER_THREAD_SCHEDULER_ROUND_ROBIN=PASS');
console.log('BROWSER_THREAD_SCHEDULER_RETURN_TERMINATION=PASS');
console.log('BROWSER_THREAD_SCHEDULER_FOUNDATION=PASS');
