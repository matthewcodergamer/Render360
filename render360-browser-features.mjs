const PREF_KEY='render360.browserFeatures.v1';
const DEFAULT_PREFS=Object.freeze({
  keepAwake:true,
  fullscreen:true,
  lockLandscape:true,
  controllerRumble:true,
  triggerRumble:true,
  webglGpuTiming:true,
  serviceWorker:true,
});

let prefs=loadPrefs();
let capabilities={};
let swRegistration=null;
let wakeLock=null;
let probeCanvas=null;

function loadPrefs(){
  try{return {...DEFAULT_PREFS,...JSON.parse(localStorage.getItem(PREF_KEY)||'{}')};}
  catch{return {...DEFAULT_PREFS};}
}
function savePrefs(){
  try{localStorage.setItem(PREF_KEY,JSON.stringify(prefs));}catch{}
}
function clamp01(value){return Math.max(0,Math.min(1,Number(value)||0));}
function firstGamepad(){try{return [...(navigator.getGamepads?.()||[])].find(Boolean)||null;}catch{return null;}}
function isStandalone(){return globalThis.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true;}
function canTransferCanvas(){return typeof HTMLCanvasElement!=='undefined'&&typeof HTMLCanvasElement.prototype?.transferControlToOffscreen==='function';}
function webglTimerAvailable(){
  try{
    probeCanvas??=document.createElement('canvas');
    const gl=probeCanvas.getContext('webgl2',{antialias:false,depth:false,stencil:false});
    return !!gl?.getExtension('EXT_disjoint_timer_query_webgl2');
  }catch{return false;}
}
function cap(label,value,detail=''){
  return {label,value:Boolean(value),detail};
}
async function probeCapabilities(){
  const gp=firstGamepad(),actuator=gp?.vibrationActuator||null;
  let storageEstimate=false,persistentStorage=false;
  try{
    storageEstimate=typeof navigator.storage?.estimate==='function';
    persistentStorage=typeof navigator.storage?.persist==='function';
  }catch{}
  capabilities={
    webgpu:cap('WebGPU',!!navigator.gpu,'Preferred Xenos graphics path.'),
    webgpuAsyncPipelines:cap('Async WebGPU Pipelines',typeof globalThis.GPUDevice?.prototype?.createRenderPipelineAsync==='function','Compiles graphics pipelines without blocking the title loop where the browser exposes the async API.'),
    offscreen:cap('OffscreenCanvas',typeof OffscreenCanvas==='function','Allows canvas work away from the main UI thread.'),
    offscreenWorker:cap('Worker canvas',typeof OffscreenCanvas==='function'&&canTransferCanvas(),'Useful for moving graphics work into a worker.'),
    serviceWorker:cap('Service Worker','serviceWorker' in navigator,'App-shell acceleration and offline resilience.'),
    navigationPreload:cap('Navigation Preload',!!swRegistration?.navigationPreload,'Starts navigation fetch while the service worker wakes.'),
    backgroundFetch:cap('Background Fetch',!!(swRegistration&&'backgroundFetch' in swRegistration),'Experimental helper for long downloads; Render360 does not depend on it.'),
    wakeLock:cap('Screen Wake Lock',typeof navigator.wakeLock?.request==='function','Keeps the display awake while a title is running.'),
    orientation:cap('Orientation Lock',typeof screen.orientation?.lock==='function','Requests landscape gameplay where Safari allows it.'),
    fullscreen:cap('Element Fullscreen',!!document.fullscreenEnabled&&typeof document.documentElement.requestFullscreen==='function',isStandalone()?'Installed web app already runs standalone.':'True element fullscreen is platform-dependent on iPhone.'),
    gamepad:cap('Gamepad API',typeof navigator.getGamepads==='function','Physical Xbox/PlayStation controller input.'),
    rumble:cap('Controller Rumble',typeof actuator?.playEffect==='function','Dual-rumble is used only when the connected controller and Safari expose it.'),
    triggerRumble:cap('Trigger Rumble',typeof actuator?.playEffect==='function','Experimental trigger-rumble is attempted only when enabled and supported.'),
    webglTimer:cap('WebGL GPU Timing',webglTimerAvailable(),'Profiles WebGL2 GPU time with EXT_disjoint_timer_query_webgl2.'),
    sharedWorker:cap('SharedWorker',typeof SharedWorker==='function','Available for persistent browser-side services.'),
    streams:cap('Transferable Streams',typeof ReadableStream==='function'&&typeof TransformStream==='function','Lets large title data flow without buffering entire files in memory.'),
    storage:cap('Storage APIs',storageEstimate&&persistentStorage,'Quota and persistence controls for large game files.'),
    opfs:cap('OPFS',typeof navigator.storage?.getDirectory==='function','Range-readable persistent game storage without loading the whole image into JavaScript memory.'),
    crossOriginIsolation:cap('Cross-Origin Isolation',globalThis.crossOriginIsolated===true,'Required for SharedArrayBuffer and Wasm threads.'),
    wasmStreaming:cap('WASM Streaming',typeof WebAssembly?.instantiateStreaming==='function','Compiles runtime modules while they download.'),
    sharedMemory:cap('Shared Memory',globalThis.crossOriginIsolated&&typeof SharedArrayBuffer==='function','Requires cross-origin isolation as well as browser support.'),
    wasmESM:cap('WASM ES Modules',false,'No reliable feature probe from page JavaScript; kept optional until Render360 has a stable ESM-Wasm loader.'),
    fileHandleSerialization:cap('File Handle Serialization',typeof FileSystemHandle!=='undefined','Conditional File System Access capability; not required for OPFS game storage.'),
  };
  renderCapabilities();
  return capabilities;
}

function injectStyles(){
  if(document.getElementById('render360-browser-feature-styles'))return;
  const style=document.createElement('style');
  style.id='render360-browser-feature-styles';
  style.textContent=`
    .r360-feature-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;font-weight:700;padding:5px 8px;border-radius:999px;background:rgba(142,142,147,.14);color:var(--secondary-label,#8e8e93)}
    .r360-feature-status::before{content:'';width:7px;height:7px;border-radius:50%;background:#8e8e93}
    .r360-feature-status.available{color:#30d158;background:rgba(48,209,88,.12)}
    .r360-feature-status.available::before{background:#30d158;box-shadow:0 0 10px rgba(48,209,88,.5)}
    .r360-feature-status.missing{color:#ff9f0a;background:rgba(255,159,10,.12)}
    .r360-feature-status.missing::before{background:#ff9f0a}
    .r360-feature-status.manual{color:#64d2ff;background:rgba(100,210,255,.12)}
    .r360-feature-status.manual::before{background:#64d2ff}
    .r360-browser-note{font-size:12px;line-height:1.45;color:var(--secondary-label,#8e8e93);padding:0 16px 12px}
    .r360-feature-action{font:inherit;color:#30d158;background:none;border:0;padding:0;text-align:right}
    .r360-feature-action:active{opacity:.55}
    .r360-feature-copy small{max-width:560px}
  `;
  document.head.appendChild(style);
}

function rowMarkup(id,title,description,status='Checking…'){
  return `<div class="row"><div class="setting-copy r360-feature-copy"><span>${title}</span><small>${description}</small></div><span id="${id}" class="r360-feature-status">${status}</span></div>`;
}
function switchRow(pref,title,description){
  return `<div class="row"><div class="setting-copy"><span>${title}</span><small>${description}</small></div><label class="switch"><input type="checkbox" data-r360-browser-pref="${pref}"><span></span></label></div>`;
}
function ensureSettingsUi(){
  const body=document.querySelector('#appSettingsView .settings-body');
  if(!body||document.getElementById('r360BrowserFeatureGroup'))return;
  injectStyles();
  const advanced=[...body.querySelectorAll('.group-title')].find(el=>el.textContent.trim()==='Advanced');
  const anchor=advanced||null;
  const frag=document.createDocumentFragment();

  const title=document.createElement('div');
  title.className='group-title';title.textContent='Browser & Safari Acceleration';frag.appendChild(title);
  const group=document.createElement('div');
  group.className='group';group.id='r360BrowserFeatureGroup';
  group.innerHTML=[
    rowMarkup('r360CapWebgpu','WebGPU','Preferred modern graphics backend for the Xenos renderer.'),
    rowMarkup('r360CapWebgpuAsync','Async WebGPU Pipelines','Uses createRenderPipelineAsync/createComputePipelineAsync where available to reduce shader/pipeline stalls.'),
    rowMarkup('r360CapOpfs','OPFS Range Storage','Reads selected game byte ranges from persistent browser storage instead of copying whole images into RAM.'),
    rowMarkup('r360CapIsolation','Cross-Origin Isolation','COOP/COEP gate required for SharedArrayBuffer and Wasm threads.'),
    rowMarkup('r360CapSharedMemory','SharedArrayBuffer / Wasm Threads','Enables the future shared-memory worker execution path when hosting and browser support are both ready.'),
    rowMarkup('r360CapOffscreen','OffscreenCanvas + Workers','Lets compatible rendering work move away from the UI thread.'),
    rowMarkup('r360CapServiceWorker','Service Worker + Navigation Preload','Speeds the app shell while keeping mutable JS/WASM network-first.'),
    rowMarkup('r360CapWake','Screen Wake Lock','Keeps the display awake during gameplay.'),
    rowMarkup('r360CapOrientation','Landscape Lock','Requests landscape where Safari exposes Screen Orientation locking.'),
    rowMarkup('r360CapFullscreen','Fullscreen / Standalone','Uses true fullscreen where available; installed iPhone web apps use standalone mode.'),
    rowMarkup('r360CapGamepad','Physical Gamepad','Reads connected Xbox/PlayStation controllers through the Gamepad API.'),
    rowMarkup('r360CapRumble','Controller Rumble','Uses dual-rumble when the controller and Safari expose vibrationActuator.'),
    rowMarkup('r360CapTriggerRumble','Trigger Rumble','Attempts Safari/WebKit experimental trigger-rumble when available.'),
    rowMarkup('r360CapGpuTiming','WebGL GPU Timer Queries','Measures GPU work on the WebGL2 fallback for performance debugging.'),
    rowMarkup('r360CapBackgroundFetch','Background Fetch','Experimental long-download capability; normal resumable loading remains the fallback.'),
    rowMarkup('r360CapWasmEsm','WebAssembly ES Modules','Experimental loading path. Render360 keeps stable streaming instantiation as the default.'),
    rowMarkup('r360CapFileHandles','File Handle Serialization','Optional file-handle capability; OPFS remains the reliable game-storage path.'),
  ].join('');
  frag.appendChild(group);

  const useTitle=document.createElement('div');
  useTitle.className='group-title';useTitle.textContent='Use Available Browser Features';frag.appendChild(useTitle);
  const useGroup=document.createElement('div');
  useGroup.className='group';
  useGroup.innerHTML=[
    switchRow('keepAwake','Keep Screen Awake','Request a wake lock while a title is booting or running.'),
    switchRow('fullscreen','Fullscreen When Available','Request element fullscreen on supported Safari platforms. iPhone falls back to the standalone/PWA layout.'),
    switchRow('lockLandscape','Lock Landscape','Request landscape after Play when the browser allows orientation locking.'),
    switchRow('controllerRumble','Controller Rumble','Allow the runtime bridge to send dual-rumble effects to supported gamepads.'),
    switchRow('triggerRumble','Trigger Rumble','Allow experimental trigger-rumble effects when WebKit and the controller support them.'),
    switchRow('webglGpuTiming','WebGL GPU Timing','Enable WebGL2 timer queries for the performance HUD/diagnostics when supported.'),
    switchRow('serviceWorker','Service Worker Acceleration','Use navigation preload and an app-shell cache. Runtime JS/WASM stays network-first to avoid stale emulator builds.'),
  ].join('');
  frag.appendChild(useGroup);

  const safariTitle=document.createElement('div');
  safariTitle.className='group-title';safariTitle.textContent='Safari Feature Flags';frag.appendChild(safariTitle);
  const safariGroup=document.createElement('div');
  safariGroup.className='group';
  safariGroup.innerHTML=`
    <div class="row"><div class="setting-copy"><span>WebKit Feature Flags</span><small>A website cannot switch Safari's internal feature flags for you. Render360 detects the resulting APIs and automatically refreshes when you return from Settings.</small></div><span class="r360-feature-status manual">Manual</span></div>
    <button id="r360CopySafariPath" class="row row-button" type="button"><span>Copy iPhone Settings Path</span><span class="chev">›</span></button>
    <button id="r360TestRumble" class="row row-button" type="button"><span>Test Controller Rumble</span><span class="chev">›</span></button>
    <button id="r360RefreshCaps" class="row row-button" type="button"><span>Refresh Capability Check</span><span class="chev">›</span></button>
  `;
  frag.appendChild(safariGroup);
  const note=document.createElement('div');
  note.className='r360-browser-note';
  note.innerHTML='Recommended development flags when they are off: <b>Gamepad.vibrationActuator</b>, <b>Gamepad trigger vibration</b>, <b>Screen Orientation Locking / Unlocking</b>, and <b>WebGL Timer Queries</b>. Background Fetch, WebAssembly ES-module integration, and File System Handle Serialization remain optional experiments.';
  frag.appendChild(note);

  if(anchor)body.insertBefore(frag,anchor);else body.appendChild(frag);
  syncSwitches();
  bindSettingsUi();
}
function syncSwitches(){
  document.querySelectorAll('[data-r360-browser-pref]').forEach(input=>{
    input.checked=!!prefs[input.dataset.r360BrowserPref];
  });
}
function setStatus(id,available,availableText='Available',missingText='Unavailable',manual=false){
  const el=document.getElementById(id);if(!el)return;
  el.className=`r360-feature-status ${manual?'manual':available?'available':'missing'}`;
  el.textContent=manual?availableText:(available?availableText:missingText);
}
function renderCapabilities(){
  setStatus('r360CapWebgpu',capabilities.webgpu?.value);
  setStatus('r360CapWebgpuAsync',capabilities.webgpuAsyncPipelines?.value,'Async ready','Sync fallback');
  setStatus('r360CapOpfs',capabilities.opfs?.value,'Range ready','Unavailable');
  setStatus('r360CapIsolation',capabilities.crossOriginIsolation?.value,'Isolated','Headers missing');
  setStatus('r360CapSharedMemory',capabilities.sharedMemory?.value,'Thread-ready','Cooperative fallback');
  setStatus('r360CapOffscreen',capabilities.offscreen?.value&&capabilities.offscreenWorker?.value);
  setStatus('r360CapServiceWorker',capabilities.serviceWorker?.value,capabilities.navigationPreload?.value?'Preload ready':'Available');
  setStatus('r360CapWake',capabilities.wakeLock?.value);
  setStatus('r360CapOrientation',capabilities.orientation?.value);
  setStatus('r360CapFullscreen',capabilities.fullscreen?.value||isStandalone(),isStandalone()?'Standalone':'Available','iPhone fallback');
  setStatus('r360CapGamepad',capabilities.gamepad?.value,firstGamepad()?'Connected':'API ready','Unavailable');
  setStatus('r360CapRumble',capabilities.rumble?.value,capabilities.rumble?.value?'Ready':'',firstGamepad()?'Not exposed':'Connect pad');
  setStatus('r360CapTriggerRumble',capabilities.triggerRumble?.value,capabilities.triggerRumble?.value?'Testable':'',firstGamepad()?'Not exposed':'Connect pad');
  setStatus('r360CapGpuTiming',capabilities.webglTimer?.value);
  setStatus('r360CapBackgroundFetch',capabilities.backgroundFetch?.value,'Available','Flag/API off');
  setStatus('r360CapWasmEsm',false,'Experimental','Manual / optional',true);
  setStatus('r360CapFileHandles',capabilities.fileHandleSerialization?.value,'API visible','Optional');
}
function bindSettingsUi(){
  document.querySelectorAll('[data-r360-browser-pref]').forEach(input=>input.addEventListener('change',async()=>{
    prefs={...prefs,[input.dataset.r360BrowserPref]:input.checked};savePrefs();
    if(input.dataset.r360BrowserPref==='serviceWorker'){
      if(input.checked)await ensureServiceWorker();else await unregisterRender360ServiceWorkers();
    }
    if(input.dataset.r360BrowserPref==='keepAwake'&&!input.checked)await releaseWakeLock();
    await probeCapabilities();
  }));
  document.getElementById('r360CopySafariPath')?.addEventListener('click',async()=>{
    const text='Settings → Apps → Safari → Advanced → Feature Flags';
    try{await navigator.clipboard.writeText(text);flashAction('r360CopySafariPath','Copied Settings Path');}
    catch{globalThis.prompt?.('Safari Feature Flags path',text);}
  });
  document.getElementById('r360TestRumble')?.addEventListener('click',async()=>{
    const ok=await rumble(.7,.35,180);
    flashAction('r360TestRumble',ok?'Rumble Sent':'Rumble Unavailable');
    await probeCapabilities();
  });
  document.getElementById('r360RefreshCaps')?.addEventListener('click',async()=>{await probeCapabilities();flashAction('r360RefreshCaps','Capabilities Refreshed');});
}
function flashAction(id,text){
  const button=document.getElementById(id),span=button?.querySelector('span');if(!span)return;
  const old=span.textContent;span.textContent=text;setTimeout(()=>span.textContent=old,1300);
}

async function ensureServiceWorker(){
  if(!prefs.serviceWorker||!('serviceWorker' in navigator)||!globalThis.isSecureContext)return null;
  try{
    const url=new URL('./render360-sw.js',import.meta.url);
    swRegistration=await navigator.serviceWorker.register(url,{scope:'./',updateViaCache:'none'});
    await swRegistration.update().catch(()=>{});
    if(swRegistration.navigationPreload)await swRegistration.navigationPreload.enable().catch(()=>{});
    return swRegistration;
  }catch(error){
    console.warn('[Render360 Browser] Service worker unavailable:',error);
    return null;
  }
}
async function unregisterRender360ServiceWorkers(){
  try{
    const regs=await navigator.serviceWorker?.getRegistrations?.()||[];
    await Promise.all(regs.filter(r=>r.active?.scriptURL?.includes('render360-sw.js')||r.waiting?.scriptURL?.includes('render360-sw.js')||r.installing?.scriptURL?.includes('render360-sw.js')).map(r=>r.unregister()));
  }catch{}
  swRegistration=null;
}
async function acquireWakeLock(){
  if(!prefs.keepAwake||document.visibilityState!=='visible'||typeof navigator.wakeLock?.request!=='function')return null;
  if(wakeLock&&!wakeLock.released)return wakeLock;
  try{
    wakeLock=await navigator.wakeLock.request('screen');
    wakeLock.addEventListener?.('release',()=>{wakeLock=null;},{once:true});
    return wakeLock;
  }catch{return null;}
}
async function releaseWakeLock(){
  try{await wakeLock?.release?.();}catch{}
  wakeLock=null;
}
async function requestFullscreenForGame(){
  if(!prefs.fullscreen)return false;
  if(isStandalone())return true;
  const target=document.getElementById('runtimeView')||document.documentElement;
  const request=target?.requestFullscreen;
  if(typeof request!=='function')return false;
  try{
    await request.call(target,{keyboardLock:'browser'});
    return true;
  }catch{
    try{await request.call(target);return true;}catch{return false;}
  }
}
async function lockLandscape(){
  if(!prefs.lockLandscape||typeof screen.orientation?.lock!=='function')return false;
  try{await screen.orientation.lock('landscape');return true;}catch{return false;}
}
async function rumble(strong=.55,weak=.25,duration=140){
  if(!prefs.controllerRumble)return false;
  const actuator=firstGamepad()?.vibrationActuator;
  if(typeof actuator?.playEffect!=='function')return false;
  try{
    const result=await actuator.playEffect('dual-rumble',{duration:Math.max(1,Number(duration)||1),startDelay:0,strongMagnitude:clamp01(strong),weakMagnitude:clamp01(weak)});
    return result!=='preempted';
  }catch{return false;}
}
async function triggerRumble(left=.45,right=.45,duration=120){
  if(!prefs.triggerRumble)return false;
  const actuator=firstGamepad()?.vibrationActuator;
  if(typeof actuator?.playEffect!=='function')return false;
  try{
    const result=await actuator.playEffect('trigger-rumble',{duration:Math.max(1,Number(duration)||1),startDelay:0,leftTrigger:clamp01(left),rightTrigger:clamp01(right),strongMagnitude:0,weakMagnitude:0});
    return result!=='preempted';
  }catch{return false;}
}
function gameplayActive(){
  const state=document.body?.dataset?.state;
  return state==='RUNNING'||state==='BOOTING_GAME'||state==='PAUSED';
}
function installGameplayHooks(){
  const play=document.getElementById('playGameButton');
  play?.addEventListener('click',()=>{
    if(prefs.keepAwake)void acquireWakeLock();
    if(prefs.fullscreen){
      const fullscreen=requestFullscreenForGame();
      if(prefs.lockLandscape)void Promise.resolve(fullscreen).finally(()=>lockLandscape());
    }else if(prefs.lockLandscape){
      void lockLandscape();
    }
  },true);
  const observer=new MutationObserver(()=>{
    if(gameplayActive()){if(prefs.keepAwake)void acquireWakeLock();}
    else void releaseWakeLock();
  });
  observer.observe(document.body,{attributes:true,attributeFilter:['data-state']});
}
function installIconLinks(){
  const href=new URL('./render360-app-icon.svg',import.meta.url).href;
  for(const rel of ['icon','mask-icon']){
    let link=document.querySelector(`link[rel="${rel}"]`);
    if(!link){link=document.createElement('link');link.rel=rel;document.head.appendChild(link);}
    link.href=href;if(rel==='icon')link.type='image/svg+xml';if(rel==='mask-icon')link.setAttribute('color','#30d158');
  }
}

async function refresh(){
  ensureSettingsUi();
  await probeCapabilities();
  return capabilities;
}

async function boot(){
  installIconLinks();
  ensureSettingsUi();
  installGameplayHooks();
  if(prefs.serviceWorker)await ensureServiceWorker();
  await probeCapabilities();
  window.addEventListener('focus',refresh);
  window.addEventListener('gamepadconnected',refresh);
  window.addEventListener('gamepaddisconnected',refresh);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible'){void refresh();if(gameplayActive()&&prefs.keepAwake)void acquireWakeLock();}
    else void releaseWakeLock();
  });
  console.log('[Render360 Browser] Safari/WebKit capability bridge active',capabilities);
}

globalThis.render360BrowserFeatures={
  get prefs(){return {...prefs};},
  get capabilities(){return {...capabilities};},
  refresh,rumble,triggerRumble,requestFullscreenForGame,lockLandscape,acquireWakeLock,releaseWakeLock,
  get serviceWorkerRegistration(){return swRegistration;},
};

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else void boot();
