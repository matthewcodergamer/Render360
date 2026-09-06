const WORKER_FILE='portal-source-worker.mjs';
const ENGINE_FILE='portal-source-engine.mjs';

const normalize=value=>String(value||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+|\/+$/g,'');
const basename=value=>normalize(value).split('/').pop()||'';

function createPortalCanvas(hostCanvas){
  if(!hostCanvas?.parentNode)throw new Error('Portal needs the Render360 game canvas host.');
  if(typeof HTMLCanvasElement==='undefined'||typeof hostCanvas.transferControlToOffscreen!=='function')throw new Error('This browser does not support OffscreenCanvas transfer, which the Portal Source WebAssembly worker requires.');
  const canvas=document.createElement('canvas');
  canvas.id='portalSourceCanvas';
  canvas.width=Math.max(1,hostCanvas.width||1280);
  canvas.height=Math.max(1,hostCanvas.height||720);
  canvas.setAttribute('aria-label','Portal 1 Source WebAssembly renderer');
  Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',display:'block',zIndex:'6',background:'#000',touchAction:'none'});
  hostCanvas.parentNode.insertBefore(canvas,hostCanvas.nextSibling);
  return canvas;
}

function collectGameFiles(content){
  const files=[];
  const ignored=/\.(?:exe|dll|pdb|sys|bat|cmd|lnk)$/i;
  for(const raw of content.paths?.()||[]){
    const path=normalize(raw);
    if(!/^(?:portal|hl2|platform)\//i.test(path)||ignored.test(path))continue;
    const file=content.file?.(path);
    if(file instanceof Blob)files.push({name:path,data:file});
  }
  if(!files.some(item=>item.name.toLowerCase()==='portal/gameinfo.txt'))throw new Error('Portal gameinfo.txt is missing from the local Source mount.');
  return files;
}

function runtimeUrlMap(pkg){
  const map={};
  for(const path of pkg.paths()){
    if(path==='render360-port.json'||path==='SOURCE_SDK_LICENSE.txt')continue;
    const url=pkg.url(path);
    map[path]=url;
    map[basename(path)]=url;
  }
  return map;
}

function waitFor(worker,predicate,timeoutMs=90000){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('Portal Source worker timed out during initialization.'));},timeoutMs);
    const onMessage=event=>{if(predicate(event.data)){cleanup();resolve(event.data);}};
    const onError=event=>{cleanup();reject(event.error||new Error(event.message||'Portal Source worker failed.'));};
    const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);};
    worker.addEventListener('message',onMessage);worker.addEventListener('error',onError,{once:true});
  });
}

export async function createRender360PcPort(host){
  const pkg=host?.package;
  if(!pkg?.manifest||pkg.manifest.gameId!=='portal-1-pc')throw new Error('Portal Source adapter received the wrong runtime package.');
  if(!pkg.has(WORKER_FILE)||!pkg.has(ENGINE_FILE))throw new Error('Portal runtime package is missing its Source worker or engine module.');

  const sourceCanvas=createPortalCanvas(host.canvas);
  const offscreen=sourceCanvas.transferControlToOffscreen();
  const worker=new Worker(pkg.url(WORKER_FILE),{type:'module',name:'Render360 Portal Source'});
  const files=collectGameFiles(host.content);
  const urls=runtimeUrlMap(pkg);
  let stopped=false,started=false;

  worker.addEventListener('message',event=>{
    const data=event.data||{};
    if(data.type==='log')host.emitLog?.(data.level||'info',`Portal Source · ${data.message||''}`);
    else if(data.type==='stage')host.emitStage?.({stage:data.stage||'portal-source-worker',message:data.message||'',detail:data.detail||null});
    else if(data.type==='fatal')host.emitBlocker?.({kind:'portal-source-worker',message:data.message||'Portal Source worker failed',stack:data.stack||null});
    else if(data.type==='frame')host.emitFrame?.({backend:'portal-source-webgl2',...data});
  });

  const ready=waitFor(worker,data=>data?.type==='ready');
  worker.postMessage({
    type:'init',
    canvas:offscreen,
    files,
    engineUrl:urls[ENGINE_FILE],
    runtimeFiles:urls,
    arguments:Array.isArray(pkg.manifest.arguments)?pkg.manifest.arguments:[],
  },[offscreen]);
  const readyState=await ready;
  host.emitStage?.({stage:'portal-source-ready',message:`Portal Source Wasm ready · ${readyState.fileCount||files.length} local files mounted without copying the whole install into Wasm memory`});

  return {
    worker,
    sourceCanvas,
    async start(){
      if(stopped)throw new Error('Portal Source session was stopped.');
      if(started)return {runtimeBoundary:'portal-source-wasm-running',alreadyStarted:true};
      started=true;
      worker.postMessage({type:'run'});
      return {runtimeBoundary:'portal-source-wasm-running',renderer:'WebGL2',contentMount:'WORKERFS',threadProfile:'single-worker'};
    },
    pause(){return false;},
    resume(){return false;},
    stop(){
      if(stopped)return true;
      stopped=true;
      worker.terminate();
      sourceCanvas.remove();
      return true;
    },
  };
}

export default createRender360PcPort;
