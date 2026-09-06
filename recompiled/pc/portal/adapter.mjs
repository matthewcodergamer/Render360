import {createCommunityPcSession} from '../../../runtime/community-wasm-package.js';

export async function createRender360PcTitle(host){
  if(host?.manifest?.gameId!=='portal-1-pc')throw new Error('Portal PC adapter received the wrong game profile.');
  if(!host.content?.has?.('portal/gameinfo.txt'))throw new Error('Portal gameinfo.txt is missing from the selected PC install.');
  if(!host.runtimePackage)throw new Error('Portal needs a separately supplied community WebAssembly runtime package.');
  host.emitStage?.({stage:'portal-pc-host',message:'Portal PC content linked · preparing community WebAssembly runtime'});
  const inner=await createCommunityPcSession({package:host.runtimePackage,host});
  let started=false,stopped=false;
  return {
    inner,
    async start(){
      if(stopped)throw new Error('Portal WebAssembly session was already stopped.');
      if(started)return {runtimeBoundary:'portal-pc-wasm-running',alreadyStarted:true};
      started=true;
      host.emitStage?.({stage:'portal-wasm',message:'Launching Portal 1 community WebAssembly build…'});
      const result=typeof inner.start==='function'?await inner.start():typeof inner.run==='function'?await inner.run():{};
      host.setState?.({portalPc:true,communityRuntime:true,gpuTraffic:{reason:'community-source-renderer'},persistentCpu:{kind:'pc-source-aot-wasm'}});
      return {runtimeBoundary:result?.runtimeBoundary||'portal-pc-wasm-running',communityResult:result||{}};
    },
    pause(){return typeof inner.pause==='function'?inner.pause():true;},
    resume(){return typeof inner.resume==='function'?inner.resume():true;},
    stop(){stopped=true;try{return inner.stop?.();}finally{host.runtimePackage?.dispose?.();}},
  };
}

export default createRender360PcTitle;
