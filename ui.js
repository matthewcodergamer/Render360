const $=id=>document.getElementById(id);

const ICONS={
  settings:`<svg class="r360-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.25"/><path d="M19.1 13.3c.1-.4.1-.9.1-1.3s0-.9-.1-1.3l2-1.55-2-3.45-2.48 1a7.8 7.8 0 0 0-2.25-1.3L14 2.75h-4l-.38 2.65a7.8 7.8 0 0 0-2.25 1.3l-2.47-1-2 3.45 2 1.55c-.07.43-.1.87-.1 1.3s.03.87.1 1.3l-2 1.55 2 3.45 2.47-1a7.8 7.8 0 0 0 2.25 1.3L10 21.25h4l.37-2.65a7.8 7.8 0 0 0 2.25-1.3l2.48 1 2-3.45-2-1.55Z"/></svg>`,
  plus:`<svg class="r360-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16"/></svg>`,
  profile:`<svg class="r360-svg-icon r360-profile-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><circle cx="12" cy="9" r="3.1"/><path d="M5.8 18.5c1.35-3.1 3.45-4.65 6.2-4.65s4.85 1.55 6.2 4.65"/></svg>`
};

function ensureStyles(){
  const sheets=[['xenios','./styles/xenios.css'],['controller','./styles/controller.css']];
  for(const [key,href] of sheets){
    const old=document.querySelector(`link[data-r360-ui="${key}"]`);
    if(old){if(old.getAttribute('href')!==href)old.setAttribute('href',href);continue;}
    const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.dataset.r360Ui=key;document.head.appendChild(link);
  }
}

function installSystemIcons(){
  const settings=$('settingsButton'),add=$('importButton');
  if(settings){settings.innerHTML=ICONS.settings;settings.title='Settings';settings.setAttribute('aria-label','Settings');settings.dataset.r360Role='settings';}
  if(add){add.innerHTML=ICONS.plus;add.title='Import Game';add.setAttribute('aria-label','Import Game');add.dataset.r360Role='import';}
}

function closeProfile(){
  $('profileSheet')?.classList.add('hidden');
  if(!document.querySelector('.sheet:not(.hidden),.alert:not(.hidden)'))$('scrim')?.classList.add('hidden');
}

function installProfile(){
  const nav=document.querySelector('#libraryView .nav-actions'),settings=$('settingsButton');
  if(nav&&!$('profileButton')){
    const button=document.createElement('button');
    button.id='profileButton';button.className='ios-icon-button';button.type='button';button.title='Profile';button.setAttribute('aria-label','Profile');button.dataset.r360Role='profile';button.innerHTML=ICONS.profile;
    if(settings?.nextSibling)nav.insertBefore(button,settings.nextSibling);else nav.appendChild(button);
    button.addEventListener('click',()=>{$('profileSheet')?.classList.remove('hidden');$('scrim')?.classList.remove('hidden');});
  }
  if(!$('profileSheet')){
    const sheet=document.createElement('section');sheet.id='profileSheet';sheet.className='sheet r360-profile-sheet hidden';sheet.setAttribute('aria-label','Profile');
    sheet.innerHTML=`<div class="sheet-handle"></div><div class="sheet-head"><b>Profile</b></div><div class="sheet-content"><div class="r360-profile-avatar">${ICONS.profile}</div><div class="r360-profile-name">Local Player</div><div class="r360-profile-sub">Local Render360 profile · no account required</div><div class="group r360-profile-group"><div class="row"><span>Game Library</span><span class="value">On this device</span></div><div class="row"><span>Cloud Account</span><span class="value">Not connected</span></div></div></div><button id="profileSettingsShortcut" class="sheet-action" type="button">Settings</button><button id="profileDone" class="sheet-action" type="button">Done</button>`;
    $('app')?.appendChild(sheet);
    $('profileDone')?.addEventListener('click',closeProfile);
    $('profileSettingsShortcut')?.addEventListener('click',()=>{closeProfile();$('settingsButton')?.click();});
  }
}

function installLibraryChrome(){
  const navbar=document.querySelector('#libraryView .navbar');
  const nav=navbar?.querySelector('.nav-row'),title=nav?.querySelector(':scope > .nav-title');
  const sync=$('runtimeSyncStatus'),add=$('importButton'),large=navbar?.querySelector(':scope > .nav-title.large');
  if(nav&&title&&!title.closest('.r360-brand')){
    const brand=document.createElement('div');brand.className='r360-brand';title.replaceWith(brand);brand.appendChild(title);if(sync)brand.appendChild(sync);
  }else if(nav&&sync&&nav.querySelector('.r360-brand')&&!sync.closest('.r360-brand'))nav.querySelector('.r360-brand').appendChild(sync);
  if(navbar&&large&&add&&!large.closest('.r360-library-title-row')){
    const row=document.createElement('div');row.className='r360-library-title-row';large.replaceWith(row);row.appendChild(large);row.appendChild(add);
  }
  const grid=$('gameGrid'),view=$('libraryView');
  const update=()=>view?.classList.toggle('has-games',Boolean(grid?.querySelector('.game-tile')));
  update();if(grid)new MutationObserver(update).observe(grid,{childList:true,subtree:false});
}

function centerNavigation(){
  const gameNav=document.querySelector('#gameSettingsView .detail-nav');
  if(gameNav&&!gameNav.querySelector('.nav-center-title')){
    const save=$('saveGameSettings'),title=document.createElement('b');title.className='nav-center-title';title.textContent='Game Settings';if(save)gameNav.insertBefore(title,save);else gameNav.appendChild(title);const cancel=$('gameSettingsBack');if(cancel)cancel.textContent='Cancel';gameNav.classList.add('r360-centered-nav');
  }
  const appNav=document.querySelector('#appSettingsView .detail-nav');
  if(appNav&&!appNav.querySelector('.nav-center-title')){
    const oldSpacer=appNav.querySelector('span');if(oldSpacer){oldSpacer.className='nav-center-title';oldSpacer.textContent='Settings';}else{const title=document.createElement('b');title.className='nav-center-title';title.textContent='Settings';appNav.appendChild(title);}const done=$('appSettingsBack');if(done)done.textContent='Done';const spacer=document.createElement('span');spacer.className='r360-nav-spacer';spacer.setAttribute('aria-hidden','true');appNav.appendChild(spacer);appNav.classList.add('r360-centered-nav');
  }
}

function installStickGuides(){document.querySelectorAll('.stick').forEach(stick=>{if(stick.querySelector('.r360-stick-guide'))return;for(const cls of ['up','down','left','right']){const node=document.createElement('span');node.className=`r360-stick-guide ${cls}`;node.setAttribute('aria-hidden','true');stick.appendChild(node);}});}

function installPerformanceHud(){
  const hud=$('performanceHud');if(!hud||hud.dataset.xeniosHud==='3')return;hud.dataset.xeniosHud='3';
  hud.innerHTML=`<div class="x-hud-top"><span id="hudGpuName">WebGPU</span><span id="hudResolution">[—×—]</span></div><div class="x-hud-sub"><span id="hudScale">1.00x</span><span id="hudBackend" class="hud-state">WAITING</span><span id="hudRefresh">—Hz</span></div><div class="x-hud-table"><span class="label">FPS:</span><b id="hudFps" class="fps-now">—</b><span id="hudFpsRange" class="detail">— / —</span><span class="label">Frm:</span><b id="hudFrame">—</b><span id="hudGpu" class="detail">0 swaps</span><span class="label">CPU:</span><b id="hudCpu" class="cpu-now">—</b><span class="detail"><span id="hudPm4">0</span> PM4</span><span class="label">Mem:</span><b id="hudRam" class="mem-now">—</b><span class="detail"><span id="hudDraws">0</span> draws</span></div><canvas id="hudGraph" class="hud-canvas" aria-label="Runtime activity history"></canvas>`;
}

let minFps=Infinity,maxFps=0;
let hudActivityHistory=[];
let hudGraphMode='cpu';
let lastHudSlices=0;
let lastTelemetryAt=0;

function drawActivityGraph(){
  const c=$('hudGraph'),ctx=c?.getContext('2d');if(!ctx)return;
  const dpr=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.floor(c.clientWidth*dpr)),h=Math.max(1,Math.floor(c.clientHeight*dpr));
  if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
  ctx.clearRect(0,0,w,h);
  if(!hudActivityHistory.length)return;
  const values=hudActivityHistory.map(p=>p.value).filter(Number.isFinite);if(!values.length)return;
  let lo=Math.min(...values),hi=Math.max(...values),center=(lo+hi)/2,span=hi-lo;
  const minimumBand=hudGraphMode==='fps'?Math.max(4,center*.12):Math.max(3,center*.10);
  if(span<minimumBand){const pad=(minimumBand-span)/2;lo-=pad;hi+=pad;span=hi-lo;}
  const topPad=Math.max(.5,span*.12);lo=Math.max(0,lo-topPad);hi+=topPad;span=Math.max(.001,hi-lo);
  ctx.strokeStyle='rgba(48,209,88,.92)';ctx.lineWidth=Math.max(1,dpr);ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();
  hudActivityHistory.forEach((point,i)=>{const x=hudActivityHistory.length<=1?0:i/(hudActivityHistory.length-1)*w;const normalized=Math.max(0,Math.min(1,(point.value-lo)/span));const y=h-normalized*h;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();
}

function resetHudRange(){minFps=Infinity;maxFps=0;hudActivityHistory=[];hudGraphMode='cpu';lastHudSlices=0;lastTelemetryAt=0;if($('hudFpsRange'))$('hudFpsRange').textContent='— / —';if($('hudFps'))$('hudFps').textContent='—';if($('hudFrame'))$('hudFrame').textContent='—';if($('hudBackend'))$('hudBackend').textContent='WAITING';drawActivityGraph();}
function resolutionFromTelemetry(t){const state=t?.state||globalThis.render360ModernTitle||{},frame=state?.frontbufferFrame||{},canvas=$('titleFrameCanvas')||$('gpuCanvas'),w=Number(frame.width||canvas?.width||canvas?.clientWidth||0),h=Number(frame.height||canvas?.height||canvas?.clientHeight||0);return w&&h?`[${Math.round(w)}×${Math.round(h)}]`:'[—×—]';}

function recordHudActivity(t,guestPresented,fps){
  const nextMode=guestPresented&&fps>0?'fps':'cpu';
  if(nextMode!==hudGraphMode){hudGraphMode=nextMode;hudActivityHistory=[];lastHudSlices=Number(t.threadSlices||0);lastTelemetryAt=performance.now();}
  let value=fps;
  if(nextMode==='cpu'){
    const now=performance.now(),workerHz=Math.max(0,Number(t.workerHz||0)),slices=Math.max(0,Number(t.threadSlices||0)),sliceDelta=Math.max(0,slices-lastHudSlices),cadence=lastTelemetryAt?Math.max(0,now-lastTelemetryAt):250;
    const cadencePressure=Math.min(12,Math.abs(cadence-250)*.08);
    value=workerHz+Math.min(30,sliceDelta*2)+cadencePressure;
    lastHudSlices=slices;lastTelemetryAt=now;
  }
  if(Number.isFinite(value)){hudActivityHistory.push({mode:nextMode,value});if(hudActivityHistory.length>70)hudActivityHistory.shift();}
  drawActivityGraph();
}

function onTelemetry(t={}){const swaps=Number(t.swaps||0),guestPresented=Boolean(t.realFrame)||swaps>0,fps=guestPresented?Number(t.fps||0):0,frameMs=guestPresented?Number(t.frameMs||0):0,hud=$('performanceHud');if(hud)hud.dataset.guestPresented=guestPresented?'1':'0';if($('hudFps'))$('hudFps').textContent=guestPresented&&fps>0?fps.toFixed(1):'—';if($('hudFrame'))$('hudFrame').textContent=guestPresented&&frameMs>0?`${frameMs.toFixed(1)} ms`:'—';if($('hudBackend'))$('hudBackend').textContent=guestPresented?(t.realFrame?'REAL FRAME':'PRESENTING'):'CPU ONLY';if($('hudGpu'))$('hudGpu').textContent=t.gpuMs&&guestPresented?`${Number(t.gpuMs).toFixed(2)} ms`:`${swaps} swaps`;if($('hudPm4'))$('hudPm4').textContent=Number(t.pm4Packets||0).toLocaleString();if($('hudDraws'))$('hudDraws').textContent=Number(t.draws||0).toLocaleString();if($('hudScale'))$('hudScale').textContent=`${Number(t.scale||1).toFixed(2)}x`;if(guestPresented&&fps>0){minFps=Math.min(minFps,fps);maxFps=Math.max(maxFps,fps);if($('hudFpsRange'))$('hudFpsRange').textContent=`${minFps.toFixed(1)} / ${maxFps.toFixed(1)}`;}else if($('hudFpsRange'))$('hudFpsRange').textContent='— / —';if($('hudResolution'))$('hudResolution').textContent=resolutionFromTelemetry(t);recordHudActivity(t,guestPresented,fps);}

async function detectGpuLabel(){const target=$('hudGpuName');if(!target)return;let label=/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(`${navigator.userAgent||''} ${navigator.platform||''}`)?'Apple GPU':'WebGPU';try{if(navigator.gpu?.requestAdapter){const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'}),info=adapter?.info||{},disclosed=String(info.device||info.description||info.architecture||'').trim();if(disclosed)label=disclosed;}}catch{}target.textContent=label.slice(0,26);}
function estimateRefreshRate(){if(!globalThis.requestAnimationFrame)return;const samples=[];let prev=0;const tick=now=>{if(prev){const d=now-prev;if(d>3&&d<45)samples.push(d);}prev=now;if(samples.length<32)return requestAnimationFrame(tick);samples.sort((a,b)=>a-b);const mid=samples[Math.floor(samples.length/2)]||16.67,hz=Math.max(24,Math.min(240,Math.round(1000/mid))),el=$('hudRefresh');if(el)el.textContent=`${hz}Hz`;};requestAnimationFrame(tick);}
function bindTelemetry(){globalThis.addEventListener('render360:telemetry',event=>onTelemetry(event.detail||{}));globalThis.addEventListener('render360:bootStage',event=>{if(String(event.detail?.stage||'').toLowerCase()==='launch')resetHudRange();});}

function boot(){ensureStyles();installSystemIcons();installProfile();installLibraryChrome();centerNavigation();installStickGuides();installPerformanceHud();bindTelemetry();detectGpuLabel();estimateRefreshRate();console.log('[Render360] XeniOS-style UI active');}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
