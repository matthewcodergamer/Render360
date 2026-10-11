// Differential test for the guest JIT (src/xenia_web_bootstrap/hir_wasm_jit.cpp):
// runs single-instruction PPC functions on random inputs through the HIR
// executor and through generated WebAssembly (forced compilation), and
// requires identical results. Covers instructions whose native JIT lowering
// has no case in Xenia's own instruction tests (e.g. vaddsws, vavgsw).
//
// Usage: node test-guest-jit-differential.mjs [bootstrap.wasm] [iterations]
// Requires powerpc64-linux-gnu-{as,ld} (apt: binutils-powerpc64-linux-gnu).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {WASI} from 'node:wasi';
import {installGuestJit} from './render360-guest-jit.mjs';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const iterations=Number(process.argv[3]||40);
const BASE=0x82010000;

const VECTOR_OPS=['vaddsws','vsubsws','vadduws','vsubuws','vaddsbs','vaddubs','vaddshs','vadduhs','vsubsbs','vsububs','vsubshs','vsubuhs',
  'vadduwm','vsubuwm','vaddubm','vsububm','vadduhm','vsubuhm','vavgsw','vavguw','vavgsh','vavguh','vavgsb','vavgub',
  'vmaxsw','vmaxuw','vminsw','vminuw','vmaxsh','vmaxuh','vminsh','vminuh','vmaxsb','vmaxub','vminsb','vminub',
  'vslw','vsrw','vsraw','vand','vandc','vor','vxor','vnor','vaddfp','vsubfp'];
const VECTOR3_OPS=['vperm','vsel'];
const SCALAR_OPS=['add','subf','mullw','mulhw','mulhwu','divw','divwu','and','andc','or','xor','nor','slw','srw','sraw','rlwnm 3,4,5,3,27'];
const program=[];
for(const op of VECTOR_OPS)program.push({name:op,asm:`${op} v3, v4, v5`,vec:true});
for(const op of VECTOR3_OPS)program.push({name:op,asm:`${op} v3, v4, v5, v6`,vec:true});
for(const op of SCALAR_OPS){
  const [mn,...args]=op.split(' ');
  program.push({name:mn,asm:args.length?`${mn} ${args.join(' ')}`:`${mn} 3, 4, 5`,vec:false});
}
program.push({name:'lvsl',asm:'lvsl v3, 0, 4',vec:true,lvs:true});
program.push({name:'lvsr',asm:'lvsr v3, 0, 4',vec:true,lvs:true});
for(const lane of [0,1,2,3])program.push({name:`vspltw${lane}`,asm:`vspltw v3, v4, ${lane}`,vec:true});
for(const lane of [0,5,15])program.push({name:`vspltb${lane}`,asm:`vspltb v3, v4, ${lane}`,vec:true});

const work=fs.mkdtempSync(path.join(os.tmpdir(),'r360-jit-diff-'));
const source=path.join(work,'diff.s');
fs.writeFileSync(source,program.map((p,i)=>`t${i}:\n  ${p.asm}\n  blr\n`).join(''));
const obj=path.join(work,'diff.o'),bin=path.join(work,'diff.bin');
execFileSync('powerpc64-linux-gnu-as',['-a32','-be','-mregnames','-mpower7','-maltivec','-mvsx','-R','-o',obj,source]);
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
  if(jit&&!installGuestJit({exports:instance.exports},{mode:2}))throw new Error('guest JIT unavailable');
  return instance.exports;
}
const interp=await instantiate(false),jit=await instantiate(true);

let seed=0x12345678;
const rand32=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
const interesting=[0,1,0x7FFFFFFF,0x80000000,0xFFFFFFFF,0x7FFF8000,0x00010001,0x80808080,0x7F7F7F7F];
const word=()=>{const r=rand32();return (r&7)===0?interesting[rand32()%interesting.length]:rand32();};
const hex=v=>(v>>>0).toString(16).toUpperCase().padStart(8,'0');

function run(e,index,inputs,lvs){
  const cstr=(off,text)=>{const b=new TextEncoder().encode(`${text}\0`);const p=e.r360_ppc_probe_input_buffer()+off;new Uint8Array(e.memory.buffer,p,b.length).set(b);return p;};
  e.r360_ppc_probe_reset();
  const buffer=e.r360_ppc_probe_input_buffer();
  new Uint8Array(e.memory.buffer,buffer,code.length).set(code);
  if((e.r360_ppc_probe_load_at(BASE,buffer,code.length)>>>0)!==code.length)throw new Error('code load failed');
  e.r360_ppc_probe_set_execute_on_translate(1);
  e.r360_ppc_probe_set_initial_lr(0xBCBCBCBCn);
  for(const [reg,val] of inputs)e.r360_ppc_probe_set_initial_register(cstr(0,reg),cstr(64,val));
  const hir=e.r360_ppc_probe_translate_scanned_at(BASE+index*8)>>>0;
  if(!hir||(e.r360_ppc_probe_correctness_status()>>>0)!==3)return 'did-not-return';
  const out=[];
  for(const reg of ['r3','v3']){
    e.r360_ppc_probe_compare_register(cstr(0,reg),cstr(64,reg[0]==='v'?'[0,0,0,0]':'0'));
    const p=e.r360_ppc_probe_register_actual()>>>0;const m=new Uint8Array(e.memory.buffer);let s='';
    for(let i=p;m[i];i++)s+=String.fromCharCode(m[i]);
    out.push(`${reg}=${s}`);
  }
  return out.join(' ');
}

let checked=0;const failures=[];
for(let i=0;i<program.length;i++){
  const p=program[i];
  for(let n=0;n<iterations;n++){
    const vec=()=>`[${[word(),word(),word(),word()].map(hex).join(', ')}]`;
    const inputs=p.vec?[['v4',vec()],['v5',vec()],['v6',vec()],['r4',String(rand32()&0xFFFF)]]
                      :[['r4',`0x${hex(word())}`],['r5',`0x${hex(word())}`]];
    if(p.lvs)inputs.push(['r4',String(rand32()&0xFFFF)]);
    const a=run(interp,i,inputs,p.lvs),b=run(jit,i,inputs,p.lvs);
    checked++;
    if(process.env.SHOW&&n===0&&i<3)console.log(p.name,JSON.stringify(inputs),'->',a,'|',b);
    if(a!==b){failures.push(`${p.name} ${JSON.stringify(inputs)}\n    executor: ${a}\n    jit:      ${b}`);break;}
  }
}
const telemetry=jit.r360_jit_stat?{functions:jit.r360_jit_stat(0)>>>0,rejected:jit.r360_jit_stat(1)>>>0}:{};
console.log(`guest JIT differential: ${checked} cases over ${program.length} instructions, ${failures.length} mismatching instructions; JIT ${JSON.stringify(telemetry)}`);
for(const f of failures)console.log(`FAIL ${f}`);
if(failures.length||!telemetry.functions)process.exit(1);
console.log('GUEST_JIT_DIFFERENTIAL_PASS');
