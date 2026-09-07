import {detectPcGame} from './pc-content-source.js';
import {createPcWebGpuPresenter} from './pc-webgpu-presenter.js';
import {createPcControllerInput} from './pc-controller-input.js';

export const PC_RECOMPILED_TITLE_SCHEMA='render360-pc-recompiled-title-v1';
const BUILTIN_MANIFESTS=new Map([
  ['portal-1-pc','../recompiled/pc/portal/manifest.json'],
]);

function normalizeGameId(value){return String(value||'').trim().toLowerCase();}
function isPcGame(game){return String(game?.platform||'').toLowerCase()==='pc'||String(game?.sourceType||'').toLowerCase()==='pc-wasm'||Boolean(game?.pcGameId);}
function directWebGlPresenter(visibleCanvas){
  if(!visibleCanvas)throw new Error('Render360 game canvas is missing.');
  return {
    sourceCanvas:visibleCanvas,
    visibleCanvas,
    profile:'source-webgl2-direct',
    start(){return true;},
    stop(){return true;},
    descriptor(){return {profile:'source-webgl2-direct',webgpu:false,direct:true};},
  };
}

export async function probePcRecompiledTitle(game,{fetchImpl=globalThis.fetch}={}){
  const gameId=normalizeGameId(game?.pcGameId||game?.recompiledGameId);
  if(!gameId)return {available:false,gameId:null,reason:'missing-pc-game-id'};
  const relative=BUILTIN_MANIFESTS.get(gameId);if(!relative)return {available:false,gameId,reason:'pc-title-not-registered'};
  const url=new URL(relative,import.meta.url);
  let response;try{response=await fetchImpl(url,{cache:'no-store'});}catch(error){return {available:false,gameId,url:url.href,reason:'pc-manifest-network-error',error:error?.message||String(error)};}
  if(!response.ok)return {available:false,gameId,url:url.href,reason:`pc-manifest-http-${response.status}`};
  let manifest;try{manifest=await response.json();}catch(error){return {available:false,gameId,url:url.href,reason:'pc-manifest-invalid-json',error:error?.message||String(error)};}
  if(manifest?.schema!==PC_RECOMPILED_TITLE_SCHEMA)return {available:false,gameId,url:url.href,reason:'pc-manifest-schema-mismatch',manifest};
  if(normalizeGameId(manifest.gameId)!==gameId)return {available:false,gameId,url:url.href,reason:'pc-manifest-game-id-mismatch',manifest};
  if(!manifest.adapter||typeof manifest.adapter!=='string')return {available:false,gameId,url:url.href,reason:'pc-manifest-adapter-missing',manifest};
  return {available:true,gameId,url:url.href,manifest};
}

function validatePcSource(source,expectedGameId){
  if(!source||source.kind!=='pc-recompiled-source')throw new Error('PC WebAssembly launch needs the player-selected PC game folder and Render360 runtime package.');
  if(!source.content||typeof source.content.has!=='function')throw new Error('PC game content source is not linked. Choose the installed game folder again.');
  const detection=source.detection?.matched?source.detection:detectPcGame(source.content);
  if(!detection.matched)throw new Error(`The selected PC folder is not a complete supported game install (${detection.reason||'content not recognized'}).`);
  if(expectedGameId&&normalizeGameId(detection.gameId)!==normalizeGameId(expectedGameId))throw new Error(`Selected PC content is ${detection.gameId}, but this library entry expects ${expectedGameId}.`);
  if(!source.runtimePackage)throw new Error('Portal PC files are recognized, but no WebAssembly runtime package is linked. Choose the Render360 Portal runtime ZIP/folder containing render360-port.json.');
  if(normalizeGameId(source.runtimePackage.manifest?.gameId)!==normalizeGameId(expectedGameId))throw new Error(`The linked WebAssembly runtime targets ${source.runtimePackage.manifest?.gameId||'another game'}, not ${expectedGameId}.`);
  return {...source,detection};
}

function buildPcHost(runtime,game,source,config,probe,presenter,controllerInput=null){
  const state={executionEngine:'pc-recompiled',kind:'pc-webassembly-port',platform:'pc',game,gameId:probe.gameId,manifest:probe.manifest,config,persistentCpu:{kind:'native-pc-to-wasm-aot'},gpuTraffic:{reason:'presentation-pending',webgpu:null,profile:presenter.profile},controller:controllerInput?.descriptor?.()||null};
  globalThis.render360ModernTitle=state;
  return {
    runtime,core:runtime.core,game,config,manifest:probe.manifest,
    source,content:source.content,runtimePackage:source.runtimePackage,
    canvas:presenter.sourceCanvas,presentationCanvas:presenter.visibleCanvas,webgpuPresenter:presenter,inputHost:runtime.inputHost,controllerInput,state,
    emitStage(detail={}){runtime.emit('bootStage',{engine:'pc-recompiled',platform:'pc',...detail});},
    emitLog(level,message){runtime.emit('log',{level,message});},
    emitBlocker(detail={}){runtime.emit('runtimeBlocker',{engine:'pc-recompiled',platform:'pc',...detail});},
    emitFrame(detail={}){runtime.emit('framePresented',{engine:'pc-recompiled',platform:'pc',...detail});},
    setState(next={}){Object.assign(state,next);globalThis.render360ModernTitle=state;return state;},
  };
}

export async function runPcRecompiledTitle({runtime,game,source,config={},probe=null}){
  if(!runtime||!game)throw new Error('PC WebAssembly launch requires a Render360 runtime and game record.');
  const gameId=normalizeGameId(game.pcGameId||game.recompiledGameId),resolvedProbe=probe?.available?probe:await probePcRecompiledTitle(game);
  if(!resolvedProbe.available)throw new Error(`No PC WebAssembly host profile is installed for ${gameId||'this game'} (${resolvedProbe.reason||'unavailable'}).`);
  const linked=validatePcSource(source,resolvedProbe.gameId),manifestUrl=new URL(resolvedProbe.url,location.href),adapterUrl=new URL(resolvedProbe.manifest.adapter,manifestUrl);
  runtime.emit('bootStage',{stage:'pc-content',engine:'pc-recompiled',message:`PC files recognized · ${linked.detection.name}`,gameId:resolvedProbe.gameId,files:linked.content.paths?.().length||0,bytes:linked.content.size||0});
  runtime.emit('bootStage',{stage:'pc-runtime-package',engine:'pc-recompiled',message:`Render360 WebAssembly runtime · ${linked.runtimePackage.manifest.name||linked.runtimePackage.manifest.gameId}`,format:linked.runtimePackage.manifest.format});
  let presenter=null,controllerInput=null,session=null;
  try{
    const visibleCanvas=document.getElementById('gpuCanvas');
    const directRequested=String(resolvedProbe.manifest?.runtime?.renderer||'').toLowerCase()==='webgl2';
    if(directRequested){
      // Portal owns its WebGL2 OffscreenCanvas. Do not allocate a WebGPU device,
      // staging context, copy texture or frame loop that Portal will never use.
      // This saves memory on iPhone 11 and removes WebGPU as a startup dependency.
      presenter=directWebGlPresenter(visibleCanvas);
      runtime.emit('bootStage',{stage:'pc-presenter-bypass',engine:'pc-recompiled',message:'Portal direct WebGL2 renderer selected · WebGPU allocation skipped'});
    }else{
      presenter=await createPcWebGpuPresenter({visibleCanvas,emitStage:detail=>runtime.emit('bootStage',{engine:'pc-recompiled',platform:'pc',...detail})});
    }
    const adapter=await import(adapterUrl.href),create=adapter.createRender360PcTitle||adapter.default;
    if(typeof create!=='function')throw new Error(`PC adapter ${resolvedProbe.manifest.adapter} must export createRender360PcTitle().`);
    const host=buildPcHost(runtime,game,linked,config,resolvedProbe,presenter,null);
    session=await create(host);
    if(!session||typeof session!=='object')throw new Error('PC WebAssembly adapter did not return a session object.');

    // Portal creates a real visible Source/WebGL canvas. Bind mouse-look and
    // mouse buttons to that canvas instead of any presenter staging canvas.
    // The same controller object then serves touch and physical gamepads.
    const inputCanvas=session.sourceCanvas||presenter.sourceCanvas;
    controllerInput=createPcControllerInput({canvas:inputCanvas,gameId:resolvedProbe.gameId,emitLog:(level,message)=>runtime.emit('log',{level,message})});
    runtime.recompiledControllerInput=controllerInput;
    host.controllerInput=controllerInput;
    host.state.controller=controllerInput.descriptor();

    const directPresentation=Boolean(directRequested||session.directPresentation||session.sourceCanvas);
    runtime.recompiledSession=session;
    runtime.backend=directPresentation?'PC WASM · WEBGL2 DIRECT':'PC WASM · WEBGPU PRESENT';
    runtime.emit('bootStage',{stage:'pc-wasm-start',engine:'pc-recompiled',message:`Starting ${game.name||linked.detection.name} WebAssembly runtime…`});
    if(directPresentation){
      runtime.emit('bootStage',{stage:'pc-direct-presentation',engine:'pc-recompiled',message:'Portal Source WebGL2 direct presentation active · WebGPU copy loop disabled'});
    }else{
      presenter.start();
    }
    let result={};if(typeof session.start==='function')result=await session.start();else if(typeof session.run==='function')result=await session.run();else throw new Error('PC WebAssembly session must expose start() or run().');
    let stopped=false;
    const stop=()=>{if(stopped)return;stopped=true;try{return session.stop?.();}finally{controllerInput?.stop?.();presenter?.stop?.();if(runtime.recompiledSession===session)runtime.recompiledSession=null;if(runtime.recompiledControllerInput===controllerInput)runtime.recompiledControllerInput=null;runtime.resetInput?.();}};
    host.setState({session,result:result||{},controller:controllerInput.descriptor(),gpuTraffic:directPresentation?{reason:'source-webgl2-direct',webgpu:false}:{reason:'source-via-webgpu-presentation',webgpu:true,profile:presenter.profile},webgpuPresenter:directPresentation?null:presenter.descriptor(),runtimeBoundary:result?.runtimeBoundary||'pc-wasm-running',directPresentation,stop});
    return {kind:'pc-webassembly-port',platform:'pc',executionEngine:'pc-recompiled',gameId:resolvedProbe.gameId,manifest:resolvedProbe.manifest,session,result:result||{},controller:controllerInput.descriptor(),directPresentation,webgpuPresenter:directPresentation?null:presenter.descriptor(),stop};
  }catch(error){controllerInput?.stop?.();if(runtime.recompiledControllerInput===controllerInput)runtime.recompiledControllerInput=null;if(runtime.recompiledSession===session)runtime.recompiledSession=null;try{session?.stop?.();}catch{}presenter?.stop?.();throw error;}
}

export function installPcRecompiledRouter(Render360RuntimeClass){
  const proto=Render360RuntimeClass?.prototype;if(!proto||proto.__r360PcRecompiledRouterInstalled)return false;
  Object.defineProperty(proto,'__r360PcRecompiledRouterInstalled',{value:true});
  const previousPlay=proto.play,previousContract=proto.contract,previousSetKey=proto.setKey,previousSetAnalog=proto.setAnalog,previousResetInput=proto.resetInput;
  proto.contract=function(){const base=previousContract.call(this);return {...base,pcRecompiledWasm:{enabled:true,titleManifestSchema:PC_RECOMPILED_TITLE_SCHEMA,communityRuntimeSchema:'render360-pc-wasm-package-v1',registeredTitles:[...BUILTIN_MANIFESTS.keys()],userOwnedPcFiles:true,webgpuPresentation:true,xboxControllerOverlay:true,physicalGamepad:true,xboxRuntimeUnchanged:true}};};
  proto.setKey=function(key,pressed){const result=typeof previousSetKey==='function'?previousSetKey.call(this,key,pressed):undefined;const controller=this.recompiledControllerInput;if(controller?.setKey)controller.setKey(key,pressed);else this.recompiledSession?.setKey?.(key,pressed);return result;};
  proto.setAnalog=function(lx=0,ly=0,rx=0,ry=0){const result=typeof previousSetAnalog==='function'?previousSetAnalog.call(this,lx,ly,rx,ry):undefined;const controller=this.recompiledControllerInput;if(controller?.setAnalog)controller.setAnalog(lx,ly,rx,ry);else this.recompiledSession?.setAnalog?.(lx,ly,rx,ry);return result;};
  proto.resetInput=function(){const result=typeof previousResetInput==='function'?previousResetInput.call(this):undefined;const controller=this.recompiledControllerInput;if(controller?.resetInput)controller.resetInput();else this.recompiledSession?.resetInput?.();return result;};
  proto.play=async function(game,source=this.getSource(game?.id),config={}){
    if(!isPcGame(game))return previousPlay.call(this,game,source,config);
    if(!this.ready||!this.core)throw new Error('Render360 core is still loading');
    if(!source)throw new Error('PC game files are not linked. Choose the PC game folder and WebAssembly runtime again.');
    if(this.recompiledSession?.stop)try{this.recompiledSession.stop();}catch{}
    this.recompiledSession=null;this.recompiledControllerInput?.stop?.();this.recompiledControllerInput=null;
    this.currentGame=game;this.bindSource(game.id,source);this.resetTelemetry();
    this.inputHost.setSession({kind:30,stage:5,titleId:0});
    const probe=await probePcRecompiledTitle(game);
    this.emit('bootStage',{stage:'execution-engine',engine:'pc-recompiled',platform:'pc',message:`Execution Engine · PC Recompiled WebAssembly · ${game.pcGameId||'unknown'}`,fileName:source.name||game.sourceName||'PC game folder',fileSize:source.size||0});
    try{const result=await runPcRecompiledTitle({runtime:this,game,source,config:{...config,executionMode:'pc-recompiled',renderer:'webgpu'},probe});this.emit('titleStarted',{game,result,type:'pc-wasm',config:{...config,executionMode:'pc-recompiled',renderer:result?.directPresentation?'webgl2-direct':'webgpu'},executionEngine:'pc-recompiled'});return result;}
    catch(error){this.emit('fatalError',{message:error?.message||String(error),error,type:'pc-wasm',executionEngine:'pc-recompiled'});throw error;}
  };
  return true;
}

export function pcRecompiledRuntimeContract(){return {schema:PC_RECOMPILED_TITLE_SCHEMA,registeredTitles:[...BUILTIN_MANIFESTS.keys()],playerProvidesPcGame:true,communityProvidesRuntimePackage:true,automaticWindowsExeTranslation:false,webgpuPresentation:true,sourceRendererBringUp:'webgl2',xboxControllerOverlay:true,physicalGamepad:true,xbox360PathModified:false};}
