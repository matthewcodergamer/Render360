import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const bytes = fs.readFileSync(wasmPath);
const parentModule = await WebAssembly.compile(bytes);
const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {}, returnOnExit: true });
const imports = wasi.getImportObject(parentModule);
for (const entry of WebAssembly.Module.imports(parentModule)) {
  if (entry.module === 'env' && entry.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {}; imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const parent = await WebAssembly.instantiate(parentModule, imports); wasi.initialize(parent);
const pick = (n) => parent.exports[n] ?? parent.exports[`_${n}`];
const required = [
  'r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be',
  'r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3','r360_ppc_probe_guest_base',
  'r360_ppc_context_size','r360_ppc_context_offset_gpr',
  'r360_wasm_backend_memory_status','r360_wasm_backend_memory_module_ptr','r360_wasm_backend_memory_module_size','r360_wasm_backend_memory_lowered_instructions','r360_wasm_backend_memory_context_ptr',
];
for (const n of required) if (typeof pick(n) !== 'function') throw new Error(`Missing memory critic export ${n}`);
if (!(parent.exports.memory instanceof WebAssembly.Memory)) throw new Error('Parent memory missing');

const wordBytes = (...words) => Uint8Array.from(words.flatMap(w => [(w>>>24)&255,(w>>>16)&255,(w>>>8)&255,w&255]));
const lwz = wordBytes(0x80640000,0x4E800020);
const stwLwz = wordBytes(0x90A40000,0x80640000,0x4E800020);
const guestBase = pick('r360_ppc_probe_guest_base')() >>> 0;
const dataAddress = (guestBase + 0x100) >>> 0;
const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
const contextSize = pick('r360_ppc_context_size')() >>> 0;
const gprOffset = pick('r360_ppc_context_offset_gpr')() >>> 0;

function writeGpr(view, ctx, index, value) { view.setBigUint64(ctx + gprOffset + index * 8, BigInt.asUintN(64,value), true); }

async function buildCase({name, ppc, correctnessGprs, correctnessSeed, expected}) {
  pick('r360_ppc_probe_reset')();
  for (const [i,v] of correctnessGprs) if ((pick('r360_ppc_probe_set_initial_gpr')(i,v)>>>0)!==1) throw new Error(`${name}: initial GPR failed`);
  if ((pick('r360_ppc_probe_write_guest_u32_be')(dataAddress, correctnessSeed)>>>0)!==1) throw new Error(`${name}: seed failed`);
  new Uint8Array(parent.exports.memory.buffer,inputPtr,ppc.length).set(ppc);
  if ((pick('r360_ppc_probe_load')(inputPtr,ppc.length)>>>0)!==ppc.length) throw new Error(`${name}: load failed`);
  pick('r360_ppc_probe_translate')();
  const cs = pick('r360_ppc_probe_correctness_status')()>>>0;
  const cr3 = BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')());
  if (cs!==3 || cr3!==expected) throw new Error(`${name}: Xenia oracle mismatch status=${cs} r3=0x${cr3.toString(16)}`);

  const status=pick('r360_wasm_backend_memory_status')()>>>0;
  const ptr=pick('r360_wasm_backend_memory_module_ptr')()>>>0;
  const size=pick('r360_wasm_backend_memory_module_size')()>>>0;
  const lowered=pick('r360_wasm_backend_memory_lowered_instructions')()>>>0;
  if(status!==2||!ptr||size<=8||lowered<3) throw new Error(`${name}: memory backend rejected finalized HIR status=${status} size=${size} lowered=${lowered}`);
  const childBytes=new Uint8Array(parent.exports.memory.buffer,ptr,size).slice();
  const childModule=await WebAssembly.compile(childBytes);
  const child=await WebAssembly.instantiate(childModule,{env:{memory:parent.exports.memory}});
  if(typeof child.exports.run!=='function') throw new Error(`${name}: generated module missing run`);
  return { child, cr3, size, lowered };
}

// Critic 1: generated lwz must read the exact Xenia guest-memory backing and
// reproduce Xbox big-endian semantics, then reuse the same compiled module on
// a second memory value without retranslation.
const loadCase=await buildCase({name:'lwz-endian',ppc:lwz,correctnessGprs:[[4,BigInt(dataAddress)]],correctnessSeed:0x89ABCDEF,expected:0x89ABCDEFn});
const loadCtx=pick('r360_wasm_backend_memory_context_ptr')()>>>0;
function runLoad(value){
  pick('r360_ppc_probe_write_guest_u32_be')(dataAddress,value>>>0);
  new Uint8Array(parent.exports.memory.buffer,loadCtx,contextSize).fill(0);
  const view=new DataView(parent.exports.memory.buffer); writeGpr(view,loadCtx,4,BigInt(dataAddress));
  const result=BigInt.asUintN(64,loadCase.child.exports.run(loadCtx));
  const stored=view.getBigUint64(loadCtx+gprOffset+3*8,true);
  if(result!==BigInt(value>>>0)||stored!==result) throw new Error(`lwz generated mismatch value=0x${(value>>>0).toString(16)} result=0x${result.toString(16)} stored=0x${stored.toString(16)}`);
  return result;
}
const loadFirst=runLoad(0x89ABCDEF); const loadReuse=runLoad(0x10203040);

// Critic 2: generated stw must mutate that same Xenia backing in big-endian
// form, and the following generated lwz must read the value back. Reseed after
// translation because the reference oracle already executed once.
const storeCase=await buildCase({name:'stw-lwz-endian',ppc:stwLwz,correctnessGprs:[[4,BigInt(dataAddress)],[5,0x12345678n]],correctnessSeed:0,expected:0x12345678n});
const storeCtx=pick('r360_wasm_backend_memory_context_ptr')()>>>0;
function runStore(value){
  pick('r360_ppc_probe_write_guest_u32_be')(dataAddress,0);
  new Uint8Array(parent.exports.memory.buffer,storeCtx,contextSize).fill(0);
  const view=new DataView(parent.exports.memory.buffer); writeGpr(view,storeCtx,4,BigInt(dataAddress)); writeGpr(view,storeCtx,5,BigInt(value>>>0));
  const result=BigInt.asUintN(64,storeCase.child.exports.run(storeCtx));
  const guest=pick('r360_ppc_probe_read_guest_u32_be')(dataAddress)>>>0;
  if(result!==BigInt(value>>>0)||guest!==(value>>>0)) throw new Error(`stw/lwz generated mismatch value=0x${(value>>>0).toString(16)} result=0x${result.toString(16)} guest=0x${guest.toString(16)}`);
  return {result,guest};
}
const storeFirst=runStore(0x12345678); const storeReuse=runStore(0xA1B2C3D4);

console.log(`memory_lwz_module_bytes=${loadCase.size}`);
console.log(`memory_lwz_lowered=${loadCase.lowered}`);
console.log(`memory_lwz_r3=0x${loadFirst.toString(16)}`);
console.log(`memory_lwz_reuse_r3=0x${loadReuse.toString(16)}`);
console.log(`memory_stw_lwz_module_bytes=${storeCase.size}`);
console.log(`memory_stw_lwz_lowered=${storeCase.lowered}`);
console.log(`memory_stw_lwz_r3=0x${storeFirst.result.toString(16)}`);
console.log(`memory_stw_lwz_reuse_r3=0x${storeReuse.result.toString(16)}`);
console.log('WASM_BACKEND_MEMORY_ENDIAN=PASS');
console.log('WASM_BACKEND_STAGE=MEMORY_ENDIAN_PASS');
