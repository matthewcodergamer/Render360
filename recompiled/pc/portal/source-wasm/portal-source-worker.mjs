let engine=null;
let launchArguments=[];
let initialized=false;
let running=false;
let lastRuntimeLog='';
const runtimeObjectUrls=new Map();

const post=(type,payload={})=>self.postMessage({type,...payload});
const log=(level,message)=>{lastRuntimeLog=String(message??'');post('log',{level,message:lastRuntimeLog});};
const normalize=value=>String(value||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+|\/+$/g,'');
const basename=value=>normalize(value).split('/').pop()||'';
const fatal=(origin,error)=>post('fatal',{origin,message:error?.message||String(error||'Portal Source worker failed'),stack:error?.stack||null,lastRuntimeLog});

// Emscripten's browser error path may call alert(). This module always runs in
// a dedicated Worker where alert is intentionally unavailable. Keep the real
// Source error visible in Render360 diagnostics instead of throwing a second,
// misleading ReferenceError from the error reporter itself.
if(typeof self.alert!=='function')self.alert=message=>log('warn',`Source alert · ${message??''}`);

// Safari can surface a WebAssembly trap or rejected dynamic-library promise at
// the Worker boundary rather than through callMain(). Preserve the exact last
// Source line so the diagnostic report no longer falls back to an unrelated
// Xenia/PPC blocker with empty fields.
self.addEventListener('error',event=>{
  const error=event?.error||new Error(event?.message||'Portal Source worker error');
  fatal('worker-error',error);
});
self.addEventListener('unhandledrejection',event=>{
  const reason=event?.reason instanceof Error?event.reason:new Error(String(event?.reason||'Unhandled Portal Source promise rejection'));
  fatal('worker-unhandledrejection',reason);
});

function installRuntimeFiles(items){
  for(const item of Array.isArray(items)?items:[]){
    const path=normalize(item?.path),file=item?.file;
    if(!path||!(file instanceof Blob))continue;
    const type=/\.m?js$/i.test(path)?'text/javascript':/\.(?:wasm|so)$/i.test(path)?'application/wasm':file.type||'application/octet-stream';
    const url=URL.createObjectURL(new Blob([file],{type}));
    runtimeObjectUrls.set(path,url);runtimeObjectUrls.set(basename(path),url);
  }
}
function runtimeLocator(name){const clean=normalize(name);return runtimeObjectUrls.get(clean)||runtimeObjectUrls.get(basename(clean))||name;}
async function preflightRuntimeFiles(){
  const unique=new Map();for(const [path,url] of runtimeObjectUrls)if(/\.(?:wasm|so)$/i.test(path)&&!unique.has(url))unique.set(url,path);
  let done=0;for(const [url,path] of unique){
    post('stage',{stage:'portal-dylib-preflight',message:`Checking Source WebAssembly module · ${basename(path)}`,detail:{path,done,total:unique.size}});
    let response;try{response=await fetch(url);}catch(error){throw new Error(`Portal runtime file ${path} could not be fetched inside the game worker: ${error?.message||error}`);}
    if(!response.ok)throw new Error(`Portal runtime file ${path} returned HTTP ${response.status} inside the game worker.`);
    const bytes=await response.arrayBuffer();if(!WebAssembly.validate(bytes))throw new Error(`Portal runtime file ${path} is not valid WebAssembly.`);done++;
  }
  post('stage',{stage:'portal-dylib-preflight-complete',message:`Source WebAssembly modules accessible · ${done} checked`,detail:{done,total:unique.size}});
}

function repairStackGeometry(phase){
  const repair=engine?.render360RepairStackGeometry;
  if(typeof repair!=='function')throw new Error('Portal Source runtime is missing the Render360 Emscripten stack-geometry repair. Build a new runtime ZIP.');
  const state=repair();
  const end=Number(state?.end||0)>>>0;
  if(!end)throw new Error('Portal Source Emscripten stack end is zero after repair. Refusing to start with an invalid stack cookie address.');
  const endHex=`0x${end.toString(16).padStart(8,'0')}`;
  post('stage',{stage:'portal-stack-geometry',message:`Source Emscripten stack geometry ready · end ${endHex}`,detail:{phase,end,endHex}});
  return state;
}

function runtimeMemoryBytes(){
  try{
    const descriptor=Object.getOwnPropertyDescriptor(engine||{},'HEAPU8');
    if(descriptor&&'value' in descriptor&&descriptor.value?.buffer)return descriptor.value.buffer.byteLength||0;
  }catch{}
  return 0;
}

async function initialize(data){
  if(initialized)return;
  if(!data?.engineFile)throw new Error('Portal Source engine module is missing from the runtime package.');
  if(!data?.canvas)throw new Error('Portal Source OffscreenCanvas is missing.');
  const files=Array.isArray(data.files)?data.files:[];
  if(!files.length)throw new Error('Portal player-owned file mount is empty.');

  installRuntimeFiles(data.runtimeFiles||[]);
  if(!runtimeObjectUrls.size)throw new Error('Portal runtime package did not provide worker-local runtime files.');
  await preflightRuntimeFiles();
  const engineUrl=runtimeObjectUrls.get('portal-source-engine.mjs')||runtimeObjectUrls.get(basename(data.engineName||'portal-source-engine.mjs'));
  if(!engineUrl)throw new Error('Portal Source engine JavaScript module could not be staged inside the worker.');

  post('stage',{stage:'portal-source-import',message:'Loading Source Engine WebAssembly module…'});
  const mod=await import(engineUrl);
  const factory=mod.default||mod.createPortalSourceModule;
  if(typeof factory!=='function')throw new Error('Portal Source engine module does not export its Emscripten factory.');

  let dependencyTimeout=0;
  const timeoutPromise=new Promise((_,reject)=>{dependencyTimeout=setTimeout(()=>reject(new Error('Portal Source timed out while loading dynamic WebAssembly libraries. Check the dylib diagnostic log for the exact module.')),75000);});
  try{
    engine=await Promise.race([factory({
      canvas:data.canvas,
      noInitialRun:true,
      locateFile:runtimeLocator,
      print:text=>log('info',text),
      printErr:text=>log('warn',text),
      onAbort:reason=>{log('error',`Source abort: ${reason||'unknown reason'}`);fatal('emscripten-abort',new Error(String(reason||'Source aborted')));},
      render360OnLocalMapReady:mapName=>post('stage',{stage:'portal-local-map',message:`Local Portal map ready · ${mapName||'content'}`}),
    }),timeoutPromise]);
  }finally{clearTimeout(dependencyTimeout);}
  if(!engine?.FS||!engine?.WORKERFS)throw new Error('Portal Source build is missing the Emscripten FS/WORKERFS bridge.');

  repairStackGeometry('runtime-init');

  const FS=engine.FS;
  try{FS.mkdir('/render360-game');}catch{}
  FS.mount(engine.WORKERFS,{blobs:files},'/render360-game');
  FS.chdir('/render360-game');

  launchArguments=Array.isArray(data.arguments)&&data.arguments.length?data.arguments:[
    '-game','portal','-noip','-language','english','-windowed','+mat_hdr_level','0'
  ];
  initialized=true;
  post('ready',{fileCount:files.length,cwd:FS.cwd(),memoryBytes:runtimeMemoryBytes(),stackEnd:engine.render360StackGeometry?.end||0});
}

function run(){
  if(!initialized)throw new Error('Portal Source worker is not initialized.');
  if(running)return;
  if(typeof engine.callMain!=='function')throw new Error('Portal Source build does not export callMain().');
  running=true;
  post('stage',{stage:'portal-source-main',message:'Starting Portal 1 Source engine…'});
  setTimeout(()=>{
    try{
      repairStackGeometry('before-callMain');
      post('stage',{stage:'portal-source-callmain',message:'Entering Portal Source callMain() · waiting for Source subsystem initialization'});
      engine.callMain(launchArguments);
      post('stage',{stage:'portal-source-exit',message:'Portal Source main returned.'});
    }catch(error){
      fatal('callMain',error);
    }
  },0);
}

self.addEventListener('message',event=>{
  const data=event.data||{};
  if(data.type==='init')initialize(data).catch(error=>{fatal('initialize',error);setTimeout(()=>self.close(),0);});
  else if(data.type==='run'){
    try{run();}catch(error){fatal('run',error);}
  }
});
