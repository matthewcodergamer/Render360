// A trap or host exception in the middle of guest execution must not poison
// the next title run, and the browser must be able to say what the core was
// doing. Reproduces the iPhone report where an "Unreachable code" trap was
// followed by define-function-failed on every later launch.
import fs from 'node:fs';
import {WASI} from 'node:wasi';
import {readTrapReport,wrapCoreTrap,describeTrap,isWasmTrap} from './render360-trap-report.mjs';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`bootstrap WASM not found: ${wasmPath}`);
const fail=message=>{console.error(`FAIL ${message}`);process.exit(1);};

const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
imports.env||={};
imports.env.emscripten_notify_memory_growth=()=>{};
// mftb reads the host clock; make that host call blow up on demand so an
// exception unwinds straight through the HIR executor mid-instruction.
let clockExplodes=false;
const clock=imports.wasi_snapshot_preview1.clock_time_get;
imports.wasi_snapshot_preview1.clock_time_get=(...args)=>{
  if(clockExplodes)throw new WebAssembly.RuntimeError('unreachable');
  return clock(...args);
};
const instance=await WebAssembly.instantiate(module,imports);
wasi.initialize(instance);
const e=instance.exports;

const BASE=0x82010000;
function run(words,{gprs={}}={}){
  e.r360_ppc_probe_reset();
  const buffer=e.r360_ppc_probe_input_buffer();
  const view=new DataView(e.memory.buffer,buffer,words.length*4);
  words.forEach((w,i)=>view.setUint32(i*4,w>>>0,false));
  if((e.r360_ppc_probe_load_at(BASE,buffer,words.length*4)>>>0)!==words.length*4)fail('code load');
  e.r360_ppc_probe_set_execute_on_translate(1);
  e.r360_ppc_probe_set_initial_lr(0xBCBCBCBCn);
  for(const [r,v] of Object.entries(gprs))e.r360_ppc_probe_set_initial_gpr(Number(r),BigInt(v));
  return e.r360_ppc_probe_translate_scanned_at(BASE)>>>0;
}

// 1. mftb r3 ; blr -- the clock host call throws mid-execution.
clockExplodes=true;
let thrown=null;
try{run([0x7C6C42E6,0x4E800020]);}catch(error){thrown=error;}
clockExplodes=false;
if(!thrown||!isWasmTrap(thrown))fail(`expected a trap mid-execution, got ${thrown}`);
const report=readTrapReport(instance);
if(report.phase!=='running'||report.guestAddress!==BASE)fail(`trap report should name the running guest function: ${JSON.stringify(report)}`);
if(!/Emulator core crashed/.test(describeTrap(report,thrown)))fail('describeTrap message');

// 2. The next run on the same instance starts a fresh outermost execution:
//    li r3, 7 ; blr
const hir=run([0x38600007,0x4E800020]);
const status=e.r360_ppc_probe_correctness_status()>>>0;
const r3=Number(e.r360_ppc_probe_correctness_gpr(3));
if(!hir||status!==3||r3!==7)fail(`run after trap was poisoned: hir=${hir} status=${status} r3=${r3} hirBlocks=${e.r360_ppc_probe_hir_block_count()}`);
if(readTrapReport(instance).phase==='translating'&&readTrapReport(instance).reason)fail('trap reason not cleared by reset');

// 3. mftb itself (LOAD_CLOCK) returns the 50 MHz guest timebase.
run([0x7C6C42E6,0x4E800020]);
if((e.r360_ppc_probe_correctness_status()>>>0)!==3||e.r360_ppc_probe_correctness_gpr(3)===0n)fail('mftb did not return a timebase');

// 4. wrapCoreTrap tags the error and lets the caller discard the instance.
let poisoned=null;
const wrapped=wrapCoreTrap(new WebAssembly.RuntimeError('unreachable'),instance,{onPoisoned:b=>{poisoned=b;},context:'test'});
if(wrapped.code!=='R360_CORE_TRAP'||poisoned!==instance||!/\[FAIL_CLOSED_CORE_TRAP\]$/.test(wrapped.message))fail('wrapCoreTrap contract');
const ordinary=new Error('ordinary');
if(wrapCoreTrap(ordinary,instance)!==ordinary)fail('non-trap errors must pass through unchanged');

console.log('CORE_TRAP_RECOVERY_PASS');
