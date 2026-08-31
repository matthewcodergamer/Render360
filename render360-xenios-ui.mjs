const $=id=>document.getElementById(id);

const ICONS={
  // Browser pages cannot call UIKit UIImage(systemName:). Let the Apple
  // system font renderer draw native glyphs instead of bundling lookalike SVGs.
  settings:`<span class="r360-native-ios-symbol r360-native-gear" aria-hidden="true">⚙︎</span>`,
  plus:`<span class="r360-native-ios-symbol r360-native-plus" aria-hidden="true">＋</span>`
};

function addStyle(){
  const sheets=[['base','./ui-v44-xenios.css?v=44.14'],['reference','./ui-v44-xenios-v15.css?v=44.15']];
  for(const [key,href] of sheets){
    if(document.querySelector(`link[data-r360-xenios-ui="${key}"]`))continue;
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

  // XeniOS keeps the primary app chrome on the first row and the add action on
  // the Library title row. This also keeps the gear from visually colliding
  // with the import action.
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
    for(const [cls,glyph] of [['up','⌃'],['down','⌄'],['left','‹'],['right','›']]){
      const node=document.createElement('span');node.className=`r360-stick-guide ${cls}`;node.textContent=glyph;stick.appendChild(node);
    }
  });
}

function installPerformanceHud(){
  const hud=$('performanceHud');if(!hud||hud.dataset.xeniosHud==='2')return;
  hud.dataset.xeniosHud='2';
  // Keep the legacy element IDs because app-v41's updateHud() owns the real
  // runtime telemetry. The V44.14 layer changes layout only, so FPS/CPU/GPU/
  // RAM/PM4/draws still come from actual Render360 telemetry.
  hud.innerHTML=`
    <div class="x-hud-top"><span id="hudGpuName">WebGPU</span><span id="hudResolution">[—×—]</span></div>
    <div class="x-hud-sub"><span id="hudScale">1.00x</span><span id="hudBackend" class="hud-state">WAITING</span><span id="hudRefresh">—Hz</span></div>
    <div class="x-hud-table">
      <span class="label">FPS:</span><b id="hudFps" class="fps-now">0.0</b><span id="hudFpsRange" class="detail">0.0 / 0.0</span>
      <span class="label">Frm:</span><b id="hudFrame">—</b><span id="hudGpu" class="detail">0 swaps</span>
      <span class="label">CPU:</span><b id="hudCpu" class="cpu-now">—</b><span class="detail"><span id="hudPm4">0</span> PM4</span>
      <span class="label">Mem:</span><b id="hudRam" class="mem-now">—</b><span class="detail"><span id="hudDraws">0</span> draws</span>
    </div>
    <canvas id="hudGraph" class="hud-canvas" aria-label="Frame rate history"></canvas>`;
}

let minFps=Infinity,maxFps=0;
function resetHudRange(){
  minFps=Infinity;maxFps=0;
  const range=$('hudFpsRange');if(range)range.textContent='0.0 / 0.0';
  const fps=$('hudFps');if(fps)fps.textContent='0.0';
}
function resolutionFromTelemetry(t){
  const state=t?.state||globalThis.render360ModernTitle||{};
  const frame=state?.frontbufferFrame||{};
  const canvas=$('titleFrameCanvas')||$('gpuCanvas');
  const w=Number(frame.width||canvas?.width||canvas?.clientWidth||0),h=Number(frame.height||canvas?.height||canvas?.clientHeight||0);
  return w&&h?`[${Math.round(w)}×${Math.round(h)}]`:'[—×—]';
}
function onTelemetry(t={}){
  const guestPresented=Boolean(t.realFrame)||Number(t.swaps||0)>0;
  const fps=guestPresented?Number(t.fps||0):0;
  if(fps>0){minFps=Math.min(minFps,fps);maxFps=Math.max(maxFps,fps);if($('hudFpsRange'))$('hudFpsRange').textContent=`${minFps.toFixed(1)} / ${maxFps.toFixed(1)}`;}
  else if(!guestPresented&&$('hudFpsRange'))$('hudFpsRange').textContent='— / —';
  if($('hudResolution'))$('hudResolution').textContent=resolutionFromTelemetry(t);
  if($('hudPipeline'))$('hudPipeline').textContent=`${Number(t.pm4Packets||0).toLocaleString()} PM4`;
}

async function detectGpuLabel(){
  const target=$('hudGpuName');if(!target)return;
  const apple=/iPhone|iPad|Macintosh|Mac OS X/i.test(navigator.userAgent);
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
  console.log('[Render360 V44.15] XeniOS reference geometry, iOS-style chrome, corrected telemetry HUD, and centered developer control active');
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
