import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`FPU semantics WASM not found: ${wasmPath}`);
const parentModule = await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi = new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports = wasi.getImportObject(parentModule);
for (const e of WebAssembly.Module.imports(parentModule)) {
  if (e.module === 'env' && e.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {};
    imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const parent = await WebAssembly.instantiate(parentModule, imports);
wasi.initialize(parent);
const pick = (n) => parent.exports[n] ?? parent.exports[`_${n}`];
const required = [
  'r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr',
  'r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be',
  'r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load',
  'r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3',
  'r360_ppc_context_size','r360_ppc_context_offset_gpr',
  'r360_wasm_backend_fpu_status','r360_wasm_backend_fpu_module_ptr',
  'r360_wasm_backend_fpu_module_size','r360_wasm_backend_fpu_lowered_instructions',
  'r360_wasm_backend_fpu_context_ptr'
];
for (const n of required) if (typeof pick(n) !== 'function') throw new Error(`Missing FPU semantics export ${n}`);

const wordBytes=(...w)=>Uint8Array.from(w.flatMap(x=>[x>>>24,(x>>>16)&255,(x>>>8)&255,x&255]));
const data=0x80000100;
const programs={
  compare: wordBytes(
    0xC8240000, // lfd f1,0(r4) = 1.0
    0xC8440008, // lfd f2,8(r4) = 2.0
    0xFC011000, // fcmpu cr0,f1,f2
    0x7C600026, // mfcr r3
    0x4E800020  // blr
  ),
  fctiwz: wordBytes(
    0xC8240000, // lfd f1,0(r4) = 3.75
    0xFC60081E, // fctiwz f3,f1
    0xD8640010, // stfd f3,16(r4)
    0x80640014, // lwz r3,20(r4)
    0x4E800020
  ),
  frsp: wordBytes(
    0xC8240000, // lfd f1,0(r4) = 3.0
    0xFC600818, // frsp f3,f1
    0xD8640010, // stfd f3,16(r4)
    0x80640010, // lwz r3,16(r4)
    0x4E800020
  ),
  fpscr: wordBytes(
    0xC8240000, // lfd f1,0(r4) = 6.0
    0xC8440008, // lfd f2,8(r4) = 2.0
    0xFC611024, // fdiv f3,f1,f2 -> Xenia UpdateFPSCR
    0xFC80048E, // mffs f4
    0xD8840018, // stfd f4,24(r4)
    0x8064001C, // lwz r3,28(r4)
    0x4E800020
  )
};
const cases=[
  {name:'compare', ppc:programs.compare,
   seeds:[[0,0x3FF00000],[4,0],[8,0x40000000],[12,0]], expectedR3:0x80000000n, memory:[]},
  {name:'fctiwz', ppc:programs.fctiwz,
   seeds:[[0,0x400E0000],[4,0],[16,0],[20,0]], expectedR3:3n,
   memory:[[16,0],[20,3]]},
  {name:'frsp', ppc:programs.frsp,
   seeds:[[0,0x40080000],[4,0],[16,0],[20,0]], expectedR3:0x40080000n,
   memory:[[16,0x40080000],[20,0]]},
  {name:'fpscr', ppc:programs.fpscr,
   seeds:[[0,0x40180000],[4,0],[8,0x40000000],[12,0],[24,0xFFFFFFFF],[28,0xFFFFFFFF]], expectedR3:0n,
   memory:[[24,0],[28,0]]}
];

function seed(entries) {
  for (const [off,val] of entries) {
    const ok = pick('r360_ppc_probe_write_guest_u32_be')((data+off)>>>0,val>>>0)>>>0;
    if (ok !== 1) throw new Error(`Could not seed guest memory +${off}`);
  }
}
function readMemory(expectations) {
  return expectations.map(([off])=>[off,pick('r360_ppc_probe_read_guest_u32_be')((data+off)>>>0)>>>0]);
}
function assertMemory(name, actual, expected, phase) {
  for (let i=0;i<expected.length;i++) {
    const [off,want]=expected[i]; const [,got]=actual[i];
    if (got !== (want>>>0)) throw new Error(`${name}: ${phase} guest +${off} expected 0x${(want>>>0).toString(16)}, got 0x${got.toString(16)}`);
  }
}

for (const test of cases) {
  pick('r360_ppc_probe_reset')();
  if ((pick('r360_ppc_probe_set_initial_gpr')(4,BigInt(data))>>>0)!==1) throw new Error(`${test.name}: could not seed oracle r4`);
  seed(test.seeds);
  const ip=pick('r360_ppc_probe_input_buffer')()>>>0;
  if(test.ppc.length>(pick('r360_ppc_probe_input_capacity')()>>>0)) throw new Error(`${test.name}: program too large`);
  new Uint8Array(parent.exports.memory.buffer,ip,test.ppc.length).set(test.ppc);
  if((pick('r360_ppc_probe_load')(ip,test.ppc.length)>>>0)!==test.ppc.length) throw new Error(`${test.name}: PPC load failed`);
  pick('r360_ppc_probe_translate')();
  const oracleStatus=pick('r360_ppc_probe_correctness_status')()>>>0;
  const oracleR3=BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')());
  if(oracleStatus!==3||oracleR3!==test.expectedR3) throw new Error(`${test.name}: Xenia oracle failed status=${oracleStatus} r3=0x${oracleR3.toString(16)}`);
  assertMemory(test.name,readMemory(test.memory),test.memory,'oracle');

  const status=pick('r360_wasm_backend_fpu_status')()>>>0;
  const ptr=pick('r360_wasm_backend_fpu_module_ptr')()>>>0;
  const size=pick('r360_wasm_backend_fpu_module_size')()>>>0;
  const lowered=pick('r360_wasm_backend_fpu_lowered_instructions')()>>>0;
  if(status!==2||!ptr||size<=8||lowered===0) throw new Error(`${test.name}: generated FPU semantic lowering rejected finalized HIR status=${status} size=${size} lowered=${lowered}`);
  const childBytes=new Uint8Array(parent.exports.memory.buffer,ptr,size).slice();
  const childModule=await WebAssembly.compile(childBytes);
  const child=await WebAssembly.instantiate(childModule,{env:{memory:parent.exports.memory}});
  if(typeof child.exports.run!=='function') throw new Error(`${test.name}: generated module missing run`);

  // Recreate the pre-execution state. This prevents generated Wasm from inheriting
  // the correctness oracle's register or memory result.
  seed(test.seeds);
  const ctx=pick('r360_wasm_backend_fpu_context_ptr')()>>>0;
  const ctxSize=pick('r360_ppc_context_size')()>>>0;
  const gpr=pick('r360_ppc_context_offset_gpr')()>>>0;
  new Uint8Array(parent.exports.memory.buffer,ctx,ctxSize).fill(0);
  const view=new DataView(parent.exports.memory.buffer);
  view.setBigUint64(ctx+gpr+4*8,BigInt(data),true);

  const generated=BigInt.asUintN(64,child.exports.run(ctx));
  const stored=BigInt.asUintN(64,view.getBigUint64(ctx+gpr+3*8,true));
  if(generated!==oracleR3||stored!==oracleR3) throw new Error(`${test.name}: generated r3 mismatch returned=0x${generated.toString(16)} stored=0x${stored.toString(16)} oracle=0x${oracleR3.toString(16)}`);
  assertMemory(test.name,readMemory(test.memory),test.memory,'generated');
  console.log(`wasm_fpu_semantic_${test.name}_module_bytes=${size}`);
  console.log(`wasm_fpu_semantic_${test.name}_lowered=${lowered}`);
  console.log(`wasm_fpu_semantic_${test.name}_r3=0x${generated.toString(16)}`);
}

console.log('WASM_BACKEND_FPU_COMPARE=PASS');
console.log('WASM_BACKEND_FPU_FCTIWZ=PASS');
console.log('WASM_BACKEND_FPU_FRSP=PASS');
console.log('WASM_BACKEND_FPU_FPSCR_CURRENT_XENIA=PASS');
console.log('WASM_BACKEND_FPU_SEMANTICS=PASS');
console.log('WASM_BACKEND_STAGE=FPU_SEMANTICS_PASS');
console.log('NOTE: FPSCR parity is intentionally bounded by current upstream Xenia UpdateFPSCR semantics; this critic does not invent missing hardware exception flags.');
