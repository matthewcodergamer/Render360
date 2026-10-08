// Render360 core trap reports.
//
// A WebAssembly trap (abort, failed allocation, `unreachable`, out-of-bounds
// access) unwinds the whole call into the emulator core. The browser only says
// "Unreachable code should not be executed", and the core's C++ state is left
// half-updated, so the instance must never be reused. Linear memory and simple
// exports stay readable after a trap; the native core keeps a breadcrumb of
// what it was doing (probe_backend.cpp) so the player sees a real reason.

import {kernelExportName} from './render360-kernel-export-names.mjs';

const pick=(bootstrap,name)=>{const f=bootstrap?.exports?.[name]??bootstrap?.exports?.[`_${name}`];return typeof f==='function'?f:null;};
const hex=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
const PHASES=['idle','translating','running'];

export function isWasmTrap(error){
  if(!error)return false;
  if(typeof WebAssembly==='object'&&WebAssembly.RuntimeError&&error instanceof WebAssembly.RuntimeError)return true;
  return error?.name==='RuntimeError'||/Unreachable code should not be executed|^unreachable$|unreachable executed|Out of bounds memory access|memory access out of bounds|call_indirect|indirect call/i.test(String(error?.message||''));
}

function call(bootstrap,name,...args){
  const f=pick(bootstrap,name);
  if(!f)return undefined;
  try{return f(...args);}catch{return undefined;}
}

function readCString(bootstrap,pointer,length){
  const buffer=bootstrap?.exports?.memory?.buffer;
  if(!buffer||!pointer||!length)return '';
  const end=Math.min(buffer.byteLength,pointer+Math.min(length,512));
  if(pointer>=end)return '';
  return new TextDecoder().decode(new Uint8Array(buffer,pointer,end-pointer));
}

// Reads the native breadcrumb. Every read is guarded: after a trap any export
// may itself fault, and a partial report is better than a second exception.
export function readTrapReport(bootstrap){
  if(!bootstrap?.exports)return null;
  const u32=name=>{const v=call(bootstrap,name);return v===undefined?undefined:(Number(v)>>>0);};
  const reasonPointer=u32('r360_trap_reason'),reasonLength=u32('r360_trap_reason_length');
  const phase=u32('r360_trap_phase');
  const calls=[];
  const callCount=Math.min(u32('r360_ppc_probe_stack_call_count')??0,32);
  for(let i=Math.max(0,callCount-8);i<callCount;i++){
    calls.push({source:Number(call(bootstrap,'r360_ppc_probe_stack_call_source',i))>>>0,target:Number(call(bootstrap,'r360_ppc_probe_stack_call_target',i))>>>0,depth:Number(call(bootstrap,'r360_ppc_probe_stack_call_depth',i))>>>0});
  }
  const kernelCalls=[];
  const kernelCount=u32('r360_kernel_import_trace_count')??0;
  for(let i=Math.max(0,kernelCount-6);i<kernelCount;i++){
    const module=Number(call(bootstrap,'r360_kernel_import_trace_module',i))>>>0,ordinal=Number(call(bootstrap,'r360_kernel_import_trace_ordinal',i))>>>0;
    kernelCalls.push({name:kernelExportName(module,ordinal),module,ordinal,status:Number(call(bootstrap,'r360_kernel_import_trace_status',i))>>>0});
  }
  return {
    reason:readCString(bootstrap,reasonPointer,reasonLength),
    phase:phase===undefined?'unknown':(PHASES[phase]||`phase-${phase}`),
    guestAddress:u32('r360_trap_address')??0,
    nestedDepth:u32('r360_trap_depth')??0,
    stackHeadroom:u32('r360_trap_stack_headroom')??0,
    stackExhaustedAt:u32('r360_trap_stack_exhausted')??0,
    memoryBytes:bootstrap.exports.memory?.buffer?.byteLength??0,
    lastGuestCalls:calls,
    lastKernelCalls:kernelCalls,
  };
}

export function describeTrap(report,error){
  const raw=String(error?.message||error||'WebAssembly trap');
  const what=report?.reason
    ?report.reason
    :/out of bounds/i.test(raw)?'out-of-bounds memory access inside the core'
    :`core trap (${raw})`;
  const where=report&&report.phase!=='idle'&&report.phase!=='unknown'&&report.guestAddress
    ?` while ${report.phase} guest code at ${hex(report.guestAddress)}${report.nestedDepth?` (call depth ${report.nestedDepth})`:''}`
    :'';
  const memory=report?.memoryBytes?` · ${(report.memoryBytes/1048576).toFixed(0)} MB wasm memory`:'';
  return `Emulator core crashed: ${what}${where}${memory}. The core was reset — press Play to try again.`;
}

// Turns a raw trap into a readable, tagged error. `onPoisoned` lets the caller
// discard the instance so the next launch instantiates a fresh core.
export function wrapCoreTrap(error,bootstrap,{onPoisoned=null,context=''}={}){
  if(!isWasmTrap(error)||error?.code==='R360_CORE_TRAP')return error;
  let report=null;
  try{report=readTrapReport(bootstrap);}catch{}
  try{onPoisoned?.(bootstrap);}catch{}
  const wrapped=new Error(describeTrap(report,error)+' [FAIL_CLOSED_CORE_TRAP]');
  wrapped.code='R360_CORE_TRAP';
  wrapped.cause=error;
  wrapped.render360={kind:'core-trap',context,trap:report,original:String(error?.message||error)};
  return wrapped;
}

export function formatTrapReport(report){
  if(!report)return [];
  const lines=[];
  if(report.reason)lines.push(`reason: ${report.reason}`);
  lines.push(`phase: ${report.phase}${report.guestAddress?` @ ${hex(report.guestAddress)}`:''} depth ${report.nestedDepth}`);
  if(report.stackHeadroom)lines.push(`host stack headroom at deepest call: ${(report.stackHeadroom/1024).toFixed(0)} KB`);
  for(const c of report.lastGuestCalls||[])lines.push(`call ${hex(c.source)} -> ${hex(c.target)} depth ${c.depth}`);
  for(const k of report.lastKernelCalls||[])lines.push(`kernel ${k.name} status ${k.status}`);
  return lines;
}
