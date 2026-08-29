// Render360 V44 live developer console.
// Captures structured runtime events plus Render360 console output and turns them
// into an iOS-friendly, persistent boot-pipeline debugger. No emulator behavior
// is faked here: every green/blocked state comes from a concrete runtime event,
// handoff result, scheduler blocker, PM4 observation, or browser exception.

const RELEASE=44;
const MAX_LOGS=300;
const $=id=>document.getElementById(id);
const fmtHex=value=>`0x${(Number(value)||0>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
const nowLabel=()=>new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
const PIPELINE=[
  ['source','Source / Core'],
  ['filesystem','Disc / Package'],
  ['xex','XEX2 / Security'],
  ['pe','PE / Guest Memory'],
  ['ppc','PPC / Scheduler'],
  ['kernel','xboxkrnl / XAM'],
  ['gpu','Xenos / Frame'],
];
const stageState=new Map(PIPELINE.map(([key,label])=>[key,{key,label,state:'wait',detail:'Waiting'}]));
const entries=[];
let opened=false;
let lastStageKey='source';
let lastBlocker=null;
let runSerial=0;
let lastLogFingerprint='';
let lastLogAt=0;

function safeJson(value,space=2){
  const seen=new WeakSet();
  try{return JSON.stringify(value,(key,v)=>{
    if(typeof v==='bigint')return `0x${v.toString(16)}`;
    if(v instanceof ArrayBuffer)return `[ArrayBuffer ${v.byteLength}]`;
    if(ArrayBuffer.isView(v))return `[${v.constructor?.name||'TypedArray'} ${v.byteLength}]`;
    if(v instanceof Blob)return `[${v.constructor?.name||'Blob'} ${v.size} bytes]`;
    if(typeof v==='object'&&v){if(seen.has(v))return '[Circular]';seen.add(v);}
    return v;
  },space);}catch{return String(value);}
}
function argText(value){if(typeof value==='string')return value;if(value instanceof Error)return `${value.name}: ${value.message}`;return safeJson(value,0);}
function normalizeLevel(level){const l=String(level||'info').toLowerCase();return l==='error'?'error':l==='warn'||l==='warning'?'warn':l==='ok'||l==='success'?'ok':'info';}
function addLog(level,message,{source='runtime',stage=null,data=null,force=false}={}){
  const text=String(message??'').trim();if(!text)return;
  const normalized=normalizeLevel(level),fingerprint=`${normalized}|${source}|${text}`,at=Date.now();
  if(!force&&fingerprint===lastLogFingerprint&&at-lastLogAt<120)return;
  lastLogFingerprint=fingerprint;lastLogAt=at;
  entries.push({at,level:normalized,message:text,source,stage,data});if(entries.length>MAX_LOGS)entries.splice(0,entries.length-MAX_LOGS);
  renderLogTail();renderHeader();
}
function setStage(key,state,detail,{activate=true}={}){
  const item=stageState.get(key);if(!item)return;
  item.state=state;item.detail=String(detail||item.detail||'');item.at=Date.now();
  if(activate)lastStageKey=key;
  renderPipeline();renderHeader();
}
function completeBefore(key){
  const index=PIPELINE.findIndex(([k])=>k===key);if(index<0)return;
  for(let i=0;i<index;i++){const item=stageState.get(PIPELINE[i][0]);if(item&&item.state!=='blocked'&&item.state!=='ok'){item.state='ok';item.detail=item.detail==='Waiting'?'Passed':item.detail;}}
}
function resetPipeline(reason='New title launch'){
  runSerial++;
  for(const [key] of PIPELINE){const item=stageState.get(key);item.state='wait';item.detail='Waiting';delete item.at;}
  lastStageKey='source';lastBlocker=null;
  setStage('source','active',reason);
  addLog('info',`──────── Run ${runSerial} · ${reason} ────────`,{source:'console',force:true});
  updateBlockerCard();setBlockedBadge(false);
}
function blockerSummary(blocker){
  if(!blocker)return 'Unknown blocker';
  const b=blocker.blocker||blocker;
  const ordinal=b.ordinal??b.kernelOrdinal??b.lastOrdinal;
  const module=b.module||b.kernelModule;
  if(module&&ordinal!==undefined){
    const thunk=b.thunkAddress!==undefined?` · thunk ${fmtHex(b.thunkAddress)}`:'';
    return `${module} ordinal 0x${(Number(ordinal)>>>0).toString(16).toUpperCase()}${thunk}`;
  }
  if(b.lastOpcode!==undefined)return `Xenos PM4 opcode 0x${(Number(b.lastOpcode)>>>0).toString(16).toUpperCase()}${b.lastFaultWord!==undefined?` · word ${b.lastFaultWord}`:''}`;
  if(b.entry!==undefined)return `${b.message||b.error||b.kind||'PPC scheduler blocker'} · entry ${fmtHex(b.entry)}`;
  return b.message||b.error||b.reason||b.kind||String(b);
}
function blockerStage(blocker){
  const b=blocker?.blocker||blocker||{};
  if(b.module||b.ordinal!==undefined||/kernel|xam|xboxkrnl/i.test(`${b.kind||''} ${b.message||''}`))return 'kernel';
  if(b.lastOpcode!==undefined||b.lastFaultWord!==undefined||/pm4|xenos|gpu|shader|webgpu/i.test(`${b.kind||''} ${b.message||''}`))return 'gpu';
  if(/stfs|xdvdfs|iso|package|mount|default\.xex/i.test(`${b.kind||''} ${b.message||''}`))return 'filesystem';
  if(/xex|decrypt|decompress|lzx|aes/i.test(`${b.kind||''} ${b.message||''}`))return 'xex';
  if(/pe|guest memory|mapping|mapper/i.test(`${b.kind||''} ${b.message||''}`))return 'pe';
  return 'ppc';
}
function markBlocked(blocker,source='runtime'){
  const summary=blockerSummary(blocker),stage=blockerStage(blocker);lastBlocker={at:Date.now(),stage,summary,raw:blocker};
  completeBefore(stage);setStage(stage,'blocked',summary);addLog('error',`BLOCKED · ${summary}`,{source,stage,data:blocker,force:true});updateBlockerCard();setBlockedBadge(true);
}
function mapBootStage(detail={}){
  const stage=String(detail.stage||'').toLowerCase(),message=detail.message||stage||'Runtime update';
  if(stage==='core'){setStage('source','active',message);addLog('info',message,{source:'stage',stage:'source'});return;}
  if(stage==='launch'){resetPipeline(message);return;}
  if(stage==='mount'){completeBefore('filesystem');setStage('filesystem','active',message);addLog('info',message,{source:'stage',stage:'filesystem',data:detail});return;}
  if(stage==='extract'){completeBefore('filesystem');setStage('filesystem',Number(detail.done||0)>=Number(detail.total||Infinity)?'ok':'active',message);setStage('xex','active','default.xex extraction / staging',{activate:false});addLog('info',progressMessage(message,detail),{source:'stage',stage:'filesystem',data:detail});return;}
  if(stage==='translate'){completeBefore('xex');setStage('xex','active',message);setStage('pe','active','Retail image preparation / PE mapping',{activate:false});addLog('info',message,{source:'stage',stage:'xex',data:detail});return;}
  if(stage==='execute'){completeBefore('ppc');setStage('ppc','active',message);addLog('ok',message,{source:'stage',stage:'ppc',data:detail});return;}
  if(stage==='frame'){for(const key of ['source','filesystem','xex','pe','ppc','kernel','gpu'])setStage(key,'ok',key==='gpu'?message:stageState.get(key).detail,{activate:false});lastStageKey='gpu';addLog('ok',message,{source:'stage',stage:'gpu',data:detail,force:true});return;}
  if(stage==='blocked'){markBlocked(detail, 'stage');return;}
  addLog('info',progressMessage(message,detail),{source:'stage',stage:lastStageKey,data:detail});
}
function progressMessage(message,detail){
  const done=Number(detail.done),total=Number(detail.total);
  if(Number.isFinite(done)&&Number.isFinite(total)&&total>0)return `${message} · ${done.toLocaleString()} / ${total.toLocaleString()} bytes (${Math.min(100,done/total*100).toFixed(1)}%)`;
  return message;
}
function normalizeTitleResult(detail){return detail?.result?.result||detail?.result||detail||null;}
function inspectTitleStarted(detail={}){
  const outer=detail.result||{},result=normalizeTitleResult(detail);if(!result)return;
  if(result.preparedBytes||result.headerSize){completeBefore('xex');setStage('xex','ok',`Retail XEX prepared · ${(Number(result.preparedBytes||0)/1048576).toFixed(2)} MB`);}
  if(result.entry){completeBefore('pe');setStage('pe','ok',`Mapped entry ${fmtHex(result.entry)} · HIR ${Number(result.hir||0).toLocaleString()}`);}
  const funcs=Number(result.translatedFunctionCount||outer.persistentCpu?.functionCount||0);if(funcs||result.executionStatus){completeBefore('ppc');setStage('ppc','ok',`${funcs.toLocaleString()} translated functions · ${Number(result.executionInstructions||0).toLocaleString()} entry instructions`);}
  const reg=result.kernelRegistration,imports=Number(result.kernelImportCount||result.kernelImports?.plan?.length||0),calls=Number(result.kernelCalls||0);
  if(reg?.available||imports||calls){setStage('kernel',result.reachedKernelBlocker?'blocked':'active',`${imports.toLocaleString()} imports · ${Number(reg?.registered||0).toLocaleString()} registered · ${calls.toLocaleString()} calls`);}
  if(result.firstKernelBlocker&&!result.reachedKernelBlocker)addLog('warn',`First unresolved imported service: ${blockerSummary(result.firstKernelBlocker)}`,{source:'kernel-plan',stage:'kernel',data:result.firstKernelBlocker});
  if(result.reachedKernelBlocker){markBlocked(result.reachedKernelBlocker,'kernel');return;}
  const cpuBlock=outer.schedulerBlocker||outer.persistentCpu?.blocker;if(cpuBlock){markBlocked(cpuBlock,'scheduler');return;}
  const gpu=outer.gpuTraffic||result.titleGpuTelemetry||result.browserHleTelemetry;
  if(gpu?.lastOpcode!==undefined&&gpu.ready&&!gpu.submitted){markBlocked(gpu,'xenos');return;}
  if(gpu?.submitted||gpu?.ringInitialized){setStage('gpu','active',gpu.submitted?`${Number(gpu.packets||0).toLocaleString()} PM4 packets · ${Number(gpu.draws||0).toLocaleString()} draws · ${Number(gpu.swaps||0).toLocaleString()} swaps`:'Xenos ring initialized');}
  addLog('ok',`Title handoff entered runtime · boundary ${result.runtimeBoundary||'running'} · entry ${result.entry?fmtHex(result.entry):'unknown'}`,{source:'title',stage:'ppc',data:summarizeResult(result,outer),force:true});
}
function summarizeResult(result={},outer={}){
  return {entry:result.entry||0,preparedBytes:result.preparedBytes||0,translatedFunctionCount:result.translatedFunctionCount||0,runtimeBoundary:result.runtimeBoundary||null,kernelImportCount:result.kernelImportCount||0,kernelRegistration:result.kernelRegistration||null,kernelCalls:result.kernelCalls||0,firstKernelBlocker:result.firstKernelBlocker||null,reachedKernelBlocker:result.reachedKernelBlocker||null,persistentCpu:outer.persistentCpu||null,gpuTraffic:summarizeGpu(outer.gpuTraffic)};
}
function summarizeGpu(gpu){if(!gpu)return null;return {submitted:gpu.submitted,ready:gpu.ready,packets:gpu.packets,draws:gpu.draws,swaps:gpu.swaps,shaderLoads:gpu.shaderLoads,lastOpcode:gpu.lastOpcode,lastFaultWord:gpu.lastFaultWord,xenosStatus:gpu.xenosStatus,realTitleFrameReady:gpu.realTitleFrameReady,reason:gpu.reason};}
function inspectTelemetry(detail={}){
  if(detail.blocker){markBlocked(detail.blocker,'telemetry');return;}
  const pm4=Number(detail.pm4Packets||0),draws=Number(detail.draws||0),swaps=Number(detail.swaps||0);
  if(pm4||draws||swaps){completeBefore('gpu');setStage('gpu',detail.realFrame?'ok':'active',`${pm4.toLocaleString()} PM4 · ${draws.toLocaleString()} draws · ${swaps.toLocaleString()} swaps${detail.realFrame?' · real frame':''}`);}
  if(detail.realFrame){lastBlocker=null;setBlockedBadge(false);}
}
function captureRuntimeEvent(type,detail){
  if(type==='bootStage')return mapBootStage(detail);
  if(type==='runtimeBlocker')return markBlocked(detail,'runtime');
  if(type==='fatalError')return markBlocked(detail,'fatal');
  if(type==='titleStarted')return inspectTitleStarted(detail);
  if(type==='telemetry')return inspectTelemetry(detail);
  if(type==='ready'){const c=detail.contract||{};setStage('source','ok',`Core V${c.loadedCoreBuild??detail.buildVersion??'?'} · ABI ${c.loadedAbi!==undefined?fmtHex(c.loadedAbi):'?'} · ${c.coreSource||'core'} · STFS ${c.stfsExtraction||'unknown'}`);addLog('ok',stageState.get('source').detail,{source:'runtime',stage:'source',data:c,force:true});return;}
  if(type==='log')return addLog(detail.level,detail.message,{source:'runtime-log',stage:lastStageKey,data:detail});
  if(type==='framePresented'){setStage('gpu','ok',`Real title frame presented · generation ${detail.generation??'?'}`);lastBlocker=null;setBlockedBadge(false);addLog('ok',`Frame presented · generation ${detail.generation??'?'}${detail.hash?` · hash ${detail.hash}`:''}`,{source:'frame',stage:'gpu'});}
}
function installRuntimeListeners(){
  for(const type of ['bootStage','runtimeBlocker','fatalError','titleStarted','telemetry','ready','log','framePresented','workerTelemetry'])globalThis.addEventListener(`render360:${type}`,event=>captureRuntimeEvent(type,event.detail||{}));
}
function installBrowserErrorCapture(){
  globalThis.addEventListener('error',event=>{const where=event.filename?`${event.filename.split('/').pop()}:${event.lineno||0}:${event.colno||0}`:'browser';addLog('error',`${event.message||'Browser error'} · ${where}`,{source:'window.error',stage:lastStageKey,data:{filename:event.filename,lineno:event.lineno,colno:event.colno}});markBlocked({kind:'browser-error',message:event.message||'Browser error'},'browser');});
  globalThis.addEventListener('unhandledrejection',event=>{const reason=event.reason instanceof Error?`${event.reason.name}: ${event.reason.message}`:argText(event.reason);addLog('error',`Unhandled promise rejection · ${reason}`,{source:'unhandledrejection',stage:lastStageKey});markBlocked({kind:'promise-rejection',message:reason},'browser');});
}
function installConsoleCapture(){
  for(const name of ['log','info','warn','error']){
    const original=console[name]?.bind(console);if(!original||original.__render360Wrapped)continue;
    const wrapped=(...args)=>{original(...args);const text=args.map(argText).join(' ');if(/^R360_HIR\s+block=/i.test(text))return;if(/Render360|R360|Xenia|Xenos|STFS|XEX|PM4/i.test(text)||name==='warn'||name==='error')addLog(name==='log'?'info':name,text,{source:`console.${name}`,stage:lastStageKey});};
    wrapped.__render360Wrapped=true;console[name]=wrapped;
  }
}
function css(){return `
#r360DevConsole{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);display:flex;align-items:flex-end;justify-content:center;padding:env(safe-area-inset-top) 0 0}
#r360DevConsole.hidden{display:none!important}.r360-dev-panel{width:min(100%,860px);height:min(92dvh,900px);background:#0a0b0d;color:#f5f5f7;border:1px solid rgba(255,255,255,.14);border-radius:26px 26px 0 0;box-shadow:0 -24px 80px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
.r360-dev-header{display:flex;align-items:center;gap:10px;padding:14px 15px 12px;border-bottom:1px solid rgba(255,255,255,.1);background:rgba(20,21,24,.96)}.r360-dev-title{min-width:0;flex:1}.r360-dev-title b{display:block;font-size:17px}.r360-dev-title span{display:block;color:#8e8e93;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.r360-dev-iconbtn{border:0;background:#25262a;color:#fff;border-radius:12px;min-width:42px;height:42px;padding:0 12px;font-weight:700;font-size:13px}.r360-dev-close{font-size:22px;font-weight:400}
.r360-dev-scroll{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px 12px calc(18px + env(safe-area-inset-bottom))}.r360-blocker{border:1px solid rgba(255,69,58,.32);background:rgba(255,69,58,.10);border-radius:15px;padding:11px 12px;margin-bottom:12px}.r360-blocker.hidden{display:none}.r360-blocker-label{font-size:10px;color:#ff6961;font-weight:800;letter-spacing:.08em}.r360-blocker-text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.45;margin-top:5px;word-break:break-word}.r360-blocker-hint{color:#9b9ba1;font-size:10px;margin-top:6px}
.r360-pipeline{display:grid;grid-template-columns:repeat(7,minmax(90px,1fr));gap:7px;overflow-x:auto;padding-bottom:4px;margin-bottom:12px}.r360-stage{min-width:105px;border:1px solid rgba(255,255,255,.09);background:#141519;border-radius:13px;padding:9px}.r360-stage-head{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:800}.r360-stage-dot{width:8px;height:8px;border-radius:50%;background:#48484a;flex:none}.r360-stage.active .r360-stage-dot{background:#0a84ff;box-shadow:0 0 0 4px rgba(10,132,255,.12)}.r360-stage.ok .r360-stage-dot{background:#30d158}.r360-stage.blocked .r360-stage-dot{background:#ff453a;box-shadow:0 0 0 4px rgba(255,69,58,.12)}.r360-stage-detail{color:#8e8e93;font-size:9px;line-height:1.35;margin-top:5px;max-height:38px;overflow:hidden}.r360-stage.active .r360-stage-detail{color:#b8d9ff}.r360-stage.blocked .r360-stage-detail{color:#ff9b96}
.r360-console-toolbar{display:flex;align-items:center;gap:7px;margin-bottom:8px;position:sticky;top:-12px;z-index:3;padding:8px 0;background:linear-gradient(#0a0b0d 78%,transparent)}.r360-filter{border:0;border-radius:999px;padding:7px 11px;background:#1c1d21;color:#a8a8ad;font-size:11px;font-weight:700}.r360-filter.active{background:#fff;color:#000}.r360-log-count{margin-left:auto;color:#777;font-size:10px}.r360-log{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#050607;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden}.r360-log-row{display:grid;grid-template-columns:64px 44px minmax(0,1fr);gap:8px;padding:7px 9px;border-bottom:1px solid rgba(255,255,255,.055);font-size:10px;line-height:1.5}.r360-log-row:last-child{border-bottom:0}.r360-log-time{color:#69696f}.r360-log-level{font-weight:800}.r360-log-row.info .r360-log-level{color:#64d2ff}.r360-log-row.ok .r360-log-level{color:#30d158}.r360-log-row.warn .r360-log-level{color:#ffd60a}.r360-log-row.error .r360-log-level{color:#ff453a}.r360-log-message{white-space:pre-wrap;word-break:break-word;color:#d1d1d6}.r360-empty-log{padding:24px;text-align:center;color:#636366;font:12px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
.r360-console-fab{position:absolute;z-index:80;right:max(12px,env(safe-area-inset-right));top:max(12px,env(safe-area-inset-top));height:42px;min-width:48px;border:1px solid rgba(255,255,255,.18);border-radius:15px;background:rgba(14,14,16,.62);color:#fff;-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 12px;box-shadow:0 8px 26px rgba(0,0,0,.25)}.r360-console-fab.blocked{border-color:rgba(255,69,58,.65);background:rgba(90,14,12,.72)}.r360-console-fab .badge{display:none;position:absolute;right:-3px;top:-3px;width:10px;height:10px;border-radius:50%;background:#ff453a;box-shadow:0 0 0 2px #000}.r360-console-fab.blocked .badge{display:block}.r360-dev-row .console-mark{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#0a84ff}
@media(max-width:600px){.r360-dev-panel{height:94dvh}.r360-pipeline{grid-template-columns:repeat(7,118px)}.r360-log-row{grid-template-columns:56px 40px minmax(0,1fr);gap:6px;padding:7px;font-size:9.5px}}
:root[data-theme="light"] #r360DevConsole{background:rgba(120,120,128,.38)}:root[data-theme="light"] .r360-dev-panel{background:#f2f2f7;color:#111}:root[data-theme="light"] .r360-dev-header{background:rgba(250,250,252,.96);border-color:rgba(0,0,0,.08)}:root[data-theme="light"] .r360-dev-iconbtn{background:#e5e5ea;color:#111}:root[data-theme="light"] .r360-stage{background:#fff;border-color:rgba(0,0,0,.08)}:root[data-theme="light"] .r360-log{background:#fff;border-color:rgba(0,0,0,.08)}:root[data-theme="light"] .r360-log-row{border-color:rgba(0,0,0,.055)}:root[data-theme="light"] .r360-log-message{color:#2c2c2e}:root[data-theme="light"] .r360-console-toolbar{background:linear-gradient(#f2f2f7 78%,transparent)}
`;}
function ensureUi(){
  if(!$('r360DevConsoleStyle')){const style=document.createElement('style');style.id='r360DevConsoleStyle';style.textContent=css();document.head.appendChild(style);}
  if(!$('r360DevConsole')){
    const root=document.createElement('section');root.id='r360DevConsole';root.className='hidden';root.setAttribute('aria-label','Render360 Developer Console');root.innerHTML=`<div class="r360-dev-panel"><div class="r360-dev-header"><div class="r360-dev-title"><b>Developer Console</b><span id="r360DevSubtitle">Render360 V${RELEASE} · waiting for runtime</span></div><button id="r360DevCopy" class="r360-dev-iconbtn" type="button">Copy</button><button id="r360DevShare" class="r360-dev-iconbtn" type="button">Share</button><button id="r360DevClose" class="r360-dev-iconbtn r360-dev-close" type="button" aria-label="Close">×</button></div><div class="r360-dev-scroll"><div id="r360DevBlocker" class="r360-blocker hidden"><div class="r360-blocker-label">CURRENT BLOCKER</div><div id="r360DevBlockerText" class="r360-blocker-text"></div><div id="r360DevBlockerHint" class="r360-blocker-hint"></div></div><div id="r360DevPipeline" class="r360-pipeline"></div><div class="r360-console-toolbar"><button class="r360-filter active" data-r360-filter="all" type="button">All</button><button class="r360-filter" data-r360-filter="warn" type="button">Warnings</button><button class="r360-filter" data-r360-filter="error" type="button">Errors</button><button id="r360DevClear" class="r360-filter" type="button">Clear</button><span id="r360DevCount" class="r360-log-count">0 events</span></div><div id="r360DevLog" class="r360-log"></div></div></div>`;document.body.appendChild(root);
    root.addEventListener('click',event=>{if(event.target===root)closeConsole();});$('r360DevClose').addEventListener('click',closeConsole);$('r360DevCopy').addEventListener('click',copyReport);$('r360DevShare').addEventListener('click',shareReport);$('r360DevClear').addEventListener('click',()=>{entries.length=0;renderLogTail();renderHeader();});document.querySelectorAll('[data-r360-filter]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-r360-filter]').forEach(b=>b.classList.remove('active'));button.classList.add('active');renderLogTail(button.dataset.r360Filter);}));
  }
  installEntryPoints();renderPipeline();renderLogTail();updateBlockerCard();renderHeader();
}
function installEntryPoints(){
  const runtimeStage=document.querySelector('.runtime-stage');if(runtimeStage&&!$('r360RuntimeConsole')){const button=document.createElement('button');button.id='r360RuntimeConsole';button.className='r360-console-fab';button.type='button';button.innerHTML='&gt;_<span class="badge"></span>';button.setAttribute('aria-label','Open developer console');button.addEventListener('click',openConsole);runtimeStage.appendChild(button);}
  const makeRow=id=>{if($(id))return null;const b=document.createElement('button');b.id=id;b.type='button';b.className='row row-button r360-dev-row';b.innerHTML='<span>Developer Console</span><span class="console-mark">&gt;_</span>';b.addEventListener('click',openConsole);return b;};
  const detailAnchor=$('diagnosticsButton');if(detailAnchor&&!$('developerConsoleButton'))detailAnchor.after(makeRow('developerConsoleButton'));
  const appAnchor=$('appDiagnosticsButton');if(appAnchor&&!$('appDeveloperConsoleButton'))appAnchor.after(makeRow('appDeveloperConsoleButton'));
}
function renderPipeline(){const root=$('r360DevPipeline');if(!root)return;root.innerHTML='';for(const [key] of PIPELINE){const s=stageState.get(key),card=document.createElement('div');card.className=`r360-stage ${s.state}`;card.innerHTML=`<div class="r360-stage-head"><span class="r360-stage-dot"></span><span>${s.label}</span></div><div class="r360-stage-detail"></div>`;card.querySelector('.r360-stage-detail').textContent=s.detail;root.appendChild(card);}}
function renderLogTail(filter=null){const root=$('r360DevLog');if(!root)return;const active=filter||document.querySelector('[data-r360-filter].active')?.dataset.r360Filter||'all';const filtered=entries.filter(e=>active==='all'||active==='warn'?(e.level==='warn'||e.level==='error'):e.level==='error');const slice=filtered.slice(-350);root.innerHTML='';if(!slice.length){root.innerHTML='<div class="r360-empty-log">No matching runtime events yet.</div>';return;}for(const entry of slice){const row=document.createElement('div');row.className=`r360-log-row ${entry.level}`;row.innerHTML='<span class="r360-log-time"></span><span class="r360-log-level"></span><span class="r360-log-message"></span>';row.children[0].textContent=new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});row.children[1].textContent=entry.level.toUpperCase();row.children[2].textContent=`${entry.stage?`[${entry.stage}] `:''}${entry.message}`;root.appendChild(row);}if(opened)requestAnimationFrame(()=>{const scroll=root.closest('.r360-dev-scroll');if(scroll)scroll.scrollTop=scroll.scrollHeight;});}
function renderHeader(){const sub=$('r360DevSubtitle');if(sub){const contract=globalThis.render360DeveloperConsole?.contract||null;sub.textContent=`Render360 V${RELEASE} · ${lastBlocker?'BLOCKED':stageState.get('gpu').state==='ok'?'FRAME LIVE':stageState.get(lastStageKey)?.detail||'waiting'} · ${entries.length} events`;}$('r360DevCount')&&($('r360DevCount').textContent=`${entries.length} events`);}
function updateBlockerCard(){const card=$('r360DevBlocker');if(!card)return;if(!lastBlocker){card.classList.add('hidden');return;}card.classList.remove('hidden');$('r360DevBlockerText').textContent=lastBlocker.summary;const b=lastBlocker.raw?.blocker||lastBlocker.raw||{};let hint=`Last successful boundary: ${stageState.get(lastStageKey)?.label||lastStageKey}.`;
  if(b.module&&b.ordinal!==undefined)hint+=` Xenia lookup target: ${b.module} ordinal 0x${(Number(b.ordinal)>>>0).toString(16).toUpperCase()}.`;
  else if(b.lastOpcode!==undefined)hint+=` Xenia/Xenos target: PM4 opcode 0x${(Number(b.lastOpcode)>>>0).toString(16).toUpperCase()}.`;
  $('r360DevBlockerHint').textContent=hint;
}
function setBlockedBadge(blocked){$('r360RuntimeConsole')?.classList.toggle('blocked',!!blocked);}
function runtimeSnapshot(){const state=globalThis.render360ModernTitle||null;return state?{fileName:state.fileName,inputKind:state.inputKind,result:summarizeResult(state.result||{},state),persistentCpu:state.persistentCpu||null,scheduler:state.threadScheduler?.inspect?.()??null,schedulerBlocker:state.schedulerBlocker||null,gpuTraffic:summarizeGpu(state.gpuTraffic),shaderRuntime:state.shaderRuntime?{available:state.shaderRuntime.available,bothExecuted:state.shaderRuntime.bothExecuted,bothSpirvTranslated:state.shaderRuntime.bothSpirvTranslated,error:state.shaderRuntime.error}:null,shaderWebGPU:state.shaderWebGPU?{available:state.shaderWebGPU.available,bothAccepted:state.shaderWebGPU.bothAccepted,reason:state.shaderWebGPU.reason}:null,frontbuffer:state.frontbufferFrame?{captured:state.frontbufferFrame.captured,realTitleFrameReady:state.frontbufferFrame.realTitleFrameReady,width:state.frontbufferFrame.width,height:state.frontbufferFrame.height,format:state.frontbufferFrame.format,reason:state.frontbufferFrame.reason}:null}:null;}
function buildReport(){return {generatedAt:new Date().toISOString(),render360Release:RELEASE,page:location.href,state:document.body.dataset.state||null,pipeline:Object.fromEntries([...stageState].map(([key,v])=>[key,{state:v.state,detail:v.detail,at:v.at?new Date(v.at).toISOString():null}])),blocker:lastBlocker?{stage:lastBlocker.stage,summary:lastBlocker.summary,raw:lastBlocker.raw}:null,runtime:runtimeSnapshot(),logs:entries.slice(-500).map(e=>({time:new Date(e.at).toISOString(),level:e.level,source:e.source,stage:e.stage,message:e.message,data:e.data||undefined}))};}
async function copyReport(){const text=safeJson(buildReport(),2);try{await navigator.clipboard.writeText(text);addLog('ok','Developer report copied to clipboard',{source:'console'});$('r360DevCopy').textContent='Copied';setTimeout(()=>{$('r360DevCopy')&&($('r360DevCopy').textContent='Copy');},1200);}catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();}}
async function shareReport(){const text=safeJson(buildReport(),2);if(navigator.share){try{await navigator.share({title:'Render360 Developer Report',text});return;}catch(error){if(error?.name==='AbortError')return;}}await copyReport();}
function openConsole(){ensureUi();opened=true;$('r360DevConsole').classList.remove('hidden');renderLogTail();requestAnimationFrame(()=>{const scroll=document.querySelector('#r360DevConsole .r360-dev-scroll');if(scroll)scroll.scrollTop=scroll.scrollHeight;});}
function closeConsole(){opened=false;$('r360DevConsole')?.classList.add('hidden');}
function boot(){ensureUi();installRuntimeListeners();installBrowserErrorCapture();installConsoleCapture();addLog('info',`Render360 V${RELEASE} developer console armed`,{source:'console',stage:'source',force:true});const observer=new MutationObserver(installEntryPoints);observer.observe(document.body,{childList:true,subtree:true});globalThis.render360DeveloperConsole={release:RELEASE,open:openConsole,close:closeConsole,clear:()=>{entries.length=0;renderLogTail();},report:buildReport,entries,stages:stageState,set contract(value){this._contract=value;},get contract(){return this._contract||null;}};}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
