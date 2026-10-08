import { prepareRetailXexImage } from './retail-xex-image-pipeline.mjs';
import { decodeXexImportLibraries } from './render360-xex-imports.mjs';
import { buildKernelImportPlan } from './render360-kernel-imports.mjs';
import { installBrowserTitleHle, readBrowserTitleHleTelemetry } from './render360-browser-title-hle.mjs';
import { kernelExportName } from './render360-kernel-export-names.mjs';

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const pick=(bootstrap,n)=>bootstrap.exports[n]??bootstrap.exports[`_${n}`];
const maybe=(bootstrap,n)=>typeof pick(bootstrap,n)==='function'?pick(bootstrap,n):null;
const moduleId=name=>name.toLowerCase()==='xboxkrnl.exe'?1:name.toLowerCase()==='xam.xex'?2:0;
const XEX_HEADER_ENTRY_POINT=0x00010100;
const XENIA_KERNEL_DATA_BASE=0x50010000;
const XENIA_EXECUTABLE_MODULE_VAR=XENIA_KERNEL_DATA_BASE;
const XENIA_KE_DEBUG_MONITOR_DATA=XENIA_KERNEL_DATA_BASE+0x004;
const XENIA_KE_CERT_MONITOR_DATA=XENIA_KERNEL_DATA_BASE+0x008;
const XENIA_EXECUTABLE_HMODULE=XENIA_KERNEL_DATA_BASE+0x100;
const XENIA_XEX_HEADER_BASE=XENIA_KERNEL_DATA_BASE+0x1000;
// Every xboxkrnl variable export Xenia backs with real guest storage
// (XboxkrnlModule constructor + RegisterVideoExports), laid out in the kernel
// data page. Offsets of the first three are part of the locked V74 ABI.
const XENIA_PROCESS_INFO_BLOCK=XENIA_KERNEL_DATA_BASE+0x200;
const XENIA_KERNEL_VARIABLE_LAYOUT=new Map([
  [0x0C,{name:'ExConsoleGameRegion',address:XENIA_KERNEL_DATA_BASE+0x00C,words:[0xFFFFFFFF]}],
  [0x59,{name:'KeDebugMonitorData',address:XENIA_KE_DEBUG_MONITOR_DATA,value:0,words:[0]}],
  [0xAD,{name:'KeTimeStampBundle',address:XENIA_KERNEL_DATA_BASE+0x040,words:[0,0,0,0,0,0]}],
  [0x156,{name:'XboxHardwareInfo',address:XENIA_KERNEL_DATA_BASE+0x010,words:[0x20,0x06000000,0,0]}],
  [0x158,{name:'XboxKrnlVersion',address:XENIA_KERNEL_DATA_BASE+0x020,words:[0x0002FFFF,0xFFFF8000]}],
  [0x193,{name:'XexExecutableModuleHandle',address:XENIA_EXECUTABLE_MODULE_VAR}],
  [0x1AE,{name:'ExLoadedCommandLine',address:XENIA_KERNEL_DATA_BASE+0x800,text:'"default.xex"',bytes:0x400}],
  [0x1AF,{name:'ExLoadedImageName',address:XENIA_KERNEL_DATA_BASE+0x400,text:'\\Device\\Cdrom0\\default.xex',bytes:0x100}],
  [0x1BE,{name:'VdGlobalDevice',address:XENIA_KERNEL_DATA_BASE+0x028,words:[0]}],
  [0x1BF,{name:'VdGlobalXamDevice',address:XENIA_KERNEL_DATA_BASE+0x02C,words:[0]}],
  [0x1C0,{name:'VdGpuClockInMHz',address:XENIA_KERNEL_DATA_BASE+0x030,words:[500]}],
  // X_RTL_CRITICAL_SECTION initialized with spin count 10000 (Xenia).
  [0x1C1,{name:'VdHSIOCalibrationLock',address:XENIA_KERNEL_DATA_BASE+0x060,words:[0x01280000,0,0,0,0xFFFFFFFF,0,0]}],
  [0x266,{name:'KeCertMonitorData',address:XENIA_KE_CERT_MONITOR_DATA,value:0,words:[0]}],
]);
// Xenia XexModule::SetupLibraryImports writes 0xD000BEEF | (ordinal & 0xFFF)
// << 16 into variable imports it has no storage for. Titles that run in Xenia
// only compare these against ObjectType placeholders, so use the same values
// instead of leaving the raw XEX descriptor in the slot.
const xeniaUnmappedVariableValue=ordinal=>(0xD000BEEF|((ordinal&0xFFF)<<16))>>>0;
const XENIA_BUILTIN_VARIABLE_EXPORTS=Object.fromEntries([...XENIA_KERNEL_VARIABLE_LAYOUT].map(([ordinal,spec])=>[`xboxkrnl.exe:${ordinal}`,{kind:'kernel-variable',name:spec.name}]));

function readXexEntryPoint(xex,headerSize){
  const count=be32(xex,0x14);
  if(headerSize<0x18||count>((headerSize-0x18)>>>3))throw new Error('XEX optional-header table out of bounds');
  for(let i=0,p=0x18;i<count;i++,p+=8){
    if(be32(xex,p)!==XEX_HEADER_ENTRY_POINT)continue;
    const entry=be32(xex,p+4);
    if(!entry)throw new Error('XEX entry point is zero');
    return entry>>>0;
  }
  throw new Error('XEX entry point optional header missing');
}

function readXexOptionalHeader(xex,headerSize,key){
  const count=be32(xex,0x14);
  if(headerSize<0x18||count>((headerSize-0x18)>>>3))return null;
  for(let i=0,p=0x18;i<count;i++,p+=8){
    if(be32(xex,p)!==key)continue;
    const value=be32(xex,p+4);
    return (key&0xff)===0?{inline:value}:(key&0xff)===1?{offset:p+4}:{offset:value};
  }
  return null;
}

// XEX_HEADER_TLS_INFO: slot count, raw template address, data size, raw size.
function readXexTlsInfo(xex,headerSize){
  const found=readXexOptionalHeader(xex,headerSize,0x00020104);
  if(!found?.offset||found.offset+16>headerSize)return null;
  const o=found.offset;
  return {slotCount:be32(xex,o),rawDataAddress:be32(xex,o+4),dataSize:be32(xex,o+8),rawDataSize:be32(xex,o+12)};
}

function readXexDefaultStackSize(xex,headerSize){
  return readXexOptionalHeader(xex,headerSize,0x00020200)?.inline>>>0||0;
}

const TERMINAL_KINDS=['none','HalReturnToFirmware','KeBugCheck','ExTerminateThread','XamLoaderTerminateTitle','XamLoaderLaunchTitle','title process exit'];
const WAIT_REASONS=['none','infinite wait on an unsignalled object','bounded wait spinning without progress','lock held by another guest thread','game file bytes not yet available to the synchronous kernel','XMA audio buffers waiting for a decoder (not implemented yet)'];

// Names the terminal (title exit) or would-block (wait) boundary reported by
// the native kernel so diagnostics say *why* execution stopped.
export function readKernelBoundaryTelemetry(bootstrap,kernelLastStatus){
  const get=(n,...a)=>{const f=maybe(bootstrap,n);return f?(f(...a)>>>0):0;};
  if(kernelLastStatus===4){
    const kind=get('r360_kernel_terminal_kind'),module=get('r360_kernel_terminal_module'),ordinal=get('r360_kernel_terminal_ordinal');
    return {kind:'title-requested-exit',reason:TERMINAL_KINDS[kind]||`terminal-${kind}`,export:kernelExportName(module,ordinal),code:get('r360_kernel_terminal_code'),callerLr:get('r360_kernel_terminal_lr'),args:[0,1,2,3].map(i=>get('r360_kernel_terminal_arg',i))};
  }
  if(kernelLastStatus===5){
    const reason=get('r360_kernel_wait_reason'),module=get('r360_kernel_wait_module'),ordinal=get('r360_kernel_wait_ordinal');
    return {kind:'guest-wait-blocked',waitReason:reason,reason:WAIT_REASONS[reason]||`wait-${reason}`,export:kernelExportName(module,ordinal),object:get('r360_kernel_wait_object'),handle:get('r360_kernel_wait_handle'),objectType:get('r360_kernel_wait_object_type')};
  }
  return null;
}

// One readable sentence for a named kernel boundary, for the "Game Stopped"
// sheet and logs. The structured boundary object stays attached for
// diagnostics.
export function describeKernelBoundary(boundary){
  if(!boundary)return '';
  const via=boundary.export&&boundary.export!==boundary.reason?` via ${boundary.export}`:'';
  if(boundary.kind==='title-requested-exit'){
    const code=boundary.code?` (code 0x${(boundary.code>>>0).toString(16).toUpperCase()})`:'';
    if(boundary.reason==='XamLoaderLaunchTitle')return `The game asked to launch another title${via}${code}; title switching is not emulated yet.`;
    if(boundary.reason==='KeBugCheck')return `The game stopped with a kernel bug check${via}${code}.`;
    return `The game asked to exit (${boundary.reason})${via}${code}. Usually an earlier kernel or GPU call returned something it did not accept; Diagnostics lists the kernel call trace.`;
  }
  if(boundary.kind==='guest-wait-blocked')return `The game is waiting in ${boundary.export||'a kernel wait'}: ${boundary.reason}.`;
  return '';
}

// Most recent kernel calls with Xenia export names, arguments and results.
export function readKernelServiceTrace(bootstrap,limit=64){
  const count=maybe(bootstrap,'r360_kernel_import_trace_count');
  if(!count)return [];
  const n=count()>>>0;
  const get=(name,...a)=>maybe(bootstrap,name)?.(...a)>>>0;
  const out=[];
  for(let i=Math.max(0,n-limit);i<n;i++){
    const module=get('r360_kernel_import_trace_module',i),ordinal=get('r360_kernel_import_trace_ordinal',i);
    out.push({sequence:get('r360_kernel_import_trace_sequence',i),name:kernelExportName(module,ordinal),module,ordinal,thunk:get('r360_kernel_import_trace_thunk',i),args:[0,1,2,3,4,5].map(a=>get('r360_kernel_import_trace_arg',i,a)),result:get('r360_kernel_import_trace_result',i),status:get('r360_kernel_import_trace_status',i)});
  }
  return out;
}

function hasNativeTitleGpuRuntime(bootstrap){
  return ['r360_title_gpu_ring_base','r360_title_gpu_ring_size_log2','r360_title_gpu_ring_bytes','r360_title_gpu_ring_word_capacity','r360_title_gpu_write_pointer','r360_title_gpu_status'].every(n=>!!maybe(bootstrap,n));
}

function readNativeTitleGpuTelemetry(bootstrap,entry){
  if(!hasNativeTitleGpuRuntime(bootstrap))return null;
  const get=n=>maybe(bootstrap,n)?.()>>>0;
  const ringBase=get('r360_title_gpu_ring_base');
  const ringSizeLog2=get('r360_title_gpu_ring_size_log2');
  const ringBytes=get('r360_title_gpu_ring_bytes');
  const ringWordCapacity=get('r360_title_gpu_ring_word_capacity');
  const writePointer=get('r360_title_gpu_write_pointer');
  const rptrWriteback=get('r360_title_gpu_rptr_writeback');
  const rptrBlockSizeLog2=get('r360_title_gpu_rptr_block_size_log2');
  const mmioWrites=get('r360_title_gpu_mmio_writes');
  const status=get('r360_title_gpu_status');
  const windowEnd=BigInt(entry>>>0)+65536n;
  const ringInActiveWindow=!!ringBase&&ringBase>=(entry>>>0)&&BigInt(ringBase)+BigInt(Math.max(4,ringBytes||4))<=windowEnd;
  return {kind:'native-wasm-title-gpu-runtime',ringInitialized:!!ringBase,ringBase,ringSizeLog2,ringBytes,ringWordCapacity,writePointer,rptrWriteback,rptrBlockSizeLog2,mmioWrites,status,ringInActiveWindow,producerObserved:status>=2&&writePointer>0};
}

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

function installKernelVariableImports(bootstrap,kernelImports,xex,{entry,headerSize}){
  const supported=kernelImports.plan.filter(item=>item.isKernelModule&&item.kind==='variable');
  if(!supported.length)return {available:true,patched:0,supported:0};
  const alloc=maybe(bootstrap,'r360_sparse_guest_memory_alloc');
  const map=maybe(bootstrap,'r360_sparse_guest_memory_map');
  const write8=maybe(bootstrap,'r360_sparse_guest_memory_write_u8');
  const patch32=maybe(bootstrap,'r360_xex_guest_mapper_patch_u32_be');
  if(!alloc||!map||!write8||!patch32)throw new Error('published browser bootstrap is missing Xenia kernel-variable relocation support; refresh to the synchronized runtime');

  const pageSize=4096,readWrite=3;
  const headerPages=Math.ceil(headerSize/pageSize);
  const pages=1+headerPages;
  const backing=alloc(pages)>>>0;
  if(!backing||(map(XENIA_KERNEL_DATA_BASE,pages,backing,0,readWrite)>>>0)!==1)throw new Error('unable to map Xenia kernel variable/module state');

  const put8=(address,value)=>{if((write8(address>>>0,value&0xff)>>>0)!==1)throw new Error(`unable to initialize Xenia kernel state @ 0x${(address>>>0).toString(16)}`)};
  const put32=(address,value)=>{const v=Number(value)>>>0;for(let i=0;i<4;i++)put8(address+i,(v>>>(24-i*8))&0xff)};
  for(let i=0;i<headerSize;i++)put8(XENIA_XEX_HEADER_BASE+i,xex[i]);

  const securityOffset=be32(xex,0x10);
  if(securityOffset>headerSize-8)throw new Error('XEX security header is outside copied guest header');
  const imageSize=be32(xex,securityOffset+4);
  // X_LDR_DATA_TABLE_ENTRY fields used by Xenia UserModule::LoadXexContinue.
  put32(XENIA_EXECUTABLE_HMODULE+0x18,0);
  put32(XENIA_EXECUTABLE_HMODULE+0x1c,kernelImports.imageBase);
  put32(XENIA_EXECUTABLE_HMODULE+0x38,imageSize);
  put32(XENIA_EXECUTABLE_HMODULE+0x3c,entry);
  put32(XENIA_EXECUTABLE_HMODULE+0x58,XENIA_XEX_HEADER_BASE);
  // Xenia's xboxkrnl module exports these as actual guest variables. Keep
  // distinct backing cells and relocate only the exact variable ordinals that
  // have faithful state here; unknown variables remain fail-closed.
  put32(XENIA_EXECUTABLE_MODULE_VAR,XENIA_EXECUTABLE_HMODULE);
  for(const spec of XENIA_KERNEL_VARIABLE_LAYOUT.values()){
    if(spec.words)spec.words.forEach((word,i)=>put32(spec.address+i*4,word));
    if(spec.text){for(let i=0;i<spec.bytes;i++)put8(spec.address+i,i<spec.text.length?spec.text.charCodeAt(i):0);}
  }
  // ProcessInfoBlock (KernelState::SetExecutableModule), pointed to by
  // KTHREAD+0x84 of every title thread.
  const tlsInfo=readXexTlsInfo(xex,headerSize);
  for(let i=0;i<0x60;i+=4)put32(XENIA_PROCESS_INFO_BLOCK+i,0);
  put32(XENIA_PROCESS_INFO_BLOCK+0x0C,0x0000007F);
  put32(XENIA_PROCESS_INFO_BLOCK+0x10,0x001F0000);
  put8(XENIA_PROCESS_INFO_BLOCK+0x1B,0x06);
  put32(XENIA_PROCESS_INFO_BLOCK+0x1C,16*1024);
  if(tlsInfo){
    put32(XENIA_PROCESS_INFO_BLOCK+0x24,tlsInfo.dataSize);
    put32(XENIA_PROCESS_INFO_BLOCK+0x28,tlsInfo.rawDataSize);
    put8(XENIA_PROCESS_INFO_BLOCK+0x2C,((tlsInfo.slotCount*4)>>>8)&0xff);
    put8(XENIA_PROCESS_INFO_BLOCK+0x2D,(tlsInfo.slotCount*4)&0xff);
  }
  put8(XENIA_PROCESS_INFO_BLOCK+0x2F,1); // X_PROCTYPE_USER
  const setModule=maybe(bootstrap,'r360_kernel_set_executable_module');
  if(setModule&&(setModule(XENIA_EXECUTABLE_HMODULE,XENIA_XEX_HEADER_BASE,XENIA_PROCESS_INFO_BLOCK)>>>0)!==1)throw new Error('native kernel rejected the guest XEX header');
  maybe(bootstrap,'r360_kernel_set_timestamp_bundle')?.(XENIA_KERNEL_DATA_BASE+0x040);

  let patched=0;
  const relocated=[];
  const placeholders=[];
  for(const item of supported){
    const isXboxkrnl=item.module.toLowerCase()==='xboxkrnl.exe';
    const spec=isXboxkrnl?XENIA_KERNEL_VARIABLE_LAYOUT.get(item.ordinal):null;
    const targetAddress=spec?spec.address>>>0:xeniaUnmappedVariableValue(item.ordinal);
    if((patch32(item.valueAddress>>>0,targetAddress)>>>0)!==1){
      const status=maybe(bootstrap,'r360_xex_guest_mapper_status')?.()>>>0||0;
      throw new Error(`failed to relocate ${item.module}!${spec?.name??`0x${item.ordinal.toString(16)}`} at 0x${(item.valueAddress>>>0).toString(16)} (mapper 0x${status.toString(16)})`);
    }
    if(spec)relocated.push({module:item.module,ordinal:item.ordinal,name:spec.name,slotAddress:item.valueAddress>>>0,targetAddress});
    else placeholders.push({module:item.module,ordinal:item.ordinal,slotAddress:item.valueAddress>>>0,value:targetAddress});
    patched++;
  }
  const variableAddresses=Object.fromEntries([...XENIA_KERNEL_VARIABLE_LAYOUT.values()].map(spec=>[spec.name,spec.address>>>0]));
  return {available:true,patched,supported:supported.length,variableAddress:XENIA_EXECUTABLE_MODULE_VAR,variableAddresses,relocated,placeholders,processInfoBlock:XENIA_PROCESS_INFO_BLOCK,hmoduleAddress:XENIA_EXECUTABLE_HMODULE,xexHeaderAddress:XENIA_XEX_HEADER_BASE,headerBytes:headerSize,imageBase:kernelImports.imageBase>>>0,imageSize,entry:entry>>>0};
}

function applyInitialGprs(bootstrap,initialGprs){
  const entries=initialGprs instanceof Map?[...initialGprs.entries()]:Array.isArray(initialGprs)?initialGprs.map((v,i)=>[i,v]):Object.entries(initialGprs??{});
  if(!entries.length)return 0;
  const set=maybe(bootstrap,'r360_ppc_probe_set_initial_gpr');if(!set)throw new Error('missing startup GPR export');let applied=0;
  for(const [rawIndex,rawValue] of entries){if(rawValue===undefined||rawValue===null)continue;const index=Number(rawIndex);if(!Number.isInteger(index)||index<0||index>=32)throw new RangeError(`invalid startup GPR index ${rawIndex}`);const value=BigInt.asUintN(64,BigInt(rawValue));if((set(index,value)>>>0)!==1)throw new Error(`failed to set startup GPR r${index}`);applied++;}
  return applied;
}

function prepareBrowserMainThreadContext(bootstrap,entry,{xex=null,headerSize=0}={}){
  const alloc=maybe(bootstrap,'r360_sparse_guest_memory_alloc');
  const map=maybe(bootstrap,'r360_sparse_guest_memory_map');
  const write8=maybe(bootstrap,'r360_sparse_guest_memory_write_u8');
  if(!alloc||!map||!write8)throw new Error('published browser bootstrap is missing sparse guest-memory main-thread support');

  // Match the important parts of Xenia's real ThreadState/XThread startup.
  // Xbox user stacks live in 0x70000000-0x7F000000 and r13 points at the
  // per-thread PCR. The fallback used to enter the XEX with every GPR zero.
  const pageSize=4096;
  const stackSlotBase=0x70000000;
  const stackGuardBytes=pageSize;
  const stackLimit=(stackSlotBase+stackGuardBytes)>>>0;
  // Xenia sizes the primary stack from XEX_HEADER_DEFAULT_STACK_SIZE. Keep the
  // historical 512 KiB as a floor so small headers never shrink the stack.
  const xexStackBytes=xex?readXexDefaultStackSize(xex,headerSize):0;
  const stackPages=Math.max(128,Math.min(0x0F00,Math.ceil(xexStackBytes/4096)));
  // Xenia ThreadState starts r1 at the high stack boundary. Processor::Execute
  // then reserves 64 + 112 bytes before entering guest code. We previously
  // entered default.xex with an invented -0x100 stack pointer, which is not the
  // Xenia/Xbox entry ABI and can make title prologues consume zeroed slots.
  const stackBasePointer=(stackLimit+stackPages*pageSize)>>>0;
  const xeniaCallFrameBytes=64+112;
  const xeniaInitialLr=0xBCBCBCBC;
  const stackTop=(stackBasePointer-xeniaCallFrameBytes)&~0xF;
  const pcrAddress=0x50000000;
  const tlsAddress=0x50001000;
  const threadAddress=0x50002000;
  const contextPages=3;
  const readWrite=3;

  // Xenia protects 0x00000000-0x0000FFFF by default. Do not map a synthetic
  // zero-filled title aperture here. If guest code reaches this region through
  // a zero base register, preserve the fault so the missing loader/register
  // state is diagnosed at the first incorrect dependency instead of being
  // hidden until a later stack teardown.

  const stackBacking=alloc(stackPages)>>>0;
  if(!stackBacking||(map(stackLimit,stackPages,stackBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map Xbox main-thread stack');
  const contextBacking=alloc(contextPages)>>>0;
  if(!contextBacking||(map(pcrAddress,contextPages,contextBacking,0,readWrite)>>>0)!==1)throw new Error('unable to map Xbox main-thread PCR/TLS');

  const be32=(address,value)=>{
    const v=Number(value)>>>0;
    for(let i=0;i<4;i++){
      if((write8((address+i)>>>0,(v>>>(24-i*8))&0xFF)>>>0)!==1){
        throw new Error(`unable to initialize Xbox thread memory @ 0x${(address+i).toString(16)}`);
      }
    }
  };

  be32(pcrAddress+0x000,tlsAddress);
  be32(pcrAddress+0x030,pcrAddress);
  be32(pcrAddress+0x070,stackBasePointer);
  be32(pcrAddress+0x074,stackLimit);
  be32(pcrAddress+0x100,threadAddress);
  be32(pcrAddress+0x150,0);

  be32(threadAddress+0x05C,stackBasePointer);
  be32(threadAddress+0x060,stackLimit);
  be32(threadAddress+0x068,tlsAddress);
  be32(threadAddress+0x0D0,stackBasePointer);
  be32(threadAddress+0x14C,1);
  be32(threadAddress+0x150,entry>>>0);
  // Remaining XThread::InitializeGuestObject fields: dispatcher header type 6
  // and self-linked list heads, process info block, creation time, flags.
  const put8=(address,value)=>{if((write8(address>>>0,value&0xff)>>>0)!==1)throw new Error(`unable to initialize Xbox thread memory @ 0x${(address>>>0).toString(16)}`)};
  put8(threadAddress+0x000,6);
  for(const [off,target] of [[0x008,0x008],[0x00C,0x008],[0x010,0x010],[0x014,0x010],[0x040,0x020],[0x044,0x020],[0x048,0x000],[0x04C,0x018],[0x074,0x074],[0x078,0x074],[0x07C,0x07C],[0x080,0x07C],[0x144,0x144],[0x148,0x144],[0x154,0x154],[0x158,0x154]])be32(threadAddress+off,threadAddress+target);
  be32(threadAddress+0x054,0x01020001);
  be32(threadAddress+0x084,XENIA_PROCESS_INFO_BLOCK);
  put8(threadAddress+0x08B,1);
  be32(threadAddress+0x09C,0xFDFFD7FF);
  be32(threadAddress+0x17C,1);

  // TLS: Xenia allocates slots*4 + extended data and copies the XEX TLS
  // template (__declspec(thread) initial values) into the static block.
  const tlsInfo=xex?readXexTlsInfo(xex,headerSize):null;
  let tlsBlock=tlsAddress,tlsBytes=pageSize;
  if(tlsInfo){
    const slots=tlsInfo.slotCount||1024;
    const total=slots*4+tlsInfo.dataSize;
    const poolAlloc=maybe(bootstrap,'r360_kernel_pool_alloc');
    if(total>pageSize){
      if(!poolAlloc)throw new Error(`XEX TLS block of ${total} bytes needs the native kernel pool; refresh to the synchronized runtime`);
      tlsBlock=poolAlloc(total,16)>>>0;
      if(!tlsBlock)throw new Error(`unable to allocate ${total}-byte Xbox TLS block`);
    }
    tlsBytes=total;
    const read8=maybe(bootstrap,'r360_sparse_guest_memory_read_u8');
    const copy=Math.min(tlsInfo.rawDataSize,tlsInfo.dataSize);
    if(copy&&tlsInfo.rawDataAddress){
      if(!read8)throw new Error('published browser bootstrap cannot read the XEX TLS template');
      for(let i=0;i<copy;i++)put8(tlsBlock+i,read8((tlsInfo.rawDataAddress+i)>>>0));
    }
    be32(pcrAddress+0x000,tlsBlock);
    be32(threadAddress+0x068,tlsBlock);
  }

  // Register the primary thread with the native thread registry so TLS,
  // critical sections, waits and thread-object queries see a current thread.
  const registerExternal=maybe(bootstrap,'r360_guest_thread_register_external');
  const registryHandle=registerExternal?(registerExternal(entry>>>0,stackBasePointer,stackLimit,pcrAddress,threadAddress,1)>>>0):0;

  return {kind:'xenia-main-thread-context',stackSlotBase,stackBase:stackBasePointer,stackLimit,stackBasePointer,stackTop,stackGuardBytes,xeniaCallFrameBytes,xeniaInitialLr,pcrAddress,tlsAddress:tlsBlock,tlsBytes,tlsTemplate:tlsInfo,threadAddress,registryHandle,startAddress:entry>>>0,stackBytes:stackPages*pageSize,xexStackBytes,zeroPageCompat:false,lowMemoryCompatBytes:0,lowMemoryPolicy:'xenia-protected'};
}

// XEX security info page descriptors, as Xenia's XexModule reads them: each
// 0x18-byte record starts with a big-endian word (low 4 bits section info,
// upper 28 bits page count). Pages are 64 KiB for images at or below
// 0x90000000, else 4 KiB.
export function readXexPageDescriptors(xex){
  const bytes=xex instanceof Uint8Array?xex:new Uint8Array(xex);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.byteLength<0x18)return null;
  const sec=view.getUint32(0x10,false);
  if(sec+0x184>bytes.byteLength)return null;
  const loadAddress=view.getUint32(sec+0x110,false);
  const count=view.getUint32(sec+0x180,false);
  if(!count||count>4096||sec+0x184+count*0x18>bytes.byteLength)return null;
  const words=new Uint32Array(count);
  for(let i=0;i<count;i++)words[i]=view.getUint32(sec+0x184+i*0x18,false);
  return {words,pageSize:loadAddress<=0x90000000?0x10000:0x1000,loadAddress};
}

function stagePreparedPeImage(bootstrap,prepared,xexEntry,xex=null){
  const inputBuffer=pick(bootstrap,'r360_xex_guest_mapper_input_buffer');
  const inputCapacity=pick(bootstrap,'r360_xex_guest_mapper_input_capacity');
  let input=inputBuffer()>>>0;
  let cap=inputCapacity()>>>0;
  let stagingGrew=false;

  if(prepared.length>cap){
    const reserve=maybe(bootstrap,'r360_xex_guest_mapper_reserve_input');
    const maxCapacity=maybe(bootstrap,'r360_xex_guest_mapper_input_max_capacity');
    const max=maxCapacity?(maxCapacity()>>>0):0;
    if(!reserve){
      throw new Error(`published browser bootstrap cannot grow PE staging for prepared image ${prepared.length}/${cap}; refresh to the synchronized runtime`);
    }
    if(max&&prepared.length>max){
      throw new Error(`prepared image exceeds bounded PE staging ceiling ${prepared.length}/${max}`);
    }
    if((reserve(prepared.length)>>>0)!==1){
      const status=maybe(bootstrap,'r360_xex_guest_mapper_status')?.()>>>0;
      throw new Error(`unable to reserve PE staging for prepared image ${prepared.length} bytes (status 0x${(status||0).toString(16)})`);
    }
    // ALLOW_MEMORY_GROWTH may replace memory.buffer and realloc may move the
    // native staging pointer. Never retain either view across the reserve.
    input=inputBuffer()>>>0;
    cap=inputCapacity()>>>0;
    stagingGrew=true;
  }

  if(!input||prepared.length>cap)throw new Error(`prepared image exceeds current PE staging capacity ${prepared.length}/${cap}`);
  // Hand Xenia's page layout to the loader first (it copies the words), then
  // reuse the staging buffer for the image itself.
  const setXexPages=maybe(bootstrap,'r360_pe_guest_set_xex_pages');
  const pages=xex&&setXexPages?readXexPageDescriptors(xex):null;
  if(pages&&pages.words.byteLength<=cap){
    new Uint32Array(bootstrap.exports.memory.buffer,input,pages.words.length).set(pages.words);
    setXexPages(input,pages.words.length,pages.pageSize);
  }
  new Uint8Array(bootstrap.exports.memory.buffer,input,prepared.length).set(prepared);
  if((pick(bootstrap,'r360_pe_guest_load_at_entry')(input,prepared.length,xexEntry>>>0)>>>0)!==1)throw new Error(`prepared PE guest load failed 0x${(pick(bootstrap,'r360_pe_guest_status')()>>>0).toString(16)}`);
  return {input,capacity:cap,stagingGrew};
}

export async function handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8,scanEntryFunction=false,implementedKernelExports={},initialGprs={},installDefaultBrowserHle=true,prepareMainThreadContext=false}){
  const xex=Buffer.from(defaultXex);
  if(xex.length<0x18||xex.toString('ascii',0,4)!=='XEX2')throw new Error('default.xex is not XEX2');
  const headerSize=be32(xex,8);
  if(headerSize<0x18||headerSize>xex.length)throw new Error('default.xex header size out of bounds');
  const xexEntry=readXexEntryPoint(xex,headerSize);
  const importedLibraries=decodeXexImportLibraries(xex);
  const header=xex.subarray(0,headerSize),body=xex.subarray(headerSize);
  const prepared=await prepareRetailXexImage({core,bootstrap,header,body,encryptedSecurityKey,useDevkitKey});

  for(const n of ['r360_xex_guest_mapper_input_buffer','r360_xex_guest_mapper_input_capacity','r360_pe_guest_load','r360_pe_guest_load_at_entry','r360_pe_guest_status','r360_pe_guest_entry_address','r360_pe_guest_pe_entry_address','r360_title_handoff_reset','r360_title_handoff_translate_entry','r360_title_handoff_status','r360_title_handoff_entry_address','r360_title_handoff_bytes','r360_title_handoff_hir_instructions'])if(typeof pick(bootstrap,n)!=='function')throw new Error(`missing title-controller export ${n}`);
  // Each handoff is a fresh title boot: clear native kernel objects, pool,
  // thread registry and trace state (the registered guest VFS is preserved).
  maybe(bootstrap,'r360_kernel_runtime_reset')?.();
  maybe(bootstrap,'r360_kernel_services_reset')?.();
  // Xenia cvars::license_mask: 0 = trial unless the player marked the title owned.
  maybe(bootstrap,'r360_xam_set_license_mask')?.(Number(globalThis.render360XamLicenseMask||0)>>>0);
  maybe(bootstrap,'r360_kernel_service_reset')?.();
  const peStage=stagePreparedPeImage(bootstrap,prepared,xexEntry,xex);
  const entry=pick(bootstrap,'r360_pe_guest_entry_address')()>>>0;
  const peEntry=pick(bootstrap,'r360_pe_guest_pe_entry_address')()>>>0;
  if(entry!==xexEntry)throw new Error(`XEX entry selection mismatch 0x${entry.toString(16)}/0x${xexEntry.toString(16)}`);
  if(peEntry!==entry)console.info(`[Render360] Xenia entry parity: XEX optional entry 0x${entry.toString(16).toUpperCase()} overrides PE entry 0x${peEntry.toString(16).toUpperCase()}`);

  // Modern bootstraps route decoded real-title imports through the live PPC
  // context directly into the native WASM kernel/Xenos service layer. Keep the
  // relocated PPC shim implementation only for older published bootstraps that
  // do not expose the native title-GPU runtime yet.
  const nativeTitleGpu=hasNativeTitleGpuRuntime(bootstrap);
  const browserHle=!nativeTitleGpu&&installDefaultBrowserHle?installBrowserTitleHle({bootstrap,entry}):null;
  const effectiveKernelExports=browserHle?{...XENIA_BUILTIN_VARIABLE_EXPORTS,...browserHle.implementedKernelExports,...implementedKernelExports}:{...XENIA_BUILTIN_VARIABLE_EXPORTS,...implementedKernelExports};
  const kernelImports=buildKernelImportPlan(xex,prepared,{implementedExports:effectiveKernelExports});
  const kernelRegistration=registerKernelImportPlan(bootstrap,kernelImports);
  const kernelVariableRegistration=installKernelVariableImports(bootstrap,kernelImports,xex,{entry,headerSize});

  pick(bootstrap,'r360_title_handoff_reset')();
  if(prepareMainThreadContext){const warm=maybe(bootstrap,'r360_ppc_probe_page_sparse_code');if(typeof warm==='function'&&(warm(entry)>>>0)===0)throw new Error('unable to initialize Xenia title decoder before main-thread context');pick(bootstrap,'r360_title_handoff_reset')();}
  const mainThreadContext=prepareMainThreadContext?prepareBrowserMainThreadContext(bootstrap,entry,{xex,headerSize}):null;
  let startupGprCount=0;
  if(mainThreadContext){
    // R360_XENIA_ENTRY_ABI_V51: match upstream Processor::Execute special state.
    const setInitialLr=maybe(bootstrap,'r360_ppc_probe_set_initial_lr');
    const readInitialLr=maybe(bootstrap,'r360_ppc_probe_initial_lr');
    if(!setInitialLr||!readInitialLr)throw new Error('published browser bootstrap is missing Xenia initial-LR support');
    if((setInitialLr(BigInt(mainThreadContext.xeniaInitialLr))>>>0)!==1)throw new Error('unable to initialize Xenia title-entry LR');
    if(Number(readInitialLr()&0xFFFFFFFFn)!==(mainThreadContext.xeniaInitialLr>>>0))throw new Error('Xenia title-entry LR verification failed');
    startupGprCount+=applyInitialGprs(bootstrap,{1:mainThreadContext.stackTop,13:mainThreadContext.pcrAddress});
  }
  startupGprCount+=applyInitialGprs(bootstrap,initialGprs);
  const scannedEntry=maybe(bootstrap,'r360_title_handoff_translate_scanned_entry');
  if(scanEntryFunction&&!scannedEntry)throw new Error('browser bootstrap is missing scanned title-entry execution');
  const hir=scanEntryFunction?(scannedEntry()>>>0):(pick(bootstrap,'r360_title_handoff_translate_entry')(entryBytes)>>>0);
  const entryExecutionMode=scanEntryFunction?'xenia-scanned-entry-function':'bounded-entry-byte-probe';
  if(!hir){
    const handoffStatus=pick(bootstrap,'r360_title_handoff_status')()>>>0;
    const probeStatus=maybe(bootstrap,'r360_ppc_probe_status')?.()>>>0||0;
    const scanDiagnostic=maybe(bootstrap,'r360_ppc_probe_scan_diagnostic')?.()>>>0||0;
    const scanAddress=maybe(bootstrap,'r360_ppc_probe_scan_address')?.()>>>0||0;
    const scanWindowEnd=maybe(bootstrap,'r360_ppc_probe_scan_window_end')?.()>>>0||0;
    const scanFunctionEnd=maybe(bootstrap,'r360_ppc_probe_scan_function_end')?.()>>>0||0;
    const scanHir=maybe(bootstrap,'r360_ppc_probe_scan_hir_instructions')?.()>>>0||0;
    const assembledFunctions=maybe(bootstrap,'r360_ppc_probe_assembled_functions')?.()>>>0||0;
    const hirBlocks=maybe(bootstrap,'r360_ppc_probe_hir_block_count')?.()>>>0||0;
    const scanReason=['idle','guard-rejected','scanner-failed','define-function-failed','zero-hir','translated'][scanDiagnostic]||'unknown';
    const hex=value=>`0x${(value>>>0).toString(16).toUpperCase()}`;
    const error=new Error(`title entry handoff failed ${hex(handoffStatus)} mode=${entryExecutionMode} scan=${scanReason}(${scanDiagnostic}) probe=${hex(probeStatus)} entry=${hex(entry)} scanAddress=${hex(scanAddress)} scanWindowEnd=${hex(scanWindowEnd)} scanFunctionEnd=${hex(scanFunctionEnd)} assembledFunctions=${assembledFunctions} hirBlocks=${hirBlocks} scanHIR=${scanHir}`);
    error.code='R360_TITLE_ENTRY_HANDOFF_FAILED';
    error.render360={kind:'ppc-entry-translation-failure',handoffStatus,probeStatus,scanDiagnostic,scanReason,scanAddress,scanWindowEnd,scanFunctionEnd,assembledFunctions,hirBlocks,scanHir,entry:entry>>>0,entryExecutionMode};
    throw error;
  }

  const execStatusFn=maybe(bootstrap,'r360_ppc_probe_correctness_status');
  const execInstructionsFn=maybe(bootstrap,'r360_ppc_probe_correctness_instructions');
  const execR3Fn=maybe(bootstrap,'r360_ppc_probe_correctness_r3');
  const execBlockerKindFn=maybe(bootstrap,'r360_ppc_probe_correctness_blocker_kind');
  const execBlockerOpcodeFn=maybe(bootstrap,'r360_ppc_probe_correctness_blocker_opcode');
  const execBlockerAddressFn=maybe(bootstrap,'r360_ppc_probe_correctness_blocker_address');
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
  const executionBlockerKind=execBlockerKindFn?(execBlockerKindFn()>>>0):0;
  const executionBlockerOpcode=execBlockerOpcodeFn?(execBlockerOpcodeFn()>>>0):0;
  const executionBlockerAddress=execBlockerAddressFn?(execBlockerAddressFn()>>>0):0;
  // Snapshot sparse-memory failure state immediately after native HIR returns.
  // Any later successful diagnostic/code/GPU read clears SparseGuestMemory's
  // global last-fault latch, so delayed UI inspection is not authoritative.
  const memoryFaultAddressFn=maybe(bootstrap,'r360_sparse_guest_memory_last_fault_address');
  const memoryFaultCodeFn=maybe(bootstrap,'r360_sparse_guest_memory_last_fault_code');
  const memoryFaultAddress=memoryFaultAddressFn?(memoryFaultAddressFn()>>>0):0;
  const memoryFaultCode=memoryFaultCodeFn?(memoryFaultCodeFn()>>>0):0;
  const stackTraceRead=(name,...args)=>{const f=maybe(bootstrap,name);return f?(f(...args)>>>0):undefined;};
  const stackTrace={
    blockerR1:stackTraceRead('r360_ppc_probe_stack_blocker_r1'),
    initialR1:stackTraceRead('r360_ppc_probe_stack_initial_r1'),
    lastWriteAddress:stackTraceRead('r360_ppc_probe_stack_last_write_address'),
    lastOldR1:stackTraceRead('r360_ppc_probe_stack_last_old_r1'),
    lastNewR1:stackTraceRead('r360_ppc_probe_stack_last_new_r1'),
    lastWriteDepth:stackTraceRead('r360_ppc_probe_stack_last_write_depth'),
    lastCallSource:stackTraceRead('r360_ppc_probe_stack_last_call_source'),
    lastCallTarget:stackTraceRead('r360_ppc_probe_stack_last_call_target'),
    lastCallR1:stackTraceRead('r360_ppc_probe_stack_last_call_r1'),
    lastCallDepth:stackTraceRead('r360_ppc_probe_stack_last_call_depth'),
  };
  const stackWriteCount=Math.min(stackTraceRead('r360_ppc_probe_stack_write_count')??0,32);
  const stackCallCount=Math.min(stackTraceRead('r360_ppc_probe_stack_call_count')??0,32);
  stackTrace.writeHistory=Array.from({length:stackWriteCount},(_,index)=>({
    sequence:stackTraceRead('r360_ppc_probe_stack_write_sequence',index),
    address:stackTraceRead('r360_ppc_probe_stack_write_address',index),
    oldR1:stackTraceRead('r360_ppc_probe_stack_write_old_r1',index),
    newR1:stackTraceRead('r360_ppc_probe_stack_write_new_r1',index),
    depth:stackTraceRead('r360_ppc_probe_stack_write_depth',index),
  }));
  stackTrace.callHistory=Array.from({length:stackCallCount},(_,index)=>({
    sequence:stackTraceRead('r360_ppc_probe_stack_call_sequence',index),
    source:stackTraceRead('r360_ppc_probe_stack_call_source',index),
    target:stackTraceRead('r360_ppc_probe_stack_call_target',index),
    r1:stackTraceRead('r360_ppc_probe_stack_call_r1',index),
    depth:stackTraceRead('r360_ppc_probe_stack_call_depth',index),
    flags:stackTraceRead('r360_ppc_probe_stack_call_flags',index),
  }));
  const translatedFunctionCount=callCountFn?(callCountFn()>>>0):0;
  const firstTranslatedFunction=callAddressFn&&translatedFunctionCount?(callAddressFn(0)>>>0):0;
  const kernelCalls=kernelCallsFn?(kernelCallsFn()>>>0):0;
  const kernelLastThunk=kernelLastThunkFn?(kernelLastThunkFn()>>>0):0;
  const kernelLastModuleId=kernelLastModuleFn?(kernelLastModuleFn()>>>0):0;
  const kernelLastOrdinal=kernelLastOrdinalFn?(kernelLastOrdinalFn()>>>0):0;
  const kernelLastStatus=kernelLastStatusFn?(kernelLastStatusFn()>>>0):0;
  const reachedKernelModule=kernelLastModuleId===1?'xboxkrnl.exe':kernelLastModuleId===2?'xam.xex':null;
  const runtimeBoundary=executionStatus===3?'guest-return':kernelLastStatus===2?'kernel-import-unimplemented':kernelLastStatus===3?'kernel-import-abi-failed':kernelLastStatus===4?'title-requested-exit':kernelLastStatus===5?'guest-wait-blocked':executionStatus===2?'no-return-boundary':executionStatus===1?(executionBlockerKind===2?'unresolved-guest-call':executionBlockerKind===3?'instruction-limit':executionBlockerKind===5?'guest-memory-dependency':'unsupported-hir'):'execution-not-observed';
  const firstKernelBlocker=kernelImports.firstKernelBlocker?{module:kernelImports.firstKernelBlocker.module,ordinal:kernelImports.firstKernelBlocker.ordinal,kind:kernelImports.firstKernelBlocker.kind,valueAddress:kernelImports.firstKernelBlocker.valueAddress,thunkAddress:kernelImports.firstKernelBlocker.thunkAddress}:null;
  const reachedKernelBlocker=kernelLastStatus===2?{module:reachedKernelModule,ordinal:kernelLastOrdinal,name:kernelExportName(reachedKernelModule??kernelLastModuleId,kernelLastOrdinal),thunkAddress:kernelLastThunk}:null;
  const kernelBoundary=readKernelBoundaryTelemetry(bootstrap,kernelLastStatus);
  const kernelTrace=readKernelServiceTrace(bootstrap);
  const titleGpuTelemetry=nativeTitleGpu?readNativeTitleGpuTelemetry(bootstrap,entry):null;
  const browserHleTelemetry=browserHle?readBrowserTitleHleTelemetry({bootstrap,hle:browserHle}):null;
  const browserHleSummary=browserHle?{kind:'relocated-ppc-abi-shims',windowBase:browserHle.windowBase,windowBytes:browserHle.windowBytes,addresses:browserHle.addresses,telemetryAddresses:browserHle.telemetryAddresses}:null;

  return {headerSize,preparedBytes:prepared.length,peStagingCapacity:peStage.capacity,peStagingGrew:peStage.stagingGrew,entry,xexEntry,peEntry,entrySource:'xex-optional-header',hir,handoffBytes:pick(bootstrap,'r360_title_handoff_bytes')()>>>0,status:pick(bootstrap,'r360_title_handoff_status')()>>>0,entryExecutionMode,startupGprCount,mainThreadContext,executionStatus,executionInstructions,executionR3Hex,executionBlockerKind,executionBlockerOpcode,executionBlockerAddress,memoryFaultAddress,memoryFaultCode,stackTrace,translatedFunctionCount,firstTranslatedFunction,runtimeBoundary,importedLibraries,kernelImports,kernelImportCount:kernelImports.plan.length,kernelRegistration,kernelVariableRegistration,kernelCalls,kernelLastStatus,reachedKernelBlocker,kernelBoundary,kernelTrace,firstKernelBlocker,titleGpuTelemetry,browserHle:browserHleSummary,browserHleTelemetry};
}