import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`FPU backend WASM not found: ${wasmPath}`);
const parentModule = await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi = new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(parentModule);
for(const e of WebAssembly.Module.imports(parentModule)){if(e.module==='env'&&e.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};}}
const parent=await WebAssembly.instantiate(parentModule,imports);wasi.initialize(parent);
const pick=(n)=>parent.exports[n]??parent.exports[`_${n}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3','r360_ppc_context_size','r360_ppc_context_offset_gpr','r360_wasm_backend_fpu_status','r360_wasm_backend_fpu_module_ptr','r360_wasm_backend_fpu_module_size','r360_wasm_backend_fpu_lowered_instructions','r360_wasm_backend_fpu_context_ptr'];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`Missing FPU backend export ${n}`);
const wordBytes=(...w)=>Uint8Array.from(w.flatMap(x=>[x>>>24,(x>>>16)&255,(x>>>8)&255,x&255]));
const data=0x80000100;
const programs={
  add:wordBytes(0xC8240000,0xC8440008,0xFC61102A,0xD8640010,0x80640010,0x4E800020),
  sub:wordBytes(0xC8240000,0xC8440008,0xFC611028,0xD8640010,0x80640010,0x4E800020),
  mul:wordBytes(0xC8240000,0xC8440008,0xFC6100B2,0xD8640010,0x80640010,0x4E800020),
  div:wordBytes(0xC8240000,0xC8440008,0xFC611024,0xD8640010,0x80640010,0x4E800020),
};
const seeds={
  add:[[0,0x3FF00000],[4,0],[8,0x40000000],[12,0]],
  sub:[[0,0x40140000],[4,0],[8,0x40000000],[12,0]],
  mul:[[0,0x3FF80000],[4,0],[8,0x40000000],[12,0]],
  div:[[0,0x40180000],[4,0],[8,0x40000000],[12,0]],
};
const expectedHi=0x40080000, expectedLo=0;
function seedMemory(entries){for(const [off,val] of entries){if((pick('r360_ppc_probe_write_guest_u32_be')((data+off)>>>0,val>>>0)>>>0)!==1)throw new Error(`Could not seed guest memory +${off}`);}pick('r360_ppc_probe_write_guest_u32_be')((data+16)>>>0,0);pick('r360_ppc_probe_write_guest_u32_be')((data+20)>>>0,0);}
async function one(name){
  const ppc=programs[name];pick('r360_ppc_probe_reset')();if((pick('r360_ppc_probe_set_initial_gpr')(4,BigInt(data))>>>0)!==1)throw new Error('Could not seed oracle r4');seedMemory(seeds[name]);
  const ip=pick('r360_ppc_probe_input_buffer')()>>>0;if(ppc.length>(pick('r360_ppc_probe_input_capacity')()>>>0))throw new Error('Program too large');new Uint8Array(parent.exports.memory.buffer,ip,ppc.length).set(ppc);if((pick('r360_ppc_probe_load')(ip,ppc.length)>>>0)!==ppc.length)throw new Error('PPC load failed');pick('r360_ppc_probe_translate')();
  const oracleStatus=pick('r360_ppc_probe_correctness_status')()>>>0;const oracleR3=BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')());
  if(oracleStatus!==3||oracleR3!==BigInt(expectedHi))throw new Error(`${name}: Xenia oracle failed status=${oracleStatus} r3=${oracleR3}`);
  if((pick('r360_ppc_probe_read_guest_u32_be')((data+16)>>>0)>>>0)!==expectedHi||(pick('r360_ppc_probe_read_guest_u32_be')((data+20)>>>0)>>>0)!==expectedLo)throw new Error(`${name}: oracle memory mismatch`);
  const status=pick('r360_wasm_backend_fpu_status')()>>>0,ptr=pick('r360_wasm_backend_fpu_module_ptr')()>>>0,size=pick('r360_wasm_backend_fpu_module_size')()>>>0,lowered=pick('r360_wasm_backend_fpu_lowered_instructions')()>>>0;
  if(status!==2||!ptr||size<=8||lowered<8)throw new Error(`${name}: FPU backend did not lower finalized HIR status=${status} size=${size} lowered=${lowered}`);
  const childBytes=new Uint8Array(parent.exports.memory.buffer,ptr,size).slice();const childModule=await WebAssembly.compile(childBytes);const child=await WebAssembly.instantiate(childModule,{env:{memory:parent.exports.memory}});
  if(typeof child.exports.run!=='function')throw new Error(`${name}: missing generated run`);
  // Destroy the oracle result and reseed input before generated execution.
  seedMemory(seeds[name]);
  const ctx=pick('r360_wasm_backend_fpu_context_ptr')()>>>0,ctxSize=pick('r360_ppc_context_size')()>>>0,gpr=pick('r360_ppc_context_offset_gpr')()>>>0;new Uint8Array(parent.exports.memory.buffer,ctx,ctxSize).fill(0);const view=new DataView(parent.exports.memory.buffer);view.setBigUint64(ctx+gpr+4*8,BigInt(data),true);
  const generated=BigInt.asUintN(64,child.exports.run(ctx));const stored=view.getBigUint64(ctx+gpr+3*8,true);const hi=pick('r360_ppc_probe_read_guest_u32_be')((data+16)>>>0)>>>0,lo=pick('r360_ppc_probe_read_guest_u32_be')((data+20)>>>0)>>>0;
  if(generated!==oracleR3||stored!==oracleR3||hi!==expectedHi||lo!==expectedLo)throw new Error(`${name}: generated mismatch returned=${generated} stored=${stored} mem=${hi.toString(16)}:${lo.toString(16)} oracle=${oracleR3}`);
  console.log(`wasm_fpu_${name}_module_bytes=${size}`);console.log(`wasm_fpu_${name}_lowered=${lowered}`);console.log(`wasm_fpu_${name}_r3=0x${generated.toString(16)}`);
}
for(const name of ['add','sub','mul','div'])await one(name);
console.log('WASM_BACKEND_FPU_ADD=PASS');console.log('WASM_BACKEND_FPU_SUB=PASS');console.log('WASM_BACKEND_FPU_MUL=PASS');console.log('WASM_BACKEND_FPU_DIV=PASS');console.log('WASM_BACKEND_FPU_ARITHMETIC=PASS');console.log('WASM_BACKEND_STAGE=FPU_ARITHMETIC_PASS');
