import {detectPcGame} from './pc-content-source.js';

export const PC_RECOMPILED_TITLE_SCHEMA='render360-pc-recompiled-title-v1';
const BUILTIN_MANIFESTS=new Map([
  ['portal-1-pc','../recompiled/pc/portal/manifest.json'],
]);

function normalizeGameId(value){return String(value||'').trim().toLowerCase();}
function isPcGame(game){return String(game?.platform||'').toLowerCase()==='pc'||String(game?.sourceType||'').toLowerCase()==='pc-wasm'||Boolean(game?.pcGameId);}

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
  if(!source||source.kind!=='pc-recompiled-source')throw new Error('PC WebAssembly launch needs the player-selected PC game folder and community runtime package.');
  if(!source.content||typeof source.content.has!=='function')throw new Error('PC game content source is not linked. Choose the installed game folder again.');
  const detection=source.detection?.matched?source.detection:detectPcGame(source.content);
  if(!detection.matched)throw new Error(`The selected PC folder is not a complete supported game install (${detection.reason||'content not recognized'}).`);
  if(expectedGameId&&normalizeGameId(detection.gameId)!==normalizeGameId(expectedGameId))throw new Error(`Selected PC content is ${detection.gameId}, but this library entry expects ${expectedGameId}.`);
  if(!source.runtimePackage)throw new Error('Portal PC files are recognized, but no community WebAssembly runtime package is linked. Choose a Render360 community runtime ZIP/folder containing render360-port.json.');
  if(normalizeGameId(source.runtimePackage.manifest?.gameId)!==normalizeGameId(expectedGameId))throw new Error(`The linked WebAssembly runtime targets ${source.runtimePackage.manifest?.gameId||'another game'}, not ${expectedGameId}.`);
  return {...source,detection};
}

function buildPcHost(runtime,game,source,config,probe){
  const state={executionEngine:'pc-recompiled',kind:'pc-webassembly-port',platform:'pc',game,gameId:probe.gameId,manifest:probe.manifest,config,persistentCpu:{kind:'native-pc-to-wasm-aot'},gpuTraffic:{reason:'owned-by-community-port'}};
  globalThis.render360ModernTitle=state;
  return {
    runtime,core:runtime.core,game,config,manifest:probe.manifest,
    source,content:source.content,runtimePackage:source.runtimePackage,
    canvas:document.getElementById('gpuCanvas'),inputHost:runtime.inputHost,state,
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
  runtime.emit('bootStage',{stage:'pc-runtime-package',engine:'pc-recompiled',message:`Community WebAssembly runtime · ${linked.runtimePackage.manifest.name||linked.runtimePackage.manifest.gameId}`,format:linked.runtimePackage.manifest.format});
  const adapter=await import(adapterUrl.href),create=adapter.createRender360PcTitle||adapter.default;
  if(typeof create!=='function')throw new Error(`PC adapter ${resolvedProbe.manifest.adapter} must export createRender360PcTitle().`);
  const host=buildPcHost(runtime,game,linked,config,resolvedProbe),session=await create(host);
  if(!session||typeof session!=='object')throw new Error('PC WebAssembly adapter did not return a session object.');
  runtime.recompiledSession=session;runtime.backend='PC RECOMPILED WASM';
  runtime.emit('bootStage',{stage:'pc-wasm-start',engine:'pc-recompiled',message:`Starting ${game.name||linked.detection.name} WebAssembly runtime…`});
  let result={};if(typeof session.start==='function')result=await session.start();else if(typeof session.run==='function')result=await session.run();else throw new Error('PC WebAssembly session must expose start() or run().');
  host.setState({session,result:result||{},runtimeBoundary:result?.runtimeBoundary||'pc-wasm-running'});
  return {kind:'pc-webassembly-port',platform:'pc',executionEngine:'pc-recompiled',gameId:resolvedProbe.gameId,manifest:resolvedProbe.manifest,session,result:result||{}};
}

export function installPcRecompiledRouter(Render360RuntimeClass){
  const proto=Render360RuntimeClass?.prototype;if(!proto||proto.__r360PcRecompiledRouterInstalled)return false;
  Object.defineProperty(proto,'__r360PcRecompiledRouterInstalled',{value:true});
  const previousPlay=proto.play,previousContract=proto.contract;
  proto.contract=function(){const base=previousContract.call(this);return {...base,pcRecompiledWasm:{enabled:true,titleManifestSchema:PC_RECOMPILED_TITLE_SCHEMA,communityRuntimeSchema:'render360-pc-wasm-package-v1',registeredTitles:[...BUILTIN_MANIFESTS.keys()],userOwnedPcFiles:true,xboxRuntimeUnchanged:true}};};
  proto.play=async function(game,source=this.getSource(game?.id),config={}){
    if(!isPcGame(game))return previousPlay.call(this,game,source,config);
    if(!this.ready||!this.core)throw new Error('Render360 core is still loading');
    if(!source)throw new Error('PC game files are not linked. Choose the PC game folder and community WebAssembly runtime again.');
    this.currentGame=game;this.bindSource(game.id,source);this.resetTelemetry();
    this.inputHost.setSession({kind:30,stage:5,titleId:0});
    const probe=await probePcRecompiledTitle(game);
    this.emit('bootStage',{stage:'execution-engine',engine:'pc-recompiled',platform:'pc',message:`Execution Engine · PC Recompiled WebAssembly · ${game.pcGameId||'unknown'}`,fileName:source.name||game.sourceName||'PC game folder',fileSize:source.size||0});
    try{const result=await runPcRecompiledTitle({runtime:this,game,source,config:{...config,executionMode:'pc-recompiled'},probe});this.emit('titleStarted',{game,result,type:'pc-wasm',config:{...config,executionMode:'pc-recompiled'},executionEngine:'pc-recompiled'});return result;}
    catch(error){this.emit('fatalError',{message:error?.message||String(error),error,type:'pc-wasm',executionEngine:'pc-recompiled'});throw error;}
  };
  return true;
}

export function pcRecompiledRuntimeContract(){return {schema:PC_RECOMPILED_TITLE_SCHEMA,registeredTitles:[...BUILTIN_MANIFESTS.keys()],playerProvidesPcGame:true,communityProvidesRuntimePackage:true,automaticWindowsExeTranslation:false,xbox360PathModified:false};}
