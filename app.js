import {Render360Core, containerName, compressionName, encryptionName} from './wasm-core.js';
import {WebGraphicsHost} from './gpu-web.js';
import {RuntimeHost} from './runtime-host.js';
import {ThreeDiagnosticHost} from './three-host.js';

const $ = id => document.getElementById(id);
const logs = [];
const core = new Render360Core();
const live = {gpuFps:0, threeFps:0, workerHz:0, ticks:0, work:0, checksum:0, worker:false};

function log(level, ...parts) {
  const stamp = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  const text = `${stamp}  ${level.toUpperCase()}  ${parts.join(' ')}`;
  logs.push({level,text});
  if (logs.length > 700) logs.shift();
  renderLogs();
}

function renderLogs(){
  $('logCount').textContent = String(logs.length);
  $('consoleBody').innerHTML = logs.map(x=>`<div class="log ${x.level}">${escapeHtml(x.text)}</div>`).join('');
  $('consoleBody').scrollTop = $('consoleBody').scrollHeight;
}

function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function formatBytes(n){if(n<1024)return `${n} B`;if(n<1048576)return `${(n/1024).toFixed(1)} KB`;if(n<1073741824)return `${(n/1048576).toFixed(1)} MB`;return `${(n/1073741824).toFixed(2)} GB`}
function hex(n, width=8){return `0x${(n>>>0).toString(16).toUpperCase().padStart(width,'0')}`}
function openSheet(id){$('scrim').classList.remove('hidden');$(id).classList.remove('hidden')}
function closeSheets(){$('scrim').classList.add('hidden');$('consoleSheet').classList.add('hidden');$('statusSheet').classList.add('hidden')}
function setDetail(id, value){$(id).textContent = value}

function renderTelemetry(){
  $('runtimeStatus').textContent = live.worker ? `${live.workerHz.toFixed(0)} Hz` : 'Starting…';
  $('runtimeTicks').textContent = live.worker ? live.ticks.toLocaleString() : '—';
  $('runtimeWork').textContent = live.worker ? live.work.toLocaleString() : '—';
  $('gpuFps').textContent = live.gpuFps ? `${live.gpuFps.toFixed(0)} FPS` : '—';
  $('threeFps').textContent = live.threeFps ? `${live.threeFps.toFixed(0)} FPS` : '—';
  $('liveTelemetry').innerHTML = `<span class="tele-dot"></span><b>WASM WORKER ${live.worker ? live.workerHz.toFixed(0)+'Hz' : 'STARTING'}</b><span>GPU ${live.gpuFps ? live.gpuFps.toFixed(0)+'fps' : '—'}</span><span>THREE ${live.threeFps ? live.threeFps.toFixed(0)+'fps' : '—'}</span>`;
}

const gpu = new WebGraphicsHost($('gpuCanvas'), log, stats => {live.gpuFps=stats.fps;renderTelemetry()});
const runtime = new RuntimeHost(log, stats => {
  live.worker=true;live.workerHz=stats.hz;live.ticks=stats.ticks;live.work=stats.work;live.checksum=stats.checksum;renderTelemetry();
});
const three = new ThreeDiagnosticHost($('threeCanvas'), log, stats => {live.threeFps=stats.fps;renderTelemetry()});

function resetXexDetails(){
  $('xexDetails').classList.add('hidden');
  for (const id of ['xexTitleId','xexEntry','xexImageBase','xexHeaderSize','xexSecurity','xexOptCount','xexCompression','xexEncryption','xexImageSize','xexLoadAddress']) setDetail(id,'—');
}

function showXexDetails(x) {
  $('xexDetails').classList.remove('hidden');
  setDetail('xexTitleId', x.titleId ? hex(x.titleId) : 'Not found');
  setDetail('xexEntry', x.entryPoint ? hex(x.entryPoint) : 'Not found');
  setDetail('xexImageBase', x.imageBase ? hex(x.imageBase) : 'Not found');
  setDetail('xexHeaderSize', x.headerSize ? formatBytes(x.headerSize) : '—');
  setDetail('xexSecurity', x.securityOffset ? hex(x.securityOffset) : '—');
  setDetail('xexOptCount', String(x.headerCount ?? 0));
  setDetail('xexCompression', x.compressionType === 0xFFFFFFFF ? 'Not found' : compressionName(x.compressionType));
  setDetail('xexEncryption', x.encryptionType === 0xFFFFFFFF ? 'Not found' : encryptionName(x.encryptionType));
  setDetail('xexImageSize', x.imageSize ? formatBytes(x.imageSize) : 'Not parsed');
  setDetail('xexLoadAddress', x.loadAddress ? hex(x.loadAddress) : 'Not parsed');
}

async function boot(){
  log('ok','Render360 Xenia-Web V29 starting');
  const tasks=[];
  tasks.push((async()=>{
    try{
      await core.init();
      $('wasmStatus').textContent='ONLINE';
      $('buildStatus').textContent=`V${core.buildVersion}`;
      $('abiStatus').textContent=`${core.abiVersion>>>16}.${core.abiVersion&0xFFFF}`;
      log('ok',`Main WASM core V${core.buildVersion} · ABI 0x${core.abiVersion.toString(16).padStart(8,'0')} · features 0x${core.featureBits.toString(16)}`);
    }catch(e){$('wasmStatus').textContent='FAILED';log('error',e.message)}
  })());
  tasks.push((async()=>{
    try{const backend=await gpu.init();$('gpuStatus').textContent=backend.toUpperCase()}catch(e){$('gpuStatus').textContent='FAILED';log('error',e.message)}
  })());
  tasks.push((async()=>{
    try{await runtime.init();live.worker=true;$('workerStatus').textContent='ACTIVE';log('ok','Continuous native runtime loop is executing in a Web Worker')}catch(e){$('workerStatus').textContent='FAILED';log('error',`Worker startup failed: ${e.message}`)}
  })());
  tasks.push((async()=>{
    try{const info=await three.init();$('threeStatus').textContent=`r${info.revision}`;}catch{$('threeStatus').textContent='OFFLINE'}
  })());
  await Promise.allSettled(tasks);
  renderTelemetry();
}

$('gameInput').addEventListener('change', async e=>{
  const file=e.target.files?.[0]; if(!file)return;
  resetXexDetails();
  if(!core.exports){log('error','Cannot inspect file: WASM core is offline');return}
  runtime.reset();
  try{
    const probe=await core.probeFile(file), name=containerName(probe.kind);
    $('gameName').textContent=file.name||'Xbox 360 content';
    $('gameType').textContent=name;
    $('gameSize').textContent=formatBytes(file.size);
    $('gameCore').textContent=`WASM V${core.buildVersion}`;
    $('emptyState').classList.add('hidden');$('gameState').classList.remove('hidden');

    if(probe.kind===1||probe.kind===2){
      const x=probe.xex;showXexDetails(x);
      if(x.inspectStatus===1){
        $('boundaryTitle').textContent=`${name} header validated — runtime remains active`;
        $('boundaryText').textContent='The worker, WASM heartbeat and GPU render loops continue running. The next emulator milestone is still the real Xenia XEX image loader: decryption/decompression, PE mapping and imports.';
        log('ok',`${name} validated · flags ${hex(x.moduleFlags)} · header ${hex(x.headerSize)} · security ${hex(x.securityOffset)} · optional ${x.headerCount}`);
        if(x.titleId)log('ok',`XEX execution info · title ${hex(x.titleId)} · media ${hex(x.mediaId)} · entry ${hex(x.entryPoint)} · image base ${hex(x.imageBase)}`);
      }else if(x.inspectStatus===2){
        $('boundaryTitle').textContent=`${name} header needs more bytes`;$('boundaryText').textContent='The XEX magic is valid but the staged WASM prefix was not large enough for the complete header table.';log('warn',`${name} header truncated in staged prefix`);
      }else{$('boundaryTitle').textContent=`${name} header rejected`;$('boundaryText').textContent='Structural validation failed; Render360 does not report malformed state as a successful boot.';log('error',`${name} structural validation failed · status ${x.inspectStatus}`)}
    }else if(probe.kind>=10&&probe.kind<=12){
      $('boundaryTitle').textContent=`${name} package recognized — worker still running`;
      $('boundaryText').textContent='The 360 package is recognized. STFS mounting/default.xex extraction is the next native VFS task; the live worker and graphics loops continue instead of the page becoming idle.';
      log('ok',`${name} package magic recognized · ${formatBytes(file.size)}`);
    }else if(probe.kind===20){
      $('boundaryTitle').textContent='PowerPC ELF recognized — runtime active';$('boundaryText').textContent='The browser worker is alive, but PowerPC execution is not yet wired to Xenia HIR/interpreter code.';log('ok','PowerPC ELF recognized');
    }else{$('boundaryTitle').textContent='Unknown Xbox container';$('boundaryText').textContent='No supported Xbox container magic was recognized by the native WASM core.';log('warn',`Unknown container · first ${probe.bytesRead} bytes inspected`)}
  }catch(err){log('error',`File probe failed: ${err.message}`)}
});

$('ejectButton').onclick=()=>{$('gameInput').value='';$('gameState').classList.add('hidden');$('emptyState').classList.remove('hidden');resetXexDetails();runtime.reset();log('ok','Container ejected; runtime heartbeat reset')};
$('consoleButton').onclick=()=>openSheet('consoleSheet');$('settingsButton').onclick=()=>openSheet('statusSheet');
$('closeConsole').onclick=closeSheets;$('closeStatus').onclick=closeSheets;$('scrim').onclick=closeSheets;
$('clearLogs').onclick=()=>{logs.length=0;renderLogs()};
$('copyLogs').onclick=async()=>{try{await navigator.clipboard.writeText(logs.map(x=>x.text).join('\n'));log('ok','Console copied')}catch{log('warn','Clipboard permission unavailable')}};

document.querySelectorAll('.control').forEach(btn=>{
  const key=btn.dataset.key;
  const down=e=>{e.preventDefault();btn.classList.add('pressed');runtime.setKey(key,true)};
  const up=e=>{e.preventDefault();btn.classList.remove('pressed');runtime.setKey(key,false)};
  btn.addEventListener('pointerdown',down);btn.addEventListener('pointerup',up);btn.addEventListener('pointercancel',up);btn.addEventListener('pointerleave',up);
});

document.addEventListener('visibilitychange',()=>{
  if(document.hidden)log('info','Page hidden · browser may throttle render/worker timers');
  else log('ok','Page visible · full render/runtime cadence restored');
});

boot();
