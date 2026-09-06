let engine=null;
let launchArguments=[];
let initialized=false;
let running=false;

const post=(type,payload={})=>self.postMessage({type,...payload});
const log=(level,message)=>post('log',{level,message:String(message??'')});
const normalize=value=>String(value||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+|\/+$/g,'');
const basename=value=>normalize(value).split('/').pop()||'';

function runtimeLocator(runtimeFiles){
  return name=>{
    const clean=normalize(name);
    return runtimeFiles?.[clean]||runtimeFiles?.[basename(clean)]||name;
  };
}

async function initialize(data){
  if(initialized)return;
  if(!data?.engineUrl)throw new Error('Portal Source engine URL is missing.');
  if(!data?.canvas)throw new Error('Portal Source OffscreenCanvas is missing.');
  const files=Array.isArray(data.files)?data.files:[];
  if(!files.length)throw new Error('Portal player-owned file mount is empty.');

  post('stage',{stage:'portal-source-import',message:'Loading Source Engine WebAssembly module…'});
  const mod=await import(data.engineUrl);
  const factory=mod.default||mod.createPortalSourceModule;
  if(typeof factory!=='function')throw new Error('Portal Source engine module does not export its Emscripten factory.');

  engine=await factory({
    canvas:data.canvas,
    noInitialRun:true,
    locateFile:runtimeLocator(data.runtimeFiles||{}),
    print:text=>log('info',text),
    printErr:text=>log('warn',text),
    render360OnLocalMapReady:mapName=>post('stage',{stage:'portal-local-map',message:`Local Portal map ready · ${mapName||'content'}`}),
  });
  if(!engine?.FS||!engine?.WORKERFS)throw new Error('Portal Source build is missing the Emscripten FS/WORKERFS bridge.');

  const FS=engine.FS;
  try{FS.mkdir('/render360-game');}catch{}
  FS.mount(engine.WORKERFS,{blobs:files},'/render360-game');
  FS.chdir('/render360-game');

  launchArguments=Array.isArray(data.arguments)&&data.arguments.length?data.arguments:[
    '-game','portal','-noip','-language','english','-windowed','+mat_hdr_level','0'
  ];
  initialized=true;
  post('ready',{fileCount:files.length,cwd:FS.cwd(),memoryBytes:engine.HEAPU8?.buffer?.byteLength||0});
}

function run(){
  if(!initialized)throw new Error('Portal Source worker is not initialized.');
  if(running)return;
  if(typeof engine.callMain!=='function')throw new Error('Portal Source build does not export callMain().');
  running=true;
  post('stage',{stage:'portal-source-main',message:'Starting Portal 1 Source engine…'});
  // Yield once so the ready/stage messages reach the UI before Source takes
  // control of this dedicated worker's game loop.
  setTimeout(()=>{
    try{
      engine.callMain(launchArguments);
      post('stage',{stage:'portal-source-exit',message:'Portal Source main returned.'});
    }catch(error){
      post('fatal',{message:error?.message||String(error),stack:error?.stack||null});
    }
  },0);
}

self.addEventListener('message',event=>{
  const data=event.data||{};
  if(data.type==='init')initialize(data).catch(error=>post('fatal',{message:error?.message||String(error),stack:error?.stack||null}));
  else if(data.type==='run'){
    try{run();}catch(error){post('fatal',{message:error?.message||String(error),stack:error?.stack||null});}
  }
});
