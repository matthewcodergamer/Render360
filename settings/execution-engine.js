import {Render360Runtime} from '../runtime/render360-runtime.js';
import {probeRecompiledTitle,runRecompiledTitle,requestedExecutionMode,recompiledTitleIdHex} from '../runtime/recompiled-title-runtime.js';
import {loadTitleProfile,saveTitleProfile} from '../profiles/title-profile-store.js';

const SETTINGS_KEY='render360.settings.v44';
const MODES=new Set(['auto','emulator','recompiled']);
const normalize=value=>MODES.has(String(value))?String(value):'auto';
const readGlobal=()=>{try{return JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')||{};}catch{return {};}};
const currentGlobalMode=()=>normalize(readGlobal().preferredExecutionMode||globalThis.render360ExecutionModePreference||'auto');
function publishGlobalMode(mode){const next=normalize(mode);globalThis.render360ExecutionModePreference=next;return next;}
function writeGlobalMode(mode){const settings=readGlobal();settings.preferredExecutionMode=publishGlobalMode(mode);localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));globalThis.dispatchEvent(new CustomEvent('render360:executionModeChanged',{detail:{mode:settings.preferredExecutionMode,scope:'global'}}));return settings.preferredExecutionMode;}
publishGlobalMode(currentGlobalMode());

function installRuntimeRouter(){
  const proto=Render360Runtime.prototype;
  if(proto.__r360ExecutionRouterInstalled)return;
  Object.defineProperty(proto,'__r360ExecutionRouterInstalled',{value:true});
  const originalPlay=proto.play,originalPause=proto.pause,originalResume=proto.resume,originalContract=proto.contract;
  proto.contract=function(){const base=originalContract.call(this);return {...base,executionEngines:{auto:true,emulator:true,recompiledWasm:true,manifestSchema:'render360-recompiled-title-v1'}};};
  proto.play=async function(game,file=this.getSource(game?.id),config={}){
    const mode=requestedExecutionMode(config);
    if(mode==='emulator')return originalPlay.call(this,game,file,{...config,executionMode:'emulator'});
    const probe=await probeRecompiledTitle(game);
    if(!probe.available){
      if(mode==='recompiled'){
        const detail={stage:'blocked',kind:'recompiled-title-missing',engine:'recompiled',message:`No Recompiled WebAssembly build is installed for Title ID ${recompiledTitleIdHex(game?.titleId)}. Add recompiled/${recompiledTitleIdHex(game?.titleId)}/manifest.json or choose Xbox 360 Emulator.`,titleId:Number(game?.titleId||0)>>>0,reason:probe.reason};
        this.emit('runtimeBlocker',detail);throw new Error(detail.message);
      }
      this.emit('bootStage',{stage:'execution-engine',engine:'emulator',message:`Execution Engine · Xbox 360 Emulator (no recompiled build for ${recompiledTitleIdHex(game?.titleId)})`});
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
function makeRow(title,description,select){const row=document.createElement('div');row.className='row';const copy=document.createElement('div');copy.className='setting-copy';const name=document.createElement('span');name.textContent=title;const small=document.createElement('small');small.textContent=description;copy.append(name,small);const tail=document.createElement('div');tail.className='setting-tail';const badge=document.createElement('span');badge.className='capability live';badge.textContent='Live router';tail.append(select,badge);row.append(copy,tail);return row;}

function installGlobalControl(){
  if(document.getElementById('appExecutionMode'))return;
  const renderer=document.getElementById('appRenderer'),anchor=renderer?.closest('.row'),group=anchor?.parentElement;if(!anchor||!group)return;
  const select=makeSelect('appExecutionMode',false),row=makeRow('Execution Engine','CPU path: general Xbox 360 emulation or a title-specific ahead-of-time WebAssembly build.',select);group.insertBefore(row,anchor);
  select.value=currentGlobalMode();select.addEventListener('change',()=>writeGlobalMode(select.value));
  document.getElementById('settingsButton')?.addEventListener('click',()=>{select.value=currentGlobalMode();});
  document.getElementById('resetAppSettings')?.addEventListener('click',()=>setTimeout(()=>{publishGlobalMode('auto');select.value='auto';},0));
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
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installUi,{once:true});else installUi();
setTimeout(installUi,0);
