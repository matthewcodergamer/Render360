const MANIFEST_SCHEMA='render360-recompiled-title-v1';

const hex8=value=>(Number(value||0)>>>0).toString(16).toUpperCase().padStart(8,'0');
const manifestPath=game=>`./recompiled/${hex8(game?.titleId)}/manifest.json`;
const normalizeMode=value=>['auto','emulator','recompiled'].includes(String(value))?String(value):'auto';

export async function probeRecompiledTitle(game){
  const titleId=Number(game?.titleId||0)>>>0;
  if(!titleId)return {available:false,titleId:0,titleIdHex:'00000000',reason:'missing-title-id'};
  const titleIdHex=hex8(titleId),url=manifestPath(game);
  let response;
  try{response=await fetch(url,{cache:'no-store'});}catch(error){return {available:false,titleId,titleIdHex,url,reason:'manifest-network-error',error:error?.message||String(error)};}
  if(response.status===404)return {available:false,titleId,titleIdHex,url,reason:'manifest-not-found'};
  if(!response.ok)return {available:false,titleId,titleIdHex,url,reason:`manifest-http-${response.status}`};
  let manifest;
  try{manifest=await response.json();}catch(error){return {available:false,titleId,titleIdHex,url,reason:'manifest-invalid-json',error:error?.message||String(error)};}
  if(manifest?.schema!==MANIFEST_SCHEMA)return {available:false,titleId,titleIdHex,url,reason:'manifest-schema-mismatch',manifest};
  if(String(manifest?.titleId||'').replace(/^0x/i,'').toUpperCase()!==titleIdHex)return {available:false,titleId,titleIdHex,url,reason:'manifest-title-id-mismatch',manifest};
  if(!manifest?.adapter||typeof manifest.adapter!=='string')return {available:false,titleId,titleIdHex,url,reason:'manifest-adapter-missing',manifest};
  return {available:true,titleId,titleIdHex,url,manifest};
}

function buildHost(runtime,game,file,config,probe){
  const state={executionEngine:'recompiled',kind:'static-recompiled-wasm',game,titleId:probe.titleId,manifest:probe.manifest,config,gpuTraffic:{reason:'waiting-for-recompiled-title'},persistentCpu:{kind:'ahead-of-time-recompiled'}};
  globalThis.render360ModernTitle=state;
  return {
    runtime,
    core:runtime.core,
    source:file,
    game,
    config,
    manifest:probe.manifest,
    canvas:document.getElementById('gpuCanvas'),
    inputHost:runtime.inputHost,
    state,
    emitStage(detail={}){runtime.emit('bootStage',{engine:'recompiled',...detail});},
    emitLog(level,message){runtime.emit('log',{level,message});},
    emitBlocker(detail={}){runtime.emit('runtimeBlocker',{engine:'recompiled',...detail});},
    emitFrame(detail={}){runtime.emit('framePresented',{engine:'recompiled',...detail});},
    setState(next={}){Object.assign(state,next);globalThis.render360ModernTitle=state;return state;},
  };
}

export async function runRecompiledTitle({runtime,game,file,config={},probe=null}){
  if(!runtime||!game||!file)throw new Error('Recompiled title launch requires runtime, game metadata, and the original game source.');
  const resolvedProbe=probe?.available?probe:await probeRecompiledTitle(game);
  if(!resolvedProbe.available)throw new Error(`No Recompiled WebAssembly build is installed for Title ID ${hex8(game.titleId)} (${resolvedProbe.reason||'unavailable'}).`);
  const manifestUrl=new URL(resolvedProbe.url,location.href);
  const adapterUrl=new URL(resolvedProbe.manifest.adapter,manifestUrl);
  runtime.emit('bootStage',{stage:'recompiled-manifest',engine:'recompiled',message:`Recompiled WebAssembly · ${resolvedProbe.titleIdHex}`});
  const adapter=await import(adapterUrl.href);
  const create=adapter.createRender360RecompiledTitle||adapter.default;
  if(typeof create!=='function')throw new Error(`Recompiled adapter ${resolvedProbe.manifest.adapter} must export createRender360RecompiledTitle().`);
  const host=buildHost(runtime,game,file,config,resolvedProbe);
  const session=await create(host);
  if(!session||typeof session!=='object')throw new Error('Recompiled adapter did not return a title session.');
  runtime.recompiledSession=session;
  runtime.backend='RECOMPILED WASM';
  runtime.emit('bootStage',{stage:'recompiled-start',engine:'recompiled',message:'Starting ahead-of-time recompiled title…'});
  let result={};
  if(typeof session.start==='function')result=await session.start();
  else if(typeof session.run==='function')result=await session.run();
  host.setState({session,result:result||{},runtimeBoundary:result?.runtimeBoundary||'recompiled-running'});
  return {kind:'static-recompiled-wasm',executionEngine:'recompiled',titleId:resolvedProbe.titleId,manifest:resolvedProbe.manifest,session,result:result||{}};
}

export function requestedExecutionMode(config={}){return normalizeMode(config?.executionMode||globalThis.render360ExecutionModePreference||'auto');}
export {MANIFEST_SCHEMA,hex8 as recompiledTitleIdHex};
