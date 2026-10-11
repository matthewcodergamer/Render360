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
//        [--license trial|full] [--dump-guest ADDR:LEN:FILE]
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
const {wrapCoreTrap,formatTrapReport}=await import(rel('render360-trap-report.mjs'));

function parseArgs(argv){
  const args={input:null,bootstrap:null,trace:48,json:null,verbose:false,traceCalls:false,license:'trial',budget:1<<30};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--bootstrap')args.bootstrap=argv[++i];
    else if(a==='--trace')args.trace=Number(argv[++i]);
    else if(a==='--budget')args.budget=Number(argv[++i]);
    else if(a==='--max-minstr')args.maxMillions=Number(argv[++i]);
    else if(a==='--json')args.json=argv[++i];
    else if(a==='--verbose'||a==='-v')args.verbose=true;
    else if(a==='--trace-calls')args.traceCalls=true;
    else if(a==='--license')args.license=String(argv[++i]||'trial');
    else if(a==='--log-draws')args.logDraws=Number(argv[++i])>>>0;
    else if(a==='--progress')args.progress=true;
    else if(a==='--no-jit')args.jit=0;
    else if(a==='--list-files'){}
    else if(a==='--xenos-trace-from')args.xenosTraceFrom=Number(argv[++i])>>>0;
    else if(a==='--dump-shaders')args.dumpShaders=argv[++i];
    else if(a==='--deterministic')args.deterministicPs=Number(argv[++i])>>>0;
    else if(a==='--jit')args.jit=Number(argv[++i]);
    else if(a==='--watch-kernel-arg')(args.kernelWatch||=[]).push(Number(argv[++i])>>>0);
    else if(a==='--render-from-minstr')args.renderFrom=Number(argv[++i])>>>0;
    else if(a==='--frame')args.frame=argv[++i];
    else if(a==='--slice-ms')args.sliceMs=Number(argv[++i])>>>0;
    else if(a==='--watch')args.watch=Number(argv[++i])>>>0;
    else if(a==='--dump-guest'){const [addr,len,file]=String(argv[++i]).split(':');(args.dumps??=[]).push({address:Number(addr)>>>0,length:Number(len)>>>0,file});}
    else if(a==='--help'||a==='-h')args.help=true;
    else if(!args.input)args.input=a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

const hex=v=>`0x${(Number(v)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;

// --dump-shaders DIR: each distinct current Xenos shader as ucode and as
// Xenia SpirvShaderTranslator SPIR-V (default modification), for the WebGPU
// backend's shader pipeline tests.
const dumpedShaders=new Set();
function dumpCurrentShaders(x,dir){
  fs.mkdirSync(dir,{recursive:true});
  for(const type of [0,1]){
    const dwords=x.r360_xenos_shader_dwords?.(type)>>>0;if(!dwords)continue;
    const key=`${type?'ps':'vs'}_${(x.r360_xenos_shader_hash(type)>>>0).toString(16).padStart(8,'0')}`;
    if(dumpedShaders.has(key))continue;dumpedShaders.add(key);
    const ptr=x.r360_xenos_shader_buffer(type)>>>0;
    fs.writeFileSync(path.join(dir,key+'.ucode'),Buffer.from(new Uint8Array(x.memory.buffer,ptr,dwords*4)));
    x.r360_xenos_spirv_reset?.();
    if((x.r360_xenos_spirv_translate(type)>>>0)===1){const p=x.r360_xenos_spirv_buffer()>>>0,n=x.r360_xenos_spirv_size()>>>0;fs.writeFileSync(path.join(dir,key+'.spv'),Buffer.from(new Uint8Array(x.memory.buffer,p,n)));}
    else fs.writeFileSync(path.join(dir,key+'.fail'),`status 0x${(x.r360_xenos_spirv_status()>>>0).toString(16)}`);
  }
}
async function loadBootstrap(file,verbose){
  // The WASI shim delivers fd_write chunks; reassemble whole lines.
  let pending='';
  const bytes=fs.readFileSync(file);
  const stderr=[];
  const host=createRender360BrowserImports({onStdout:t=>{if(verbose)process.stdout.write(t+'\n');},onStderr:t=>{pending+=t;let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);stderr.push(line);if(stderr.length>4000)stderr.shift();if(verbose||line.startsWith('R360_KWATCH')||line.startsWith('R360_WATCH')||line.startsWith('R360_XENOS_')||line.startsWith('R360_JITPROF'))process.stderr.write(line+'\n');}}});
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
    if(process.argv.includes('--list-files'))for(const f of listed)console.log(`file ${f.path} ${f.size??''}`);
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
    console.log('usage: node tools/run-title.mjs <game.iso|package|default.xex|folder> [--bootstrap file.wasm] [--trace N] [--json out.json] [--budget N] [--verbose] [--trace-calls] [--license trial|full] [--max-minstr N] [--render-from-minstr N] [--frame out.png] [--progress]');
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
  if(args.watch)bootstrap.exports.r360_debug_watch?.(args.watch);
  // Guest time from executed instructions (ps per HIR instruction): replayable runs.
  if(args.deterministicPs)bootstrap.exports.r360_set_deterministic_clock?.(args.deterministicPs);
  if(args.logDraws)bootstrap.exports.r360_xenos_debug_draws?.(args.logDraws);
  // Guest JIT (render360-guest-jit.mjs): hot guest functions run as
  // generated WebAssembly. --no-jit keeps everything on the HIR executor.
  const {installGuestJit}=await import(rel('render360-guest-jit.mjs'));
  const jit=args.jit===0?null:installGuestJit(bootstrap,{mode:args.jit||1,onError:(err)=>{if(!globalThis.__r360JitErrShown){globalThis.__r360JitErrShown=1;console.error('JIT module error:',err.message);}}});
  globalThis.__r360Jit=jit;
  if(process.env.R360_JITPROF)bootstrap.exports.r360_jit_profile?.(1);
  (args.kernelWatch||[]).slice(0,4).forEach((v,k)=>bootstrap.exports.r360_kernel_watch_arg?.(k,v));
  if(args.renderFrom!==undefined)bootstrap.exports.r360_xenos_soft_set_rasterize?.(args.renderFrom===0?1:0);
  // --max-minstr N: stop after N million guest instructions in total.
  bootstrap.exports.r360_hir_set_total_instruction_budget?.(args.maxMillions>>>0||0);
  // XBLA license mask (Xenia license_mask): trial by default, --license full for an owned title.
  globalThis.render360XamLicenseMask=args.license==='full'?1:0;
  const setExecute=bootstrap.exports.r360_ppc_probe_set_execute_on_translate;
  if(typeof setExecute==='function')setExecute(1);
  let error=null,result=null;
  try{
    result=await runWithGuestVfsRetries(
      ()=>handoffDefaultXex({core,bootstrap,defaultXex:title.defaultXex,encryptedSecurityKey,scanEntryFunction:true,prepareMainThreadContext:true,guestSliceMs:args.sliceMs||((args.renderFrom!==undefined||args.progress)?200:0),onGuestSlice:(args.sliceMs||args.renderFrom!==undefined||args.progress||args.dumpShaders||args.xenosTraceFrom!==undefined)?(s=>{const x=bootstrap.exports;if(args.dumpShaders)dumpCurrentShaders(x,args.dumpShaders);if(args.xenosTraceFrom!==undefined&&!globalThis.__r360XenosTrace&&(x.r360_hir_total_instructions_millions?.()>>>0)>=args.xenosTraceFrom){globalThis.__r360XenosTrace=1;x.r360_xenos_trace_ibs?.(1);}if(args.progress){const now=Date.now();if(!globalThis.__r360LastProgress||now-globalThis.__r360LastProgress>5000){globalThis.__r360LastProgress=now;const g=n=>typeof x[n]==='function'?(x[n]()>>>0):0;globalThis.__r360Threads=Array.from({length:g('r360_fiber_count')},(_,k)=>{const t=x.r360_fiber_thread(k)>>>0,w=f=>(x.r360_kernel_thread_wait?.(t,f)??0)>>>0,id=w(0);return {fiber:k,thread:hex(t),state:['new','running','ready','blocked','done'][x.r360_fiber_state(k)>>>0]??'?',resumes:x.r360_fiber_resumes?.(k)>>>0,left:['-','blocked','yield','preempt','host'][x.r360_fiber_leave?.(k,0)>>>0],leaves:[3,4,5,6].map(f=>x.r360_fiber_leave?.(k,f)>>>0).join('/'),leftAfter:(c=>c?kernelExportName(c>>>16,c&0xFFFF):'-')(x.r360_fiber_leave?.(k,1)>>>0),minstr:x.r360_fiber_instructions_millions?.(k)>>>0,wait:id?kernelExportName(id>>>16,id&0xFFFF):null,object:id?hex(w(1)):null,handle:id?hex(w(2)):null,objectType:id?w(3):null,reason:id?w(4):null,callerLr:id?hex(w(5)):null,retries:id?w(6):null,...(()=>{const q=f=>(x.r360_kernel_thread_poll?.(t,f)??0)>>>0,pid=q(0);return pid?{poll:kernelExportName(pid>>>16,pid&0xFFFF),pollObject:hex(q(1)),pollHandle:hex(q(2)),pollType:q(3),pollTimeout:hex(q(4)),pollLr:hex(q(5)),polls:q(6)}:{};})()};});process.stdout.write(`progress ${g('r360_hir_total_instructions_millions')}M instr · ${g('r360_kernel_import_calls')} kernel calls · ${g('r360_title_gpu_vd_swap_calls')} frames · ${g('r360_xenos_soft_draws')} drawn · ${g('r360_xenos_soft_pixels')} px · ${g('r360_fiber_count')} fibers · ${g('r360_fiber_switches')} switches · ${g('r360_fiber_preemptions')} preemptions · ${g('r360_kernel_audio_callbacks')} audio callbacks · jit ${globalThis.__r360Jit?(()=>{const t=globalThis.__r360Jit.telemetry();return `${t.functions}fn/${t.rejected}rej/${Math.round(t.calls/1000)}kcalls`;})():'off'} · resolve ${g('r360_xenos_soft_resolves')}/${g('r360_xenos_soft_resolve_kpixels')}kpx clear ${g('r360_xenos_soft_clear_ksamples')}ks info 0x${g('r360_xenos_soft_last_resolve_info').toString(16)} · cp ${g('r360_xenos_status').toString(16)} stalled ${g('r360_title_gpu_stalled')} ready ${g('r360_xenos_stall_ready')} pumps ${g('r360_title_gpu_pumps')}/${g('r360_title_gpu_status')} waits ${g('r360_xenos_waits')} stall ${[0,1,2,3,4].map(i=>hex(x.r360_xenos_stall_wait?.(i)??0)).join(',')} wptr ${g('r360_title_gpu_write_pointer')} lastop 0x${g('r360_xenos_last_opcode').toString(16)} · pcs ${Array.from({length:g('r360_fiber_count')},(_,k)=>hex(x.r360_fiber_leave?.(k,7))).join(',')}\n`);}}if(args.renderFrom!==undefined&&(x.r360_hir_total_instructions_millions?.()>>>0)>=args.renderFrom)x.r360_xenos_soft_set_rasterize?.(1);if(args.sliceMs&&(s.slices<5||s.slices%50===0))process.stderr.write(`slice ${s.slices}: ${x.r360_title_gpu_vd_swap_calls?.()>>>0} frames\n`);}):null}),
      {bootstrap,fetchPending:async()=>false},
    );
  }catch(caught){if(process.env.R360_TRAP_STACK)console.error(caught?.stack);error=wrapCoreTrap(caught,bootstrap,{context:"run-title"});}
  if(process.env.R360_OPHIST&&bootstrap.exports.r360_hir_opcode_histogram_k){const x=bootstrap.exports,mem=()=>new Uint8Array(x.memory.buffer);const name=op=>{const p=x.r360_hir_opcode_name(op)>>>0;if(!p)return 'op'+op;const m=mem();let e=p;while(m[e])e++;return new TextDecoder().decode(m.subarray(p,e));};const rows=[];for(let op=0;op<256;op++){const k=x.r360_hir_opcode_histogram_k(op)>>>0;if(k)rows.push([name(op),k]);}rows.sort((a,b)=>b[1]-a[1]);const tot=rows.reduce((a,r)=>a+r[1],0);console.log('OPHIST total '+tot+'k');for(const [n,k] of rows)console.log('  '+(100*k/tot).toFixed(2).padStart(6)+'% '+n);}
  if(process.env.R360_JITPROF){bootstrap.exports.r360_jit_profile?.(2);bootstrap.exports.r360_hir_cache_miss_dump?.();}
  if(process.env.R360_JITSTAT&&bootstrap.exports.r360_jit_reject_count){const x=bootstrap.exports,mem=()=>new Uint8Array(x.memory.buffer);const name=op=>{const p=x.r360_hir_opcode_name(op)>>>0;if(!p)return 'op'+op;const m=mem();let e=p;while(m[e])e++;return new TextDecoder().decode(m.subarray(p,e));};const rows=[];for(let op=0;op<256;op++){const k=x.r360_jit_reject_count(op)>>>0;if(k)rows.push([name(op),k]);}rows.sort((a,b)=>b[1]-a[1]);console.log('JIT rejects by first unsupported opcode:');for(const [n,k] of rows.slice(0,30))console.log('  '+String(k).padStart(6)+' '+n);}
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
      guestFibers:result.guestFibers??null,
      guestThreadWaits:globalThis.__r360Threads??null,
      framesPresented:(()=>{const x=bootstrap.exports;const f=n=>typeof x[n]==='function'?(x[n]()>>>0):null;return {vdSwapCalls:f('r360_title_gpu_vd_swap_calls'),vblankInterrupts:f('r360_kernel_vblank_interrupts'),cpInterrupts:f('r360_kernel_cp_interrupts'),gpuPackets:f('r360_xenos_packets'),gpuDraws:f('r360_xenos_draws'),gpuIndirect:f('r360_xenos_indirect_buffers'),gpuStatus:f('r360_xenos_status'),gpuInterruptsRaised:f('r360_xenos_interrupts'),gpuLastOpcode:f('r360_xenos_last_opcode'),gpuFaultWord:f('r360_xenos_last_fault_word'),gpuMemoryWrites:f('r360_xenos_memory_writes'),gpuSwaps:f('r360_xenos_swaps'),gpuWaits:f('r360_xenos_waits'),softDraws:f('r360_xenos_soft_draws'),cacheHits:f('r360_hir_cache_hits'),cacheMisses:f('r360_hir_cache_misses'),cacheEntries:f('r360_hir_cache_entries'),cacheKB:f('r360_hir_cache_kilobytes'),softSkipped:f('r360_xenos_soft_skipped'),softLastSkip:f('r360_xenos_soft_last_skip'),softResolves:f('r360_xenos_soft_resolves'),softPixels:f('r360_xenos_soft_pixels'),softTextureFailures:f('r360_xenos_soft_texture_failures'),softLastTextureFormat:f('r360_xenos_soft_last_texture_format'),vdSwapFailures:f('r360_title_gpu_vd_swap_failures'),width:f('r360_title_gpu_last_vd_swap_width'),height:f('r360_title_gpu_last_vd_swap_height')};})(),
      mainThread:result.mainThreadContext?{stackBytes:result.mainThreadContext.stackBytes,tlsBytes:result.mainThreadContext.tlsBytes,tlsTemplate:result.mainThreadContext.tlsTemplate}:null,
      kernelVariables:{relocated:result.kernelVariableRegistration?.relocated?.map(v=>v.name),placeholders:result.kernelVariableRegistration?.placeholders?.map(v=>kernelExportName(v.module,v.ordinal))},
      importedKernelFunctions:result.kernelImports?.plan?.filter(i=>i.isKernelModule&&i.kind==='function').length,
      kernelFunctionImports:result.kernelImports?.plan?.filter(i=>i.kind==='function').map(i=>kernelExportName(i.module,i.ordinal)),
      kernelExportCalls:Object.fromEntries((result.kernelImports?.plan||[]).filter(i=>i.kind==='function').map(i=>[kernelExportName(i.module,i.ordinal),bootstrap.exports.r360_kernel_export_calls?.(typeof i.module==='number'?i.module:(String(i.module).toLowerCase().startsWith('xam')?2:1),i.ordinal)>>>0]).sort((a,b)=>b[1]-a[1])),
      kernelVariableImports:result.kernelImports?.plan?.filter(i=>i.kind!=='function').map(i=>({module:i.module,ordinal:i.ordinal,name:kernelExportName(i.module,i.ordinal),valueAddress:hex(i.valueAddress),layout:i.descriptorLayout})),
      kernelTrace:(result.kernelTrace||[]).slice(-args.trace),
      titleGpu:result.titleGpuTelemetry,
      debugLog:readDebugLog(bootstrap),
      guestVfsFetched:result.guestVfsFetched,
    });
  }
  // --frame FILE.png saves the last swapped frontbuffer (Xenos decode of the
  // VdSwap fetch constant from guest memory).
  // R360_DUMP=address,bytes,file: guest bytes (sparse memory) after the run.
  for(const spec of (process.env.R360_DUMP||'').split(';').filter(Boolean)){const [a0,n0,file]=spec.split(',');const a=Number(a0)>>>0,n=Number(n0)>>>0,x=bootstrap.exports,out=Buffer.alloc(n);
    const tmp=x.r360_ppc_probe_input_buffer()>>>0;for(let i=0;i<n;i+=4){x.r360_sparse_guest_memory_read_u32_be(a+i,tmp);out.writeUInt32BE(new DataView(x.memory.buffer).getUint32(tmp,true),i);}fs.writeFileSync(file,out);}
  if(args.frame){
    const {captureTitleFrontbuffer}=await import(rel('render360-title-frontbuffer.mjs'));
    const zlib=await import('node:zlib');
    let frame=null;
    try{frame=captureTitleFrontbuffer({bootstrap});}catch(e){frame={captured:false,reason:e.message};}
    if(frame?.captured){
      const {width,height,rgba}=frame;
      const raw=Buffer.alloc((width*4+1)*height);
      for(let y=0;y<height;y++){raw[y*(width*4+1)]=0;Buffer.from(rgba.buffer,rgba.byteOffset+y*width*4,width*4).copy(raw,y*(width*4+1)+1);}
      const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;return c>>>0;});
      const crc=b=>{let c=0xFFFFFFFF;for(const x of b)c=crcTable[(c^x)&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
      const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([len,td,c]);};
      const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
      fs.writeFileSync(args.frame,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
      let nonBlack=0;for(let i=0;i<rgba.length;i+=4)if(rgba[i]|rgba[i+1]|rgba[i+2])nonBlack++;
      report.frame={file:args.frame,width,height,hash:frame.hash,format:frame.format,tiled:frame.tiled,nonBlackPixels:nonBlack};
    }else report.frame={captured:false,reason:frame?.reason};
  }
  // --dump-guest ADDR:LEN:FILE writes raw big-endian guest memory (for
  // powerpc objdump -b binary -EB) after the run.
  for(const dump of args.dumps||[]){
    const out=Buffer.alloc(dump.length);
    const scratch=bootstrap.exports.r360_xex_guest_mapper_input_buffer()>>>0;
    for(let o=0;o<dump.length;o+=4){
      if((bootstrap.exports.r360_sparse_guest_memory_read_u32_be((dump.address+o)>>>0,scratch)>>>0)===1)out.writeUInt32BE(new DataView(bootstrap.exports.memory.buffer).getUint32(scratch,true),o);
    }
    fs.writeFileSync(dump.file,out);
  }
  report.gprsAtStop=Array.from({length:32},(_,i)=>hex(Number(BigInt.asUintN(32,BigInt(bootstrap.exports.r360_ppc_probe_correctness_gpr?.(i)??0)))));
  // Guest call stack of the stopped thread: walk the r1 back chain; each
  // frame's caller saved LR at back_chain - 8 (Xbox 360 prologue).
  {const x=bootstrap.exports,tmp=x.r360_ppc_probe_input_buffer?.()>>>0,rd=a=>{if(!tmp||!x.r360_sparse_guest_memory_read_u32_be?.(a>>>0,tmp))return null;return new DataView(x.memory.buffer).getUint32(tmp,true);};
   const frames=[];let fp=Number(BigInt.asUintN(32,BigInt(x.r360_ppc_probe_correctness_gpr?.(1)??0)));
   for(let n=0;n<48&&fp;n++){const back=rd(fp);if(!back||back<=fp)break;const lr=rd(back-8);if(lr!==null)frames.push(hex(lr));fp=back;}
   report.backtraceAtStop=frames;}
  report.totalInstructionsMillions=bootstrap.exports.r360_hir_total_instructions_millions?.()>>>0;
  report.hostStackHeadroom=bootstrap.exports.r360_trap_stack_headroom?.()>>>0;
  report.lastRuntimeLog=stderr.filter(l=>/R360_(KERNEL|EXEC|STACK_BLOCKER|CALL_RESOLVE|HIR_BLOCK|HIR_MEMORY|XENOS)/.test(l)).slice(-12);

  const statusOf=s=>['?','ok','UNSUPPORTED','INVALID','EXIT','BLOCKED'][s]||String(s);
  console.log(`Render360 title runner · ${report.kind} · ${report.vfs.files} files · ${elapsedMs} ms`);
  if(error){console.log(`${error.code==='R360_CORE_TRAP'?'CORE CRASHED':'FAILED BEFORE EXECUTION'}: ${error.message}`);for(const line of formatTrapReport(error.render360?.trap))console.log(`  ${line}`);}
  else{
    console.log(`entry ${report.entry} · ${report.instructions} PPC instructions (native HIR) · ${report.kernelCalls} kernel calls`);
    console.log(`stopped at: ${report.runtimeBoundary}`);
    if(report.framesPresented?.vdSwapCalls)console.log(`  frames presented (VdSwap): ${report.framesPresented.vdSwapCalls} at ${report.framesPresented.width}x${report.framesPresented.height}${report.framesPresented.vdSwapFailures?`, ${report.framesPresented.vdSwapFailures} failed`:''} · ${report.framesPresented.vblankInterrupts} vblank + ${report.framesPresented.cpInterrupts} CP interrupts · ${report.framesPresented.gpuPackets} PM4 packets, ${report.framesPresented.gpuDraws} draws`);
    if(report.guestFibers)console.log(`  guest threads: ${report.guestFibers.threads} title-created, ${report.guestFibers.switches} switches, stopped on ${report.guestFibers.endedOn?`thread 0x${report.guestFibers.endedOnThread.toString(16)}`:'the primary thread'}`);
    for(const t of report.guestThreadWaits??[])console.log(`    fiber ${t.fiber} thread ${t.thread} ${t.state} (${t.resumes} runs, ${t.minstr}M instr, left by ${t.left} after ${t.leftAfter}; blocked/yield/preempt/host ${t.leaves})${t.wait&&t.state==='blocked'?` in ${t.wait}(${t.object}, handle ${t.handle}, type ${t.objectType}, reason ${t.reason}) from ${t.callerLr} ×${t.retries}`:''}${t.poll?` · polls ${t.poll}(${t.pollObject}, handle ${t.pollHandle}, type ${t.pollType}, timeout ${t.pollTimeout}) from ${t.pollLr} ×${t.polls}`:''}`);
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
    if(report.backtraceAtStop?.length)console.log(`backtrace (stopped thread): ${report.backtraceAtStop.join(' ')}`);
  if(report.debugLog.length){console.log('DbgPrint output:');for(const line of report.debugLog.slice(-16))console.log(`  ${line}`);}
  }
  if(args.json){fs.writeFileSync(args.json,JSON.stringify(report,(k,v)=>typeof v==='bigint'?v.toString():v,2));console.log(`report written to ${args.json}`);}
  process.exitCode=error?1:0;
}

main().catch(error=>{console.error(error?.stack||error);process.exit(1);});
