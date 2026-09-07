let engine=null;
let launchArguments=[];
let initialized=false;
let running=false;
const runtimeObjectUrls=new Map();

const post=(type,payload={})=>self.postMessage({type,...payload});
const log=(level,message)=>post('log',{level,message:String(message??'')});
const normalize=value=>String(value||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+|\/+$/g,'');
const basename=value=>normalize(value).split('/').pop()||'';

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
      onAbort:reason=>log('error',`Source abort: ${reason||'unknown reason'}`),
      render360OnLocalMapReady:mapName=>post('stage',{stage:'portal-local-map',message:`Local Portal map ready · ${mapName||'content'}`}),
    }),timeoutPromise]);
  }finally{clearTimeout(dependencyTimeout);}
  if(!engine?.FS||!engine?.WORKERFS)throw new Error('Portal Source build is missing the Emscripten FS/WORKERFS bridge.');

  // Dynamic side-module constructors have completed by this point. Confirm the
  // relocatable main module's stack limits are valid before touching game data.
  repairStackGeometry('runtime-init');

  const FS=engine.FS;
  try{FS.mkdir('/render360-game');}catch{}
  FS.mount(engine.WORKERFS,{blobs:files},'/render360-game');
  FS.chdir('/render360-game');

  launchArguments=Array.isArray(data.arguments)&&data.arguments.length?data.arguments:[
    '-game','portal','-noip','-language','english','-windowed','+mat_hdr_level','0'
  ];
  initialized=true;
  post('ready',{fileCount:files.length,cwd:FS.cwd(),memoryBytes:engine.HEAPU8?.buffer?.byteLength||0,stackEnd:engine.render360StackGeometry?.end||0});
}

function run(){
  if(!initialized)throw new Error('Portal Source worker is not initialized.');
  if(running)return;
  if(typeof engine.callMain!=='function')throw new Error('Portal Source build does not export callMain().');
  running=true;
  post('stage',{stage:'portal-source-main',message:'Starting Portal 1 Source engine…'});
  setTimeout(()=>{
    try{
      // noInitialRun keeps Source idle while player-owned files are mounted.
      // Reapply Emscripten's own exact stack limits at the last possible point
      // before manual callMain(), preventing the 0x00000004 cookie false crash.
      repairStackGeometry('before-callMain');
      engine.callMain(launchArguments);
      post('stage',{stage:'portal-source-exit',message:'Portal Source main returned.'});
    }catch(error){
      post('fatal',{message:error?.message||String(error),stack:error?.stack||null});
    }
  },0);
}

self.addEventListener('message',event=>{
  const data=event.data||{};
  if(data.type==='init')initialize(data).catch(error=>{post('fatal',{message:error?.message||String(error),stack:error?.stack||null});setTimeout(()=>self.close(),0);});
  else if(data.type==='run'){
    try{run();}catch(error){post('fatal',{message:error?.message||String(error),stack:error?.stack||null});}
  }
});
