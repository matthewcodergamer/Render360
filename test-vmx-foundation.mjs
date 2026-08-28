import fs from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = process.argv[2] || 'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if (!fs.existsSync(wasmPath)) throw new Error(`VMX foundation WASM not found: ${wasmPath}`);
const bytes = fs.readFileSync(wasmPath);
const module = await WebAssembly.compile(bytes);
const wasi = new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports = wasi.getImportObject(module);
for (const entry of WebAssembly.Module.imports(module)) {
  if (entry.module === 'env' && entry.name === 'emscripten_notify_memory_growth') {
    imports.env ||= {}; imports.env.emscripten_notify_memory_growth = () => {};
  }
}
const instance = await WebAssembly.instantiate(module, imports);
wasi.initialize(instance);
const pick = name => instance.exports[name] ?? instance.exports[`_${name}`];
const required = ['r360_ppc_probe_reset','r360_ppc_probe_set_initial_gpr','r360_ppc_probe_write_guest_u32_be','r360_ppc_probe_read_guest_u32_be','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity','r360_ppc_probe_load','r360_ppc_probe_translate','r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3'];
for (const name of required) if (typeof pick(name) !== 'function') throw new Error(`Missing VMX gate export ${name}`);
const inputPtr = pick('r360_ppc_probe_input_buffer')() >>> 0;
const capacity = pick('r360_ppc_probe_input_capacity')() >>> 0;
const base = 0x80000100;
const srcA = base + 0x40, srcB = base + 0x50, dst = base + 0x60;
const wordBytes = (...words) => Uint8Array.from(words.flatMap(w => [(w>>>24)&255,(w>>>16)&255,(w>>>8)&255,w&255]));
const vx = xo => (0x10611000 + xo) >>> 0; // opcode 4, vd=3, va=1, vb=2
const lvx1=0x7C2020CE, lvx2=0x7C4028CE, stvx3=0x7C6039CE, lwz3=0x80670000, blr=0x4E800020;
const program = op => wordBytes(lvx1,lvx2,op,stvx3,lwz3,blr);
const lanes = (a,b,c,d) => [a>>>0,b>>>0,c>>>0,d>>>0];
const repeat = x => lanes(x,x,x,x);
const EXECUTED_WITH_RETURN_BOUNDARY = 3;

// Raw words are derived from Xenia's pinned tools/ppc-instructions.xml opcode
// contracts. For low VMX128 registers, VX128 uses the same low VD/VA/VB bit
// positions as VX, with high register selector fields remaining zero.
const tests = [
  {name:'vadduhm-int16-modulo',op:vx(0x040),a:repeat(0x00010001),b:repeat(0x00020002),expect:repeat(0x00030003)},
  {name:'vadduwm-int32-modulo',op:vx(0x080),a:repeat(0x01020304),b:repeat(1),expect:repeat(0x01020305)},
  {name:'vsububm-int8-modulo',op:vx(0x400),a:repeat(0x05050505),b:repeat(0x02020202),expect:repeat(0x03030303)},
  {name:'vsubuhm-int16-modulo',op:vx(0x440),a:repeat(0x00050005),b:repeat(0x00020002),expect:repeat(0x00030003)},
  {name:'vsubuwm-int32-modulo',op:vx(0x480),a:repeat(9),b:repeat(6),expect:repeat(3)},
  {name:'vand-vec128',op:vx(0x404),a:repeat(0xF0F0F0F0),b:repeat(0x0F0F0F0F),expect:repeat(0)},
  {name:'vor-vec128',op:vx(0x484),a:repeat(0xF0F0F0F0),b:repeat(0x0F0F0F0F),expect:repeat(0xFFFFFFFF)},
  {name:'vxor-vec128',op:vx(0x4C4),a:repeat(0xAAAAAAAA),b:repeat(0x55555555),expect:repeat(0xFFFFFFFF)},
  // Xenia opcode database: vcmpequw base 0x10000086, VC Rc bit clear.
  {name:'vcmpequw-int32',op:vx(0x086),a:repeat(0x12345678),b:repeat(0x12345678),expect:repeat(0xFFFFFFFF)},
  {name:'vslw-int32',op:vx(0x184),a:lanes(1,2,4,8),b:repeat(1),expect:lanes(2,4,8,16)},
  {name:'vsrw-int32',op:vx(0x284),a:lanes(8,16,32,64),b:repeat(1),expect:lanes(4,8,16,32)},
  // Genuine Xbox 360 VX128 encoding from Xenia: vand128 base 0x14000210.
  // Low-register VD=3, VA=1, VB=2 -> 0x14611210.
  {name:'vand128-xbox360-low-registers',op:0x14611210,a:repeat(0xFF00FF00),b:repeat(0x0F0F0F0F),expect:repeat(0x0F000F00),vmx128:true},
];

function writeWords(address, words) { for (let i=0;i<4;i++) if ((pick('r360_ppc_probe_write_guest_u32_be')(address+i*4,words[i])>>>0)!==1) throw new Error('guest write failed'); }
function readWords(address) { return Array.from({length:4},(_,i)=>pick('r360_ppc_probe_read_guest_u32_be')(address+i*4)>>>0); }
let vmx128Cases=0;
for (const t of tests) {
  pick('r360_ppc_probe_reset')();
  for (const [r,v] of [[4,BigInt(srcA)],[5,BigInt(srcB)],[7,BigInt(dst)]]) if ((pick('r360_ppc_probe_set_initial_gpr')(r,v)>>>0)!==1) throw new Error(`GPR seed failed ${t.name}`);
  writeWords(srcA,t.a); writeWords(srcB,t.b); writeWords(dst,repeat(0));
  const ppc=program(t.op); if (ppc.length>capacity) throw new Error('probe capacity too small');
  new Uint8Array(instance.exports.memory.buffer,inputPtr,ppc.length).set(ppc);
  if ((pick('r360_ppc_probe_load')(inputPtr,ppc.length)>>>0)!==ppc.length) throw new Error(`load failed ${t.name}`);
  pick('r360_ppc_probe_translate')();
  const status=pick('r360_ppc_probe_correctness_status')()>>>0;
  const actual=readWords(dst);
  console.log(`vmx_case=${t.name} opcode=0x${t.op.toString(16).padStart(8,'0')} status=${status} result=${actual.map(x=>x.toString(16).padStart(8,'0')).join(':')}`);
  if (status!==EXECUTED_WITH_RETURN_BOUNDARY || actual.some((x,i)=>x!==(t.expect[i]>>>0))) throw new Error(`VMX foundation mismatch ${t.name}: got ${actual.map(x=>x.toString(16))}`);
  if (t.vmx128) vmx128Cases++;
}
console.log(`VMX_STANDARD_BASELINE=PASS cases=${tests.length-vmx128Cases}`);
console.log(`VMX128_REPRESENTATIVE=PASS cases=${vmx128Cases}`);
console.log(`VMX_FOUNDATION=PASS cases=${tests.length}`);
