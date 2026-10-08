// Xenos command processor semantics the synchronous browser GPU needs:
// WAIT_REG_MEM stalls at the packet (Xenia's CP thread blocks there) and the
// next submit resumes exactly there; COHER_STATUS_HOST writes mark it dirty
// and a WAIT_REG_MEM on it makes it coherent (Xenia MakeCoherent).
import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const fail=m=>{console.error(`FAIL ${m}`);process.exit(1);};
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(module);
imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};
const instance=await WebAssembly.instantiate(module,imports);
wasi.initialize(instance);
const e=instance.exports;

const type0=(reg,count)=>(((count-1)&0x3FFF)<<16)|reg;
const type3=(op,count)=>((3<<30)|(((count-1)&0x3FFF)<<16)|((op&0x7F)<<8))>>>0;
const WAIT_REG_MEM=0x3C, SCRATCH_REG2=0x057A, COHER_STATUS_HOST=0x0A31, POLL=0x0100;
function submit(words){
  const ring=e.r360_xenos_ring_buffer()>>>0;
  new Uint32Array(e.memory.buffer,ring,words.length).set(words.map(w=>w>>>0));
  return e.r360_xenos_submit(words.length)>>>0;
}

e.r360_xenos_reset();
// reg POLL must equal 7 (function 3, register poll), then write SCRATCH_REG2.
const program=[type3(WAIT_REG_MEM,5),0x3,POLL,7,0xFFFFFFFF,0x100,type0(SCRATCH_REG2,1),0x1234];
if(submit(program)!==0||(e.r360_xenos_status()>>>0)!==4)fail(`unmatched WAIT_REG_MEM must stall (status ${e.r360_xenos_status()})`);
if((e.r360_xenos_stall_ring_offset()>>>0)!==0)fail('stall must point at the WAIT packet');
if((e.r360_xenos_register(SCRATCH_REG2)>>>0)!==0)fail('packets after the stalled wait must not run');
e.r360_xenos_set_register(POLL,7);
if(!(e.r360_xenos_arm_resume()>>>0))fail('arm resume');
if(submit(program)!==1)fail(`resumed submit status ${e.r360_xenos_status()}`);
if((e.r360_xenos_register(SCRATCH_REG2)>>>0)!==0x1234)fail('resume did not continue after the wait');

// COHER_STATUS_HOST: a write sets bit 31; WAIT on it clears it and passes.
e.r360_xenos_reset();
const coher=[type0(COHER_STATUS_HOST,1),0x03000000,type3(WAIT_REG_MEM,5),0x3,COHER_STATUS_HOST,0,0x80000000,0x100,type0(SCRATCH_REG2,1),0x55];
if(submit(coher)!==1)fail(`coherency wait must pass after MakeCoherent (status ${e.r360_xenos_status()})`);
if((e.r360_xenos_register(COHER_STATUS_HOST)>>>0)!==0||(e.r360_xenos_register(SCRATCH_REG2)>>>0)!==0x55)fail('MakeCoherent');

console.log('XENOS_WAIT_RESUME_PASS');
