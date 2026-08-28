import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`VMX backend WASM not found: ${wasmPath}`);
const parentModule=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(parentModule);
for(const e of WebAssembly.Module.imports(parentModule)){if(e.module==='env'&&e.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};}}
const parent=await WebAssembly.instantiate(parentModule,imports);wasi.initialize(parent);
const pick=n=>parent.exports[n]??parent.exports[`_${n}`];
const required=['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_context_size','r360_ppc_context_offset_gpr','r360_wasm_backend_vmx_status','r360_wasm_backend_vmx_module_ptr','r360_wasm_backend_vmx_module_size','r360_wasm_backend_vmx_lowered_instructions','r360_wasm_backend_vmx_context_ptr','r360_wasm_backend_vmx_vector_ops','r360_wasm_backend_vmx_native_simd_ops','r360_wasm_backend_vmx_scalarized_lane_ops'];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`Missing generated VMX export ${n}`);
const inputPtr=pick('r360_ppc_probe_input_buffer')()>>>0,capacity=pick('r360_ppc_probe_input_capacity')()>>>0;
const base=0x80000100,srcA=base+0x40,srcB=base+0x50,dst=base+0x60;
const wordBytes=(...words)=>Uint8Array.from(words.flatMap(w=>[(w>>>24)&255,(w>>>16)&255,(w>>>8)&255,w&255]));
const vx=xo=>(0x10611000+xo)>>>0;
const lvx1=0x7C2020CE,lvx2=0x7C4028CE,stvx3=0x7C6039CE,lwz3=0x80670000,blr=0x4E800020;
const program=op=>wordBytes(lvx1,lvx2,op,stvx3,lwz3,blr);
const lanes=(a,b,c,d)=>[a>>>0,b>>>0,c>>>0,d>>>0],repeat=x=>lanes(x,x,x,x);
const tests=[
{name:'vadduhm-int16-modulo',op:vx(0x040),a:repeat(0x00010001),b:repeat(0x00020002),expect:repeat(0x00030003)},
{name:'vadduwm-int32-modulo',op:vx(0x080),a:repeat(0x01020304),b:repeat(1),expect:repeat(0x01020305),reuse:true},
{name:'vsububm-int8-modulo',op:vx(0x400),a:repeat(0x05050505),b:repeat(0x02020202),expect:repeat(0x03030303)},
{name:'vsubuhm-int16-modulo',op:vx(0x440),a:repeat(0x00050005),b:repeat(0x00020002),expect:repeat(0x00030003)},
{name:'vsubuwm-int32-modulo',op:vx(0x480),a:repeat(9),b:repeat(6),expect:repeat(3)},
{name:'vand-vec128',op:vx(0x404),a:repeat(0xF0F0F0F0),b:repeat(0x0F0F0F0F),expect:repeat(0)},
{name:'vor-vec128',op:vx(0x484),a:repeat(0xF0F0F0F0),b:repeat(0x0F0F0F0F),expect:repeat(0xFFFFFFFF)},
{name:'vxor-vec128',op:vx(0x4C4),a:repeat(0xAAAAAAAA),b:repeat(0x55555555),expect:repeat(0xFFFFFFFF)},
{name:'vcmpequw-int32',op:vx(0x086),a:repeat(0x12345678),b:repeat(0x12345678),expect:repeat(0xFFFFFFFF)},
{name:'vslw-int32',op:vx(0x184),a:lanes(1,2,4,8),b:repeat(1),expect:lanes(2,4,8,16)},
{name:'vsrw-int32',op:vx(0x284),a:lanes(8,16,32,64),b:repeat(1),expect:lanes(4,8,16,32)},
{name:'vand128-xbox360-low-registers',op:0x14611210,a:repeat(0xFF00FF00),b:repeat(0x0F0F0F0F),expect:repeat(0x0F000F00),vmx128:true},
];
function writeWords(address,words){for(let i=0;i<4;i++)if((pick('r360_ppc_probe_write_guest_u32_be')(address+i*4,words[i])>>>0)!==1)throw new Error('guest write failed');}
function readWords(address){return Array.from({length:4},(_,i)=>pick('r360_ppc_probe_read_guest_u32_be')(address+i*4)>>>0);}
function seed(a,b){writeWords(srcA,a);writeWords(srcB,b);writeWords(dst,repeat(0));}
function seedGeneratedContext(){const ctx=pick('r360_wasm_backend_vmx_context_ptr')()>>>0,ctxSize=pick('r360_ppc_context_size')()>>>0,gpr=pick('r360_ppc_context_offset_gpr')()>>>0;new Uint8Array(parent.exports.memory.buffer,ctx,ctxSize).fill(0);const view=new DataView(parent.exports.memory.buffer);for(const [r,v] of [[4,srcA],[5,srcB],[7,dst]])view.setBigUint64(ctx+gpr+r*8,BigInt(v),true);return ctx;}
let vmx128=0,reused=0;
for(const t of tests){
  pick('r360_ppc_probe_reset')();for(const [r,v] of [[4,srcA],[5,srcB],[7,dst]])if((pick('r360_ppc_probe_set_initial_gpr')(r,BigInt(v))>>>0)!==1)throw new Error(`GPR seed failed ${t.name}`);seed(t.a,t.b);
  const ppc=program(t.op);if(ppc.length>capacity)throw new Error('probe capacity too small');new Uint8Array(parent.exports.memory.buffer,inputPtr,ppc.length).set(ppc);if((pick('r360_ppc_probe_load')(inputPtr,ppc.length)>>>0)!==ppc.length)throw new Error(`load failed ${t.name}`);pick('r360_ppc_probe_translate')();
  const oracleStatus=pick('r360_ppc_probe_correctness_status')()>>>0,oracle=readWords(dst);if(oracleStatus!==3||oracle.some((x,i)=>x!==(t.expect[i]>>>0)))throw new Error(`${t.name}: Xenia oracle mismatch status=${oracleStatus} result=${oracle.map(x=>x.toString(16))}`);
  const status=pick('r360_wasm_backend_vmx_status')()>>>0,ptr=pick('r360_wasm_backend_vmx_module_ptr')()>>>0,size=pick('r360_wasm_backend_vmx_module_size')()>>>0,lowered=pick('r360_wasm_backend_vmx_lowered_instructions')()>>>0,vectorOps=pick('r360_wasm_backend_vmx_vector_ops')()>>>0,simdOps=pick('r360_wasm_backend_vmx_native_simd_ops')()>>>0,laneOps=pick('r360_wasm_backend_vmx_scalarized_lane_ops')()>>>0;
  if(status!==2||!ptr||size<=8||!lowered||!vectorOps||!simdOps)throw new Error(`${t.name}: generated VMX lowering unavailable status=${status} size=${size} lowered=${lowered} vector=${vectorOps} simd=${simdOps}`);
  const childBytes=new Uint8Array(parent.exports.memory.buffer,ptr,size).slice();const childModule=await WebAssembly.compile(childBytes);const child=await WebAssembly.instantiate(childModule,{env:{memory:parent.exports.memory}});if(typeof child.exports.run!=='function')throw new Error(`${t.name}: missing child run`);
  seed(t.a,t.b);const ctx=seedGeneratedContext();child.exports.run(ctx);const actual=readWords(dst);if(actual.some((x,i)=>x!==(t.expect[i]>>>0)))throw new Error(`${t.name}: generated mismatch got=${actual.map(x=>x.toString(16))}`);
  if(t.reuse){const a2=repeat(10),b2=repeat(7),e2=repeat(17);seed(a2,b2);child.exports.run(ctx);const second=readWords(dst);if(second.some((x,i)=>x!==(e2[i]>>>0)))throw new Error(`${t.name}: module reuse baked stale data got=${second.map(x=>x.toString(16))}`);reused++;}
  if(t.vmx128)vmx128++;
  console.log(`wasm_vmx_case=${t.name} module_bytes=${size} lowered=${lowered} vector_ops=${vectorOps} native_simd=${simdOps} scalarized_lanes=${laneOps} result=${actual.map(x=>x.toString(16).padStart(8,'0')).join(':')}`);
}
console.log(`WASM_BACKEND_VMX_STANDARD=PASS cases=${tests.length-vmx128}`);
console.log(`WASM_BACKEND_VMX128=PASS cases=${vmx128}`);
console.log(`WASM_BACKEND_VMX_REUSE=PASS cases=${reused}`);
console.log('WASM_BACKEND_VMX_SIMD=PASS');
console.log('WASM_BACKEND_STAGE=VMX_SIMD_PASS');
