const $=id=>document.getElementById(id);

const ICONS={
  settings:`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3.15"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3v-4h.04A1.7 1.7 0 0 0 4.6 8.92a1.7 1.7 0 0 0-.34-1.87L4.2 6.99l2.83-2.83.06.06a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.04V3h4v.04a1.7 1.7 0 0 0 1.04 1.52 1.7 1.7 0 0 0 1.87-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21v4h-.04A1.7 1.7 0 0 0 19.4 15Z"></path></svg>`,
  plus:`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"></path></svg>`
};

function addStyle(){
  const sheets=[
    ['base','./ui-v44-xenios.css?v=44.17'],
    ['reference','./ui-v44-xenios-v16.css?v=44.17'],
    ['mobile','./ui-v44-mobile-fix.css?v=44.17']
  ];
  for(const [key,href] of sheets){
    const old=document.querySelector(`link[data-r360-xenios-ui="${key}"]`);
    if(old){if(old.getAttribute('href')!==href)old.setAttribute('href',href);continue;}
    const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.dataset.r360XeniosUi=key;document.head.appendChild(link);
  }
}

function installSystemIcons(){
  const settings=$('settingsButton'),add=$('importButton');
  if(settings){settings.innerHTML=ICONS.settings;settings.title='Settings';settings.setAttribute('aria-label','Settings');}
  if(add){add.innerHTML=ICONS.plus;add.title='Import Game';add.setAttribute('aria-label','Import Game');}
}

function installLibraryChrome(){
  const navbar=document.querySelector('#libraryView .navbar');
  const nav=navbar?.querySelector('.nav-row'),title=nav?.querySelector(':scope > .nav-title');
  const sync=$('runtimeSyncStatus'),add=$('importButton'),large=navbar?.querySelector(':scope > .nav-title.large');
  if(nav&&title&&!title.closest('.r360-brand')){
    const brand=document.createElement('div');brand.className='r360-brand';title.replaceWith(brand);brand.appendChild(title);if(sync)brand.appendChild(sync);
  }else if(nav&&sync&&nav.querySelector('.r360-brand')&&!sync.closest('.r360-brand'))nav.querySelector('.r360-brand').appendChild(sync);

  if(navbar&&large&&add&&!large.closest('.r360-library-title-row')){
    const row=document.createElement('div');row.className='r360-library-title-row';
    large.replaceWith(row);row.appendChild(large);row.appendChild(add);
  }

  const grid=$('gameGrid'),view=$('libraryView');
  const update=()=>view?.classList.toggle('has-games',Boolean(grid?.querySelector('.game-tile')));
  update();if(grid)new MutationObserver(update).observe(grid,{childList:true,subtree:false});
}

function centerNavigation(){
  const gameNav=document.querySelector('#gameSettingsView .detail-nav');
  if(gameNav&&!gameNav.querySelector('.nav-center-title')){
    const save=$('saveGameSettings'),title=document.createElement('b');title.className='nav-center-title';title.textContent='Game Settings';
    if(save)gameNav.insertBefore(title,save);else gameNav.appendChild(title);
    const cancel=$('gameSettingsBack');if(cancel)cancel.textContent='Cancel';gameNav.classList.add('r360-centered-nav');
  }
  const appNav=document.querySelector('#appSettingsView .detail-nav');
  if(appNav&&!appNav.querySelector('.nav-center-title')){
    const oldSpacer=appNav.querySelector('span');if(oldSpacer){oldSpacer.className='nav-center-title';oldSpacer.textContent='Settings';}
    else{const title=document.createElement('b');title.className='nav-center-title';title.textContent='Settings';appNav.appendChild(title);}
    const done=$('appSettingsBack');if(done)done.textContent='Done';
    const spacer=document.createElement('span');spacer.className='r360-nav-spacer';spacer.setAttribute('aria-hidden','true');appNav.appendChild(spacer);appNav.classList.add('r360-centered-nav');
  }
}

function advancedDisclosure(label,note){
  const details=document.createElement('details');details.className='r360-advanced-settings';
  const summary=document.createElement('summary');
  summary.innerHTML=`<span class="r360-advanced-copy"><span>${label}</span><small>${note}</small></span><span class="r360-disclosure" aria-hidden="true"></span>`;
  const content=document.createElement('div');content.className='r360-advanced-content';
  details.append(summary,content);return {details,content};
}
function moveNamedSections(body,content,names){
  const wanted=new Set(names.map(v=>v.toLowerCase()));
  for(const title of [...body.children]){
    if(!title.classList?.contains('group-title'))continue;
    const name=String(title.textContent||'').trim().toLowerCase();if(!wanted.has(name))continue;
    const group=title.nextElementSibling;content.appendChild(title);if(group?.classList?.contains('group'))content.appendChild(group);
  }
}
function compactSettings(){
  const gameBody=document.querySelector('#gameSettingsView .settings-body');
  if(gameBody&&!gameBody.querySelector(':scope > .r360-advanced-settings')){
    const note=gameBody.querySelector('.settings-note');if(note)note.textContent='Per-game overrides. Most titles should stay on the defaults.';
    const {details,content}=advancedDisclosure('Advanced Settings','Graphics workarounds, CPU and developer options');
    moveNamedSections(gameBody,content,['Graphics Workarounds','CPU & Kernel','Advanced']);gameBody.appendChild(details);
  }
  const appBody=document.querySelector('#appSettingsView .settings-body');
  if(appBody&&!appBody.querySelector(':scope > .r360-advanced-settings')){
    const note=appBody.querySelector('.settings-note');if(note)note.textContent='Defaults for every game. Change only what you need.';
    const {details,content}=advancedDisclosure('Advanced Settings','Storage, diagnostics and developer options');
    moveNamedSections(appBody,content,['Library & Game Storage','Advanced','Runtime Contract']);appBody.appendChild(details);
  }
}
function collectInjectedAdminSections(){
  const appBody=document.querySelector('#appSettingsView .settings-body'),details=appBody?.querySelector(':scope > .r360-advanced-settings'),content=details?.querySelector('.r360-advanced-content');
  if(!appBody||!content)return;
  for(const title of [...appBody.children]){
    if(!title.classList?.contains('group-title'))continue;
    const name=String(title.textContent||'').trim();
    if(!/owner|admin|developer|runtime contract/i.test(name))continue;
    const group=title.nextElementSibling;content.appendChild(title);if(group?.classList?.contains('group'))content.appendChild(group);
  }
}
function watchSettingsInjection(){
  const body=document.querySelector('#appSettingsView .settings-body');if(!body)return;
  new MutationObserver(()=>collectInjectedAdminSections()).observe(body,{childList:true,subtree:false});collectInjectedAdminSections();
}

function installStickGuides(){
  document.querySelectorAll('.stick').forEach(stick=>{
    if(stick.querySelector('.r360-stick-guide'))return;
    for(const cls of ['up','down','left','right']){
      const node=document.createElement('span');node.className=`r360-stick-guide ${cls}`;node.setAttribute('aria-hidden','true');stick.appendChild(node);
    }
  });
}

function installPerformanceHud(){
  const hud=$('performanceHud');if(!hud||hud.dataset.xeniosHud==='3')return;
  hud.dataset.xeniosHud='3';
  hud.innerHTML=`
    <div class="x-hud-top"><span id="hudGpuName">WebGPU</span><span id="hudResolution">[—×—]</span></div>
    <div class="x-hud-sub"><span id="hudScale">1.00x</span><span id="hudBackend" class="hud-state">WAITING</span><span id="hudRefresh">—Hz</span></div>
    <div class="x-hud-table">
      <span class="label">FPS:</span><b id="hudFps" class="fps-now">—</b><span id="hudFpsRange" class="detail">— / —</span>
      <span class="label">Frm:</span><b id="hudFrame">—</b><span id="hudGpu" class="detail">0 swaps</span>
      <span class="label">CPU:</span><b id="hudCpu" class="cpu-now">—</b><span class="detail"><span id="hudPm4">0</span> PM4</span>
      <span class="label">Mem:</span><b id="hudRam" class="mem-now">—</b><span class="detail"><span id="hudDraws">0</span> draws</span>
    </div>
    <canvas id="hudGraph" class="hud-canvas" aria-label="Guest frame-rate history"></canvas>`;
}

let minFps=Infinity,maxFps=0,guestFrameVerified=false;
function resetHudRange(){
  minFps=Infinity;maxFps=0;guestFrameVerified=false;
  if($('hudFpsRange'))$('hudFpsRange').textContent='— / —';
  if($('hudFps'))$('hudFps').textContent='—';
  if($('hudFrame'))$('hudFrame').textContent='—';
  if($('hudBackend'))$('hudBackend').textContent='WAITING';
  enforceBootOverlay();
}
function resolutionFromTelemetry(t){
  const state=t?.state||globalThis.render360ModernTitle||{};
  const frame=state?.frontbufferFrame||{};
  const canvas=$('titleFrameCanvas')||$('gpuCanvas');
  const w=Number(frame.width||canvas?.width||canvas?.clientWidth||0),h=Number(frame.height||canvas?.height||canvas?.clientHeight||0);
  return w&&h?`[${Math.round(w)}×${Math.round(h)}]`:'[—×—]';
}
function onTelemetry(t={}){
  const swaps=Number(t.swaps||0),guestPresented=Boolean(t.realFrame)||swaps>0;
  if(t.realFrame)guestFrameVerified=true;
  const fps=guestPresented?Number(t.fps||0):0;
  const frameMs=guestPresented?Number(t.frameMs||0):0;
  const hud=$('performanceHud');if(hud)hud.dataset.guestPresented=guestPresented?'1':'0';

  if($('hudFps'))$('hudFps').textContent=guestPresented&&fps>0?fps.toFixed(1):'—';
  if($('hudFrame'))$('hudFrame').textContent=guestPresented&&frameMs>0?`${frameMs.toFixed(1)} ms`:'—';
  if($('hudBackend'))$('hudBackend').textContent=guestPresented?(t.realFrame?'REAL FRAME':'PRESENTING'):'CPU ONLY';
  if($('hudGpu'))$('hudGpu').textContent=t.gpuMs&&guestPresented?`${Number(t.gpuMs).toFixed(2)} ms`:`${swaps} swaps`;
  if($('hudPm4'))$('hudPm4').textContent=Number(t.pm4Packets||0).toLocaleString();
  if($('hudDraws'))$('hudDraws').textContent=Number(t.draws||0).toLocaleString();
  if($('hudScale'))$('hudScale').textContent=`${Number(t.scale||1).toFixed(2)}x`;

  if(guestPresented&&fps>0){
    minFps=Math.min(minFps,fps);maxFps=Math.max(maxFps,fps);
    if($('hudFpsRange'))$('hudFpsRange').textContent=`${minFps.toFixed(1)} / ${maxFps.toFixed(1)}`;
  }else if($('hudFpsRange'))$('hudFpsRange').textContent='— / —';
  if($('hudResolution'))$('hudResolution').textContent=resolutionFromTelemetry(t);
  enforceBootOverlay();
}

function enforceBootOverlay(){
  const overlay=$('bootOverlay'),runtimeView=$('runtimeView');if(!overlay||!runtimeView)return;
  const runtimeVisible=!runtimeView.classList.contains('hidden');
  if(runtimeVisible&&!guestFrameVerified&&overlay.classList.contains('frame-live'))overlay.classList.remove('frame-live');
}
function installBootOverlayGuard(){
  const overlay=$('bootOverlay');if(!overlay)return;
  new MutationObserver(()=>{if(!guestFrameVerified&&overlay.classList.contains('frame-live'))queueMicrotask(enforceBootOverlay);}).observe(overlay,{attributes:true,attributeFilter:['class']});
  enforceBootOverlay();
}

function syncMobileViewport(){
  const vv=globalThis.visualViewport;
  const width=Math.max(1,Math.round(vv?.width||innerWidth||document.documentElement.clientWidth||1));
  const height=Math.max(1,Math.round(vv?.height||innerHeight||document.documentElement.clientHeight||1));
  const root=document.documentElement;
  root.style.setProperty('--r360-vw',`${width}px`);root.style.setProperty('--r360-vh',`${height}px`);root.style.setProperty('--app-height',`${height}px`);
  enforceBootOverlay();
}
function installViewportRecovery(){
  const syncBurst=()=>{for(const delay of [0,60,180,360,700])setTimeout(syncMobileViewport,delay);};
  syncMobileViewport();
  globalThis.addEventListener('resize',syncMobileViewport,{passive:true});
  globalThis.addEventListener('orientationchange',syncBurst,{passive:true});
  globalThis.addEventListener('fullscreenchange',syncBurst,{passive:true});
  globalThis.visualViewport?.addEventListener('resize',syncMobileViewport,{passive:true});
  globalThis.visualViewport?.addEventListener('scroll',syncMobileViewport,{passive:true});
}

async function detectGpuLabel(){
  const target=$('hudGpuName');if(!target)return;
  const apple=/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(`${navigator.userAgent||''} ${navigator.platform||''}`);
  let label=apple?'Apple GPU':'WebGPU';
  try{
    if(navigator.gpu?.requestAdapter){
      const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'}),info=adapter?.info||{};
      const disclosed=String(info.device||info.description||info.architecture||'').trim();
      if(disclosed)label=disclosed;if(apple&&(!disclosed||/^webgpu$/i.test(disclosed)))label='Apple GPU';
    }
  }catch{}
  target.textContent=label.slice(0,26);
}

function estimateRefreshRate(){
  if(!globalThis.requestAnimationFrame)return;
  const samples=[];let prev=0;
  const tick=now=>{
    if(prev){const d=now-prev;if(d>3&&d<45)samples.push(d);}prev=now;
    if(samples.length<48)return requestAnimationFrame(tick);
    samples.sort((a,b)=>a-b);const mid=samples[Math.floor(samples.length/2)]||16.67;
    const hz=Math.max(24,Math.min(240,Math.round(1000/mid))),el=$('hudRefresh');if(el)el.textContent=`${hz}Hz`;
  };requestAnimationFrame(tick);
}

function bindTelemetry(){
  globalThis.addEventListener('render360:telemetry',event=>onTelemetry(event.detail||{}));
  globalThis.addEventListener('render360:framePresented',()=>{guestFrameVerified=true;enforceBootOverlay();});
  globalThis.addEventListener('render360:bootStage',event=>{
    const stage=String(event.detail?.stage||'').toLowerCase();
    if(stage==='launch'||stage==='core'){resetHudRange();}
  });
}

function boot(){
  addStyle();installSystemIcons();installLibraryChrome();centerNavigation();compactSettings();watchSettingsInjection();installStickGuides();installPerformanceHud();installBootOverlayGuard();installViewportRecovery();bindTelemetry();detectGpuLabel();estimateRefreshRate();
  console.log('[Render360 V44.17] deterministic icons, concise settings, Safari rotation recovery and boot-overlay guard active');
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
