import { prepareRetailXexImage } from './retail-xex-image-pipeline.mjs';
import { decodeXexImportLibraries } from './render360-xex-imports.mjs';

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const pick=(bootstrap,n)=>bootstrap.exports[n]??bootstrap.exports[`_${n}`];
const maybe=(bootstrap,n)=>typeof pick(bootstrap,n)==='function'?pick(bootstrap,n):null;

export async function handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8}){
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
  pick(bootstrap,'r360_title_handoff_reset')();
  const hir=pick(bootstrap,'r360_title_handoff_translate_entry')(entryBytes)>>>0;
  if(!hir)throw new Error(`title entry handoff failed 0x${(pick(bootstrap,'r360_title_handoff_status')()>>>0).toString(16)}`);

  const execStatusFn=maybe(bootstrap,'r360_ppc_probe_correctness_status');
  const execInstructionsFn=maybe(bootstrap,'r360_ppc_probe_correctness_instructions');
  const execR3Fn=maybe(bootstrap,'r360_ppc_probe_correctness_r3');
  const callCountFn=maybe(bootstrap,'r360_wasm_backend_call_function_count');
  const callAddressFn=maybe(bootstrap,'r360_wasm_backend_call_function_address');
  const executionStatus=execStatusFn?(execStatusFn()>>>0):0;
  const executionInstructions=execInstructionsFn?(execInstructionsFn()>>>0):0;
  const executionR3Hex=execR3Fn?`0x${BigInt.asUintN(64,execR3Fn()).toString(16)}`:'0x0';
  const translatedFunctionCount=callCountFn?(callCountFn()>>>0):0;
  const firstTranslatedFunction=callAddressFn&&translatedFunctionCount?(callAddressFn(0)>>>0):0;
  const runtimeBoundary=executionStatus===3?'guest-return':executionStatus===2?'no-return-boundary':executionStatus===1?'unsupported-hir-or-runtime-dependency':'execution-not-observed';

  return {headerSize,preparedBytes:prepared.length,entry,hir,handoffBytes:pick(bootstrap,'r360_title_handoff_bytes')()>>>0,status:pick(bootstrap,'r360_title_handoff_status')()>>>0,executionStatus,executionInstructions,executionR3Hex,translatedFunctionCount,firstTranslatedFunction,runtimeBoundary,importedLibraries};
}
