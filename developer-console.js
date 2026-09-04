// Render360 developer tools are opt-in. Production mode keeps only the tiny UI guard.
const SETTINGS_KEY='render360.settings.v44';
const $=id=>document.getElementById(id);
const entries=[];
const MAX_LOGS=30;
let enabled=false;
let listenersInstalled=false;
let opened=false;
let lastBlocker=null;

function readDeveloperMode(){
  try{return !!JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')?.developerMode;}catch{return false;}
}
function unlockNavigation(){
  for(const id of ['settingsButton','importButton','emptyImportButton']){
    const el=$(id);if(!el)continue;el.disabled=false;el.removeAttribute('disabled');el.removeAttribute('aria-disabled');el.style.pointerEvents='auto';
  }
}
function compactRuntimeStatus(){
  const el=$('runtimeSyncText');if(!el)return;
  const text=String(el.textContent||'');
  const match=text.match(/Runtime V(\d+).*?Core V(\d+).*?\(([^)]+)\)/i);
  if(match)el.textContent=`Emulator ready · Core build ${match[2]} · ${match[3]}`;
}
function present(value){return value!==undefined&&value!==null&&value!=='';}
function number(value){return present(value)&&Number.isFinite(Number(value))?Number(value):undefined;}
function address(value){const n=number(value);return n===undefined?undefined:`0x${(n>>>0).toString(16).toUpperCase().padStart(8,'0')}`;}
function compact(value){return Object.fromEntries(Object.entries(value).filter(([,item])=>present(item)));}
function knownPpcHelper(word){
  const value=number(word);if(value===undefined)return undefined;const p=value>>>0;
  if((p>>>26)!==58)return undefined;
  const rt=(p>>>21)&31,ra=(p>>>16)&31;if(rt<14||rt>31||ra!==1)return undefined;
  let ds=(p>>>2)&0x3FFF;if(ds&0x2000)ds-=0x4000;const disp=(ds<<2)|0;
  return disp===-8*(33-rt)?`__restgprlr_${rt}`:undefined;
}
function compactBlocker(detail){
  const source=detail?.blocker||detail?.schedulerBlocker||detail||{};
  return compact({
    kind:source.kind||detail?.stage,
    message:source.message||source.reason||detail?.message||detail?.reason,
    address:address(source.address??source.sourceAddress??source.entry),
    opcode:number(source.opcode??source.executionBlockerOpcode),
    status:number(source.status??source.executionStatus),
    instructions:number(source.instructions??source.executionInstructions),
    module:source.module,
    ordinal:present(source.ordinal)?`0x${Number(source.ordinal).toString(16).toUpperCase()}`:undefined,
  });
}
function memoryDiagnostics(state,result){
  const bootstrap=state?.bootstrap,exp=bootstrap?.exports||{};
  const fn=name=>{const value=exp[name]??exp[`_${name}`];return typeof value==='function'?value:null;};
  const faultAddressFn=fn('r360_sparse_guest_memory_last_fault_address');
  const faultCodeFn=fn('r360_sparse_guest_memory_last_fault_code');
  const mappedPagesFn=fn('r360_sparse_guest_memory_mapped_pages');
  const backingPagesFn=fn('r360_sparse_guest_memory_backing_pages');
  const readStackU32=name=>{const f=fn(name);return f?(f()>>>0):undefined;};
  const resultStack=result?.stackTrace||{};
  const stackTrace=compact({
    blockerR1:address(number(resultStack.blockerR1)??readStackU32('r360_ppc_probe_stack_blocker_r1')),
    initialR1:address(number(resultStack.initialR1)??readStackU32('r360_ppc_probe_stack_initial_r1')),
    lastWriteAddress:address(number(resultStack.lastWriteAddress)??readStackU32('r360_ppc_probe_stack_last_write_address')),
    lastOldR1:address(number(resultStack.lastOldR1)??readStackU32('r360_ppc_probe_stack_last_old_r1')),
    lastNewR1:address(number(resultStack.lastNewR1)??readStackU32('r360_ppc_probe_stack_last_new_r1')),
    lastWriteDepth:number(resultStack.lastWriteDepth)??readStackU32('r360_ppc_probe_stack_last_write_depth'),
    lastCallSource:address(number(resultStack.lastCallSource)??readStackU32('r360_ppc_probe_stack_last_call_source')),
    lastCallTarget:address(number(resultStack.lastCallTarget)??readStackU32('r360_ppc_probe_stack_last_call_target')),
    lastCallR1:address(number(resultStack.lastCallR1)??readStackU32('r360_ppc_probe_stack_last_call_r1')),
    lastCallDepth:number(resultStack.lastCallDepth)??readStackU32('r360_ppc_probe_stack_last_call_depth'),
  });
  const rawHistory=Array.isArray(resultStack.history)?resultStack.history:[];
  const stackHistory=rawHistory.map(event=>compact({
    index:number(event.index),kind:event.kindName||number(event.kind),
    source:address(event.source),instruction:address(event.sourceInstruction),
    target:number(event.target)?address(event.target):undefined,flags:number(event.flags),depth:number(event.depth),
    oldR1:address(event.oldR1),newR1:address(event.newR1),
  }));
  if(stackHistory.length)stackTrace.history=stackHistory;
  const capturedFaultAddress=number(result?.memoryFaultAddress);
  const capturedFaultCode=number(result?.memoryFaultCode);
  const faultAddress=capturedFaultAddress!==undefined?capturedFaultAddress:(faultAddressFn?(faultAddressFn()>>>0):undefined);
  const faultCode=capturedFaultCode!==undefined?capturedFaultCode:(faultCodeFn?(faultCodeFn()>>>0):undefined);
  const blockerAddress=number(result?.executionBlockerAddress);
  let instructionWord,primaryOpcode,instructionKind='unknown';
  let rt,ra,displacement,baseRegisterValue,effectiveAddress;
  let branchDisplacement,branchTarget,branchAbsolute,branchLink,branchBO,branchBI;
  const read8=fn('r360_sparse_guest_memory_read_u8');
  if(read8&&blockerAddress!==undefined){
    const a=blockerAddress>>>0;
    const bytes=[0,1,2,3].map(i=>read8((a+i)>>>0)>>>0);
    instructionWord=((bytes[0]<<24)|(bytes[1]<<16)|(bytes[2]<<8)|bytes[3])>>>0;
    primaryOpcode=instructionWord>>>26;
    if(primaryOpcode>=32&&primaryOpcode<=55){
      instructionKind='d-form-memory';
      rt=(instructionWord>>>21)&31;ra=(instructionWord>>>16)&31;
      displacement=(instructionWord<<16)>>16;
      if(faultAddress!==undefined&&faultCode){
        effectiveAddress=faultAddress>>>0;
        baseRegisterValue=ra===0?0:(effectiveAddress-(displacement|0))>>>0;
      }
    }else if(primaryOpcode===58||primaryOpcode===62){
      instructionKind='ds-form-memory';
      rt=(instructionWord>>>21)&31;ra=(instructionWord>>>16)&31;
      let ds=(instructionWord>>>2)&0x3FFF;
      if(ds&0x2000)ds-=0x4000;
      displacement=(ds<<2)|0;
      if(faultAddress!==undefined&&faultCode){
        effectiveAddress=faultAddress>>>0;
        baseRegisterValue=ra===0?0:(effectiveAddress-(displacement|0))>>>0;
      }
    }else if(primaryOpcode===18){
      instructionKind='direct-branch';
      const li=instructionWord&0x03FFFFFC;
      branchDisplacement=((li&0x02000000)?(li|0xFC000000):li)|0;
      branchAbsolute=!!(instructionWord&2);branchLink=!!(instructionWord&1);
      branchTarget=(branchAbsolute?branchDisplacement:(a+branchDisplacement))>>>0;
    }else if(primaryOpcode===16){
      instructionKind='conditional-branch';
      const bd=instructionWord&0x0000FFFC;
      branchDisplacement=(bd<<16)>>16;
      branchAbsolute=!!(instructionWord&2);branchLink=!!(instructionWord&1);
      branchBO=(instructionWord>>>21)&31;branchBI=(instructionWord>>>16)&31;
      branchTarget=(branchAbsolute?branchDisplacement:(a+branchDisplacement))>>>0;
    }else{
      instructionKind='other';
    }
  }
  const knownHelper=knownPpcHelper(instructionWord);
  const faultNames={0:'none',1:'unmapped',2:'read-protection',3:'write-protection',4:'invalid-argument',5:'already-mapped'};
  const context=result?.mainThreadContext||{};
  return compact({
    faultAddress:faultAddress===undefined?undefined:address(faultAddress),
    faultCode,faultName:faultCode===undefined?undefined:(faultNames[faultCode]||`fault-${faultCode}`),
    faultCapturedAtExecution:capturedFaultCode!==undefined,
    blockerInstruction:instructionWord===undefined?undefined:`0x${instructionWord.toString(16).toUpperCase().padStart(8,'0')}`,
    instructionKind,knownHelper,ppcPrimaryOpcode:primaryOpcode,rt,ra,displacement,
    effectiveAddress:effectiveAddress===undefined?undefined:address(effectiveAddress),
    baseRegisterValue:baseRegisterValue===undefined?undefined:address(baseRegisterValue),
    branchDisplacement,branchTarget:branchTarget===undefined?undefined:address(branchTarget),
    branchAbsolute,branchLink,branchBO,branchBI,
    faultInstructionAttribution:faultCode&&instructionKind!=='d-form-memory'&&instructionKind!=='ds-form-memory'?'fault-not-derived-from-boundary-instruction':undefined,
    mappedPages:mappedPagesFn?(mappedPagesFn()>>>0):undefined,backingPages:backingPagesFn?(backingPagesFn()>>>0):undefined,
    stackTop:address(context.stackTop),stackLimit:address(context.stackLimit),stackBase:address(context.stackBase),stackSlotBase:address(context.stackSlotBase),stackGuardBytes:number(context.stackGuardBytes),pcrAddress:address(context.pcrAddress),tlsAddress:address(context.tlsAddress),
    stackTrace:Object.keys(stackTrace).length?stackTrace:undefined,
  });
}
function ppcDiagnosticSummary(memory){
  if(!memory?.blockerInstruction)return undefined;
  if((memory.instructionKind==='d-form-memory'||memory.instructionKind==='ds-form-memory')&&present(memory.ra))return `PPC memory: rA=${memory.ra}=${memory.baseRegisterValue||'—'} rT=${memory.rt??'—'} disp=${memory.displacement??'—'} EA=${memory.effectiveAddress||'—'}${memory.knownHelper?` · ${memory.knownHelper}`:''}`;
  if(memory.instructionKind==='direct-branch'||memory.instructionKind==='conditional-branch')return `PPC ${memory.instructionKind}: target=${memory.branchTarget||'—'} disp=${memory.branchDisplacement??'—'} AA=${memory.branchAbsolute?1:0} LK=${memory.branchLink?1:0}${memory.faultInstructionAttribution?' · memory fault belongs to an earlier/different boundary':''}`;
  return `PPC ${memory.instructionKind||'other'} · primary opcode ${memory.ppcPrimaryOpcode??'—'}`;
}
function stackDiagnosticSummary(memory){
  const trace=memory?.stackTrace;if(!trace?.blockerR1)return undefined;
  return `stack r1=${trace.blockerR1} initial=${trace.initialR1||'—'} · last write ${trace.lastWriteAddress||'—'} ${trace.lastOldR1||'—'}→${trace.lastNewR1||'—'} depth=${trace.lastWriteDepth??'—'} · last call ${trace.lastCallSource||'—'}→${trace.lastCallTarget||'—'} r1=${trace.lastCallR1||'—'} depth=${trace.lastCallDepth??'—'}`;
}
function addEntry(level,message){
  if(!enabled)return;
  const next={at:Date.now(),level:String(level||'info'),message:String(message||'')};
  const previous=entries.at(-1);
  if(previous&&previous.level===next.level&&previous.message===next.message){previous.at=next.at;previous.count=(previous.count||1)+1;}
  else entries.push(next);
  if(entries.length>MAX_LOGS)entries.splice(0,entries.length-MAX_LOGS);render();
}
function eventHandler(event){
  if(!enabled)return;const type=event.type.replace('render360:',''),detail=event.detail||{};
  if(type==='runtimeBlocker'||type==='fatalError'||detail?.stage==='blocked')lastBlocker=compactBlocker(detail);
  const message=detail.message||detail.reason||detail.stage||type;
  addEntry(type==='runtimeBlocker'||type==='fatalError'?'error':detail.level||'info',`${type}: ${message}`);
}
function installListeners(){
  if(listenersInstalled)return;listenersInstalled=true;
  for(const type of ['bootStage','runtimeBlocker','fatalError','titleStarted','ready','log','framePresented'])globalThis.addEventListener(`render360:${type}`,eventHandler);
  globalThis.addEventListener('error',e=>{if(enabled)addEntry('error',`${e.message||'Browser error'}${e.filename?` · ${e.filename.split('/').pop()}:${e.lineno||0}`:''}`);});
  globalThis.addEventListener('unhandledrejection',e=>{if(enabled)addEntry('error',`Unhandled promise rejection · ${e.reason?.message||String(e.reason)}`);});
}
function consoleCss(){return `
#r360DevConsole{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.7);display:flex;align-items:flex-end}.r360-dev-panel{width:100%;max-width:100dvw;height:min(88dvh,820px);max-height:calc(100dvh - env(safe-area-inset-top));background:#0b0c0e;color:#f5f5f7;border-radius:24px 24px 0 0;display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.12)}.r360-dev-head{display:flex;align-items:center;gap:8px;padding:14px 14px 12px;border-bottom:1px solid rgba(255,255,255,.1)}.r360-dev-head b{font-size:17px;flex:1}.r360-dev-head button{height:38px;border:0;border-radius:11px;background:#242529;color:#fff;padding:0 12px;font-weight:700}.r360-dev-body{overflow:auto;-webkit-overflow-scrolling:touch;padding:12px 12px calc(18px + env(safe-area-inset-bottom))}.r360-dev-blocker{padding:11px 12px;margin-bottom:10px;border:1px solid rgba(255,69,58,.35);border-radius:14px;background:rgba(255,69,58,.1);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}.r360-dev-log{font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid rgba(255,255,255,.09);border-radius:13px;overflow:hidden}.r360-dev-line{display:grid;grid-template-columns:64px 46px minmax(0,1fr);gap:6px;padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.06)}.r360-dev-line:last-child{border-bottom:0}.r360-dev-line time{color:#6e6e73}.r360-dev-line strong{font-size:9px;color:#64d2ff}.r360-dev-line.error strong{color:#ff453a}.r360-dev-line.warn strong{color:#ffd60a}.r360-dev-line span{white-space:pre-wrap;word-break:break-word}.r360-console-fab{position:absolute;z-index:80;left:50%;top:max(6px,env(safe-area-inset-top));transform:translateX(-50%);width:48px;height:42px;border-radius:14px;border:1px solid rgba(255,255,255,.2);background:rgba(20,20,22,.7);color:#fff;font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}.r360-dev-settings-row .console-mark{color:#0a84ff;font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}#r360DevConsole.hidden{display:none!important}`;}
function ensureUi(){
  if(!$('r360DevConsoleStyle')){const s=document.createElement('style');s.id='r360DevConsoleStyle';s.textContent=consoleCss();document.head.appendChild(s);}
  if(!$('r360DevConsole')){const root=document.createElement('section');root.id='r360DevConsole';root.className='hidden';root.innerHTML='<div class="r360-dev-panel"><div class="r360-dev-head"><b>Developer Console</b><button id="r360DevCopy" type="button">Copy Report</button><button id="r360DevClose" type="button">Done</button></div><div class="r360-dev-body"><div id="r360DevBlocker" class="r360-dev-blocker"></div><div id="r360DevLog" class="r360-dev-log"></div></div></div>';document.body.appendChild(root);root.addEventListener('click',e=>{if(e.target===root)closeConsole();});$('r360DevClose').onclick=closeConsole;$('r360DevCopy').onclick=copyReport;}
  installEntryPoints();render();
}
function installEntryPoints(){
  const host=document.body||document.documentElement;if(host&&!$('r360RuntimeConsole')){const b=document.createElement('button');b.id='r360RuntimeConsole';b.type='button';b.className='r360-console-fab';b.textContent='>_';b.onclick=openConsole;host.appendChild(b);}
  const anchor=$('appDiagnosticsButton');if(anchor&&!$('appDeveloperConsoleButton')){const b=document.createElement('button');b.id='appDeveloperConsoleButton';b.type='button';b.className='row row-button r360-dev-settings-row';b.innerHTML='<span>Developer Console</span><span class="console-mark">&gt;_</span>';b.onclick=openConsole;anchor.after(b);}
}
function removeEntryPoints(){$('r360RuntimeConsole')?.remove();$('appDeveloperConsoleButton')?.remove();$('r360DevConsole')?.classList.add('hidden');opened=false;}
function render(){
  if(!enabled)return;const blocker=$('r360DevBlocker'),log=$('r360DevLog');if(blocker){const summary=report();if(summary.blocker||summary.cpu.entry){blocker.hidden=false;blocker.textContent=['CURRENT BLOCKER',summary.blocker?.message,summary.blocker?.kind&&`kind: ${summary.blocker.kind}`,summary.blocker?.address&&`address: ${summary.blocker.address}`,present(summary.blocker?.opcode)&&`HIR opcode: ${summary.blocker.opcode}`,summary.cpu.entry&&`entry: ${summary.cpu.entry} · HIR: ${summary.cpu.hir??'—'}`,present(summary.cpu.instructions)&&`instructions: ${summary.cpu.instructions} · generated functions: ${summary.cpu.translatedFunctions??'—'}`,summary.memory?.faultName&&`memory: ${summary.memory.faultName} @ ${summary.memory.faultAddress||'—'} · PPC ${summary.memory.blockerInstruction||'—'}`,ppcDiagnosticSummary(summary.memory),stackDiagnosticSummary(summary.memory),summary.runtimeAsset?.verified&&`runtime: ${summary.runtimeAsset.sourceCommit.slice(0,12)} · ${summary.runtimeAsset.sha256.slice(0,12)}`].filter(Boolean).join('\n');}else{blocker.hidden=true;}}
  if(!log)return;log.innerHTML='';for(const e of entries){const row=document.createElement('div');row.className=`r360-dev-line ${e.level}`;row.innerHTML='<time></time><strong></strong><span></span>';row.children[0].textContent=new Date(e.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});row.children[1].textContent=e.level.toUpperCase();row.children[2].textContent=`${e.message}${e.count>1?` ×${e.count}`:''}`;log.appendChild(row);}if(!entries.length)log.innerHTML='<div class="r360-dev-line"><span></span><strong>INFO</strong><span>No runtime events captured yet.</span></div>';
}
function report(){
  const state=globalThis.render360ModernTitle||{};
  const result=state.result||{};
  const compatibility=result.compatibilityExecution||{};
  const scheduler=state.threadScheduler?.inspect?.()||state.schedulerReport||result.commercialCpu?.firstPump||null;
  const gpu=state.gpuTraffic||result.titleGpuTelemetry||result.browserHleTelemetry||{};
  const kernelBlocker=result.reachedKernelBlocker||result.firstKernelBlocker||null;
  const blocker=Object.keys(lastBlocker||{}).length?lastBlocker:compactBlocker(state.schedulerBlocker||result.executionBlocker||kernelBlocker);
  const memory=memoryDiagnostics(state,result);
  return {
    schema:'render360-blocker-report-v1',
    generatedAt:new Date().toISOString(),
    page:compact({path:location.pathname,state:document.body.dataset.state||undefined}),
    runtimeAsset:globalThis.render360PpcRuntimeIdentity||null,
    blocker:Object.keys(blocker).length?blocker:null,
    memory:Object.keys(memory).length?memory:null,
    cpu:compact({
      entry:address(result.entry),hir:number(result.hir),runtimeBoundary:result.runtimeBoundary,
      executionStatus:number(result.executionStatus),instructions:number(result.executionInstructions??compatibility.executionInstructions),
      executionBlockerKind:result.executionBlockerKind,executionBlockerOpcode:number(result.executionBlockerOpcode),
      executionBlockerAddress:address(result.executionBlockerAddress),translatedFunctions:number(result.translatedFunctionCount),
      firstTranslatedFunction:address(result.firstTranslatedFunction),callableFunctions:number(state.ppcSession?.functionCount??result.commercialCpu?.callableFunctionCount),
      schedulerReady:Boolean(state.threadScheduler),schedulerState:scheduler?.state||scheduler?.status,
    }),
    kernel:compact({
      imports:number(result.kernelImportCount??result.importCount),registered:number(result.registeredKernelImports),calls:number(result.kernelCalls),
      lastStatus:number(result.lastKernelServiceStatus),reachedBlocker:kernelBlocker?compactBlocker(kernelBlocker):undefined,
    }),
    gpu:compact({
      ringInitialized:gpu.ringInitialized,producerObserved:gpu.producerObserved,packets:number(gpu.packets),draws:number(gpu.draws),
      swaps:number(gpu.swaps),presents:number(gpu.presents),realTitleFrameReady:gpu.realTitleFrameReady,reason:gpu.reason,
    }),
    logs:entries.map(({at,level,message,count})=>compact({at:new Date(at).toISOString(),level,message,count})),
  };
}
async function writeClipboard(text){
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true;}}catch{}
  const field=document.createElement('textarea');field.value=text;field.readOnly=true;field.setAttribute('aria-hidden','true');field.style.cssText='position:fixed;inset:0;width:1px;height:1px;opacity:0;';document.body.appendChild(field);field.focus();field.select();field.setSelectionRange(0,field.value.length);
  let copied=false;try{copied=document.execCommand('copy');}catch{}field.remove();return copied;
}
async function copyReport(){
  const button=$('r360DevCopy');const original=button?.textContent||'Copy Report';
  const text=JSON.stringify(report(),(key,value)=>typeof value==='bigint'?String(value):value,2);
  const copied=await writeClipboard(text);if(button){button.textContent=copied?'Copied':'Copy failed';setTimeout(()=>{button.textContent=original;},1400);}return copied;
}
function openConsole(){if(!enabled)return;ensureUi();opened=true;$('r360DevConsole').classList.remove('hidden');render();}
function closeConsole(){opened=false;$('r360DevConsole')?.classList.add('hidden');}
function setEnabled(next){
  next=!!next;if(next===enabled)return;enabled=next;globalThis.render360DeveloperMode=enabled;
  $('appDiagnosticsButton')?.classList.toggle('hidden',!enabled);$('diagnosticsButton')?.classList.toggle('hidden',!enabled);
  if(enabled){installListeners();ensureUi();addEntry('info','Developer Mode enabled');}else removeEntryPoints();
}
function tick(){unlockNavigation();compactRuntimeStatus();setEnabled(readDeveloperMode());if(enabled)installEntryPoints();}
function start(){unlockNavigation();compactRuntimeStatus();setEnabled(readDeveloperMode());setInterval(tick,500);globalThis.render360DeveloperConsole={open:openConsole,close:closeConsole,report,copy:copyReport,setEnabled,get enabled(){return enabled;}};}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
