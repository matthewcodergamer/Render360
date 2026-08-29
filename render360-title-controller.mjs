import { prepareRetailXexImage } from './retail-xex-image-pipeline.mjs';

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const pick=(bootstrap,n)=>bootstrap.exports[n]??bootstrap.exports[`_${n}`];

export async function handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8}){
  const xex=Buffer.from(defaultXex);
  if(xex.length<0x18||xex.toString('ascii',0,4)!=='XEX2')throw new Error('default.xex is not XEX2');
  const headerSize=be32(xex,8);
  if(headerSize<0x18||headerSize>xex.length)throw new Error('default.xex header size out of bounds');
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
  return {headerSize,preparedBytes:prepared.length,entry,hir,handoffBytes:pick(bootstrap,'r360_title_handoff_bytes')()>>>0,status:pick(bootstrap,'r360_title_handoff_status')()>>>0};
}
