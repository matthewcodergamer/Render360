// Rendr360 V44.24 — iPhone visual-viewport, header, icon and rotation recovery.
// Presentation-only: emulator execution state is preserved while Safari rotates,
// changes browser chrome, or attempts element fullscreen.

const $=id=>document.getElementById(id);
const root=document.documentElement;
const RUNTIME_STATES=new Set(['BOOTING_GAME','RUNNING','PAUSED']);
const IOS_WEBKIT=/iPhone|iPad|iPod/i.test(navigator.userAgent||'')||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const STANDALONE=globalThis.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true;
const COMPACT_STATUS=new Set(['Starting runtime…','Runtime V44 · Core V32','Runtime unavailable']);
let lastKey='';
let rotateTimer=0;

function readViewport(){
  const vv=globalThis.visualViewport;
  const iw=Math.max(1,Math.round(globalThis.innerWidth||root.clientWidth||1));
  const ih=Math.max(1,Math.round(globalThis.innerHeight||root.clientHeight||1));
  const vw=Math.max(1,Math.round(vv?.width||iw));
  const vh=Math.max(1,Math.round(vv?.height||ih));
  const landscape=Boolean(globalThis.matchMedia?.('(orientation: landscape)')?.matches);
  const visualMatches=(vw>=vh)===landscape;
  const innerMatches=(iw>=ih)===landscape;
  const width=visualMatches?vw:(innerMatches?iw:vw);
  const height=visualMatches?vh:(innerMatches?ih:vh);
  return {width,height,x:Math.max(0,Math.round(vv?.offsetLeft||0)),y:Math.max(0,Math.round(vv?.offsetTop||0)),orientation:width>=height?'landscape':'portrait'};
}
function runtimeState(){return String(document.body?.dataset?.state||'');}
function runtimeActive(){
  const runtime=$('runtimeView');
  return RUNTIME_STATES.has(runtimeState())||Boolean(runtime&&!runtime.classList.contains('hidden'));
}

function ensureFreshUiLayer(){
  const desired=new URL('./ui-v44-mobile-fix-v24.css?v=44.24',import.meta.url).href;
  for(const link of [...document.querySelectorAll('link[rel="stylesheet"]')]){
    if(String(link.href).includes('ui-v44-mobile-fix-v24.css'))link.remove();
  }
  const link=document.createElement('link');
  link.rel='stylesheet';link.href=desired;link.dataset.r360MobileOverride='44.24';
  document.head.appendChild(link);
}

function profileSvg(){return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.25"></circle><circle cx="12" cy="9" r="3.15"></circle><path d="M6.9 18.2c.9-3 2.7-4.5 5.1-4.5s4.2 1.5 5.1 4.5"></path></svg>';}
function compactRuntimeStatus(){
  const sync=$('runtimeSyncStatus'),text=$('runtimeSyncText');if(!sync||!text)return;
  const raw=String(text.textContent||'').trim();
  if(raw&&!COMPACT_STATUS.has(raw))text.dataset.r360FullStatus=raw;
  const full=String(text.dataset.r360FullStatus||raw||'');
  let compact='Starting runtime…';
  if(sync.classList.contains('error')||/unavailable|failed|error/i.test(full))compact='Runtime unavailable';
  else if(sync.classList.contains('ready')||/synced|ready|core\s*v?\d+/i.test(full)){
    const runtimeVersion=(full.match(/runtime\s*v?(\d+)/i)||[])[1]||'44';
    const coreVersion=(full.match(/core\s*v?(\d+)/i)||[])[1]||'32';
    compact=`Runtime V${runtimeVersion} · Core V${coreVersion}`;
  }
  if(full)text.title=full;
  if(text.textContent!==compact)text.textContent=compact;
}
function ensureHeaderChrome(){
  const nav=document.querySelector('#libraryView .nav-row');if(!nav)return;
  let brand=nav.querySelector('.r360-brand');
  let title=brand?.querySelector(':scope > .nav-title')||nav.querySelector(':scope > .nav-title');
  if(!brand){brand=document.createElement('div');brand.className='r360-brand';if(title)title.replaceWith(brand);else nav.prepend(brand);if(title)brand.appendChild(title);}
  if(!title){title=document.createElement('div');title.className='nav-title';brand.prepend(title);}
  if(!title.querySelector('.r360-name')||!title.querySelector('.r360-360'))title.innerHTML='<span class="r360-name">Rendr</span><span class="r360-360">360</span>';
  title.style.removeProperty('font-size');title.style.removeProperty('visibility');title.style.removeProperty('opacity');

  const sync=$('runtimeSyncStatus');if(sync&&!sync.closest('.r360-brand'))brand.appendChild(sync);
  const text=$('runtimeSyncText');
  if(text&&!text.dataset.r360CompactObserved){
    text.dataset.r360CompactObserved='1';
    new MutationObserver(()=>compactRuntimeStatus()).observe(text,{childList:true,characterData:true,subtree:true});
  }
  if(sync&&!sync.dataset.r360ClassObserved){
    sync.dataset.r360ClassObserved='1';
    new MutationObserver(()=>compactRuntimeStatus()).observe(sync,{attributes:true,attributeFilter:['class']});
  }
  compactRuntimeStatus();

  let actions=nav.querySelector('.nav-actions');if(!actions){actions=document.createElement('div');actions.className='nav-actions';nav.appendChild(actions);}
  const settings=$('settingsButton');
  let profile=$('profileButton');
  if(!profile){profile=document.createElement('button');profile.id='profileButton';profile.type='button';profile.setAttribute('aria-label','Profile');profile.title='Profile';profile.innerHTML=profileSvg();}
  if(settings)actions.appendChild(settings);
  actions.appendChild(profile);
}

function ensureAppIcon(){
  const png=new URL('./rendr360-apple-touch-icon.png?v=44.24',import.meta.url).href;
  const svg=new URL('./rendr360-apple-touch-icon.svg?v=44.24',import.meta.url).href;
  const upsert=(selector,rel,href,type='',sizes='')=>{
    let link=document.querySelector(selector);if(!link){link=document.createElement('link');link.rel=rel;document.head.appendChild(link);}
    link.href=href;if(type)link.type=type;if(sizes)link.setAttribute('sizes',sizes);return link;
  };
  upsert('link[rel="apple-touch-icon"]','apple-touch-icon',png,'image/png','180x180');
  upsert('link[rel="apple-touch-icon-precomposed"]','apple-touch-icon-precomposed',png,'image/png','180x180');
  upsert('link[rel="shortcut icon"]','shortcut icon',png,'image/png');
  upsert('link[rel="icon"][data-r360-png]','icon',png,'image/png','180x180').dataset.r360Png='1';
  const mask=document.querySelector('link[rel="mask-icon"]');if(mask){mask.href=svg;mask.setAttribute('color','#30D158');}
  const manifest=document.querySelector('link[rel="manifest"]');if(manifest)manifest.href=new URL('./manifest.webmanifest?v=44.24',import.meta.url).href;
  let meta=document.querySelector('meta[name="apple-mobile-web-app-title"]');if(!meta){meta=document.createElement('meta');meta.name='apple-mobile-web-app-title';document.head.appendChild(meta);}meta.content='Rendr360';
  document.title='Rendr360 · Xbox 360 Emulator';
}

function releaseOrientationLock(){
  if(!IOS_WEBKIT)return;
  try{globalThis.screen?.orientation?.unlock?.();}catch{}
}
function exitElementFullscreen(){
  if(!IOS_WEBKIT||!runtimeActive())return;
  try{if(document.fullscreenElement)void document.exitFullscreen?.().catch(()=>{});}catch{}
  try{if(document.webkitFullscreenElement)document.webkitExitFullscreen?.();}catch{}
}
function enforceRuntimeLayers(){
  const active=runtimeActive();
  document.body?.classList.toggle('r360-runtime-active',active);
  if(!active)return;
  const state=runtimeState(),runtime=$('runtimeView');if(!runtime)return;
  for(const id of ['libraryView','detailView','gameSettingsView','appSettingsView'])$(id)?.classList.add('hidden');
  runtime.classList.remove('hidden');
  runtime.style.setProperty('display','block','important');runtime.style.setProperty('visibility','visible','important');runtime.style.setProperty('opacity','1','important');runtime.style.setProperty('z-index','1000','important');
  const controls=$('controllerLayer');
  if(controls){controls.style.setProperty('display','block','important');controls.style.setProperty('visibility','visible','important');if(state!=='PAUSED')controls.style.setProperty('opacity','1','important');}
}

function syncViewport(force=false){
  const {width,height,x,y,orientation}=readViewport();
  const key=`${width}x${height}:${orientation}`;
  if(!force&&key===lastKey)return;
  lastKey=key;
  root.style.setProperty('--r360-vw',`${width}px`);
  root.style.setProperty('--r360-vh',`${height}px`);
  root.style.setProperty('--r360-vx','0px');
  root.style.setProperty('--r360-vy','0px');
  root.style.setProperty('--app-height',`${height}px`);
  root.dataset.r360Orientation=orientation;

  enforceRuntimeLayers();
  const runtime=$('runtimeView');
  if(runtimeActive()&&runtime){
    try{globalThis.scrollTo(0,0);}catch{}
    runtime.style.setProperty('position','fixed','important');
    runtime.style.setProperty('left','0','important');runtime.style.setProperty('top','0','important');
    runtime.style.setProperty('right','auto','important');runtime.style.setProperty('bottom','auto','important');
    runtime.style.setProperty('width',`${width}px`,'important');runtime.style.setProperty('height',`${height}px`,'important');
    runtime.style.setProperty('margin','0','important');runtime.style.setProperty('transform','none','important');
    const stage=runtime.querySelector('.runtime-stage');
    if(stage){stage.style.setProperty('inset','0','important');stage.style.setProperty('width','100%','important');stage.style.setProperty('height','100%','important');stage.style.setProperty('transform','none','important');void stage.offsetWidth;}
    for(const id of ['gpuCanvas','titleFrameCanvas']){const canvas=$(id);if(canvas){canvas.style.setProperty('inset','0','important');canvas.style.setProperty('width','100%','important');canvas.style.setProperty('height','100%','important');}}
    const overlay=$('bootOverlay');if(overlay){overlay.style.setProperty('inset','0','important');overlay.style.setProperty('width','100%','important');overlay.style.setProperty('height','100%','important');}
    const card=runtime.querySelector('.boot-card');if(card){card.style.removeProperty('left');card.style.removeProperty('top');card.style.removeProperty('transform');}
    const controls=$('controllerLayer');if(controls){controls.style.setProperty('inset','0','important');controls.style.setProperty('width','100%','important');controls.style.setProperty('height','100%','important');controls.style.setProperty('display','block','important');controls.style.setProperty('visibility','visible','important');}
  }
  globalThis.dispatchEvent(new CustomEvent('render360:viewportChanged',{detail:{width,height,x,y,orientation}}));
}

function markRotating(){
  document.body?.classList.add('r360-rotating');clearTimeout(rotateTimer);
  rotateTimer=setTimeout(()=>document.body?.classList.remove('r360-rotating'),1650);
}
function syncBurst(){
  markRotating();releaseOrientationLock();exitElementFullscreen();
  for(const delay of [0,30,70,120,200,320,500,750,1050,1400,1650])setTimeout(()=>{
    releaseOrientationLock();exitElementFullscreen();syncViewport(true);requestAnimationFrame(()=>syncViewport(true));
  },delay);
}

function installStableIOSFullscreen(){
  if(!IOS_WEBKIT||STANDALONE)return;
  const runtime=$('runtimeView');if(!runtime||runtime.dataset.r360VisualFullscreen==='24')return;
  runtime.dataset.r360VisualFullscreen='24';
  const visualRequest=async()=>{root.classList.add('r360-visual-fullscreen');releaseOrientationLock();syncBurst();return undefined;};
  try{Object.defineProperty(runtime,'requestFullscreen',{configurable:true,writable:true,value:visualRequest});}catch{try{runtime.requestFullscreen=visualRequest;}catch{}}
  try{Object.defineProperty(runtime,'webkitRequestFullscreen',{configurable:true,writable:true,value:visualRequest});}catch{}

  const proto=globalThis.Element?.prototype;
  if(proto&&!proto.__r360VisualFullscreenV24){
    const native=proto.requestFullscreen;
    const nativeWebkit=proto.webkitRequestFullscreen;
    try{Object.defineProperty(proto,'__r360VisualFullscreenV24',{configurable:true,value:true});}catch{}
    if(typeof native==='function')try{Object.defineProperty(proto,'requestFullscreen',{configurable:true,writable:true,value:function(...args){if(this===runtime||this?.id==='runtimeView')return visualRequest();return native.apply(this,args);}});}catch{}
    if(typeof nativeWebkit==='function')try{Object.defineProperty(proto,'webkitRequestFullscreen',{configurable:true,writable:true,value:function(...args){if(this===runtime||this?.id==='runtimeView')return visualRequest();return nativeWebkit.apply(this,args);}});}catch{}
  }

  const screenOrientation=globalThis.screen?.orientation;
  if(screenOrientation&&typeof screenOrientation.lock==='function'){
    try{Object.defineProperty(screenOrientation,'lock',{configurable:true,writable:true,value:async()=>{releaseOrientationLock();return false;}});}catch{}
  }
  const escape=()=>{exitElementFullscreen();releaseOrientationLock();syncBurst();};
  document.addEventListener('fullscreenchange',escape);
  document.addEventListener('webkitfullscreenchange',escape);
  releaseOrientationLock();exitElementFullscreen();
}

function installRuntimeStateRecovery(){
  if(!document.body)return;
  const recover=()=>{enforceRuntimeLayers();syncBurst();};
  new MutationObserver(recover).observe(document.body,{attributes:true,attributeFilter:['data-state']});
  recover();
}
function installHeaderRecovery(){
  ensureHeaderChrome();
  const navbar=document.querySelector('#libraryView .navbar');if(!navbar)return;
  let queued=false;
  new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;ensureHeaderChrome();});}).observe(navbar,{childList:true,subtree:true});
}

function installViewportRecovery(){
  root.dataset.r360MobileFix='44.24';
  ensureFreshUiLayer();ensureAppIcon();installHeaderRecovery();installStableIOSFullscreen();installRuntimeStateRecovery();
  syncBurst();
  globalThis.addEventListener('resize',syncBurst,{passive:true});
  globalThis.addEventListener('orientationchange',syncBurst,{passive:true});
  globalThis.addEventListener('fullscreenchange',syncBurst,{passive:true});
  globalThis.addEventListener('pageshow',syncBurst,{passive:true});
  globalThis.addEventListener('focus',syncBurst,{passive:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncBurst();});
  globalThis.visualViewport?.addEventListener('resize',syncBurst,{passive:true});
  globalThis.visualViewport?.addEventListener('scroll',()=>syncViewport(),{passive:true});
  globalThis.screen?.orientation?.addEventListener?.('change',syncBurst);
  try{matchMedia('(orientation: landscape)').addEventListener?.('change',syncBurst);}catch{}
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installViewportRecovery,{once:true});
else installViewportRecovery();
