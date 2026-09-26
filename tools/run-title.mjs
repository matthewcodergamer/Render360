#!/usr/bin/env node
// Render360 headless title runner.
//
// Boots a lawfully owned Xbox 360 title through exactly the same pipeline the
// browser uses (package core -> retail XEX preparation -> Xbox PE mapping ->
// Xenia PPC/HIR -> native xboxkrnl/XAM services + guest VFS) and prints where
// execution stopped, with every kernel call named from Xenia's export tables.
// It lets you iterate on a title (Braid, Portal ports, ...) on a laptop
// without a round trip through an iPhone.
//
// Usage:
//   node tools/run-title.mjs <game.iso | package (LIVE/PIRS/CON) | default.xex | extracted folder>
//        [--bootstrap build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm]
//        [--trace 64] [--json report.json] [--budget N] [--verbose] [--trace-calls]
//        [--license trial|full]
//
// Nothing here uploads or copies game data anywhere; files are read in place.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rel=p=>path.join(ROOT,p);
const {createRender360BrowserImports,attachRender360BrowserInstance}=await import(rel('render360-browser-wasi.mjs'));
const {handoffDefaultXex}=await import(rel('render360-title-controller.mjs'));
const {extractXex2EncryptedImageKey}=await import(rel('render360-iso-title-controller.mjs'));
const {mountXdvdfs}=await import(rel('render360-xdvdfs.mjs'));
const {registerGuestVfs,listXdvdfsVfsFiles,listStfsVfsFiles,runWithGuestVfsRetries,pendingGuestVfsRead}=await import(rel('render360-guest-vfs.mjs'));
const {kernelExportName}=await import(rel('render360-kernel-export-names.mjs'));
const {Render360Core}=await import(rel('wasm-core.js'));

function parseArgs(argv){
  const args={input:null,bootstrap:null,trace:48,json:null,verbose:false,traceCalls:false,license:'trial',budget:1<<30};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--bootstrap')args.bootstrap=argv[++i];
    else if(a==='--trace')args.trace=Number(argv[++i]);
    else if(a==='--budget')args.budget=Number(argv[++i]);
    else if(a==='--json')args.json=argv[++i];
    else if(a==='--verbose'||a==='-v')args.verbose=true;
    else if(a==='--trace-calls')args.traceCalls=true;
    else if(a==='--license')args.license=String(argv[++i]||'trial');
    else if(a==='--help'||a==='-h')args.help=true;
    else if(!args.input)args.input=a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

const hex=v=>`0x${(Number(v)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;

async function loadBootstrap(file,verbose){
  const bytes=fs.readFileSync(file);
  const stderr=[];
  const host=createRender360BrowserImports({onStdout:t=>{if(verbose)process.stdout.write(t+'\n');},onStderr:t=>{stderr.push(t);if(stderr.length>4000)stderr.shift();if(verbose)process.stderr.write(t+'\n');}});
  const module=await WebAssembly.compile(bytes);
  const instance=attachRender360BrowserInstance(host,await WebAssembly.instantiate(module,host.imports));
  return {instance,host,stderr};
}

async function loadCore(){
  const bytes=fs.readFileSync(rel('render360_xenia_core.wasm'));
  const {instance}=await WebAssembly.instantiate(bytes,{});
  const core=new Render360Core();
  core.instance=instance;core.exports=instance.exports;core.source='node';
  return core;
}

function fileReader(fd){
  return {readSync(offset,length){const out=Buffer.allocUnsafe(length);const n=fs.readSync(fd,out,0,length,offset);return out.subarray(0,n);}};
}

function walkFolder(root){
  const files=[];
  const walk=(dir,prefix)=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const full=path.join(dir,entry.name);const guest=prefix?`${prefix}\\${entry.name}`:entry.name;
      if(entry.isDirectory()){files.push({path:guest,directory:true});walk(full,guest);}
      else if(entry.isFile())files.push({path:guest,size:fs.statSync(full).size,full});
    }
  };
  walk(root,'');
  return files;
}

async function openTitle(input,{core,host}){
  const stat=fs.statSync(input);
  if(stat.isDirectory()){
    const defaultXex=path.join(input,'default.xex');
    if(!fs.existsSync(defaultXex))throw new Error(`${input} has no default.xex`);
    const files=walkFolder(input).map(f=>f.full?{...f,hostFd:host.registerHostFile(fileReader(fs.openSync(f.full,'r')))}:f);
    return {kind:'folder',defaultXex:fs.readFileSync(defaultXex),files};
  }
  const fd=fs.openSync(input,'r');
  const magic=Buffer.alloc(4);fs.readSync(fd,magic,0,4,0);
  const tag=magic.toString('latin1');
  if(tag==='XEX2'){
    // A bare XEX: its folder is the game root, as when launched from a HDD.
    const root=path.dirname(path.resolve(input));
    const files=walkFolder(root).map(f=>f.full?{...f,hostFd:host.registerHostFile(fileReader(fs.openSync(f.full,'r')))}:f);
    if(!files.some(f=>f.path.toLowerCase()==='default.xex'))files.push({path:'default.xex',size:stat.size,hostFd:host.registerHostFile(fileReader(fd))});
    return {kind:'xex',defaultXex:fs.readFileSync(input),files};
  }
  if(tag==='LIVE'||tag==='PIRS'||tag==='CON '){
    const blob=await fs.openAsBlob(input);
    const mount=await core.mountStfs(blob,{extractDefaultXex:false});
    if(!mount.mounted)throw new Error(`STFS package did not mount (${mount.stfs?.statusName})`);
    const listed=listStfsVfsFiles(mount);
    const files=[];let defaultXex=null;
    for(const file of listed){
      if(file.directory){files.push(file);continue;}
      const extracted=await core.extractStfsEntry(blob,file.stfsIndex,{captureLimit:Math.max(1,file.size),maxRequests:1<<20});
      if(!extracted.complete||!extracted.fullyCaptured)throw new Error(`STFS extraction of ${file.path} stopped at ${extracted.bytesDone}/${file.size}`);
      files.push({...file,data:extracted.captured});
      if(file.path.toLowerCase()==='default.xex')defaultXex=Buffer.from(extracted.captured);
    }
    if(!defaultXex)throw new Error('package has no default.xex');
    return {kind:'stfs',defaultXex,files,title:mount.stfs?.displayName};
  }
  // Otherwise try an Xbox game disc image (XISO / XGD1-3).
  const source={size:stat.size,async readRange(offset,length){return fileReader(fd).readSync(offset,length);}};
  const volume=await mountXdvdfs(source);
  const listed=await listXdvdfsVfsFiles(volume);
  const discFd=host.registerHostFile(fileReader(fd));
  const files=listed.map(f=>f.directory?f:{...f,hostFd:discFd,hostOffset:f.imageOffset});
  return {kind:`iso-${volume.layout.toLowerCase()}`,defaultXex:Buffer.from(await volume.readDefaultXex()),files};
}

function readDebugLog(bootstrap){
  const e=bootstrap.exports;
  const count=e.r360_kernel_debug_log_count?.()>>>0;if(!count)return [];
  const scratch=e.r360_vfs_path_buffer?.()>>>0;const out=[];
  for(let i=0;i<count;i++){const n=e.r360_kernel_debug_log_read(i,scratch,1023)>>>0;out.push(Buffer.from(e.memory.buffer,scratch,n).toString('latin1'));}
  return out;
}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  if(args.help||!args.input){
    console.log('usage: node tools/run-title.mjs <game.iso|package|default.xex|folder> [--bootstrap file.wasm] [--trace N] [--json out.json] [--budget N] [--verbose] [--trace-calls] [--license trial|full]');
    process.exit(args.help?0:2);
  }
  const bootstrapFile=args.bootstrap||(fs.existsSync(rel('build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm'))?rel('build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm'):rel('xenia_ppc_bootstrap.wasm'));
  const {instance:bootstrap,host,stderr}=await loadBootstrap(bootstrapFile,args.verbose);
  const core=await loadCore();
  const started=Date.now();
  const title=await openTitle(args.input,{core,host});
  const vfs=registerGuestVfs(bootstrap,title.files);
  const encryptedSecurityKey=extractXex2EncryptedImageKey(title.defaultXex);
  // Per-function HIR fuel: generous on a laptop so CRT startup can finish.
  const budget=bootstrap.exports.r360_hir_set_instruction_budget?.(args.budget>>>0)>>>0;
  // Per-call/per-function stderr tracing is off by default for speed.
  bootstrap.exports.r360_trace_set_verbose?.(args.traceCalls?1:0);
  // XBLA license mask (Xenia license_mask): trial by default, --license full for an owned title.
  globalThis.render360XamLicenseMask=args.license==='full'?1:0;
  const setExecute=bootstrap.exports.r360_ppc_probe_set_execute_on_translate;
  if(typeof setExecute==='function')setExecute(1);
  let error=null,result=null;
  try{
    result=await runWithGuestVfsRetries(
      ()=>handoffDefaultXex({core,bootstrap,defaultXex:title.defaultXex,encryptedSecurityKey,scanEntryFunction:true,prepareMainThreadContext:true}),
      {bootstrap,fetchPending:async()=>false},
    );
  }catch(caught){error=caught;}
  const elapsedMs=Date.now()-started;

  const report={
    input:path.resolve(args.input),kind:title.kind,bootstrap:bootstrapFile,elapsedMs,instructionBudget:budget||null,
    vfs:{files:title.files.filter(f=>!f.directory).length,directories:title.files.filter(f=>f.directory).length,registered:vfs.registered,reads:bootstrap.exports.r360_vfs_reads?.()>>>0,pending:pendingGuestVfsRead(bootstrap)},
    error:error?{message:error.message,details:error.render360??null}:null,
  };
  if(result){
    Object.assign(report,{
      entry:hex(result.entry),runtimeBoundary:result.runtimeBoundary,executionStatus:result.executionStatus,
      instructions:result.executionInstructions,translatedFunctions:result.translatedFunctionCount,
      kernelCalls:result.kernelCalls,kernelBoundary:result.kernelBoundary,
      unsupportedKernelCall:result.reachedKernelBlocker,
      hirBlocker:result.executionBlockerKind?{kind:result.executionBlockerKind,opcode:result.executionBlockerOpcode,address:hex(result.executionBlockerAddress)}:null,
      memoryFault:result.memoryFaultCode?{code:result.memoryFaultCode,address:hex(result.memoryFaultAddress)}:null,
      mainThread:result.mainThreadContext?{stackBytes:result.mainThreadContext.stackBytes,tlsBytes:result.mainThreadContext.tlsBytes,tlsTemplate:result.mainThreadContext.tlsTemplate}:null,
      kernelVariables:{relocated:result.kernelVariableRegistration?.relocated?.map(v=>v.name),placeholders:result.kernelVariableRegistration?.placeholders?.map(v=>kernelExportName(v.module,v.ordinal))},
      importedKernelFunctions:result.kernelImports?.plan?.filter(i=>i.isKernelModule&&i.kind==='function').length,
      kernelTrace:(result.kernelTrace||[]).slice(-args.trace),
      titleGpu:result.titleGpuTelemetry,
      debugLog:readDebugLog(bootstrap),
      guestVfsFetched:result.guestVfsFetched,
    });
  }
  report.lastRuntimeLog=stderr.filter(l=>/R360_(KERNEL|EXEC|STACK_BLOCKER|CALL_RESOLVE|HIR_BLOCK)/.test(l)).slice(-12);

  const statusOf=s=>['?','ok','UNSUPPORTED','INVALID','EXIT','BLOCKED'][s]||String(s);
  console.log(`Render360 title runner · ${report.kind} · ${report.vfs.files} files · ${elapsedMs} ms`);
  if(error){console.log(`FAILED BEFORE EXECUTION: ${error.message}`);}
  else{
    console.log(`entry ${report.entry} · ${report.instructions} PPC instructions (native HIR) · ${report.kernelCalls} kernel calls`);
    console.log(`stopped at: ${report.runtimeBoundary}`);
    if(report.unsupportedKernelCall)console.log(`  next kernel export to implement: ${report.unsupportedKernelCall.module}!${report.unsupportedKernelCall.name} (ordinal ${hex(report.unsupportedKernelCall.ordinal)})`);
    if(report.kernelBoundary)console.log(`  ${report.kernelBoundary.kind}: ${report.kernelBoundary.reason} via ${report.kernelBoundary.export}${report.kernelBoundary.callerLr?` from LR ${hex(report.kernelBoundary.callerLr)}`:''}`);
    if(report.hirBlocker)console.log(`  HIR blocker kind ${report.hirBlocker.kind} opcode ${report.hirBlocker.opcode} at ${report.hirBlocker.address}`);
    if(report.memoryFault)console.log(`  guest memory fault ${report.memoryFault.code} at ${report.memoryFault.address}`);
    if(report.vfs.pending)console.log(`  waiting for game file ${report.vfs.pending.path} (+${report.vfs.pending.offset}, ${report.vfs.pending.length} bytes)`);
    if(report.kernelVariables?.placeholders?.length)console.log(`  kernel variables without Xenia storage (placeholder values): ${report.kernelVariables.placeholders.join(', ')}`);
    console.log(`last ${report.kernelTrace.length} kernel calls:`);
    for(const call of report.kernelTrace){
      console.log(`  #${String(call.sequence).padStart(5)} ${call.name.padEnd(36)} (${call.args.slice(0,4).map(hex).join(', ')}) -> ${hex(call.result)} ${statusOf(call.status)}`);
    }
    if(report.debugLog.length){console.log('DbgPrint output:');for(const line of report.debugLog.slice(-16))console.log(`  ${line}`);}
  }
  if(args.json){fs.writeFileSync(args.json,JSON.stringify(report,(k,v)=>typeof v==='bigint'?v.toString():v,2));console.log(`report written to ${args.json}`);}
  process.exitCode=error?1:0;
}

main().catch(error=>{console.error(error?.stack||error);process.exit(1);});
