import {Render360Runtime} from '../runtime/render360-runtime.js';
import {loadRender360Bootstrap} from '../render360-browser-title-runtime.mjs';
import {probeRecompiledTitle,runRecompiledTitle,requestedExecutionMode,recompiledTitleIdHex} from '../runtime/recompiled-title-runtime.js';
import {loadTitleProfile,saveTitleProfile} from '../profiles/title-profile-store.js';
import {installPcRecompiledRouter} from '../runtime/pc-recompiled-runtime.js';
import '../runtime/pc-recompiled-ui.js';

const SETTINGS_KEY='render360.settings.v44';
const MODES=new Set(['auto','emulator','recompiled']);
const MEMORY_RESERVES_MB=new Set([0,96,128,160,192,256,384,512]);
const WASM_PAGE_BYTES=65536;
const MIB=1024*1024;
const normalize=value=>MODES.has(String(value))?String(value):'auto';
const normalizeMemory=value=>{const mb=Number(value);return MEMORY_RESERVES_MB.has(mb)?mb:0;};
const readGlobal=()=>{try{return JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')||{};}catch{return {};}};
const currentGlobalMode=()=>normalize(readGlobal().preferredExecutionMode||globalThis.render360ExecutionModePreference||'auto');
const currentGlobalMemory=()=>normalizeMemory(globalThis.render360MemoryReserveMb??readGlobal().wasmMemoryReserveMb??0);
function publishGlobalMode(mode){const next=normalize(mode);globalThis.render360ExecutionModePreference=next;return next;}
function publishGlobalMemory(mb){const next=normalizeMemory(mb);globalThis.render360MemoryReserveMb=next;return next;}
function writeGlobalMode(mode){const settings=readGlobal();settings.preferredExecutionMode=publishGlobalMode(mode);localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));globalThis.dispatchEvent(new CustomEvent('render360:executionModeChanged',{detail:{mode:settings.preferredExecutionMode,scope:'global'}}));return settings.preferredExecutionMode;}
function writeGlobalMemory(mb){const settings=readGlobal();settings.wasmMemoryReserveMb=publishGlobalMemory(mb);localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));globalThis.dispatchEvent(new CustomEvent('render360:memoryReserveChanged',{detail:{memoryReserveMb:settings.wasmMemoryReserveMb,scope:'global'}}));return settings.wasmMemoryReserveMb;}
publishGlobalMode(currentGlobalMode());
publishGlobalMemory(currentGlobalMemory());

function isIosLike(){const nav=globalThis.navigator;const ua=String(nav?.userAgent||'');return /iPad|iPhone|iPod/i.test(ua)||(nav?.platform==='MacIntel'&&Number(nav?.maxTouchPoints||0)>1);}
function isMobileLike(){const nav=globalThis.navigator;return isIosLike()||/Android|Mobile/i.test(String(nav?.userAgent||''));}
function safeMemoryCeilingMb(){
  const nav=globalThis.navigator;
  const deviceMemory=Number(nav?.deviceMemory||0);
  if(isMobileLike()||deviceMemory&&deviceMemory<=4)return 256;
  if(deviceMemory&&deviceMemory<=8)return 384;
  return 512;
}
function memoryReport({requestedMb=0,targetMb=0,beforeBytes=0,afterBytes=0,clamped=false,error=null,status='auto'}={}){
  return {requestedMb,targetMb,beforeBytes,afterBytes,clamped,status,error:error?String(error?.message||error):null,deviceClass:isIosLike()?'ios':isMobileLike()?'mobile':'desktop'};
}
async function ensureEmulatorMemoryReserve(runtime){
  const requestedMb=currentGlobalMemory();
  if(!requestedMb){const report=memoryReport({status:'auto'});globalThis.render360WasmMemoryReserve=report;return report;}
  let bootstrap;
  try{bootstrap=await loadRender360Bootstrap();}
  catch(error){const report=memoryReport({requestedMb,targetMb:requestedMb,status:'bootstrap-failed',error});globalThis.render360WasmMemoryReserve=report;runtime?.emit?.('log',{level:'warn',message:`WASM memory reserve skipped: ${report.error}`});return report;}
  const memory=bootstrap?.exports?.memory;
  if(!(memory instanceof WebAssembly.Memory)){const report=memoryReport({requestedMb,targetMb:requestedMb,status:'memory-unavailable',error:'bootstrap memory export unavailable'});globalThis.render360WasmMemoryReserve=report;return report;}
  const beforeBytes=memory.buffer.byteLength;
  const ceilingMb=safeMemoryCeilingMb();
  const targetMb=Math.min(requestedMb,ceilingMb);
  const targetBytes=targetMb*MIB;
  let afterBytes=beforeBytes,error=null;
  if(targetBytes>afterBytes){
    // Grow in bounded 16 MiB steps. A rejected growth is caught and launch
    // continues with the memory already available instead of intentionally
    // turning a user preference into a fatal emulator boot error.
    while(afterBytes<targetBytes){
      const stepBytes=Math.min(16*MIB,targetBytes-afterBytes);
      const pages=Math.max(1,Math.ceil(stepBytes/WASM_PAGE_BYTES));
      try{memory.grow(pages);afterBytes=memory.buffer.byteLength;}
      catch(growError){error=growError;afterBytes=memory.buffer.byteLength;break;}
    }
  }
  const clamped=targetMb!==requestedMb;
  const reached=afterBytes>=targetBytes;
  const status=error?'partial':reached?'reserved':'unchanged';
  const report=memoryReport({requestedMb,targetMb,beforeBytes,afterBytes,clamped,error,status});
  globalThis.render360WasmMemoryReserve=report;
  const before=(beforeBytes/MIB).toFixed(1),after=(afterBytes/MIB).toFixed(1);
  const clampText=clamped?` · safety cap ${targetMb} MB`:'';
  runtime?.emit?.('bootStage',{stage:'memory',message:`WASM memory reserve · ${before} → ${after} MB${clampText}`,memoryReserve:report});
  if(error)runtime?.emit?.('log',{level:'warn',message:`Requested ${requestedMb} MB WASM reserve; browser stopped growth at ${after} MB (${report.error}). Continuing without failing the page.`});
  else if(clamped)runtime?.emit?.('log',{level:'warn',message:`Requested ${requestedMb} MB WASM reserve was capped at ${targetMb} MB for this ${report.deviceClass} device.`});
  return report;
}

function installRuntimeRouter(){
  const proto=Render360Runtime.prototype;
  if(proto.__r360ExecutionRouterInstalled)return;
  Object.defineProperty(proto,'__r360ExecutionRouterInstalled',{value:true});
  const originalPlay=proto.play,originalPause=proto.pause,originalResume=proto.resume,originalContract=proto.contract;
  proto.contract=function(){const base=originalContract.call(this);return {...base,executionEngines:{auto:true,emulator:true,recompiledWasm:true,manifestSchema:'render360-recompiled-title-v1'},wasmMemoryReserve:{presetsMb:[...MEMORY_RESERVES_MB],autoOnDemand:true,mobileSafetyCapMb:256,desktopCeilingMb:512}};};
  proto.play=async function(game,file=this.getSource(game?.id),config={}){
    const mode=requestedExecutionMode(config);
    if(mode==='emulator'){await ensureEmulatorMemoryReserve(this);return originalPlay.call(this,game,file,{...config,executionMode:'emulator'});}
    const probe=await probeRecompiledTitle(game);
    if(!probe.available){
      if(mode==='recompiled'){
        const detail={stage:'blocked',kind:'recompiled-title-missing',engine:'recompiled',message:`No Recompiled WebAssembly build is installed for Title ID ${recompiledTitleIdHex(game?.titleId)}. Add recompiled/${recompiledTitleIdHex(game?.titleId)}/manifest.json or choose Xbox 360 Emulator.`,titleId:Number(game?.titleId||0)>>>0,reason:probe.reason};
        this.emit('runtimeBlocker',detail);throw new Error(detail.message);
      }
      this.emit('bootStage',{stage:'execution-engine',engine:'emulator',message:`Execution Engine · Xbox 360 Emulator (no recompiled build for ${recompiledTitleIdHex(game?.titleId)})`});
      await ensureEmulatorMemoryReserve(this);
      return originalPlay.call(this,game,file,{...config,executionMode:'emulator'});
    }
    if(!file)throw new Error('The original game file is not linked. Choose it again or enable persistent Game Storage.');
    if(!this.ready||!this.core)throw new Error('Render360 core is still loading');
    this.currentGame=game;this.bindSource(game.id,file);this.resetTelemetry();this.backend='RECOMPILED WASM';
    const type=String(game.sourceType||'game').toLowerCase();
    this.inputHost.setSession({kind:type==='iso'?1:type==='xex'?2:3,stage:5,titleId:game.titleId||0});
    this.emit('bootStage',{stage:'execution-engine',engine:'recompiled',message:`Execution Engine · Recompiled WebAssembly · ${probe.titleIdHex}`,type,fileName:file.name||'',fileSize:file.size||0,titleId:game.titleId||0,mediaId:game.mediaId||0});
    try{const result=await runRecompiledTitle({runtime:this,game,file,config:{...config,executionMode:'recompiled'},probe});this.emit('titleStarted',{game,result,type,config:{...config,executionMode:'recompiled'},executionEngine:'recompiled'});return result;}
    catch(error){this.emit('fatalError',{message:error?.message||String(error),error,type,executionEngine:'recompiled'});throw error;}
  };
  proto.pause=function(){if(this.recompiledSession){const value=typeof this.recompiledSession.pause==='function'?this.recompiledSession.pause():true;this.inputHost.pause();this.emit('paused',{executionEngine:'recompiled',titlePaused:value!==false});return value!==false;}return originalPause.call(this);};
  proto.resume=function(){if(this.recompiledSession){const value=typeof this.recompiledSession.resume==='function'?this.recompiledSession.resume():true;this.inputHost.resume();this.emit('resumed',{executionEngine:'recompiled',titleResumed:value!==false});return value!==false;}return originalResume.call(this);};
}

function option(value,label){const el=document.createElement('option');el.value=value;el.textContent=label;return el;}
function makeSelect(id,perTitle=false){const select=document.createElement('select');select.id=id;select.className='settings-select';if(perTitle)select.append(option('inherit','Use Global'));select.append(option('auto','Auto · Recompiled if available'));select.append(option('emulator','Xbox 360 Emulator'));select.append(option('recompiled','Recompiled WebAssembly'));return select;}
function makeMemorySelect(){
  const select=document.createElement('select');select.id='appMemoryReserve';select.className='settings-select';
  select.append(option('0','Auto · grow on demand'));
  for(const [mb,label] of [[96,'96 MB'],[128,'128 MB'],[160,'160 MB'],[192,'192 MB'],[256,'256 MB · high on mobile'],[384,'384 MB · desktop only'],[512,'512 MB · desktop only']]){
    const item=option(String(mb),label);if(isIosLike()&&mb>256)item.disabled=true;select.append(item);
  }
  return select;
}
function makeRow(title,description,select,badgeText='Live router'){const row=document.createElement('div');row.className='row';const copy=document.createElement('div');copy.className='setting-copy';const name=document.createElement('span');name.textContent=title;const small=document.createElement('small');small.textContent=description;copy.append(name,small);const tail=document.createElement('div');tail.className='setting-tail';const badge=document.createElement('span');badge.className='capability live';badge.textContent=badgeText;tail.append(select,badge);row.append(copy,tail);return row;}

function installGlobalControl(){
  const renderer=document.getElementById('appRenderer'),anchor=renderer?.closest('.row'),group=anchor?.parentElement;if(!anchor||!group)return;
  if(!document.getElementById('appExecutionMode')){
    const select=makeSelect('appExecutionMode',false),row=makeRow('Execution Engine','CPU path: general Xbox 360 emulation or a title-specific ahead-of-time WebAssembly build.',select);group.insertBefore(row,anchor);
    select.value=currentGlobalMode();select.addEventListener('change',()=>writeGlobalMode(select.value));
    document.getElementById('settingsButton')?.addEventListener('click',()=>{select.value=currentGlobalMode();});
    document.getElementById('resetAppSettings')?.addEventListener('click',()=>setTimeout(()=>{publishGlobalMode('auto');select.value='auto';},0));
  }
  if(!document.getElementById('appMemoryReserve')){
    const select=makeMemorySelect(),row=makeRow('WASM Memory Reserve','Pre-grows the host WebAssembly heap before title launch. Auto grows only when needed. This is not Xbox guest RAM and it does not map missing guest pages.',select,'Safe reserve');group.insertBefore(row,anchor);
    select.value=String(currentGlobalMemory());select.addEventListener('change',()=>writeGlobalMemory(select.value));
    document.getElementById('settingsButton')?.addEventListener('click',()=>{select.value=String(currentGlobalMemory());});
    document.getElementById('resetAppSettings')?.addEventListener('click',()=>setTimeout(()=>{publishGlobalMemory(0);select.value='0';},0));
  }
}
function currentGameTitleId(){const text=document.getElementById('gameSettingsName')?.textContent||'';const match=text.match(/(?:^|·|\s)([0-9A-F]{8})\s*$/i);return match?parseInt(match[1],16)>>>0:0;}
function syncGameControl(select){const titleId=currentGameTitleId();if(!titleId){select.value='inherit';select.disabled=true;return;}select.disabled=false;select.dataset.titleId=String(titleId);select.value=loadTitleProfile({titleId}).executionMode||'inherit';}
function installGameControl(){
  if(document.getElementById('gameExecutionMode'))return;
  const scheduler=document.getElementById('gameSchedulerQuantum'),anchor=scheduler?.closest('.row'),group=anchor?.parentElement;if(!anchor||!group)return;
  const select=makeSelect('gameExecutionMode',true),row=makeRow('Execution Engine','Override the CPU execution path for this title without changing the graphics renderer.',select);group.insertBefore(row,anchor);
  select.addEventListener('change',()=>{const titleId=Number(select.dataset.titleId||currentGameTitleId())>>>0;if(!titleId)return;const profile=loadTitleProfile({titleId});profile.executionMode=select.value;saveTitleProfile({titleId},profile);globalThis.dispatchEvent(new CustomEvent('render360:executionModeChanged',{detail:{mode:select.value,scope:'title',titleId}}));});
  document.getElementById('gameSettingsButton')?.addEventListener('click',()=>setTimeout(()=>syncGameControl(select),0));
  document.getElementById('resetGameSettings')?.addEventListener('click',()=>setTimeout(()=>syncGameControl(select),0));
}
function installUi(){installGlobalControl();installGameControl();}

installRuntimeRouter();
installPcRecompiledRouter(Render360Runtime);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installUi,{once:true});else installUi();
setTimeout(installUi,0);
