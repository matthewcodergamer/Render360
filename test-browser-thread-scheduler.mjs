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
const required=['r360_ppc_probe_reset','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_instructions','r360_ppc_probe_set_execute_on_translate','r360_ppc_probe_execute_on_translate','r360_wasm_backend_cfg_status','r360_kernel_runtime_reset','r360_guest_thread_state','r360_guest_thread_exit_code','r360_guest_thread_stack_mapped'];
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
const entryC=0x80020000;
// Production mode: translation may register/lower the functions, but it must
// not execute programs or mutate guest architectural state as an assembly side
// effect.
if((pick('r360_ppc_probe_set_execute_on_translate')(0)>>>0)!==0||(pick('r360_ppc_probe_execute_on_translate')()>>>0)!==0)throw new Error('Could not enter side-effect-free PPC translation mode');
translateAt(entryA,words(0x38630001,0x4E800020));
if((pick('r360_ppc_probe_correctness_status')()>>>0)!==4||(pick('r360_ppc_probe_correctness_instructions')()>>>0)!==0)throw new Error('Thread A executed during production translation');
translateAt(entryB,words(0x38630002,0x4E800020));
if((pick('r360_ppc_probe_correctness_status')()>>>0)!==4||(pick('r360_ppc_probe_correctness_instructions')()>>>0)!==0)throw new Error('Thread B executed during production translation');
if((pick('r360_ppc_probe_set_execute_on_translate')(1)>>>0)!==1)throw new Error('Could not restore correctness-execution mode');
console.log('BROWSER_THREAD_SCHEDULER_TRANSLATION_ONLY_BOOT=PASS');

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

// Translate a deliberately long integer CFG loop after the scheduler already
// exists. r3 is the native Xbox thread context argument; mtctr copies the live
// value, then the function counts r3 upward from zero. 10,000 trips exceed the
// 4096-dispatch browser quantum and therefore must exercise continuation state.
if((pick('r360_ppc_probe_set_execute_on_translate')(0)>>>0)!==0)throw new Error('Could not re-enter side-effect-free translation mode');
translateAt(entryC,words(
  0x7C6903A6, // mtctr r3
  0x38600000, // li    r3,0
  0x38630001, // loop: addi r3,r3,1
  0x4200FFFC, // bdnz  loop
  0x4E800020, // blr
));
if((pick('r360_wasm_backend_cfg_status')()>>>0)!==2)throw new Error('Long scheduler fixture did not produce the resumable CFG tier');
if((pick('r360_ppc_probe_set_execute_on_translate')(1)>>>0)!==1)throw new Error('Could not restore correctness mode after long fixture translation');

const c=scheduler.createThread({entry:entryC,context:10000,stackSize:0x10000,flags:0});
let sawYield=false;
let finished=false;
let cSlices=0;
for(;cSlices<16;cSlices++){
  const quantum=await scheduler.pumpOnce({maxSlices:1});
  if(quantum.slices.length!==1||quantum.slices[0].handle!==c.handle)throw new Error('Long-loop scheduler quantum did not execute the expected native thread');
  const slice=quantum.slices[0];
  if(slice.yielded){
    sawYield=true;
    const state=pick('r360_guest_thread_state')(c.handle)>>>0;
    if(state===4)throw new Error('CFG fuel yield incorrectly terminated the native Xbox thread');
    if((pick('r360_guest_thread_stack_mapped')(c.handle)>>>0)!==1)throw new Error('CFG fuel yield unmapped the native thread stack');
    continue;
  }
  if(!slice.terminated||slice.guestReturned===false)throw new Error('Final resumed CFG slice did not terminate at a real guest return');
  finished=true;
  cSlices++;
  break;
}
if(!sawYield)throw new Error('Native scheduler long-loop test never observed a CFG fuel yield');
if(!finished)throw new Error(`Native scheduler long-loop did not finish after ${cSlices} quanta`);
if((pick('r360_guest_thread_state')(c.handle)>>>0)!==4)throw new Error('Resumed native Xbox thread did not terminate after guest return');
if((pick('r360_guest_thread_exit_code')(c.handle)>>>0)!==10000)throw new Error(`Resumed native thread exit code was ${pick('r360_guest_thread_exit_code')(c.handle)>>>0}, expected 10000`);
if((pick('r360_guest_thread_stack_mapped')(c.handle)>>>0)!==0)throw new Error('Resumed native thread retained its sparse stack after completion');

const state=scheduler.inspect();
if(state.trackedContexts!==3||state.sliceCount<3||state.completedThreads!==3||state.yieldedSlices<1)throw new Error('Scheduler telemetry did not preserve yielded/resumed native thread state');
if(state.contract.midFunctionPreemption!==true||state.contract.midFunctionPreemptionTier!=='integer-cfg-fallback'||state.contract.perThreadCfgContinuation!==true||state.contract.productionSlicesPerBrowserYield!==1||state.contract.fullXboxThreadScheduler!==false)throw new Error('Scheduler contract does not match bounded CFG continuation coverage');

console.log('BROWSER_THREAD_SCHEDULER_NATIVE_REGISTRY=PASS');
console.log('BROWSER_THREAD_SCHEDULER_PPC_CONTEXT_ISOLATION=PASS');
console.log('BROWSER_THREAD_SCHEDULER_SPARSE_STACKS=PASS');
console.log('BROWSER_THREAD_SCHEDULER_ROUND_ROBIN=PASS');
console.log('BROWSER_THREAD_SCHEDULER_RETURN_TERMINATION=PASS');
console.log('BROWSER_THREAD_SCHEDULER_CFG_YIELD_SURVIVES=PASS');
console.log('BROWSER_THREAD_SCHEDULER_CFG_RESUME_RETURN=PASS');
console.log(`browser_thread_scheduler_cfg_quanta=${cSlices}`);
console.log('BROWSER_THREAD_SCHEDULER_FOUNDATION=PASS');
