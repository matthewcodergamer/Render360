import fs from 'node:fs';
import {WASI} from 'node:wasi';
import {installBrowserTitleHle,readBrowserTitleHleTelemetry} from './render360-browser-title-hle.mjs';

const mod=await WebAssembly.compile(fs.readFileSync(process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm'));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const bootstrap=await WebAssembly.instantiate(mod,imports);wasi.initialize(bootstrap);const e=bootstrap.exports;
const pick=n=>e[n]??e[`_${n}`];
const p32be=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const dform=(op,rt,ra,imm)=>((op<<26)|(rt<<21)|(ra<<16)|(imm&0xffff))>>>0;
const lis=(rt,imm)=>dform(15,rt,0,imm),ori=(ra,rs,imm)=>dform(24,rs,ra,imm);
const mtctr11=0x7D6903A6,bctrl=0x4E800421,blr=0x4E800020;
const entry=0x91000000;
const hle=installBrowserTitleHle({bootstrap,entry});
if(hle.windowBase!==entry||hle.addresses.vdInitializeRingBuffer!==(entry+0xF080>>>0))throw new Error('relocated HLE layout mismatch');
if(!hle.implementedKernelExports['xboxkrnl.exe:451'])throw new Error('VdInitializeRingBuffer mapping missing');

function runCall(target,{r3=0,r4=0}={}){
  pick('r360_ppc_probe_reset')();
  const words=[lis(11,target>>>16),ori(11,11,target&0xffff),mtctr11,bctrl,blr];
  const ptr=pick('r360_ppc_probe_input_buffer')()>>>0;const bytes=new Uint8Array(e.memory.buffer,ptr,words.length*4);words.forEach((w,i)=>p32be(bytes,i*4,w));
  if((pick('r360_ppc_probe_load_at')(entry,ptr,bytes.length)>>>0)!==bytes.length)throw new Error('relocated caller load failed');
  if((pick('r360_ppc_probe_set_initial_gpr')(3,BigInt(r3>>>0))>>>0)!==1||(pick('r360_ppc_probe_set_initial_gpr')(4,BigInt(r4>>>0))>>>0)!==1)throw new Error('initial GPR setup failed');
  const hir=pick('r360_ppc_probe_translate')()>>>0;if(!hir)throw new Error('relocated caller translation failed');
  const status=pick('r360_ppc_probe_correctness_status')()>>>0;if(status!==3)throw new Error(`relocated nested PPC ABI call failed status=${status}`);
  return {hir,r3:Number(BigInt.asUintN(64,pick('r360_ppc_probe_correctness_r3')()))>>>0};
}

const ringBase=0x91002000,ringSizeLog2=17;
runCall(hle.addresses.vdInitializeRingBuffer,{r3:ringBase,r4:ringSizeLog2});
const telemetry=readBrowserTitleHleTelemetry({bootstrap,hle});
if(!telemetry.ringInitialized||telemetry.ringBase!==ringBase||telemetry.ringSizeLog2!==ringSizeLog2||telemetry.ringBytes!==1048576||telemetry.ringWordCapacity!==262144)throw new Error(`ring capture mismatch ${JSON.stringify(telemetry)}`);
if(telemetry.ringInActiveWindow)throw new Error('1 MiB ring must not be falsely claimed inside the 64 KiB execution window');

const physical=0x91001234;const identity=runCall(hle.addresses.mmGetPhysicalAddress,{r3:physical});if(identity.r3!==physical)throw new Error('MmGetPhysicalAddress identity ABI mismatch');
const freq=runCall(hle.addresses.queryPerformanceFrequency);if(freq.r3!==50000000)throw new Error(`KeQueryPerformanceFrequency ABI mismatch ${freq.r3}`);
const language=runCall(hle.addresses.xGetLanguage);if(language.r3!==1)throw new Error('XGetLanguage ABI mismatch');

console.log('RELOCATED_TITLE_NESTED_PPC_CALLS=PASS');
console.log('BROWSER_TITLE_HLE_ABI_SHIMS=PASS');
console.log('REAL_TITLE_RING_CONFIGURATION_CAPTURE=PASS');
console.log('GPU_RING_OUTSIDE_64K_WINDOW_REPORTED=PASS');
