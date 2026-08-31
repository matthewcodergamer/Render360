// Rendr360 V44.25 — low-churn iPhone viewport, header and rotation recovery.
// Keeps runtime execution untouched while avoiding Safari resize/event storms.

const $=id=>document.getElementById(id);
const root=document.documentElement;
const RUNTIME_STATES=new Set(['BOOTING_GAME','RUNNING','PAUSED']);
const IOS_WEBKIT=/iPhone|iPad|iPod/i.test(navigator.userAgent||'')||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const STANDALONE=globalThis.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true;
let lastKey='';
let rafPending=false;
let rotateTimer=0;
let burstTimers=[];

function runtimeState(){return String(document.body?.dataset?.state||'');}
function runtimeActive(){const runtime=$('runtimeView');return RUNTIME_STATES.has(runtimeState())||Boolean(runtime&&!runtime.classList.contains('hidden'));}

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
  return {width,height,orientation:width>=height?'landscape':'portrait'};
}

function ensureFreshUiLayer(){
  const desired=new URL('./ui-v44-mobile-fix-v25.css?v=44.25',import.meta.url).href;
  for(const link of [...document.querySelectorAll('link[rel="stylesheet"]')])if(String(link.href).includes('ui-v44-mobile-fix-v25.css'))link.remove();
  const link=document.createElement('link');link.rel='stylesheet';link.href=desired;link.dataset.r360MobileOverride='44.25';document.head.appendChild(link);
}

function profileSvg(){return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.25"></circle><circle cx="12" cy="9" r="3.15"></circle><path d="M6.9 18.2c.9-3 2.7-4.5 5.1-4.5s4.2 1.5 5.1 4.5"></path></svg>';}
function compactFromSource(sync,source){
  const full=String(source?.textContent||'').trim();
  if(sync?.classList.contains('error')||/unavailable|failed|error/i.test(full))return 'Runtime unavailable';
  if(sync?.classList.contains('ready')||/synced|ready|core\s*v?\d+/i.test(full)){
    const runtimeVersion=(full.match(/runtime\s*v?(\d+)/i)||[])[1]||'44';
    const coreVersion=(full.match(/core\s*v?(\d+)/i)||[])[1]||'32';
    return `Runtime V${runtimeVersion} · Core V${coreVersion}`;
  }
  return 'Starting runtime…';
}
function ensureStatusMirror(){
  const sync=$('runtimeSyncStatus'),source=$('runtimeSyncText');if(!sync||!source)return;
  let mirror=$('r360RuntimeDisplayText');
  if(!mirror){mirror=document.createElement('span');mirror.id='r360RuntimeDisplayText';mirror.setAttribute('aria-hidden','true');sync.appendChild(mirror);}
  const refresh=()=>{const full=String(source.textContent||'').trim();mirror.textContent=compactFromSource(sync,source);if(full){mirror.title=full;sync.title=full;}};
  if(!source.dataset.r360MirrorObserved){source.dataset.r360MirrorObserved='1';new MutationObserver(refresh).observe(source,{childList:true,characterData:true,subtree:true});}
  if(!sync.dataset.r360MirrorClassObserved){sync.dataset.r360MirrorClassObserved='1';new MutationObserver(refresh).observe(sync,{attributes:true,attributeFilter:['class']});}
  refresh();
}
function ensureHeaderChrome(){
  const nav=document.querySelector('#libraryView .nav-row');if(!nav)return;
  let brand=nav.querySelector('.r360-brand');let title=brand?.querySelector(':scope > .nav-title')||nav.querySelector(':scope > .nav-title');
  if(!brand){brand=document.createElement('div');brand.className='r360-brand';if(title)title.replaceWith(brand);else nav.prepend(brand);if(title)brand.appendChild(title);}
  if(!title){title=document.createElement('div');title.className='nav-title';brand.prepend(title);}
  if(!title.querySelector('.r360-name')||!title.querySelector('.r360-360'))title.innerHTML='<span class="r360-name">Rendr</span><span class="r360-360">360</span>';
  const sync=$('runtimeSyncStatus');if(sync&&!sync.closest('.r360-brand'))brand.appendChild(sync);ensureStatusMirror();
  let actions=nav.querySelector('.nav-actions');if(!actions){actions=document.createElement('div');actions.className='nav-actions';nav.appendChild(actions);}
  const settings=$('settingsButton');let profile=$('profileButton');
  if(!profile){profile=document.createElement('button');profile.id='profileButton';profile.type='button';profile.setAttribute('aria-label','Profile');profile.title='Profile';profile.innerHTML=profileSvg();}
  if(settings&&settings.parentElement!==actions)actions.appendChild(settings);
  if(profile.parentElement!==actions)actions.appendChild(profile);
  if(settings&&actions.firstElementChild!==settings)actions.insertBefore(settings,actions.firstElementChild);
  if(settings&&profile.previousElementSibling!==settings)actions.insertBefore(profile,settings.nextElementSibling);
}

function ensureAppIcon(){
  const png=new URL('./rendr360-apple-touch-icon.png?v=44.25',import.meta.url).href;
  const svg=new URL('./rendr360-apple-touch-icon.svg?v=44.25',import.meta.url).href;
  const upsert=(selector,rel,href,type='',sizes='')=>{let link=document.querySelector(selector);if(!link){link=document.createElement('link');link.rel=rel;document.head.appendChild(link);}link.href=href;if(type)link.type=type;if(sizes)link.setAttribute('sizes',sizes);return link;};
  upsert('link[rel="apple-touch-icon"]','apple-touch-icon',png,'image/png','180x180');
  upsert('link[rel="apple-touch-icon-precomposed"]','apple-touch-icon-precomposed',png,'image/png','180x180');
  upsert('link[rel="shortcut icon"]','shortcut icon',png,'image/png');
  upsert('link[rel="icon"][data-r360-png]','icon',png,'image/png','180x180').dataset.r360Png='1';
  const mask=document.querySelector('link[rel="mask-icon"]');if(mask){mask.href=svg;mask.setAttribute('color','#30D158');}
  const manifest=document.querySelector('link[rel="manifest"]');if(manifest)manifest.href=new URL('./manifest.webmanifest?v=44.25',import.meta.url).href;
}

function enforceRuntimeLayers(){
  const active=runtimeActive();document.body?.classList.toggle('r360-runtime-active',active);if(!active)return;
  const runtime=$('runtimeView');if(!runtime)return;
  for(const id of ['libraryView','detailView','gameSettingsView','appSettingsView'])$(id)?.classList.add('hidden');
  runtime.classList.remove('hidden');runtime.style.setProperty('display','block','important');runtime.style.setProperty('visibility','visible','important');runtime.style.setProperty('opacity','1','important');
  const controls=$('controllerLayer');if(controls){controls.style.setProperty('display','block','important');controls.style.setProperty('visibility','visible','important');if(runtimeState()!=='PAUSED')controls.style.setProperty('opacity','1','important');}
}
function syncViewport(force=false){
  const {width,height,orientation}=readViewport();const key=`${width}x${height}:${orientation}`;if(!force&&key===lastKey)return;lastKey=key;
  root.style.setProperty('--r360-vw',`${width}px`);root.style.setProperty('--r360-vh',`${height}px`);root.style.setProperty('--app-height',`${height}px`);root.dataset.r360Orientation=orientation;
  enforceRuntimeLayers();const runtime=$('runtimeView');
  if(runtimeActive()&&runtime){
    runtime.style.setProperty('position','fixed','important');runtime.style.setProperty('left','0','important');runtime.style.setProperty('top','0','important');runtime.style.setProperty('width',`${width}px`,'important');runtime.style.setProperty('height',`${height}px`,'important');runtime.style.setProperty('transform','none','important');
    const stage=runtime.querySelector('.runtime-stage');if(stage){stage.style.setProperty('inset','0','important');stage.style.setProperty('width','100%','important');stage.style.setProperty('height','100%','important');stage.style.setProperty('transform','none','important');}
    for(const id of ['gpuCanvas','titleFrameCanvas','bootOverlay','controllerLayer']){const el=$(id);if(el){el.style.setProperty('inset','0','important');el.style.setProperty('width','100%','important');el.style.setProperty('height','100%','important');}}
  }
  globalThis.dispatchEvent(new CustomEvent('render360:viewportChanged',{detail:{width,height,orientation}}));
}
function scheduleViewportSync(force=false){if(rafPending&&!force)return;rafPending=true;requestAnimationFrame(()=>{rafPending=false;syncViewport(force);});}
function markRotating(){document.body?.classList.add('r360-rotating');clearTimeout(rotateTimer);rotateTimer=setTimeout(()=>document.body?.classList.remove('r360-rotating'),900);}
function syncBurst(){
  markRotating();for(const timer of burstTimers)clearTimeout(timer);burstTimers=[];
  for(const delay of [0,120,360,720])burstTimers.push(setTimeout(()=>scheduleViewportSync(true),delay));
}

function exitElementFullscreen(){if(!IOS_WEBKIT||!runtimeActive())return;try{if(document.fullscreenElement)void document.exitFullscreen?.().catch(()=>{});}catch{}try{if(document.webkitFullscreenElement)document.webkitExitFullscreen?.();}catch{}}
function installStableIOSFullscreen(){
  if(!IOS_WEBKIT||STANDALONE)return;const runtime=$('runtimeView');if(!runtime||runtime.dataset.r360VisualFullscreen==='25')return;runtime.dataset.r360VisualFullscreen='25';
  const visualRequest=async()=>{root.classList.add('r360-visual-fullscreen');syncBurst();return undefined;};
  try{Object.defineProperty(runtime,'requestFullscreen',{configurable:true,writable:true,value:visualRequest});}catch{}
  try{Object.defineProperty(runtime,'webkitRequestFullscreen',{configurable:true,writable:true,value:visualRequest});}catch{}
  const escape=()=>{exitElementFullscreen();syncBurst();};document.addEventListener('fullscreenchange',escape);document.addEventListener('webkitfullscreenchange',escape);
}
function installRuntimeStateRecovery(){if(!document.body)return;new MutationObserver(()=>{enforceRuntimeLayers();scheduleViewportSync(true);}).observe(document.body,{attributes:true,attributeFilter:['data-state']});enforceRuntimeLayers();}
function installHeaderRecovery(){ensureHeaderChrome();const navbar=document.querySelector('#libraryView .navbar');if(!navbar)return;let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;ensureHeaderChrome();});}).observe(navbar,{childList:true,subtree:true});}
function installViewportRecovery(){
  root.dataset.r360MobileFix='44.25';ensureFreshUiLayer();ensureAppIcon();installHeaderRecovery();installStableIOSFullscreen();installRuntimeStateRecovery();scheduleViewportSync(true);
  globalThis.addEventListener('orientationchange',syncBurst,{passive:true});
  globalThis.addEventListener('resize',()=>scheduleViewportSync(),{passive:true});
  globalThis.visualViewport?.addEventListener('resize',()=>scheduleViewportSync(),{passive:true});
  globalThis.visualViewport?.addEventListener('scroll',()=>scheduleViewportSync(),{passive:true});
  globalThis.addEventListener('pageshow',()=>scheduleViewportSync(true),{passive:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleViewportSync(true);});
  try{matchMedia('(orientation: landscape)').addEventListener?.('change',syncBurst);}catch{}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installViewportRecovery,{once:true});else installViewportRecovery();
