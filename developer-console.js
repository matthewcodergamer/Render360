// Render360 developer tools are opt-in. Production mode keeps only the tiny UI guard.
// V53: Braid blocker console — diagnosis first, full report always retained.
const SETTINGS_KEY='render360.settings.v44';
const $=id=>document.getElementById(id);
const entries=[];
const MAX_LOGS=60;
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
function hexDelta(value){
  const n=number(value);if(n===undefined)return '—';
  const sign=n<0?'-':'+';
  return `${sign}0x${Math.abs(n).toString(16).toUpperCase()}`;
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

function decodePpcInstruction(word,sourceAddress){
  if(word===undefined)return undefined;
  const primary=word>>>26;
  const rt=(word>>>21)&31,ra=(word>>>16)&31;
  if(primary===14){
    const imm=(word<<16)>>16;
    return {kind:'addi',text:`addi r${rt},r${ra},${imm}`,rt,ra,immediate:imm};
  }
  if(primary===15){
    const imm=(word<<16)>>16;
    return {kind:'addis',text:`addis r${rt},r${ra},${imm}`,rt,ra,immediate:imm};
  }
  if(primary===58||primary===62){
    let ds=(word>>>2)&0x3FFF;if(ds&0x2000)ds-=0x4000;
    const displacement=(ds<<2)|0;
    const xo=word&3;
    const mnemonic=primary===58?(xo===1?'ldu':xo===2?'lwa':'ld'):(xo===1?'stdu':'std');
    return {kind:'ds-form-memory',text:`${mnemonic} r${rt},${displacement}(r${ra})`,rt,ra,displacement,mnemonic};
  }
  if(primary>=32&&primary<=55){
    const displacement=(word<<16)>>16;
    const names={32:'lwz',33:'lwzu',34:'lbz',35:'lbzu',36:'stw',37:'stwu',38:'stb',39:'stbu',40:'lhz',41:'lhzu',42:'lha',43:'lhau',44:'sth',45:'sthu',46:'lmw',47:'stmw',48:'lfs',49:'lfsu',50:'lfd',51:'lfdu',52:'stfs',53:'stfsu',54:'stfd',55:'stfdu'};
    const mnemonic=names[primary]||`op${primary}`;
    return {kind:'d-form-memory',text:`${mnemonic} r${rt},${displacement}(r${ra})`,rt,ra,displacement,mnemonic};
  }
  if(primary===18){
    let displacement=word&0x03FFFFFC;if(displacement&0x02000000)displacement|=0xFC000000;
    displacement|=0;
    const absolute=!!(word&2),link=!!(word&1);
    const target=(absolute?displacement:((sourceAddress>>>0)+displacement))>>>0;
    return {kind:'direct-branch',text:`b${link?'l':''} ${address(target)}`,target:address(target),displacement,absolute,link};
  }
  if(primary===16){
    let displacement=word&0x0000FFFC;displacement=(displacement<<16)>>16;
    const absolute=!!(word&2),link=!!(word&1);
    const target=(absolute?displacement:((sourceAddress>>>0)+displacement))>>>0;
    return {kind:'conditional-branch',text:`bc${link?'l':''} ${address(target)}`,target:address(target),displacement,absolute,link,bo:(word>>>21)&31,bi:(word>>>16)&31};
  }
  if(primary===19){
    const xo=(word>>>1)&0x3FF,link=!!(word&1);
    if(xo===16)return {kind:'bclr',text:`bclr${link?'l':''}`,link,bo:(word>>>21)&31,bi:(word>>>16)&31};
    if(xo===528)return {kind:'bcctr',text:`bcctr${link?'l':''}`,link,bo:(word>>>21)&31,bi:(word>>>16)&31};
  }
  return {kind:'other',text:`opcode ${primary}`,primaryOpcode:primary};
}

function readInstructionWord(read8,sourceAddress){
  const a=number(sourceAddress);if(!read8||a===undefined)return undefined;
  const b0=read8(a>>>0)>>>0,b1=read8((a+1)>>>0)>>>0,b2=read8((a+2)>>>0)>>>0,b3=read8((a+3)>>>0)>>>0;
  return ((b0<<24)|(b1<<16)|(b2<<8)|b3)>>>0;
}
function readPpcWindow(read8,center,radius=3){
  const c=number(center);if(!read8||c===undefined)return undefined;
  const rows=[];
  for(let i=-radius;i<=radius;i++){
    const at=(c+i*4)>>>0;
    const word=readInstructionWord(read8,at);
    if(word===undefined)continue;
    const decoded=decodePpcInstruction(word,at);
    rows.push(compact({
      address:address(at),
      word:`0x${word.toString(16).toUpperCase().padStart(8,'0')}`,
      decoded:decoded?.text,
      kind:decoded?.kind,
      current:i===0,
    }));
  }
  return rows.length?rows:undefined;
}

function memoryDiagnostics(state,result){
  const bootstrap=state?.bootstrap,exp=bootstrap?.exports||{};
  const fn=name=>{const value=exp[name]??exp[`_${name}`];return typeof value==='function'?value:null;};
  const faultAddressFn=fn('r360_sparse_guest_memory_last_fault_address');
  const faultCodeFn=fn('r360_sparse_guest_memory_last_fault_code');
  const mappedPagesFn=fn('r360_sparse_guest_memory_mapped_pages');
  const backingPagesFn=fn('r360_sparse_guest_memory_backing_pages');
  const read8=fn('r360_sparse_guest_memory_read_u8');
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
  const capturedFaultAddress=number(result?.memoryFaultAddress);
  const capturedFaultCode=number(result?.memoryFaultCode);
  const faultAddress=capturedFaultAddress!==undefined?capturedFaultAddress:(faultAddressFn?(faultAddressFn()>>>0):undefined);
  const faultCode=capturedFaultCode!==undefined?capturedFaultCode:(faultCodeFn?(faultCodeFn()>>>0):undefined);
  const blockerAddress=number(result?.executionBlockerAddress);
  const instructionWord=readInstructionWord(read8,blockerAddress);
  const decoded=instructionWord===undefined?undefined:decodePpcInstruction(instructionWord,blockerAddress);
  let baseRegisterValue,effectiveAddress;
  if(decoded&&(decoded.kind==='d-form-memory'||decoded.kind==='ds-form-memory')&&faultAddress!==undefined&&faultCode){
    effectiveAddress=faultAddress>>>0;
    baseRegisterValue=decoded.ra===0?0:(effectiveAddress-(decoded.displacement|0))>>>0;
  }
  const faultNames={0:'none',1:'unmapped',2:'read-protection',3:'write-protection',4:'invalid-argument',5:'already-mapped'};
  const context=result?.mainThreadContext||{};
  return compact({
    faultAddress:faultAddress===undefined?undefined:address(faultAddress),
    faultCode,
    faultName:faultCode===undefined?undefined:(faultNames[faultCode]||`fault-${faultCode}`),
    faultCapturedAtExecution:capturedFaultCode!==undefined,
    blockerInstruction:instructionWord===undefined?undefined:`0x${instructionWord.toString(16).toUpperCase().padStart(8,'0')}`,
    blockerDecoded:decoded?.text,
    instructionKind:decoded?.kind||'unknown',
    ppcPrimaryOpcode:instructionWord===undefined?undefined:instructionWord>>>26,
    rt:decoded?.rt,ra:decoded?.ra,displacement:decoded?.displacement,
    effectiveAddress:effectiveAddress===undefined?undefined:address(effectiveAddress),
    baseRegisterValue:baseRegisterValue===undefined?undefined:address(baseRegisterValue),
    branchDisplacement:decoded?.displacement,
    branchTarget:decoded?.target,
    branchAbsolute:decoded?.absolute,
    branchLink:decoded?.link,
    branchBO:decoded?.bo,
    branchBI:decoded?.bi,
    faultInstructionAttribution:faultCode&&decoded&&!['d-form-memory','ds-form-memory'].includes(decoded.kind)?'fault-not-derived-from-boundary-instruction':undefined,
    mappedPages:mappedPagesFn?(mappedPagesFn()>>>0):undefined,
    backingPages:backingPagesFn?(backingPagesFn()>>>0):undefined,
    stackTop:address(context.stackTop),stackLimit:address(context.stackLimit),stackBase:address(context.stackBase),stackSlotBase:address(context.stackSlotBase),
    stackGuardBytes:number(context.stackGuardBytes),pcrAddress:address(context.pcrAddress),tlsAddress:address(context.tlsAddress),
    stackTrace:Object.keys(stackTrace).length?stackTrace:undefined,
    codeWindows:compact({
      r1Write:readPpcWindow(read8,stackTrace.lastWriteAddress,3),
      callSite:readPpcWindow(read8,stackTrace.lastCallSource,2),
      blocker:readPpcWindow(read8,blockerAddress,2),
    }),
  });
}

function ppcDiagnosticSummary(memory){
  if(!memory?.blockerInstruction)return undefined;
  if((memory.instructionKind==='d-form-memory'||memory.instructionKind==='ds-form-memory')&&present(memory.ra))
    return `PPC memory: rA=${memory.ra}=${memory.baseRegisterValue||'—'} rT=${memory.rt??'—'} disp=${memory.displacement??'—'} EA=${memory.effectiveAddress||'—'}`;
  if(memory.instructionKind==='direct-branch'||memory.instructionKind==='conditional-branch')
    return `PPC ${memory.instructionKind}: target=${memory.branchTarget||'—'} disp=${memory.branchDisplacement??'—'} AA=${memory.branchAbsolute?1:0} LK=${memory.branchLink?1:0}${memory.faultInstructionAttribution?' · memory fault belongs to an earlier/different boundary':''}`;
  return `PPC ${memory.instructionKind||'other'} · primary opcode ${memory.ppcPrimaryOpcode??'—'}`;
}
function stackDiagnosticSummary(memory){
  const trace=memory?.stackTrace;if(!trace?.blockerR1)return undefined;
  return `stack r1=${trace.blockerR1} initial=${trace.initialR1||'—'} · last write ${trace.lastWriteAddress||'—'} ${trace.lastOldR1||'—'}→${trace.lastNewR1||'—'} depth=${trace.lastWriteDepth??'—'} · last call ${trace.lastCallSource||'—'}→${trace.lastCallTarget||'—'} r1=${trace.lastCallR1||'—'} depth=${trace.lastCallDepth??'—'}`;
}

function problemFocus(memory,cpu,kernel,gpu,runtimeAsset){
  const trace=memory?.stackTrace||{};
  const blockerR1=number(trace.blockerR1),initialR1=number(trace.initialR1),stackBase=number(memory?.stackBase),stackTop=number(memory?.stackTop);
  const lastOld=number(trace.lastOldR1),lastNew=number(trace.lastNewR1),fault=number(memory?.faultAddress),ea=number(memory?.effectiveAddress);
  const stackCrossing=blockerR1!==undefined&&stackBase!==undefined?(blockerR1-stackBase):undefined;
  const faultIntoGuard=fault!==undefined&&stackBase!==undefined?(fault-stackBase):undefined;
  const r1WriteDelta=lastOld!==undefined&&lastNew!==undefined?(lastNew-lastOld):undefined;
  const initialAbiCorrect=initialR1!==undefined&&stackTop!==undefined&&initialR1===stackTop;
  const crossedGuard=stackCrossing!==undefined&&stackCrossing>0&&memory?.faultCode===1;
  const isR1Fault=memory?.ra===1&&ea!==undefined&&fault!==undefined&&ea===fault;
  const writeWindow=memory?.codeWindows?.r1Write||[];
  const writeInstruction=writeWindow.find(row=>row.current);
  const classification=crossedGuard&&isR1Fault?'STACK_FRAME_TEARDOWN_MISMATCH':memory?.faultCode?'GUEST_MEMORY_BOUNDARY':'CPU_RUNTIME_BLOCKER';
  const evidence=[
    initialAbiCorrect?`Entry r1 is correct: ${trace.initialR1} == stackTop ${memory.stackTop}.`:undefined,
    r1WriteDelta!==undefined?`Last r1 write: ${trace.lastWriteAddress} moved ${trace.lastOldR1} → ${trace.lastNewR1} (${hexDelta(r1WriteDelta)}).`:undefined,
    writeInstruction?`Instruction at last r1 write: ${writeInstruction.word} · ${writeInstruction.decoded||writeInstruction.kind}.`:undefined,
    crossedGuard?`At the blocker r1 is ${hexDelta(stackCrossing)} above stackBase ${memory.stackBase}.`:undefined,
    faultIntoGuard!==undefined&&faultIntoGuard>=0?`Fault address ${memory.faultAddress} is ${hexDelta(faultIntoGuard)} into the protected upper stack guard.`:undefined,
    isR1Fault?`Fault equation: ${memory.baseRegisterValue} + (${memory.displacement}) = ${memory.effectiveAddress}.`:undefined,
    trace.lastCallSource&&trace.lastCallTarget?`Immediate call edge: ${trace.lastCallSource} → ${trace.lastCallTarget}, depth ${trace.lastCallDepth??'—'}, r1=${trace.lastCallR1||'—'}.`:undefined,
  ].filter(Boolean);
  const ruledOut=[
    initialAbiCorrect?'Initial stack reservation / stackTop mismatch':undefined,
    crossedGuard?'Mapping or clamping the upper guard page (guard violation is real evidence)':undefined,
    number(kernel?.calls)===0?'XAM/xboxkrnl HLE as the current cause (kernel calls = 0)':undefined,
    gpu?.ringInitialized===false||gpu?.reason==='ring-not-initialized'?'GPU/ring path as the current cause (CPU stops first)':undefined,
  ].filter(Boolean);
  const next=[
    trace.lastWriteAddress?`Inspect the frame teardown at ${trace.lastWriteAddress}; determine whether its positive r1 restore has a matching earlier allocation in the same guest frame.`:undefined,
    trace.lastCallSource?`Verify function/shared-epilogue classification around ${trace.lastCallSource} and the target ${trace.lastCallTarget||'—'}.`:undefined,
    `Do not patch ${memory?.faultAddress||'the fault address'} writable; preserve Xenia's stack guard and fix the control-flow/frame state that reached it.`,
  ].filter(Boolean);
  return compact({
    classification,
    headline:crossedGuard?'r1 crossed the Xenia stack base before the restore load':'CPU execution stopped at a guest-memory boundary',
    primarySuspect:trace.lastWriteAddress,
    primarySuspectInstruction:writeInstruction,
    stackCrossingBytes:stackCrossing,
    r1WriteDelta,
    faultIntoGuardBytes:faultIntoGuard,
    initialAbiCorrect,
    faultDerivedFromR1:isR1Fault,
    callEdge:trace.lastCallSource&&trace.lastCallTarget?`${trace.lastCallSource} -> ${trace.lastCallTarget}`:undefined,
    evidence,ruledOut,next,
    runtime:runtimeAsset?.verified?compact({sourceCommit:runtimeAsset.sourceCommit,sourceRun:runtimeAsset.sourceRun,sha256:runtimeAsset.sha256}):undefined,
    cpuCheckpoint:compact({entry:cpu?.entry,instructions:cpu?.instructions,blockerAddress:cpu?.executionBlockerAddress,blockerOpcode:cpu?.executionBlockerOpcode}),
  });
}

function addEntry(level,message){
  if(!enabled)return;
  const next={at:Date.now(),level:String(level||'info'),message:String(message||'')};
  const previous=entries.at(-1);
  if(previous&&previous.level===next.level&&previous.message===next.message){previous.at=next.at;previous.count=(previous.count||1)+1;}
  else entries.push(next);
  if(entries.length>MAX_LOGS)entries.splice(0,entries.length-MAX_LOGS);
  render();
}
function eventHandler(event){
  if(!enabled)return;
  const type=event.type.replace('render360:',''),detail=event.detail||{};
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
#r360DevConsole{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);display:flex;align-items:flex-end}
.r360-dev-panel{width:100%;max-width:100dvw;height:min(92dvh,900px);max-height:calc(100dvh - env(safe-area-inset-top));background:#090a0c;color:#f5f5f7;border-radius:24px 24px 0 0;display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.12)}
.r360-dev-head{display:flex;align-items:center;gap:8px;padding:13px 12px 11px;border-bottom:1px solid rgba(255,255,255,.1)}
.r360-dev-title{min-width:0;flex:1}.r360-dev-title b{display:block;font-size:17px}.r360-dev-title small{display:block;color:#8e8e93;font-size:10px;margin-top:1px}
.r360-dev-head button{height:38px;border:0;border-radius:11px;background:#242529;color:#fff;padding:0 11px;font-weight:700;white-space:nowrap}
.r360-dev-body{overflow:auto;-webkit-overflow-scrolling:touch;padding:11px 11px calc(18px + env(safe-area-inset-bottom))}
.r360-focus-card,.r360-dev-section{border:1px solid rgba(255,255,255,.1);border-radius:14px;background:#101114;margin-bottom:10px;overflow:hidden}
.r360-focus-card{border-color:rgba(255,69,58,.42);background:linear-gradient(180deg,rgba(255,69,58,.13),rgba(255,69,58,.06))}
.r360-focus-head{padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.08)}
.r360-focus-kicker{font:700 9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#ff6961;letter-spacing:.08em}
.r360-focus-head h3{font-size:15px;line-height:1.25;margin:5px 0 0}
.r360-focus-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(255,255,255,.07)}
.r360-focus-cell{background:#0e0f12;padding:9px 10px;min-width:0}.r360-focus-cell b{display:block;font-size:9px;color:#8e8e93;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}.r360-focus-cell span{display:block;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
.r360-dev-section h4{margin:0;padding:9px 11px;border-bottom:1px solid rgba(255,255,255,.07);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#aeaeb2}
.r360-bullet-list{margin:0;padding:8px 11px 9px 25px;font:10.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.r360-bullet-list li{margin:3px 0}
.r360-code-window{padding:7px 8px;font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.r360-code-row{display:grid;grid-template-columns:76px 86px minmax(0,1fr);gap:6px;padding:3px 4px;border-radius:6px}.r360-code-row.current{background:rgba(255,214,10,.12);outline:1px solid rgba(255,214,10,.22)}.r360-code-row .addr{color:#64d2ff}.r360-code-row .word{color:#aeaeb2}.r360-code-row .decoded{word-break:break-word}
.r360-dev-note{padding:8px 10px;color:#8e8e93;font-size:10px;line-height:1.35}
.r360-dev-details{border:1px solid rgba(255,255,255,.09);border-radius:13px;overflow:hidden;background:#0d0e10}.r360-dev-details summary{padding:10px 11px;font-size:11px;font-weight:700;cursor:pointer}
.r360-dev-log{font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;border-top:1px solid rgba(255,255,255,.07)}
.r360-dev-line{display:grid;grid-template-columns:64px 42px minmax(0,1fr);gap:6px;padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.06)}.r360-dev-line:last-child{border-bottom:0}.r360-dev-line time{color:#6e6e73}.r360-dev-line strong{font-size:9px;color:#64d2ff}.r360-dev-line.error strong{color:#ff453a}.r360-dev-line.warn strong{color:#ffd60a}.r360-dev-line span{white-space:pre-wrap;word-break:break-word}
.r360-console-fab{position:absolute;z-index:80;left:50%;top:max(6px,env(safe-area-inset-top));transform:translateX(-50%);width:48px;height:42px;border-radius:14px;border:1px solid rgba(255,255,255,.2);background:rgba(20,20,22,.72);color:#fff;font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}
.r360-dev-settings-row .console-mark{color:#0a84ff;font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}
#r360DevConsole.hidden{display:none!important}
@media(max-width:390px){.r360-dev-head{gap:6px}.r360-dev-title small{display:none}.r360-dev-head button{padding:0 9px;font-size:12px}.r360-focus-grid{grid-template-columns:1fr}.r360-code-row{grid-template-columns:70px 82px minmax(0,1fr)}}
`;}

function ensureUi(){
  if(!$('r360DevConsoleStyle')){const s=document.createElement('style');s.id='r360DevConsoleStyle';s.textContent=consoleCss();document.head.appendChild(s);}
  if(!$('r360DevConsole')){
    const root=document.createElement('section');root.id='r360DevConsole';root.className='hidden';
    root.innerHTML='<div class="r360-dev-panel"><div class="r360-dev-head"><div class="r360-dev-title"><b>Braid CPU Diagnostic</b><small>Problem-first developer console</small></div><button id="r360DevCopy" type="button">Copy Report</button><button id="r360DevClose" type="button">Done</button></div><div class="r360-dev-body"><div id="r360DevFocus"></div><details id="r360DevFullLog" class="r360-dev-details"><summary id="r360DevLogSummary">Full event log</summary><div id="r360DevLog" class="r360-dev-log"></div></details></div></div>';
    document.body.appendChild(root);
    root.addEventListener('click',e=>{if(e.target===root)closeConsole();});
    $('r360DevClose').onclick=closeConsole;$('r360DevCopy').onclick=copyReport;
  }
  installEntryPoints();render();
}
function installEntryPoints(){
  const stage=document.querySelector('.runtime-stage');
  if(stage&&!$('r360RuntimeConsole')){const b=document.createElement('button');b.id='r360RuntimeConsole';b.type='button';b.className='r360-console-fab';b.textContent='>_';b.onclick=openConsole;stage.appendChild(b);}
  const anchor=$('appDiagnosticsButton');
  if(anchor&&!$('appDeveloperConsoleButton')){const b=document.createElement('button');b.id='appDeveloperConsoleButton';b.type='button';b.className='row row-button r360-dev-settings-row';b.innerHTML='<span>Developer Console</span><span class="console-mark">&gt;_</span>';b.onclick=openConsole;anchor.after(b);}
}
function removeEntryPoints(){$('r360RuntimeConsole')?.remove();$('appDeveloperConsoleButton')?.remove();$('r360DevConsole')?.classList.add('hidden');opened=false;}

function appendTextList(parent,title,items){
  if(!items?.length)return;
  const section=document.createElement('section');section.className='r360-dev-section';
  const heading=document.createElement('h4');heading.textContent=title;section.appendChild(heading);
  const ul=document.createElement('ul');ul.className='r360-bullet-list';
  for(const item of items){const li=document.createElement('li');li.textContent=item;ul.appendChild(li);}
  section.appendChild(ul);parent.appendChild(section);
}
function appendCodeWindow(parent,title,rows){
  if(!rows?.length)return;
  const section=document.createElement('section');section.className='r360-dev-section';
  const heading=document.createElement('h4');heading.textContent=title;section.appendChild(heading);
  const body=document.createElement('div');body.className='r360-code-window';
  for(const row of rows){
    const line=document.createElement('div');line.className=`r360-code-row${row.current?' current':''}`;
    for(const [cls,text] of [['addr',row.address],['word',row.word],['decoded',row.decoded||row.kind||'—']]){
      const span=document.createElement('span');span.className=cls;span.textContent=text||'—';line.appendChild(span);
    }
    body.appendChild(line);
  }
  section.appendChild(body);parent.appendChild(section);
}
function focusCell(label,value){
  const cell=document.createElement('div');cell.className='r360-focus-cell';
  const b=document.createElement('b');b.textContent=label;const span=document.createElement('span');span.textContent=value||'—';
  cell.append(b,span);return cell;
}
function renderFocus(summary){
  const root=$('r360DevFocus');if(!root)return;root.innerHTML='';
  const focus=summary.problemFocus||{};
  if(!summary.blocker&&!summary.cpu?.entry){
    const empty=document.createElement('section');empty.className='r360-dev-section';
    empty.innerHTML='<div class="r360-dev-note">No CPU blocker captured yet. Start Braid, then reopen this console.</div>';root.appendChild(empty);return;
  }
  const card=document.createElement('section');card.className='r360-focus-card';
  const head=document.createElement('div');head.className='r360-focus-head';
  const kicker=document.createElement('div');kicker.className='r360-focus-kicker';kicker.textContent=focus.classification||'CURRENT CPU BLOCKER';
  const title=document.createElement('h3');title.textContent=focus.headline||summary.blocker?.message||'Braid execution blocked';
  head.append(kicker,title);card.appendChild(head);
  const grid=document.createElement('div');grid.className='r360-focus-grid';
  grid.append(
    focusCell('First suspect',focus.primarySuspect||summary.memory?.stackTrace?.lastWriteAddress),
    focusCell('r1 change',focus.r1WriteDelta!==undefined?`${summary.memory?.stackTrace?.lastOldR1||'—'} → ${summary.memory?.stackTrace?.lastNewR1||'—'} (${hexDelta(focus.r1WriteDelta)})`:'—'),
    focusCell('Fault',`${summary.memory?.faultName||'—'} @ ${summary.memory?.faultAddress||'—'}`),
    focusCell('Failing PPC',`${summary.memory?.blockerInstruction||'—'} · ${summary.memory?.blockerDecoded||ppcDiagnosticSummary(summary.memory)||'—'}`),
    focusCell('Call edge',focus.callEdge||'—'),
    focusCell('Progress',`${summary.cpu?.instructions??'—'} instructions · HIR ${summary.cpu?.hir??'—'}`)
  );
  card.appendChild(grid);root.appendChild(card);
  appendTextList(root,'Evidence',focus.evidence);
  appendCodeWindow(root,'PPC around last r1 write',summary.memory?.codeWindows?.r1Write);
  appendCodeWindow(root,'PPC around call site',summary.memory?.codeWindows?.callSite);
  appendCodeWindow(root,'PPC around fault',summary.memory?.codeWindows?.blocker);
  appendTextList(root,'Ruled out right now',focus.ruledOut);
  appendTextList(root,'Next diagnostic target',focus.next);
  const note=document.createElement('div');note.className='r360-dev-note';
  const commit=summary.runtimeAsset?.sourceCommit?.slice?.(0,12)||'unknown';
  note.textContent=`Runtime ${commit}. Copy Report still includes the complete JSON, full memory diagnostics, kernel/GPU state, code windows and every captured event.`;
  root.appendChild(note);
}
function render(){
  if(!enabled)return;
  const summary=report();renderFocus(summary);
  const log=$('r360DevLog');const label=$('r360DevLogSummary');
  if(label)label.textContent=`Full event log · ${entries.length} events`;
  if(!log)return;log.innerHTML='';
  for(const e of entries){
    const row=document.createElement('div');row.className=`r360-dev-line ${e.level}`;
    row.innerHTML='<time></time><strong></strong><span></span>';
    row.children[0].textContent=new Date(e.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    row.children[1].textContent=e.level.toUpperCase();
    row.children[2].textContent=`${e.message}${e.count>1?` ×${e.count}`:''}`;
    log.appendChild(row);
  }
  if(!entries.length)log.innerHTML='<div class="r360-dev-line"><span></span><strong>INFO</strong><span>No runtime events captured yet.</span></div>';
}

function report(){
  const state=globalThis.render360ModernTitle||{};
  const result=state.result||{};
  const compatibility=result.compatibilityExecution||{};
  const scheduler=state.threadScheduler?.inspect?.()||state.schedulerReport||result.commercialCpu?.firstPump||null;
  const gpuSource=state.gpuTraffic||result.titleGpuTelemetry||result.browserHleTelemetry||{};
  const kernelBlocker=result.reachedKernelBlocker||result.firstKernelBlocker||null;
  const blocker=lastBlocker||compactBlocker(result.schedulerBlocker||result.blocker||{
    kind:result.runtimeBoundary?'native-hir-unsupported-boundary':undefined,
    message:result.runtimeBlocker||result.blockerMessage||result.reason,
    address:result.entry,
    executionBlockerOpcode:result.executionBlockerOpcode,
    executionStatus:result.executionStatus,
    executionInstructions:result.executionInstructions,
  });
  const memory=memoryDiagnostics(state,result);
  const cpu=compact({
    entry:address(result.entry),hir:number(result.hir),runtimeBoundary:result.runtimeBoundary,
    executionStatus:number(result.executionStatus),instructions:number(result.executionInstructions??compatibility.executionInstructions),
    executionBlockerKind:result.executionBlockerKind,executionBlockerOpcode:number(result.executionBlockerOpcode),
    executionBlockerAddress:address(result.executionBlockerAddress),translatedFunctions:number(result.translatedFunctionCount),
    firstTranslatedFunction:address(result.firstTranslatedFunction),callableFunctions:number(state.ppcSession?.functionCount??result.commercialCpu?.callableFunctionCount),
    schedulerReady:Boolean(state.threadScheduler),schedulerState:scheduler?.state||scheduler?.status,
  });
  const kernel=compact({
    imports:number(result.kernelImportCount??result.importCount),registered:number(result.registeredKernelImports),calls:number(result.kernelCalls),
    lastStatus:number(result.lastKernelServiceStatus),reachedBlocker:kernelBlocker?compactBlocker(kernelBlocker):undefined,
  });
  const gpu=compact({
    ringInitialized:gpuSource.ringInitialized,producerObserved:gpuSource.producerObserved,packets:number(gpuSource.packets),draws:number(gpuSource.draws),
    swaps:number(gpuSource.swaps),presents:number(gpuSource.presents),realTitleFrameReady:gpuSource.realTitleFrameReady,reason:gpuSource.reason,
  });
  const runtimeAsset=globalThis.render360PpcRuntimeIdentity||null;
  const focus=problemFocus(memory,cpu,kernel,gpu,runtimeAsset);
  return {
    schema:'render360-blocker-report-v1',
    generatedAt:new Date().toISOString(),
    page:compact({path:location.pathname,state:document.body.dataset.state||undefined}),
    runtimeAsset,
    blocker:Object.keys(blocker).length?blocker:null,
    problemFocus:Object.keys(focus).length?focus:null,
    memory:Object.keys(memory).length?memory:null,
    cpu,kernel,gpu,
    logs:entries.map(e=>({...e,at:new Date(e.at).toISOString()})),
  };
}

async function writeClipboard(text){
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true;}}catch{}
  try{const area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const ok=document.execCommand('copy');area.remove();return ok;}catch{return false;}
}
async function copyReport(){
  const button=$('r360DevCopy'),original=button?.textContent||'Copy Report';
  const text=JSON.stringify(report(),null,2);
  const copied=await writeClipboard(text);
  if(button){button.textContent=copied?'Copied':'Copy failed';setTimeout(()=>{button.textContent=original;},1400);}
  return copied;
}
function openConsole(){if(!enabled)return;ensureUi();opened=true;$('r360DevConsole').classList.remove('hidden');render();}
function closeConsole(){opened=false;$('r360DevConsole')?.classList.add('hidden');}
function setEnabled(next){
  next=!!next;if(next===enabled)return;enabled=next;globalThis.render360DeveloperMode=enabled;
  $('appDiagnosticsButton')?.classList.toggle('hidden',!enabled);$('diagnosticsButton')?.classList.toggle('hidden',!enabled);
  if(enabled){installListeners();ensureUi();addEntry('info','Developer Mode enabled');}else removeEntryPoints();
}
function tick(){unlockNavigation();compactRuntimeStatus();setEnabled(readDeveloperMode());if(enabled)installEntryPoints();}
function start(){
  unlockNavigation();compactRuntimeStatus();setEnabled(readDeveloperMode());setInterval(tick,500);
  globalThis.render360DeveloperConsole={open:openConsole,close:closeConsole,report,copy:copyReport,setEnabled,get enabled(){return enabled;}};
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
