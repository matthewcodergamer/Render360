import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`HIR CNTLZ bootstrap WASM not found: ${wasmPath}`);

const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
for(const im of WebAssembly.Module.imports(module)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};
    imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(module,imports);
wasi.initialize(instance);
const e=instance.exports;
const p=name=>e[name]??e[`_${name}`];

const required=[
  'r360_ppc_probe_reset','r360_ppc_probe_input_buffer','r360_ppc_probe_input_capacity',
  'r360_ppc_probe_load_at','r360_ppc_probe_translate','r360_ppc_probe_set_initial_gpr',
  'r360_ppc_probe_correctness_status','r360_ppc_probe_correctness_r3','r360_ppc_probe_correctness_blocker_opcode',
  'r360_ppc_context_size','r360_ppc_context_offset_gpr',
  'r360_wasm_backend_status','r360_wasm_backend_module_ptr','r360_wasm_backend_module_size',
  'r360_wasm_backend_lowered_instructions','r360_wasm_backend_context_ptr',
  'r360_hir_opcode_count','r360_hir_opcode_name','r360_hir_correctness_supports_opcode',
  'r360_hir_correctness_supported_opcode_count','r360_wasm_backend_supports_hir_opcode',
  'r360_wasm_backend_supported_opcode_count',
];
for(const name of required){
  if(typeof p(name)!=='function')throw new Error(`missing V73 HIR CNTLZ export ${name}`);
}
if(!(e.memory instanceof WebAssembly.Memory))throw new Error('V73 HIR CNTLZ test requires exported memory');

const readCString=ptr=>{
  ptr=Number(ptr)>>>0;
  if(!ptr)return '';
  const bytes=new Uint8Array(e.memory.buffer);
  let end=ptr;
  while(end<bytes.length&&bytes[end]&&end-ptr<128)end++;
  return new TextDecoder().decode(bytes.subarray(ptr,end));
};

const CNTLZ_OPCODE=102;
const opcodeCount=p('r360_hir_opcode_count')()>>>0;
const opcodeName=readCString(p('r360_hir_opcode_name')(CNTLZ_OPCODE));
const executorSupport=p('r360_hir_correctness_supports_opcode')(CNTLZ_OPCODE)>>>0;
const wasmSupport=p('r360_wasm_backend_supports_hir_opcode')(CNTLZ_OPCODE)>>>0;
const executorSupported=p('r360_hir_correctness_supported_opcode_count')()>>>0;
const wasmSupported=p('r360_wasm_backend_supported_opcode_count')()>>>0;
if(opcodeCount<=CNTLZ_OPCODE)throw new Error(`Xenia HIR opcode table too short: ${opcodeCount}`);
if(opcodeName!=='cntlz')throw new Error(`opcode ${CNTLZ_OPCODE} resolved as ${opcodeName||'<empty>'}, expected cntlz`);
if(executorSupport!==1)throw new Error('CNTLZ missing from compatibility-executor support metadata');
if(wasmSupport!==1)throw new Error('CNTLZ missing from generated-Wasm backend support metadata');
if(!executorSupported||!wasmSupported)throw new Error(`invalid HIR coverage counts executor=${executorSupported} wasm=${wasmSupported}`);

const input=p('r360_ppc_probe_input_buffer')()>>>0;
const capacity=p('r360_ppc_probe_input_capacity')()>>>0;
const contextSize=p('r360_ppc_context_size')()>>>0;
const gprOffset=p('r360_ppc_context_offset_gpr')()>>>0;
if(!input||!capacity||!contextSize)throw new Error('V73 HIR CNTLZ probe buffers are unavailable');

const wordsToBytes=words=>Uint8Array.from(words.flatMap(w=>[(w>>>24)&255,(w>>>16)&255,(w>>>8)&255,w&255]));

async function runCase(name,words,expected,{initialGprs={},requireLowered=false}={}){
  const code=wordsToBytes(words);
  if(code.length>capacity)throw new Error(`${name}: fixture exceeds probe capacity`);
  p('r360_ppc_probe_reset')();
  for(const [index,value] of Object.entries(initialGprs)){
    if((p('r360_ppc_probe_set_initial_gpr')(Number(index),BigInt(value))>>>0)!==1){
      throw new Error(`${name}: failed to seed GPR ${index}`);
    }
  }
  new Uint8Array(e.memory.buffer,input,code.length).set(code);
  const loaded=p('r360_ppc_probe_load_at')(0x80000000,input,code.length)>>>0;
  if(loaded!==code.length)throw new Error(`${name}: PPC load failed ${loaded}/${code.length}`);
  if(!(p('r360_ppc_probe_translate')()>>>0))throw new Error(`${name}: PPC translation failed`);

  const status=p('r360_ppc_probe_correctness_status')()>>>0;
  const blocker=p('r360_ppc_probe_correctness_blocker_opcode')()>>>0;
  const r3=BigInt.asUintN(64,p('r360_ppc_probe_correctness_r3')());
  if(status!==3||blocker!==0||r3!==expected){
    throw new Error(`${name}: compatibility executor mismatch status=${status} blocker=${blocker} r3=${r3} expected=${expected}`);
  }

  const backendStatus=p('r360_wasm_backend_status')()>>>0;
  const childPtr=p('r360_wasm_backend_module_ptr')()>>>0;
  const childSize=p('r360_wasm_backend_module_size')()>>>0;
  const lowered=p('r360_wasm_backend_lowered_instructions')()>>>0;
  // Constant PPC inputs may be folded by Xenia before the browser backend sees
  // CNTLZ. Those fixtures still certify end-to-end semantics, but two dynamic
  // LOAD_CONTEXT fixtures below must lower the real i32.clz / i64.clz path.
  if(backendStatus!==2||!childPtr||childSize<=8||(requireLowered&&lowered<1)){
    throw new Error(`${name}: generated-Wasm lowering failed status=${backendStatus} ptr=${childPtr} size=${childSize} lowered=${lowered} requireLowered=${requireLowered}`);
  }
  const childBytes=new Uint8Array(e.memory.buffer,childPtr,childSize).slice();
  const childModule=await WebAssembly.compile(childBytes);
  const child=await WebAssembly.instantiate(childModule,{env:{memory:e.memory}});
  if(typeof child.exports.run!=='function')throw new Error(`${name}: generated child has no run export`);

  const contextPtr=p('r360_wasm_backend_context_ptr')()>>>0;
  if(!contextPtr)throw new Error(`${name}: generated backend context pointer is zero`);
  new Uint8Array(e.memory.buffer,contextPtr,contextSize).fill(0);
  const contextView=new DataView(e.memory.buffer);
  for(const [index,value] of Object.entries(initialGprs)){
    contextView.setBigUint64(contextPtr+gprOffset+Number(index)*8,BigInt.asUintN(64,BigInt(value)),true);
  }
  const result=BigInt.asUintN(64,child.exports.run(contextPtr));
  const stored=contextView.getBigUint64(contextPtr+gprOffset+3*8,true);
  if(result!==expected||stored!==expected){
    throw new Error(`${name}: generated-Wasm mismatch result=${result} stored=${stored} expected=${expected}`);
  }
  console.log(`${name}=PASS correctness=${r3} generated=${result} lowered=${lowered} dynamic=${requireLowered?1:0}`);
}

const CNTLZW=0x7D6B0034; // cntlzw r11,r11 — exact Braid blocker instruction at 0x823737D8.
const CNTLZD=0x7D6B0074; // cntlzd r11,r11.
const CNTLZW_R11_R5=0x7CAB0034; // cntlzw r11,r5 — dynamic LOAD_CONTEXT source.
const CNTLZD_R11_R5=0x7CAB0074; // cntlzd r11,r5 — dynamic LOAD_CONTEXT source.
const COPY_R11_TO_R3=0x386B0000; // addi r3,r11,0.
const BLR=0x4E800020;

// Constant-source fixtures certify Xenia/frontend + correctness-oracle behavior.
// Xenia is free to constant-fold these before Render360's runtime Wasm emitter.
await runCase('cntlzw-zero',[0x39600000,CNTLZW,COPY_R11_TO_R3,BLR],32n);
await runCase('cntlzw-one',[0x39600001,CNTLZW,COPY_R11_TO_R3,BLR],31n);
await runCase('cntlzw-all-ones',[0x3960FFFF,CNTLZW,COPY_R11_TO_R3,BLR],0n);
await runCase('cntlzw-0x00010000',[0x3D600001,CNTLZW,COPY_R11_TO_R3,BLR],15n);
await runCase('cntlzw-high-bit',[0x3D608000,CNTLZW,COPY_R11_TO_R3,BLR],0n);
await runCase('cntlzd-zero',[0x39600000,CNTLZD,COPY_R11_TO_R3,BLR],64n);

// Dynamic register fixtures cannot be folded to a constant. These are the
// production-lane proof that actual CNTLZ HIR reaches the generated Wasm emitter.
await runCase('cntlzw-dynamic-r5',[CNTLZW_R11_R5,COPY_R11_TO_R3,BLR],15n,{
  initialGprs:{5:0x00010000n},requireLowered:true,
});
await runCase('cntlzd-dynamic-r5',[CNTLZD_R11_R5,COPY_R11_TO_R3,BLR],63n,{
  initialGprs:{5:1n},requireLowered:true,
});

console.log(`xenia_hir_opcode_count=${opcodeCount}`);
console.log(`hir_executor_supported=${executorSupported}`);
console.log(`hir_wasm_supported=${wasmSupported}`);
console.log('HIR_CNTLZ_METADATA=PASS');
console.log('HIR_CNTLZ_COMPATIBILITY_EXECUTOR=PASS');
console.log('HIR_CNTLZ_GENERATED_WASM_I32_CLZ=PASS');
console.log('HIR_CNTLZ_GENERATED_WASM_I64_CLZ=PASS');
console.log('BRAID_CNTLZW_0x823737D8=PASS');
