// Runs Xenia's own PPC instruction tests (upstream/xenia/src/xenia/cpu/ppc/
// testing/*.s) through the browser bootstrap: Xenia PPCFrontend -> HIR ->
// Render360 HIR executor. Each test is assembled with PowerPC binutils, placed
// at 0x82010000 like Xenia's xenia-cpu-ppc-tests runner, given its
// `#_ REGISTER_IN` state through Xenia's PPCContext::SetRegFromString and
// checked with PPCContext::CompareRegWithString.
//
// Usage: node test-xenia-ppc-instruction-suite.mjs [bootstrap.wasm] [filter]
// Requires powerpc64-linux-gnu-{as,ld,nm} (apt: binutils-powerpc64-linux-gnu).
//
// Not covered here: VMX128 files stock binutils cannot assemble (Xenia uses a
// patched binutils for those) and the MEMORY_IN/OUT store tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const filter=process.argv[3]||'';
const TESTDIR='upstream/xenia/src/xenia/cpu/ppc/testing';
const BASE=0x82010000;
// Every assemblable register test passes; a drop means a regression or tests
// silently being skipped.
const MIN_PASSING=1398;

if(!fs.existsSync(wasmPath))throw new Error(`bootstrap WASM not found: ${wasmPath}`);
if(!fs.existsSync(TESTDIR))throw new Error(`Xenia PPC tests not found at ${TESTDIR} (run ./fetch-xenia.sh)`);
for(const tool of ['as','ld','nm']){
  try{execFileSync(`powerpc64-linux-gnu-${tool}`,['--version'],{stdio:'ignore'});}
  catch{throw new Error(`powerpc64-linux-gnu-${tool} is required (apt-get install binutils-powerpc64-linux-gnu)`);}
}

const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
async function instantiate(){
  const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
  const imports=wasi.getImportObject(module);
  imports.env||={};
  imports.env.emscripten_notify_memory_growth=()=>{};
  const instance=await WebAssembly.instantiate(module,imports);
  wasi.initialize(instance);
  return instance.exports;
}
let e=await instantiate();
for(const name of ['r360_ppc_probe_set_initial_register','r360_ppc_probe_compare_register','r360_ppc_probe_register_actual','_initialize']){
  if(typeof e[name]!=='function')throw new Error(`bootstrap is missing ${name}`);
}

const work=fs.mkdtempSync(path.join(os.tmpdir(),'r360-ppc-tests-'));
function assemble(src){
  const name=path.basename(src,'.s');
  const obj=path.join(work,`${name}.o`),bin=path.join(work,`${name}.bin`);
  try{
    // Same flags as xenia-build gentests, minus its patched -mvmx128.
    execFileSync('powerpc64-linux-gnu-as',['-a32','-be','-mregnames','-mpower7','-maltivec','-mvsx','-R','-o',obj,src],{stdio:'pipe'});
    execFileSync('powerpc64-linux-gnu-ld',['-melf32ppc','-EB','-nostdlib','--oformat=binary',`-Ttext=0x${BASE.toString(16)}`,`-e0x${BASE.toString(16)}`,'-o',bin,obj],{stdio:'pipe'});
  }catch{return null;}
  const labels=new Map();
  for(const line of execFileSync('powerpc64-linux-gnu-nm',['--numeric-sort',obj]).toString().split('\n')){
    const m=line.match(/^([0-9a-f]+)\s+\w\s+(\S+)$/);
    if(m)labels.set(m[2],BASE+parseInt(m[1],16));
  }
  return {bin:fs.readFileSync(bin),labels};
}

function parseTests(src){
  const tests=[];let current=null;
  for(const raw of fs.readFileSync(src,'utf8').split('\n')){
    const label=raw.match(/^(test_\w+):/);
    if(label){current={name:label[1],annotations:[]};tests.push(current);continue;}
    if(current&&raw.trim().startsWith('#_')){
      const a=raw.match(/#_\s+(\w+)\s+(.*)$/);
      if(a)current.annotations.push([a[1],a[2].trim()]);
    }
  }
  return tests;
}

const splitAnnotation=v=>{const i=v.search(/\s/);return [v.slice(0,i),v.slice(i+1).trim()];};
function writeCString(base,offset,text){
  const bytes=new TextEncoder().encode(`${text}\0`);
  new Uint8Array(e.memory.buffer,base+offset,bytes.length).set(bytes);
  return base+offset;
}
function readCString(pointer){
  const mem=new Uint8Array(e.memory.buffer);let s='';
  for(let i=pointer;mem[i];i++)s+=String.fromCharCode(mem[i]);
  return s;
}

let passed=0,skipped=0,unassembled=0;
const failures=[];
const files=fs.readdirSync(TESTDIR).filter(f=>/^(instr|seq)_.*\.s$/.test(f)&&f.includes(filter)).sort();
for(const file of files){
  const src=path.join(TESTDIR,file);
  const asm=assemble(src);
  if(!asm){unassembled++;continue;}
  const code=new Uint8Array((asm.bin.length+3)&~3);code.set(asm.bin);
  for(const test of parseTests(src)){
    const registers=test.annotations.filter(([k])=>k==='REGISTER_IN'||k==='REGISTER_OUT');
    if(test.annotations.some(([k])=>k!=='REGISTER_IN'&&k!=='REGISTER_OUT')||!asm.labels.has(test.name)){skipped++;continue;}
    try{
      e.r360_ppc_probe_reset();
      const buffer=e.r360_ppc_probe_input_buffer();
      new Uint8Array(e.memory.buffer,buffer,code.length).set(code);
      if((e.r360_ppc_probe_load_at(BASE,buffer,code.length)>>>0)!==code.length)throw new Error('code load failed');
      e.r360_ppc_probe_set_execute_on_translate(1);
      e.r360_ppc_probe_set_initial_lr(0xBCBCBCBCn);  // Xenia's test runner LR.
      for(const [kind,value] of registers){
        if(kind!=='REGISTER_IN')continue;
        const [reg,val]=splitAnnotation(value);
        e.r360_ppc_probe_set_initial_register(writeCString(buffer,0,reg),writeCString(buffer,64,val));
      }
      const hir=e.r360_ppc_probe_translate_scanned_at(asm.labels.get(test.name))>>>0;
      const status=e.r360_ppc_probe_correctness_status()>>>0;
      const bad=[];
      if(!hir||status!==3){
        bad.push(`did not return (status ${status}, HIR blocker ${e.r360_ppc_probe_correctness_blocker_kind()}/${e.r360_ppc_probe_correctness_blocker_opcode()} @0x${(e.r360_ppc_probe_correctness_blocker_address()>>>0).toString(16)})`);
      }else{
        for(const [kind,value] of registers){
          if(kind!=='REGISTER_OUT')continue;
          const [reg,val]=splitAnnotation(value);
          if((e.r360_ppc_probe_compare_register(writeCString(buffer,0,reg),writeCString(buffer,64,val))>>>0)!==1){
            bad.push(`${reg}=${readCString(e.r360_ppc_probe_register_actual())} expected ${val}`);
          }
        }
      }
      if(bad.length)failures.push(`${file}:${test.name}: ${bad.join('; ')}`);else passed++;
    }catch(error){
      failures.push(`${file}:${test.name}: core trap ${error.message}`);
      e=await instantiate();
    }
  }
}
fs.rmSync(work,{recursive:true,force:true});

console.log(`Xenia PPC instruction suite: ${passed} passed, ${failures.length} failed, ${skipped} memory tests skipped, ${unassembled} VMX128 files not assemblable`);
for(const failure of failures)console.log(`FAIL ${failure}`);
if(failures.length)process.exit(1);
if(!filter&&passed<MIN_PASSING){console.error(`expected at least ${MIN_PASSING} passing tests`);process.exit(1);}
console.log('XENIA_PPC_INSTRUCTION_SUITE_PASS');
