import {Render360Core, containerName, compressionName, encryptionName, stfsStatusName} from './wasm-core.js?v=30';
import {WebGraphicsHost} from './gpu-web.js?v=30';
import {RuntimeHost} from './runtime-host.js?v=30';
import {ThreeDiagnosticHost} from './three-host.js?v=30';

const $ = id => document.getElementById(id);
const logs = [];
const core = new Render360Core();
const live = {gpuFps:0, threeFps:0, workerHz:0, ticks:0, work:0, checksum:0, worker:false, renderScale:1, sessionStage:0};

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
function setDetail(id, value){const el=$(id);if(el)el.textContent=value}
function stageName(stage){return ({0:'IDLE',1:'CONTAINER',2:'STFS',3:'DEFAULT.XEX',4:'XEX'})[stage]||`STAGE ${stage}`}

function renderTelemetry(){
  $('runtimeStatus').textContent = live.worker ? `${live.workerHz.toFixed(0)} Hz · ${stageName(live.sessionStage)}` : 'Starting…';
  $('runtimeTicks').textContent = live.worker ? live.ticks.toLocaleString() : '—';
  $('runtimeWork').textContent = live.worker ? live.work.toLocaleString() : '—';
  $('gpuFps').textContent = live.gpuFps ? `${live.gpuFps.toFixed(0)} FPS` : '—';
  $('threeFps').textContent = live.threeFps ? `${live.threeFps.toFixed(0)} FPS` : 'OFF';
  $('renderScale').textContent = `${Math.round(live.renderScale*100)}%`;
  $('liveTelemetry').innerHTML = `<span class="tele-dot"></span><b>WASM ${live.worker ? live.workerHz.toFixed(0)+'Hz' : 'STARTING'} · ${stageName(live.sessionStage)}</b><span>GPU ${live.gpuFps ? live.gpuFps.toFixed(0)+'fps' : '—'}</span><span>SCALE ${Math.round(live.renderScale*100)}%</span>`;
}

const gpu = new WebGraphicsHost($('gpuCanvas'), log, stats => {
  live.gpuFps=stats.fps;live.renderScale=stats.renderScale ?? live.renderScale;renderTelemetry();
});
const runtime = new RuntimeHost(log, stats => {
  live.worker=true;live.workerHz=stats.hz;live.ticks=stats.ticks;live.work=stats.work;live.checksum=stats.checksum;live.sessionStage=stats.sessionStage||0;renderTelemetry();
});
const three = new ThreeDiagnosticHost($('threeCanvas'), log, stats => {live.threeFps=stats.fps;renderTelemetry()});

const perfPresets = {
  performance:{targetFps:30,autoScale:true,minScale:.50,maxScale:.75,scale:.65},
  balanced:{targetFps:30,autoScale:true,minScale:.60,maxScale:.90,scale:.80},
  compatibility:{targetFps:30,autoScale:false,minScale:1,maxScale:1,scale:1},
};
function applyPerformanceProfile(name, announce=false){
  const profile=perfPresets[name]||perfPresets.performance;
  const auto=$('autoScaleToggle')?.checked ?? profile.autoScale;
  gpu.setPerformance({...profile,autoScale:auto});
  live.renderScale=gpu.renderScale;
  try{localStorage.setItem('render360.performanceProfile',name);localStorage.setItem('render360.autoScale',auto?'1':'0')}catch{}
  if(announce)log('ok',`Performance profile ${name} · target ${profile.targetFps} FPS · scale ${Math.round(gpu.renderScale*100)}%${auto?' dynamic':''}`);
  renderTelemetry();
}

function resetXexDetails(){
  $('xexDetails').classList.add('hidden');
  for (const id of ['xexTitleId','xexEntry','xexImageBase','xexHeaderSize','xexSecurity','xexOptCount','xexCompression','xexEncryption','xexImageSize','xexLoadAddress']) setDetail(id,'—');
}
function resetStfsDetails(){
  $('stfsDetails').classList.add('hidden');
  for(const id of ['stfsDisplayName','stfsMountStatus','stfsTitleId','stfsMediaId','stfsHeaderSize','stfsFileTable','stfsBlocks','stfsFormat','stfsEntries','stfsRequests','stfsDefaultXex','stfsDefaultKind'])setDetail(id,'—');
  const list=$('stfsFileList');if(list)list.innerHTML='';
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
function showStfsDetails(stfs, mount=null){
  $('stfsDetails').classList.remove('hidden');
  setDetail('stfsDisplayName',stfs.displayName||'Unnamed package');
  setDetail('stfsMountStatus',stfs.statusName||stfsStatusName(stfs.status));
  setDetail('stfsTitleId',stfs.titleId?hex(stfs.titleId):'Not found');
  setDetail('stfsMediaId',stfs.mediaId?hex(stfs.mediaId):'Not found');
  setDetail('stfsHeaderSize',stfs.headerSize?formatBytes(stfs.headerSize):'—');
  setDetail('stfsFileTable',`${stfs.fileTableBlockCount} block${stfs.fileTableBlockCount===1?'':'s'} @ #${stfs.fileTableBlockNumber}`);
  setDetail('stfsBlocks',stfs.totalBlockCount.toLocaleString());
  setDetail('stfsFormat',stfs.readOnly?'Read-only STFS':'Resilient STFS');
  setDetail('stfsEntries',mount?mount.entries.length.toLocaleString():String(stfs.entryCount??0));
  setDetail('stfsRequests',mount?`${mount.requestCount} reads · ${formatBytes(mount.totalBytesRead)}`:'—');
  if(mount?.defaultXex){
    setDetail('stfsDefaultXex',`${formatBytes(mount.defaultXex.length)} · block ${mount.defaultXex.startBlock}`);
    setDetail('stfsDefaultKind',mount.defaultXexKind===2?'XEX2':mount.defaultXexKind===1?'XEX1':'Unknown');
  }else if(mount){setDetail('stfsDefaultXex','Not found');setDetail('stfsDefaultKind','—')}
  const list=$('stfsFileList');
  if(list&&mount){
    const shown=mount.entries.slice(0,80);
    list.innerHTML=shown.map(e=>`<div class="stfs-file-row"><span>${e.directory?'DIR':'FILE'}</span><b>${escapeHtml(e.name)}</b><em>${e.directory?'':formatBytes(e.length)}</em></div>`).join('') + (mount.entries.length>shown.length?`<div class="stfs-file-more">+ ${mount.entries.length-shown.length} more entries</div>`:'');
  }
}

async function boot(){
  log('ok','Render360 Xenia-Web V30 starting');
  let savedProfile='performance',savedAuto=true;
  try{savedProfile=localStorage.getItem('render360.performanceProfile')||'performance';savedAuto=localStorage.getItem('render360.autoScale')!=='0'}catch{}
  $('performanceProfile').value=perfPresets[savedProfile]?savedProfile:'performance';
  $('autoScaleToggle').checked=savedAuto;
  applyPerformanceProfile($('performanceProfile').value,false);

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
  resetXexDetails();resetStfsDetails();
  if(!core.exports){log('error','Cannot inspect file: WASM core is offline');return}
  runtime.reset();
  three.setEnabled(false);live.threeFps=0;
  try{
    const probe=await core.probeFile(file), name=containerName(probe.kind);
    $('gameName').textContent=file.name||'Xbox 360 content';
    $('gameType').textContent=name;
    $('gameSize').textContent=formatBytes(file.size);
    $('gameCore').textContent=`WASM V${core.buildVersion}`;
    $('emptyState').classList.add('hidden');$('gameState').classList.remove('hidden');
    runtime.setSession({kind:probe.kind,stage:1,titleId:probe.xex?.titleId||0});

    if(probe.kind===1||probe.kind===2){
      const x=probe.xex;showXexDetails(x);runtime.setSession({kind:probe.kind,stage:4,titleId:x.titleId||0});
      if(x.inspectStatus===1){
        $('boundaryTitle').textContent=`${name} header validated — XEX image loader is next`;
        $('boundaryText').textContent='The real XEX header is being interpreted in native WASM. Decryption/decompression, PE image mapping and imports remain strict future work; V30 does not report execution yet.';
        log('ok',`${name} validated · flags ${hex(x.moduleFlags)} · header ${hex(x.headerSize)} · security ${hex(x.securityOffset)} · optional ${x.headerCount}`);
      }else if(x.inspectStatus===2){
        $('boundaryTitle').textContent=`${name} header needs more bytes`;$('boundaryText').textContent='The XEX magic is valid but the staged prefix did not contain the full header table.';log('warn',`${name} header truncated in staged prefix`);
      }else{$('boundaryTitle').textContent=`${name} header rejected`;$('boundaryText').textContent='Structural validation failed; Render360 does not report malformed state as a successful boot.';log('error',`${name} structural validation failed · status ${x.inspectStatus}`)}
    }else if(probe.kind>=10&&probe.kind<=12){
      $('boundaryTitle').textContent=`${name} recognized — native STFS mount running…`;
      $('boundaryText').textContent='The C++/WASM state machine owns the STFS layout, directory parsing and hash-chain traversal. JavaScript only fulfills byte-range requests from the selected File.';
      const mount=await core.mountStfs(file);showStfsDetails(mount.stfs,mount);
      runtime.setSession({kind:probe.kind,stage:mount.mounted?2:1,titleId:mount.stfs.titleId||0});
      log(mount.mounted?'ok':'error',`${name} native mount · ${mount.stfs.statusName} · ${mount.requestCount} browser reads · ${mount.entries.length} entries`);
      if(!mount.mounted){
        $('boundaryTitle').textContent=`${name} native STFS mount stopped`;
        $('boundaryText').textContent=mount.stfs.status===103?'This is an SVOD volume. V30 intentionally stops because the SVOD path has not been ported yet.':`Native mount status: ${mount.stfs.statusName}. Render360 does not turn a failed Xbox structure into a fake success.`;
      }else if(mount.defaultXex){
        runtime.setSession({kind:probe.kind,stage:3,titleId:mount.stfs.titleId||0});
        $('boundaryTitle').textContent='default.xex found by the native STFS mount';
        const kindText=mount.defaultXexKind===2?'XEX2':mount.defaultXexKind===1?'XEX1':'unrecognized';
        $('boundaryText').textContent=`C++/WASM walked ${mount.stfs.directoryBlocksRead} file-table block(s), enumerated ${mount.entries.length} entries, found default.xex at STFS data block ${mount.defaultXex.startBlock}, and probed its first block as ${kindText}. V31 is the full default.xex block-chain extraction/VFS step; decryption, decompression and execution are not claimed yet.`;
        log('ok',`default.xex · ${formatBytes(mount.defaultXex.length)} · data block ${mount.defaultXex.startBlock} · first-block kind ${kindText}`);
        if(mount.partial)log('warn','STFS mounted partially because the directory hash chain ended before the header-declared table count');
      }else{
        $('boundaryTitle').textContent='STFS mounted — default.xex not located';
        $('boundaryText').textContent=`The native mount parsed ${mount.entries.length} file-table entries. This package may be non-executable content, or its directory chain may not contain a root default.xex.`;
        log('warn',`STFS mounted · ${mount.entries.length} entries · default.xex not found`);
      }
    }else if(probe.kind===20){
      $('boundaryTitle').textContent='PowerPC ELF recognized — runtime active';$('boundaryText').textContent='The browser worker is alive, but PowerPC execution is not yet wired to Xenia HIR/interpreter code.';log('ok','PowerPC ELF recognized');
    }else{
      $('boundaryTitle').textContent='Unknown Xbox container';$('boundaryText').textContent='No supported Xbox container magic was recognized by the native WASM core.';log('warn',`Unknown container · first ${probe.bytesRead} bytes inspected`);
    }
  }catch(err){
    $('boundaryTitle').textContent='Native mount/inspection stopped';$('boundaryText').textContent=err.message;
    log('error',`File mount/probe failed: ${err.message}`);
  }
  renderTelemetry();
});

$('ejectButton').onclick=()=>{
  $('gameInput').value='';$('gameState').classList.add('hidden');$('emptyState').classList.remove('hidden');resetXexDetails();resetStfsDetails();runtime.reset();runtime.setSession({});three.setEnabled(true);live.threeFps=0;log('ok','Container ejected; native runtime session reset');
};
$('consoleButton').onclick=()=>openSheet('consoleSheet');$('settingsButton').onclick=()=>openSheet('statusSheet');
$('closeConsole').onclick=closeSheets;$('closeStatus').onclick=closeSheets;$('scrim').onclick=closeSheets;
$('clearLogs').onclick=()=>{logs.length=0;renderLogs()};
$('copyLogs').onclick=async()=>{try{await navigator.clipboard.writeText(logs.map(x=>x.text).join('\n'));log('ok','Console copied')}catch{log('warn','Clipboard permission unavailable')}};
$('performanceProfile').addEventListener('change',()=>applyPerformanceProfile($('performanceProfile').value,true));
$('autoScaleToggle').addEventListener('change',()=>applyPerformanceProfile($('performanceProfile').value,true));

document.querySelectorAll('.control').forEach(btn=>{
  const key=btn.dataset.key;
  const down=e=>{e.preventDefault();btn.classList.add('pressed');runtime.setKey(key,true)};
  const up=e=>{e.preventDefault();btn.classList.remove('pressed');runtime.setKey(key,false)};
  btn.addEventListener('pointerdown',down);btn.addEventListener('pointerup',up);btn.addEventListener('pointercancel',up);btn.addEventListener('pointerleave',up);
});

document.addEventListener('visibilitychange',()=>{
  if(document.hidden)log('info','Page hidden · iOS/browser may throttle render and worker timers');
  else log('ok','Page visible · render/runtime cadence restored');
});

boot();
