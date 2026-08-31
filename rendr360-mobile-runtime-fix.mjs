// Rendr360 V44.23 — iPhone visual-viewport, chrome and rotation recovery.
// Presentation-only: keeps the emulator runtime state intact while Safari changes
// visual viewport geometry, rotates, collapses toolbars, or attempts fullscreen.

const $=id=>document.getElementById(id);
const root=document.documentElement;
const RUNTIME_STATES=new Set(['BOOTING_GAME','RUNNING','PAUSED']);
const IOS_WEBKIT=/iPhone|iPad|iPod/i.test(navigator.userAgent||'')||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const STANDALONE=globalThis.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true;
let lastKey='';
let rotateTimer=0;

function readViewport(){
  const vv=globalThis.visualViewport;
  const width=Math.max(1,Math.round(vv?.width||globalThis.innerWidth||root.clientWidth||1));
  const height=Math.max(1,Math.round(vv?.height||globalThis.innerHeight||root.clientHeight||1));
  const x=Math.max(0,Math.round(vv?.offsetLeft||0));
  const y=Math.max(0,Math.round(vv?.offsetTop||0));
  return {width,height,x,y};
}
function runtimeState(){return String(document.body?.dataset?.state||'');}
function runtimeActive(){
  const runtime=$('runtimeView');
  return RUNTIME_STATES.has(runtimeState())||Boolean(runtime&&!runtime.classList.contains('hidden'));
}

function ensureFreshUiLayer(){
  const desired=new URL('./ui-v44-mobile-fix.css?v=44.23',import.meta.url).href;
  for(const link of [...document.querySelectorAll('link[rel="stylesheet"]')]){
    if(String(link.href).includes('ui-v44-mobile-fix.css'))link.remove();
  }
  // Append after index.html's critical first-paint style so the current mobile
  // layer becomes authoritative once JavaScript is ready. This prevents old
  // inline V44.19 !important rules from flattening the runtime pill/layout.
  const link=document.createElement('link');
  link.rel='stylesheet';link.href=desired;link.dataset.r360XeniosUi='mobile';
  document.head.appendChild(link);
}

function profileSvg(){return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.25"></circle><circle cx="12" cy="9" r="3.15"></circle><path d="M6.9 18.2c.9-3 2.7-4.5 5.1-4.5s4.2 1.5 5.1 4.5"></path></svg>';}
function ensureHeaderChrome(){
  const nav=document.querySelector('#libraryView .nav-row');if(!nav)return;
  let brand=nav.querySelector('.r360-brand');
  let title=brand?.querySelector(':scope > .nav-title')||nav.querySelector(':scope > .nav-title');
  if(!brand){brand=document.createElement('div');brand.className='r360-brand';if(title)title.replaceWith(brand);else nav.prepend(brand);if(title)brand.appendChild(title);}
  if(!title){title=document.createElement('div');title.className='nav-title';brand.prepend(title);}
  if(!title.querySelector('.r360-name')||!title.querySelector('.r360-360'))title.innerHTML='<span class="r360-name">Rendr</span><span class="r360-360">360</span>';

  const sync=$('runtimeSyncStatus');if(sync&&!sync.closest('.r360-brand'))brand.appendChild(sync);
  const text=$('runtimeSyncText');if(text){const remember=()=>{const raw=String(text.textContent||'').trim();if(raw)text.title=raw;};remember();if(!text.dataset.r360Observed){text.dataset.r360Observed='1';new MutationObserver(remember).observe(text,{childList:true,characterData:true,subtree:true});}}

  let actions=nav.querySelector('.nav-actions');if(!actions){actions=document.createElement('div');actions.className='nav-actions';nav.appendChild(actions);}
  const settings=$('settingsButton');
  let profile=$('profileButton');
  if(!profile){profile=document.createElement('button');profile.id='profileButton';profile.type='button';profile.setAttribute('aria-label','Profile');profile.title='Profile';profile.innerHTML=profileSvg();}
  if(settings&&settings.parentElement!==actions)actions.appendChild(settings);
  if(profile.parentElement!==actions)actions.appendChild(profile);
  if(settings&&settings.nextElementSibling!==profile)actions.insertBefore(profile,settings.nextElementSibling);
}

function ensureAppIcon(){
  const href=new URL('./rendr360-apple-touch-icon.png?v=44.23',import.meta.url).href;
  let icon=document.querySelector('link[rel="apple-touch-icon"]');
  if(!icon){icon=document.createElement('link');icon.rel='apple-touch-icon';document.head.appendChild(icon);}
  icon.setAttribute('sizes','180x180');icon.href=href;
  let shortcut=document.querySelector('link[rel="shortcut icon"]');
  if(!shortcut){shortcut=document.createElement('link');shortcut.rel='shortcut icon';document.head.appendChild(shortcut);}
  shortcut.href=href;shortcut.type='image/png';
}

function enforceRuntimeLayers(){
  const active=runtimeActive();
  document.body?.classList.toggle('r360-runtime-active',active);
  if(!active)return;
  const state=runtimeState(),runtime=$('runtimeView');if(!runtime)return;
  if(RUNTIME_STATES.has(state)){
    for(const id of ['libraryView','detailView','gameSettingsView','appSettingsView'])$(id)?.classList.add('hidden');
    runtime.classList.remove('hidden');
  }
  runtime.style.setProperty('z-index','1000','important');
  const controls=$('controllerLayer');
  if(controls){controls.style.setProperty('display','block','important');controls.style.setProperty('visibility','visible','important');if(state!=='PAUSED')controls.style.setProperty('opacity','1','important');}
}

function syncViewport(force=false){
  const {width,height,x,y}=readViewport();
  const key=`${width}x${height}@${x},${y}`;
  if(!force&&key===lastKey)return;
  lastKey=key;
  root.style.setProperty('--r360-vw',`${width}px`);
  root.style.setProperty('--r360-vh',`${height}px`);
  root.style.setProperty('--r360-vx',`${x}px`);
  root.style.setProperty('--r360-vy',`${y}px`);
  root.style.setProperty('--app-height',`${height}px`);
  root.dataset.r360Orientation=width>=height?'landscape':'portrait';

  enforceRuntimeLayers();
  const runtime=$('runtimeView');
  if(runtimeActive()&&runtime){
    runtime.style.setProperty('position','fixed','important');
    runtime.style.setProperty('left',`${x}px`,'important');
    runtime.style.setProperty('top',`${y}px`,'important');
    runtime.style.setProperty('right','auto','important');
    runtime.style.setProperty('bottom','auto','important');
    runtime.style.setProperty('width',`${width}px`,'important');
    runtime.style.setProperty('height',`${height}px`,'important');
    runtime.style.setProperty('margin','0','important');

    const stage=runtime.querySelector('.runtime-stage');
    if(stage){stage.style.setProperty('width','100%','important');stage.style.setProperty('height','100%','important');stage.style.setProperty('inset','0','important');void stage.offsetWidth;}
    for(const id of ['gpuCanvas','titleFrameCanvas']){const canvas=$(id);if(canvas){canvas.style.setProperty('width','100%','important');canvas.style.setProperty('height','100%','important');canvas.style.setProperty('inset','0','important');}}
    const overlay=$('bootOverlay');if(overlay){overlay.style.setProperty('width','100%','important');overlay.style.setProperty('height','100%','important');overlay.style.setProperty('inset','0','important');}
    const card=runtime.querySelector('.boot-card');if(card){card.style.removeProperty('left');card.style.removeProperty('top');card.style.removeProperty('transform');}
    const controls=$('controllerLayer');if(controls){controls.style.setProperty('width','100%','important');controls.style.setProperty('height','100%','important');controls.style.setProperty('inset','0','important');}
  }
  globalThis.dispatchEvent(new CustomEvent('render360:viewportChanged',{detail:{width,height,x,y,orientation:width>=height?'landscape':'portrait'}}));
}

function markRotating(){
  document.body?.classList.add('r360-rotating');clearTimeout(rotateTimer);
  rotateTimer=setTimeout(()=>document.body?.classList.remove('r360-rotating'),1450);
}
function syncBurst(){
  markRotating();
  for(const delay of [0,30,70,120,200,320,500,750,1050,1400])setTimeout(()=>{syncViewport(true);requestAnimationFrame(()=>syncViewport(true));},delay);
}

function installStableIOSFullscreen(){
  if(!IOS_WEBKIT||STANDALONE)return;
  const runtime=$('runtimeView');if(!runtime||runtime.dataset.r360VisualFullscreen==='1')return;
  runtime.dataset.r360VisualFullscreen='1';
  if(typeof runtime.requestFullscreen==='function'){
    try{Object.defineProperty(runtime,'requestFullscreen',{configurable:true,value:async()=>{root.classList.add('r360-visual-fullscreen');syncBurst();return undefined;}});}catch{}
  }
  // If WebKit entered element fullscreen before this guard won the race, leave
  // it and keep Rendr360 edge-to-edge inside the visual viewport instead.
  document.addEventListener('fullscreenchange',()=>{
    if(document.fullscreenElement&&runtimeActive())void document.exitFullscreen?.().catch(()=>{});
    syncBurst();
  });
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
  root.dataset.r360MobileFix='44.23';
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
