// On-stack replacement test for the guest JIT (hir_wasm_jit.h JitOsrFunction):
// a guest function called once that runs a long loop starts interpreted (it
// has not reached the call-count threshold) and must continue in compiled
// code at a block head with exactly the interpreter's results.
//
// Usage: node test-guest-jit-osr.mjs [bootstrap.wasm]
// Requires powerpc64-linux-gnu-{as,ld} (apt: binutils-powerpc64-linux-gnu).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {WASI} from 'node:wasi';
import {spawnSync} from 'node:child_process';
import {installGuestJit} from './render360-guest-jit.mjs';

// The probe translates and runs the guest code on one host stack; V8's
// default 984 KiB native stack can overflow when a wasm tier-up lands deep in
// it (a segfault, not a JS RangeError). Re-run with a larger stack.
if(!process.execArgv.some(a=>a.startsWith('--stack-size'))){
  const r=spawnSync(process.execPath,['--stack-size=4000',...process.execArgv,...process.argv.slice(1)],{stdio:'inherit'});
  process.exit(r.status??1);
}

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const BASE=0x82010000;

// t0 calls loop once through the translation cache (a nested call, so its run
// has a JIT slot). loop mixes add, rotate, xor and a data-dependent branch
// for r5 iterations (several thousand HIR instructions per call).
const asm=`
t0:
  mflr 12
  bl loop
  mtlr 12
  blr
loop:
  li 3, 0
  mtctr 5
1:
  add 3, 3, 4
  rotlwi 3, 3, 3
  xor 3, 3, 5
  andi. 6, 4, 1
  beq 2f
  addi 3, 3, 7
2:
  addi 4, 4, 1
  bdnz 1b
  blr
`;
const work=fs.mkdtempSync(path.join(os.tmpdir(),'r360-jit-osr-'));
const source=path.join(work,'osr.s'),obj=path.join(work,'osr.o'),bin=path.join(work,'osr.bin');
fs.writeFileSync(source,asm);
execFileSync('powerpc64-linux-gnu-as',['-a32','-be','-mregnames','-R','-o',obj,source]);
execFileSync('powerpc64-linux-gnu-ld',['-melf32ppc','-EB','-nostdlib','--oformat=binary',`-Ttext=0x${BASE.toString(16)}`,`-e0x${BASE.toString(16)}`,'-o',bin,obj]);
const code=fs.readFileSync(bin);
fs.rmSync(work,{recursive:true,force:true});

const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
async function instantiate(jit){
  const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
  const imports=wasi.getImportObject(module);
  imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
  const instance=await WebAssembly.instantiate(module,imports);
  wasi.initialize(instance);
  // Mode 1: compile by call count, as in titles (mode 2 compiles every run).
  if(jit&&!installGuestJit({exports:instance.exports},{mode:1}))throw new Error('guest JIT unavailable');
  return instance.exports;
}

function run(e,r4,r5){
  const cstr=(off,text)=>{const b=new TextEncoder().encode(`${text}\0`);const p=e.r360_ppc_probe_input_buffer()+off;new Uint8Array(e.memory.buffer,p,b.length).set(b);return p;};
  e.r360_ppc_probe_reset();
  const buffer=e.r360_ppc_probe_input_buffer();
  new Uint8Array(e.memory.buffer,buffer,code.length).set(code);
  if((e.r360_ppc_probe_load_at(BASE,buffer,code.length)>>>0)!==code.length)throw new Error('code load failed');
  e.r360_ppc_probe_set_execute_on_translate(1);
  e.r360_ppc_probe_set_initial_lr(0xBCBCBCBCn);
  e.r360_ppc_probe_set_initial_register(cstr(0,'r4'),cstr(64,String(r4)));
  e.r360_ppc_probe_set_initial_register(cstr(0,'r5'),cstr(64,String(r5)));
  const hir=e.r360_ppc_probe_translate_scanned_at(BASE)>>>0;
  if(!hir||(e.r360_ppc_probe_correctness_status()>>>0)!==3)return 'did-not-return';
  const out=[];
  for(const reg of ['r3','r4','r6']){
    e.r360_ppc_probe_compare_register(cstr(0,reg),cstr(64,'0'));
    const p=e.r360_ppc_probe_register_actual()>>>0,m=new Uint8Array(e.memory.buffer);let s='';
    for(let i=p;m[i];i++)s+=String.fromCharCode(m[i]);
    out.push(`${reg}=${s}`);
  }
  return out.join(' ');
}

const interp=await instantiate(false),jit=await instantiate(true);
const failures=[];
let cases=0;
for(const [r4,r5] of [[1,600],[12345,1000],[0x7FFFFFF0,2500],[3,4000]]){
  const a=run(interp,r4,r5),b=run(jit,r4,r5);
  cases++;
  if(a!==b||a==='did-not-return')failures.push(`r4=${r4} r5=${r5}\n    executor: ${a}\n    jit:      ${b}`);
}
const osr=jit.r360_jit_osr_entries?jit.r360_jit_osr_entries()>>>0:0;
console.log(`guest JIT OSR: ${cases} cases, ${failures.length} mismatching, ${osr} OSR entries`);
for(const f of failures)console.log(`FAIL ${f}`);
if(failures.length||!osr)process.exit(1);
console.log('GUEST_JIT_OSR_PASS');
