const $=id=>document.getElementById(id);

const APPLE_CLIENT=/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(`${navigator.userAgent||''} ${navigator.platform||''}`);
const systemGlyph=(codePoint,fallback)=>APPLE_CLIENT?String.fromCodePoint(codePoint):fallback;
const ICONS={
  // A browser cannot invoke UIKit's UIImage(systemName:). On Apple clients we
  // ask the installed Apple system font to render the SF Symbols private glyph
  // instead of shipping/redrawing Apple's vector artwork. Non-Apple clients get
  // a semantic fallback so the control never becomes a tofu square.
  settings:`<span class="r360-sf-symbol r360-sf-gear" data-symbol-name="gearshape" aria-hidden="true">${systemGlyph(0x1008CC,'⚙︎')}</span>`,
  plus:`<span class="r360-sf-symbol r360-sf-plus" data-symbol-name="plus" aria-hidden="true">${systemGlyph(0x100185,'+')}</span>`
};

function addStyle(){
  const sheets=[['base','./ui-v44-xenios.css?v=44.16'],['reference','./ui-v44-xenios-v16.css?v=44.16']];
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

function installStickGuides(){
  document.querySelectorAll('.stick').forEach(stick=>{
    if(stick.querySelector('.r360-stick-guide'))return;
    // Text is intentionally empty in V44.16. CSS draws deterministic chevrons
    // so the Move arrows don't change shape with the active system font.
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

let minFps=Infinity,maxFps=0;
function resetHudRange(){
  minFps=Infinity;maxFps=0;
  if($('hudFpsRange'))$('hudFpsRange').textContent='— / —';
  if($('hudFps'))$('hudFps').textContent='—';
  if($('hudFrame'))$('hudFrame').textContent='—';
  if($('hudBackend'))$('hudBackend').textContent='WAITING';
}
function resolutionFromTelemetry(t){
  const state=t?.state||globalThis.render360ModernTitle||{};
  const frame=state?.frontbufferFrame||{};
  const canvas=$('titleFrameCanvas')||$('gpuCanvas');
  const w=Number(frame.width||canvas?.width||canvas?.clientWidth||0),h=Number(frame.height||canvas?.height||canvas?.clientHeight||0);
  return w&&h?`[${Math.round(w)}×${Math.round(h)}]`:'[—×—]';
}
function onTelemetry(t={}){
  // This is the critical distinction for the HUD: requestAnimationFrame,
  // workerHz and WebGPU polling are not Xbox 360 frames. A frame exists only
  // after the guest produces a real frontbuffer/presentation or swap.
  const swaps=Number(t.swaps||0),guestPresented=Boolean(t.realFrame)||swaps>0;
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
}

async function detectGpuLabel(){
  const target=$('hudGpuName');if(!target)return;
  const apple=APPLE_CLIENT;
  let label=apple?'Apple GPU':'WebGPU';
  try{
    if(navigator.gpu?.requestAdapter){
      const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'}),info=adapter?.info||{};
      const disclosed=String(info.device||info.description||info.architecture||'').trim();
      if(disclosed)label=disclosed;
      if(apple&&(!disclosed||/^webgpu$/i.test(disclosed)))label='Apple GPU';
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
    samples.sort((a,b)=>a-b);
    const mid=samples[Math.floor(samples.length/2)]||16.67;
    const hz=Math.max(24,Math.min(240,Math.round(1000/mid)));
    const el=$('hudRefresh');if(el)el.textContent=`${hz}Hz`;
  };
  requestAnimationFrame(tick);
}

function bindTelemetry(){
  globalThis.addEventListener('render360:telemetry',event=>onTelemetry(event.detail||{}));
  globalThis.addEventListener('render360:bootStage',event=>{if(String(event.detail?.stage||'').toLowerCase()==='launch')resetHudRange();});
}

function boot(){
  addStyle();installSystemIcons();installLibraryChrome();centerNavigation();installStickGuides();installPerformanceHud();bindTelemetry();detectGpuLabel();estimateRefreshRate();
  console.log('[Render360 V44.16] measured XeniOS controller geometry, Apple system-symbol path, centered chrome, and guest-only FPS telemetry active');
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();