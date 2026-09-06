// Render360 V74 diagnostic-only kernel/startup trace.
//
// This file deliberately does not change PPC/HIR execution, sparse guest
// memory, stack geometry, kernel return values or GPU state. It joins the
// decoded XEX import plan, PPC call history and diagnostic-only native ABI
// telemetry so the iPhone report can show why Braid chose firmware return.

const DIAG_ID='r360V74KernelTrace';
const BOOTSTRAP_SINGLETON_KEY=Symbol.for('render360.ppc.bootstrap.singleton');
const hex32=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
const hexOrdinal=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase()}`;
const MODULE_NAMES=new Map([[1,'xboxkrnl.exe'],[2,'xam.xex']]);
const XBOXKRNL_NAMES=new Map([
  [0x12B,'RtlImageXexHeaderField'],
  [0x0CC,'NtAllocateVirtualMemory'],
  [0x0DC,'NtFreeVirtualMemory'],
  [0x028,'HalReturnToFirmware'],
]);
const SERVICE_STATUS_NAMES=new Map([[0,'none'],[1,'success'],[2,'unsupported'],[3,'invalid']]);
const enrichmentPromises=new WeakMap();
const enrichmentLogged=new WeakSet();

function currentResult(){
  return globalThis.render360ModernTitle?.result||null;
}

function pickExport(bootstrap,name){
  const exports=bootstrap?.exports;
  if(!exports)return null;
  const value=exports[name]??exports[`_${name}`];
  return typeof value==='function'?value:null;
}

async function currentBootstrap(){
  try{
    const state=globalThis[BOOTSTRAP_SINGLETON_KEY];
    return state?.promise?await state.promise:null;
  }catch{return null;}
}

function serviceName(module,ordinal){
  if(String(module).toLowerCase()==='xboxkrnl.exe')return XBOXKRNL_NAMES.get(Number(ordinal)>>>0)||null;
  return null;
}

function buildKernelCallHistory(result){
  const plan=Array.isArray(result?.kernelImports?.plan)?result.kernelImports.plan:[];
  const calls=Array.isArray(result?.stackTrace?.callHistory)?result.stackTrace.callHistory:[];
  if(!plan.length||!calls.length)return [];

  const byThunk=new Map();
  for(const item of plan){
    if(!item?.isKernelModule||item.kind!=='function'||!item.thunkAddress)continue;
    byThunk.set(item.thunkAddress>>>0,item);
  }

  const history=[];
  for(const event of calls){
    const target=Number(event?.target)>>>0;
    const item=byThunk.get(target);
    if(!item)continue;
    const module=String(item.module||'kernel');
    history.push({
      sequence:Number(event.sequence)||0,
      source:Number(event.source)>>>0,
      thunkAddress:item.thunkAddress>>>0,
      module,
      ordinal:item.ordinal>>>0,
      serviceName:serviceName(module,item.ordinal),
      planResolution:String(item.resolution||'unknown'),
      r1:Number(event.r1)>>>0,
      depth:Number(event.depth)||0,
    });
  }
  return history;
}

function blockerInfo(result){
  const blocker=result?.reachedKernelBlocker||result?.firstKernelBlocker||null;
  const module=String(blocker?.module||'').toLowerCase();
  const ordinal=Number(blocker?.ordinal);
  return {blocker,module,ordinal};
}

function buildDiagnostic(result){
  if(!result)return null;
  const {blocker,module,ordinal}=blockerInfo(result);
  if(module!=='xboxkrnl.exe'||ordinal!==0x28)return null;

  const writes=Array.isArray(result?.stackTrace?.writeHistory)?result.stackTrace.writeHistory:[];
  const hasA0Allocation=writes.some(event=>((Number(event.newR1)>>>0)-(Number(event.oldR1)>>>0))===-0xA0);
  const hasA0Restore=writes.some(event=>((Number(event.newR1)>>>0)-(Number(event.oldR1)>>>0))===0xA0);
  const memoryFaultCode=Number(result?.memoryFaultCode)||0;
  const history=buildKernelCallHistory(result);

  return {
    classification:'FIRMWARE_REENTRY_REQUEST',
    service:'xboxkrnl.exe!HalReturnToFirmware',
    ordinal:0x28,
    blockerAddress:Number(result.executionBlockerAddress)>>>0,
    memoryFaultCode,
    stackBalanced:hasA0Allocation&&hasA0Restore,
    kernelCallHistory:history,
    message:'Braid reached xboxkrnl!HalReturnToFirmware. No sparse-memory fault was captured and the observed stack frames balance.',
    next:'Inspect the live return values/arguments of the startup kernel services and the XexExecutableModuleHandle relocation chain before changing emulator semantics.',
    blocker,
  };
}

function readNativeKernelTrace(bootstrap){
  const countFn=pickExport(bootstrap,'r360_kernel_import_trace_count');
  const sequenceFn=pickExport(bootstrap,'r360_kernel_import_trace_sequence');
  const thunkFn=pickExport(bootstrap,'r360_kernel_import_trace_thunk');
  const moduleFn=pickExport(bootstrap,'r360_kernel_import_trace_module');
  const ordinalFn=pickExport(bootstrap,'r360_kernel_import_trace_ordinal');
  const argFn=pickExport(bootstrap,'r360_kernel_import_trace_arg');
  const resultFn=pickExport(bootstrap,'r360_kernel_import_trace_result');
  const statusFn=pickExport(bootstrap,'r360_kernel_import_trace_status');
  const handledFn=pickExport(bootstrap,'r360_kernel_import_trace_handled');
  if(!countFn||!sequenceFn||!thunkFn||!moduleFn||!ordinalFn||!argFn||!resultFn||!statusFn||!handledFn){
    return {available:false,reason:'diagnostic ABI exports not present in loaded V74 bootstrap',calls:[]};
  }
  const count=Math.min(countFn()>>>0,32);
  const calls=[];
  for(let index=0;index<count;index++){
    const moduleId=moduleFn(index)>>>0;
    const module=MODULE_NAMES.get(moduleId)||`module-${moduleId}`;
    const ordinal=ordinalFn(index)>>>0;
    const status=statusFn(index)>>>0;
    calls.push({
      index,
      sequence:sequenceFn(index)>>>0,
      thunkAddress:thunkFn(index)>>>0,
      moduleId,
      module,
      ordinal,
      serviceName:serviceName(module,ordinal),
      args:Array.from({length:8},(_,argIndex)=>argFn(index,argIndex)>>>0),
      result:resultFn(index)>>>0,
      serviceStatus:status,
      serviceStatusName:SERVICE_STATUS_NAMES.get(status)||`status-${status}`,
      handled:(handledFn(index)>>>0)!==0,
    });
  }
  return {available:true,count,calls};
}

function readGuestLoaderState(bootstrap,result){
  const read32=pickExport(bootstrap,'r360_ppc_probe_read_guest_u32_be');
  if(!read32)return {available:false,reason:'guest u32 reader unavailable'};
  const plan=Array.isArray(result?.kernelImports?.plan)?result.kernelImports.plan:[];
  const moduleHandleImport=plan.find(item=>item?.isKernelModule&&item.kind==='variable'&&String(item.module).toLowerCase()==='xboxkrnl.exe'&&(item.ordinal>>>0)===0x193)||null;
  if(!moduleHandleImport)return {available:false,reason:'Braid XexExecutableModuleHandle import not found'};
  const slotAddress=moduleHandleImport.valueAddress>>>0;
  const exportVariableAddress=read32(slotAddress)>>>0;
  const hmoduleAddress=exportVariableAddress?read32(exportVariableAddress)>>>0:0;
  const imageBase=hmoduleAddress?read32((hmoduleAddress+0x1C)>>>0)>>>0:0;
  const imageSize=hmoduleAddress?read32((hmoduleAddress+0x38)>>>0)>>>0:0;
  const entryPoint=hmoduleAddress?read32((hmoduleAddress+0x3C)>>>0)>>>0:0;
  const xexHeaderAddress=hmoduleAddress?read32((hmoduleAddress+0x58)>>>0)>>>0:0;
  const xexHeaderMagic=xexHeaderAddress?read32(xexHeaderAddress)>>>0:0;
  return {
    available:true,
    ordinal:0x193,
    slotAddress,
    exportVariableAddress,
    hmoduleAddress,
    imageBase,
    imageSize,
    entryPoint,
    xexHeaderAddress,
    xexHeaderMagic,
    xexHeaderMagicAscii:xexHeaderMagic===0x58455832?'XEX2':null,
    registration:result?.kernelVariableRegistration??null,
  };
}

function readCodeWords(bootstrap,begin,end){
  const read32=pickExport(bootstrap,'r360_ppc_probe_read_guest_u32_be');
  if(!read32||!begin||!end||end<=begin||end-begin>0x1000)return [];
  const words=[];
  for(let address=begin>>>0;address<(end>>>0);address=(address+4)>>>0){
    words.push({address,word:read32(address)>>>0});
  }
  return words;
}

function readFinalGprs(bootstrap){
  const get=pickExport(bootstrap,'r360_ppc_probe_correctness_gpr');
  if(!get)return null;
  const values={};
  for(let index=0;index<32;index++){
    try{
      values[`r${index}`]=`0x${BigInt.asUintN(64,get(index)).toString(16).toUpperCase().padStart(16,'0')}`;
    }catch{
      values[`r${index}`]=hex32(get(index));
    }
  }
  return values;
}

async function enrichDiagnostic(result,diag){
  if(diag.startupTrace)return diag.startupTrace;
  let pending=enrichmentPromises.get(result);
  if(pending)return pending;
  pending=(async()=>{
    const bootstrap=await currentBootstrap();
    if(!bootstrap){
      const trace={available:false,reason:'V74 bootstrap singleton unavailable'};
      diag.startupTrace=trace;
      result.v74StartupTrace=trace;
      return trace;
    }
    const kernelServiceTelemetry=readNativeKernelTrace(bootstrap);
    const loaderState=readGuestLoaderState(bootstrap,result);
    const startupFunctionWords=readCodeWords(bootstrap,0x82373728,0x823737FC);
    const wrapperFunctionWords=readCodeWords(bootstrap,0x82373828,0x82373880);
    const finalGprs=readFinalGprs(bootstrap);
    const trace={
      available:true,
      capturedAt:new Date().toISOString(),
      kernelServiceTelemetry,
      loaderState,
      finalGprs,
      codeWindows:{startup_0x82373728:startupFunctionWords,wrapper_0x82373828:wrapperFunctionWords},
    };
    diag.startupTrace=trace;
    result.v74StartupTrace=trace;
    if(!enrichmentLogged.has(result)){
      enrichmentLogged.add(result);
      if(kernelServiceTelemetry.available){
        for(const call of kernelServiceTelemetry.calls){
          const label=call.serviceName||hexOrdinal(call.ordinal);
          dispatchLog('info',`V74 ABI #${call.sequence} ${call.module}!${label} args=${call.args.map(hex32).join(',')} -> ${hex32(call.result)} status=${call.serviceStatusName} handled=${call.handled?'yes':'no'}`);
        }
      }
      if(loaderState.available){
        dispatchLog('info',`V74 loader: import ${hex32(loaderState.slotAddress)} -> export ${hex32(loaderState.exportVariableAddress)} -> HMODULE ${hex32(loaderState.hmoduleAddress)} -> XEX ${hex32(loaderState.xexHeaderAddress)} magic=${hex32(loaderState.xexHeaderMagic)}.`);
      }
    }
    return trace;
  })();
  enrichmentPromises.set(result,pending);
  return pending;
}

function traceLine(event){
  const name=event.serviceName?`!${event.serviceName}`:`!${hexOrdinal(event.ordinal)}`;
  return `#${event.sequence||'?'} ${event.module}${name} (${hexOrdinal(event.ordinal)}) @ ${hex32(event.thunkAddress)} from ${hex32(event.source)} r1=${hex32(event.r1)} depth=${event.depth}`;
}

function kernelServiceLine(call){
  const label=call.serviceName||hexOrdinal(call.ordinal);
  const args=call.args.map(hex32).join(', ');
  return `ABI #${call.sequence} ${call.module}!${label} (${hexOrdinal(call.ordinal)}) [${args}] → ${hex32(call.result)} · ${call.serviceStatusName} · ${call.handled?'handled':'blocked'}`;
}

function dispatchLog(level,message){
  globalThis.dispatchEvent(new CustomEvent('render360:log',{detail:{level,message}}));
}

let loggedResult=null;
function publishDiagnostic(result,diag){
  result.kernelCallHistory=diag.kernelCallHistory;
  result.v74Diagnostic=diag;
  if(loggedResult===result||!globalThis.render360DeveloperConsole)return;
  loggedResult=result;

  dispatchLog('warn',`V74 diagnostic: ${diag.service} (${hexOrdinal(diag.ordinal)}) reached at ${hex32(diag.blockerAddress)}; sparse-memory fault code=${diag.memoryFaultCode}.`);
  if(diag.kernelCallHistory.length){
    for(const event of diag.kernelCallHistory)dispatchLog('info',`V74 kernel call ${traceLine(event)}`);
  }else{
    dispatchLog('warn','V74 diagnostic: no kernel thunk addresses from the PPC call timeline matched the decoded XEX import plan.');
  }
  dispatchLog('info',diag.stackBalanced
    ?'V74 diagnostic: the -0xA0 frame allocation and +0xA0 restore are balanced; do not patch the stack guard or zero page.'
    :'V74 diagnostic: stack-balance evidence is incomplete; keep the guard unchanged until the exact control-flow edge is proven.');
}

function addList(parent,title,items){
  const section=document.createElement('section');
  section.id=DIAG_ID;
  section.className='r360-dev-section';
  const heading=document.createElement('h4');
  heading.textContent=title;
  section.appendChild(heading);
  const list=document.createElement('ul');
  list.className='r360-bullet-list';
  for(const text of items){
    const item=document.createElement('li');
    item.textContent=text;
    list.appendChild(item);
  }
  section.appendChild(list);
  parent.appendChild(section);
}

function patchDeveloperUi(diag){
  const focus=document.getElementById('r360DevFocus');
  if(!focus)return;

  const kicker=focus.querySelector('.r360-focus-kicker');
  const headline=focus.querySelector('.r360-focus-head h3');
  if(kicker)kicker.textContent='FIRMWARE_REENTRY_REQUEST';
  if(headline)headline.textContent='Braid requested xboxkrnl!HalReturnToFirmware';

  document.getElementById(DIAG_ID)?.remove();
  const items=[
    `Terminal request: ${diag.service} (${hexOrdinal(diag.ordinal)}) at CPU call ${hex32(diag.blockerAddress)}.`,
    `Sparse guest-memory fault code: ${diag.memoryFaultCode} (${diag.memoryFaultCode?'fault captured':'none captured'}).`,
    diag.stackBalanced
      ?'Stack evidence is balanced: the -0xA0 allocation has its matching +0xA0 restore.'
      :'Stack balance was not proven by this sample; no memory workaround has been applied.',
    ...diag.kernelCallHistory.map(event=>`Kernel ${traceLine(event)}`),
  ];
  const startup=diag.startupTrace;
  if(startup?.kernelServiceTelemetry?.available){
    items.push(...startup.kernelServiceTelemetry.calls.map(kernelServiceLine));
  }else if(startup){
    items.push(`Native ABI trace: ${startup.kernelServiceTelemetry?.reason||startup.reason||'not available'}.`);
  }else{
    items.push('Native ABI trace: collecting live V74 service arguments/results…');
  }
  if(startup?.loaderState?.available){
    const s=startup.loaderState;
    items.push(`Loader chain: ${hex32(s.slotAddress)} → ${hex32(s.exportVariableAddress)} → HMODULE ${hex32(s.hmoduleAddress)} → XEX ${hex32(s.xexHeaderAddress)} (${s.xexHeaderMagicAscii||hex32(s.xexHeaderMagic)}).`);
  }
  items.push('Next: use the captured ABI return values and loader chain to fix the first wrong startup dependency; HalReturnToFirmware remains fail-closed.');
  addList(focus,'V74 startup / kernel ABI trace',items);
}

function patchRuntimeOverlay(diag){
  const message=document.getElementById('bootMessage');
  const stage=document.getElementById('bootStage');
  if(message)message.textContent='Braid requested firmware return · xboxkrnl!HalReturnToFirmware';
  if(stage)stage.textContent='FIRMWARE RETURN';
}

async function writeClipboard(text){
  try{
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true;}
  }catch{}
  try{
    const area=document.createElement('textarea');
    area.value=text;area.setAttribute('readonly','');
    area.style.position='fixed';area.style.opacity='0';
    document.body.appendChild(area);area.select();
    const ok=document.execCommand('copy');area.remove();return ok;
  }catch{return false;}
}

function patchCopyButton(result,diag){
  const button=document.getElementById('r360DevCopy');
  const api=globalThis.render360DeveloperConsole;
  if(!button||!api?.report||button.dataset.v74KernelTrace==='1')return;
  button.dataset.v74KernelTrace='1';
  button.onclick=async()=>{
    await enrichDiagnostic(result,diag);
    const base=api.report();
    base.v74Diagnostic=diag;
    base.kernelCallHistory=diag.kernelCallHistory;
    base.v74StartupTrace=diag.startupTrace??result.v74StartupTrace??null;
    const ok=await writeClipboard(JSON.stringify(base,null,2));
    const old=button.textContent;
    button.textContent=ok?'Copied V74 trace':'Copy failed';
    setTimeout(()=>{button.textContent=old||'Copy Report';},1400);
  };
}

function tick(){
  const result=currentResult();
  const diag=buildDiagnostic(result);
  if(!diag)return;
  publishDiagnostic(result,diag);
  void enrichDiagnostic(result,diag).then(()=>patchDeveloperUi(diag));
  patchRuntimeOverlay(diag);
  patchDeveloperUi(diag);
  patchCopyButton(result,diag);
}

setInterval(tick,300);
queueMicrotask(tick);