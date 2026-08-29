import { prepareRetailXexImage } from './retail-xex-image-pipeline.mjs';
import { decodeXexImportLibraries } from './render360-xex-imports.mjs';
import { buildKernelImportPlan } from './render360-kernel-imports.mjs';
import { installBrowserTitleHle, readBrowserTitleHleTelemetry } from './render360-browser-title-hle.mjs';

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const pick=(bootstrap,n)=>bootstrap.exports[n]??bootstrap.exports[`_${n}`];
const maybe=(bootstrap,n)=>typeof pick(bootstrap,n)==='function'?pick(bootstrap,n):null;
const moduleId=name=>name.toLowerCase()==='xboxkrnl.exe'?1:name.toLowerCase()==='xam.xex'?2:0;

function registerKernelImportPlan(bootstrap,kernelImports){
  const reset=maybe(bootstrap,'r360_kernel_import_reset');
  const register=maybe(bootstrap,'r360_kernel_import_register');
  if(!reset||!register)return {registered:0,available:false};
  reset();let registered=0;
  for(const item of kernelImports.plan){
    if(!item.isKernelModule||item.kind!=='function'||!item.thunkAddress)continue;
    const id=moduleId(item.module);if(!id)continue;
    const impl=item.implementation;
    const implemented=!!impl;
    const abiTarget=implemented?(typeof impl==='object'&&impl!==null&&'r3' in impl?Number(impl.r3)>>>0:0):0;
    if((register(item.thunkAddress>>>0,id,item.ordinal>>>0,implemented?1:0,abiTarget)>>>0)!==1)throw new Error(`failed to register kernel import ${item.module} ordinal 0x${item.ordinal.toString(16)}`);
    registered++;
  }
  return {registered,available:true};
}

function applyInitialGprs(bootstrap,initialGprs){
  const entries=initialGprs instanceof Map?[...initialGprs.entries()]:Array.isArray(initialGprs)?initialGprs.map((v,i)=>[i,v]):Object.entries(initialGprs??{});
  if(!entries.length)return 0;
  const set=maybe(bootstrap,'r360_ppc_probe_set_initial_gpr');if(!set)throw new Error('missing startup GPR export');let applied=0;
  for(const [rawIndex,rawValue] of entries){if(rawValue===undefined||rawValue===null)continue;const index=Number(rawIndex);if(!Number.isInteger(index)||index<0||index>=32)throw new RangeError(`invalid startup GPR index ${rawIndex}`);const value=BigInt.asUintN(64,BigInt(rawValue));if((set(index,value)>>>0)!==1)throw new Error(`failed to set startup GPR r${index}`);applied++;}
  return applied;
}

export async function handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8,implementedKernelExports={},initialGprs={},installDefaultBrowserHle=true}){
  const xex=Buffer.from(defaultXex);
  if(xex.length<0x18||xex.toString('ascii',0,4)!=='XEX2')throw new Error('default.xex is not XEX2');
  const headerSize=be32(xex,8);
  if(headerSize<0x18||headerSize>xex.length)throw new Error('default.xex header size out of bounds');
  const importedLibraries=decodeXexImportLibraries(xex);
  const header=xex.subarray(0,headerSize),body=xex.subarray(headerSize);
  const prepared=await prepareRetailXexImage({core,bootstrap,header,body,encryptedSecurityKey,useDevkitKey});

  for(const n of ['r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_pe_guest_load','r360_pe_guest_status','r360_pe_guest_entry_address','r360_title_handoff_reset','r360_title_handoff_translate_entry','r360_title_handoff_status','r360_title_handoff_entry_address','r360_title_handoff_bytes','r360_title_handoff_hir_instructions'])if(typeof pick(bootstrap,n)!=='function')throw new Error(`missing title-controller export ${n}`);
  const input=pick(bootstrap,'r360_xex_guest_mapper_input_buffer')()>>>0,cap=pick(bootstrap,'r360_xex_guest_mapper_input_capacity')()>>>0;
  if(!input||prepared.length>cap)throw new Error(`prepared image exceeds current PE staging capacity ${prepared.length}/${cap}`);
  new Uint8Array(bootstrap.exports.memory.buffer,input,prepared.length).set(prepared);
  if((pick(bootstrap,'r360_pe_guest_load')(input,prepared.length)>>>0)!==1)throw new Error(`prepared PE guest load failed 0x${(pick(bootstrap,'r360_pe_guest_status')()>>>0).toString(16)}`);
  const entry=pick(bootstrap,'r360_pe_guest_entry_address')()>>>0;

  // Install tiny PPC ABI shims inside the same relocated 64 KiB execution
  // window before title translation. They run as genuine nested guest PPC with
  // the caller's live r3-r10 context. This lets the browser preserve simple
  // kernel semantics and capture the title's real Xenos ring configuration
  // without inventing a ring address in JavaScript.
  const browserHle=installDefaultBrowserHle?installBrowserTitleHle({bootstrap,entry}):null;
  const effectiveKernelExports=browserHle?{...browserHle.implementedKernelExports,...implementedKernelExports}:implementedKernelExports;
  const kernelImports=buildKernelImportPlan(xex,prepared,{implementedExports:effectiveKernelExports});
  const kernelRegistration=registerKernelImportPlan(bootstrap,kernelImports);

  pick(bootstrap,'r360_title_handoff_reset')();
  const startupGprCount=applyInitialGprs(bootstrap,initialGprs);
  const hir=pick(bootstrap,'r360_title_handoff_translate_entry')(entryBytes)>>>0;
  if(!hir)throw new Error(`title entry handoff failed 0x${(pick(bootstrap,'r360_title_handoff_status')()>>>0).toString(16)}`);

  const execStatusFn=maybe(bootstrap,'r360_ppc_probe_correctness_status');
  const execInstructionsFn=maybe(bootstrap,'r360_ppc_probe_correctness_instructions');
  const execR3Fn=maybe(bootstrap,'r360_ppc_probe_correctness_r3');
  const callCountFn=maybe(bootstrap,'r360_wasm_backend_call_function_count');
  const callAddressFn=maybe(bootstrap,'r360_wasm_backend_call_function_address');
  const kernelCallsFn=maybe(bootstrap,'r360_kernel_import_calls');
  const kernelLastThunkFn=maybe(bootstrap,'r360_kernel_import_last_thunk');
  const kernelLastModuleFn=maybe(bootstrap,'r360_kernel_import_last_module');
  const kernelLastOrdinalFn=maybe(bootstrap,'r360_kernel_import_last_ordinal');
  const kernelLastStatusFn=maybe(bootstrap,'r360_kernel_import_last_status');
  const executionStatus=execStatusFn?(execStatusFn()>>>0):0;
  const executionInstructions=execInstructionsFn?(execInstructionsFn()>>>0):0;
  const executionR3Hex=execR3Fn?`0x${BigInt.asUintN(64,execR3Fn()).toString(16)}`:'0x0';
  const translatedFunctionCount=callCountFn?(callCountFn()>>>0):0;
  const firstTranslatedFunction=callAddressFn&&translatedFunctionCount?(callAddressFn(0)>>>0):0;
  const kernelCalls=kernelCallsFn?(kernelCallsFn()>>>0):0;
  const kernelLastThunk=kernelLastThunkFn?(kernelLastThunkFn()>>>0):0;
  const kernelLastModuleId=kernelLastModuleFn?(kernelLastModuleFn()>>>0):0;
  const kernelLastOrdinal=kernelLastOrdinalFn?(kernelLastOrdinalFn()>>>0):0;
  const kernelLastStatus=kernelLastStatusFn?(kernelLastStatusFn()>>>0):0;
  const reachedKernelModule=kernelLastModuleId===1?'xboxkrnl.exe':kernelLastModuleId===2?'xam.xex':null;
  const runtimeBoundary=executionStatus===3?'guest-return':kernelLastStatus===2?'kernel-import-unimplemented':kernelLastStatus===3?'kernel-import-abi-failed':executionStatus===2?'no-return-boundary':executionStatus===1?'unsupported-hir-or-runtime-dependency':'execution-not-observed';
  const firstKernelBlocker=kernelImports.firstKernelBlocker?{module:kernelImports.firstKernelBlocker.module,ordinal:kernelImports.firstKernelBlocker.ordinal,kind:kernelImports.firstKernelBlocker.kind,valueAddress:kernelImports.firstKernelBlocker.valueAddress,thunkAddress:kernelImports.firstKernelBlocker.thunkAddress}:null;
  const reachedKernelBlocker=kernelLastStatus===2?{module:reachedKernelModule,ordinal:kernelLastOrdinal,thunkAddress:kernelLastThunk}:null;
  const browserHleTelemetry=browserHle?readBrowserTitleHleTelemetry({bootstrap,hle:browserHle}):null;
  const browserHleSummary=browserHle?{kind:'relocated-ppc-abi-shims',windowBase:browserHle.windowBase,windowBytes:browserHle.windowBytes,addresses:browserHle.addresses,telemetryAddresses:browserHle.telemetryAddresses}:null;

  return {headerSize,preparedBytes:prepared.length,entry,hir,handoffBytes:pick(bootstrap,'r360_title_handoff_bytes')()>>>0,status:pick(bootstrap,'r360_title_handoff_status')()>>>0,startupGprCount,executionStatus,executionInstructions,executionR3Hex,translatedFunctionCount,firstTranslatedFunction,runtimeBoundary,importedLibraries,kernelImports,kernelImportCount:kernelImports.plan.length,kernelRegistration,kernelCalls,kernelLastStatus,reachedKernelBlocker,firstKernelBlocker,browserHle:browserHleSummary,browserHleTelemetry};
}
