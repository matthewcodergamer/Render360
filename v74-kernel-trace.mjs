// Render360 V74 diagnostic-only kernel trace.
//
// This file deliberately does not change PPC/HIR execution, sparse guest
// memory, stack geometry, kernel return values, GPU state, or the V74 Wasm
// bootstrap. It only joins the already-decoded XEX import plan with the
// already-captured PPC call timeline so the iPhone report can name the kernel
// services Braid reached before its terminal startup path.

const DIAG_ID='r360V74KernelTrace';
const hex32=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
const hexOrdinal=value=>`0x${(Number(value)>>>0).toString(16).toUpperCase()}`;

function currentResult(){
  return globalThis.render360ModernTitle?.result||null;
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
    history.push({
      sequence:Number(event.sequence)||0,
      source:Number(event.source)>>>0,
      thunkAddress:item.thunkAddress>>>0,
      module:String(item.module||'kernel'),
      ordinal:item.ordinal>>>0,
      resolution:String(item.resolution||'unknown'),
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
    message:'Braid reached xboxkrnl!HalReturnToFirmware. The V74 generic guest-memory headline is not the active cause because no sparse-memory fault was captured.',
    next:'Identify the kernel/startup result immediately before HalReturnToFirmware that made Braid choose its reboot path. Do not make HalReturnToFirmware return success.',
    blocker,
  };
}

function traceLine(event){
  return `#${event.sequence||'?'} ${event.module}!${hexOrdinal(event.ordinal)} @ ${hex32(event.thunkAddress)} from ${hex32(event.source)} r1=${hex32(event.r1)} depth=${event.depth}`;
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
    `Real blocker: ${diag.service} (${hexOrdinal(diag.ordinal)}) at CPU call ${hex32(diag.blockerAddress)}.`,
    `Sparse guest-memory fault code: ${diag.memoryFaultCode} (${diag.memoryFaultCode?'fault captured':'none captured'}).`,
    diag.stackBalanced
      ?'Stack evidence is balanced: the -0xA0 allocation has its matching +0xA0 restore.'
      :'Stack balance was not proven by this sample; no memory workaround has been applied.',
    ...diag.kernelCallHistory.map(event=>`Kernel ${traceLine(event)}`),
    'Next: inspect the last successful/failed startup kernel result before ordinal 0x28. HalReturnToFirmware stays fail-closed; it is not stubbed as success.',
  ];
  addList(focus,'V74 kernel call trace',items);
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

function patchCopyButton(diag){
  const button=document.getElementById('r360DevCopy');
  const api=globalThis.render360DeveloperConsole;
  if(!button||!api?.report||button.dataset.v74KernelTrace==='1')return;
  button.dataset.v74KernelTrace='1';
  button.onclick=async()=>{
    const base=api.report();
    base.v74Diagnostic=diag;
    base.kernelCallHistory=diag.kernelCallHistory;
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
  patchRuntimeOverlay(diag);
  patchDeveloperUi(diag);
  patchCopyButton(diag);
}

setInterval(tick,300);
queueMicrotask(tick);
