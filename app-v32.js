import {Render360Core, containerName, compressionName, encryptionName, stfsStatusName} from './wasm-core-v32.js';
import {WebGraphicsHost} from './gpu-web.js?v=32';
import {RuntimeHost} from './runtime-host-v32.js';
import {ThreeDiagnosticHost} from './three-host.js?v=32';

const $=id=>document.getElementById(id);
const logs=[];
const core=new Render360Core();
const live={gpuFps:0,threeFps:0,workerHz:0,ticks:0,work:0,checksum:0,worker:false,renderScale:1,sessionStage:0};
let loadedFile=null,loadedSession={kind:0,stage:0,titleId:0},arenaActive=false;
let touchMove={x:0,y:0},rightAnalog={x:0,y:0};
const keys=new Set();

function log(level,...parts){const stamp=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});const text=`${stamp}  ${level.toUpperCase()}  ${parts.join(' ')}`;logs.push({level,text});if(logs.length>700)logs.shift();renderLogs()}
function renderLogs(){$('logCount').textContent=String(logs.length);$('consoleBody').innerHTML=logs.map(x=>`<div class="log ${x.level}">${escapeHtml(x.text)}</div>`).join('');$('consoleBody').scrollTop=$('consoleBody').scrollHeight}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function formatBytes(n){if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`}
function hex(n,width=8){return`0x${(n>>>0).toString(16).toUpperCase().padStart(width,'0')}`}
function openSheet(id){$('scrim').classList.remove('hidden');$(id).classList.remove('hidden')}
function closeSheets(){$('scrim').classList.add('hidden');$('consoleSheet').classList.add('hidden');$('statusSheet').classList.add('hidden')}
function setDetail(id,value){const el=$(id);if(el)el.textContent=value}
function stageName(stage){return stage===90?'ARENA':({0:'IDLE',1:'CONTAINER',2:'STFS',3:'DEFAULT.XEX',4:'XEX READY',5:'FIRST FRAME GATE'})[stage]||`STAGE ${stage}`}
function setGate(id,state,label){const el=$(id);if(!el)return;el.classList.remove('ready','blocked');if(state)el.classList.add(state);const em=el.querySelector('em');if(em)em.textContent=label}
function resetFrameGate(){$('firstFrameGate')?.classList.add('hidden');setDetail('frameGateState','PREPARING');for(const id of['gateExtract','gateXex','gateCpu','gateKernel','gateGpu'])setGate(id,'','WAIT')}
function showFrameGate(mount){$('firstFrameGate')?.classList.remove('hidden');const extracted=!!mount?.defaultXexExtract?.complete,inspected=!!(mount?.defaultXexInspection&&mount.defaultXexInspection.inspectStatus===1);setGate('gateExtract',extracted?'ready':'blocked',extracted?'READY':'FAILED');setGate('gateXex',inspected?'ready':'blocked',inspected?'HEADER READY':'BLOCKED');setGate('gateCpu','blocked','NEEDS WASM BACKEND');setGate('gateKernel','blocked','NEEDS PORT');setGate('gateGpu','blocked','NEEDS WEBGPU');setDetail('frameGateState',extracted&&inspected?'NEXT: PPC BACKEND':'PACKAGE BLOCKED')}

function renderTelemetry(){
  $('runtimeStatus').textContent=live.worker?`${live.workerHz.toFixed(0)} Hz · ${stageName(live.sessionStage)}`:'Starting…';
  $('runtimeTicks').textContent=live.worker?live.ticks.toLocaleString():'—';$('runtimeWork').textContent=live.worker?live.work.toLocaleString():'—';
  $('gpuFps').textContent=live.gpuFps?`${live.gpuFps.toFixed(0)} FPS`:'—';$('threeFps').textContent=live.threeFps?`${live.threeFps.toFixed(0)} FPS`:'OFF';$('renderScale').textContent=`${Math.round(live.renderScale*100)}%`;
  $('liveTelemetry').innerHTML=`<span class="tele-dot"></span><b>WASM ${live.worker?live.workerHz.toFixed(0)+'Hz':'STARTING'} · ${stageName(live.sessionStage)}</b><span>GPU ${live.gpuFps?live.gpuFps.toFixed(0)+'fps':'—'}</span><span>3D ${live.threeFps?live.threeFps.toFixed(0)+'fps':'—'}</span>`;
}

const gpu=new WebGraphicsHost($('gpuCanvas'),log,stats=>{live.gpuFps=stats.fps;live.renderScale=stats.renderScale??live.renderScale;renderTelemetry()});
const runtime=new RuntimeHost(log,stats=>{live.worker=true;live.workerHz=stats.hz;live.ticks=stats.ticks;live.work=stats.work;live.checksum=stats.checksum;live.sessionStage=stats.sessionStage||0;renderTelemetry()});
const three=new ThreeDiagnosticHost($('threeCanvas'),log,stats=>{live.threeFps=stats.fps;renderTelemetry()},stats=>{if(stats.playing)$('arenaScore').textContent=`${stats.score} / 6 ORBS`});

const perfPresets={performance:{targetFps:30,autoScale:true,minScale:.50,maxScale:.75,scale:.65},balanced:{targetFps:30,autoScale:true,minScale:.60,maxScale:.90,scale:.80},compatibility:{targetFps:30,autoScale:false,minScale:1,maxScale:1,scale:1}};
function applyPerformanceProfile(name,announce=false){const profile=perfPresets[name]||perfPresets.performance;const auto=$('autoScaleToggle')?.checked??profile.autoScale;gpu.setPerformance({...profile,autoScale:auto});live.renderScale=gpu.renderScale;try{localStorage.setItem('render360.performanceProfile',name);localStorage.setItem('render360.autoScale',auto?'1':'0')}catch{}if(announce)log('ok',`Performance profile ${name} · target ${profile.targetFps} FPS · scale ${Math.round(gpu.renderScale*100)}%${auto?' dynamic':''}`);renderTelemetry()}

function resetXexDetails(){$('xexDetails').classList.add('hidden');for(const id of['xexTitleId','xexEntry','xexImageBase','xexHeaderSize','xexSecurity','xexOptCount','xexCompression','xexEncryption','xexImageSize','xexLoadAddress'])setDetail(id,'—')}
function resetStfsDetails(){resetFrameGate();$('stfsDetails').classList.add('hidden');for(const id of['stfsDisplayName','stfsMountStatus','stfsTitleId','stfsMediaId','stfsHeaderSize','stfsFileTable','stfsBlocks','stfsFormat','stfsEntries','stfsRequests','stfsDefaultXex','stfsDefaultKind','stfsExtractStatus','stfsExtractCapture'])setDetail(id,'—');const list=$('stfsFileList');if(list)list.innerHTML=''}
function showXexDetails(x){$('xexDetails').classList.remove('hidden');setDetail('xexTitleId',x.titleId?hex(x.titleId):'Not found');setDetail('xexEntry',x.entryPoint?hex(x.entryPoint):'Not found');setDetail('xexImageBase',x.imageBase?hex(x.imageBase):'Not found');setDetail('xexHeaderSize',x.headerSize?formatBytes(x.headerSize):'—');setDetail('xexSecurity',x.securityOffset?hex(x.securityOffset):'—');setDetail('xexOptCount',String(x.headerCount??0));setDetail('xexCompression',x.compressionType===0xFFFFFFFF?'Not found':compressionName(x.compressionType));setDetail('xexEncryption',x.encryptionType===0xFFFFFFFF?'Not found':encryptionName(x.encryptionType));setDetail('xexImageSize',x.imageSize?formatBytes(x.imageSize):'Not parsed');setDetail('xexLoadAddress',x.loadAddress?hex(x.loadAddress):'Not parsed')}
function showStfsDetails(stfs,mount=null){
  $('stfsDetails').classList.remove('hidden');setDetail('stfsDisplayName',stfs.displayName||'Unnamed package');setDetail('stfsMountStatus',stfs.statusName||stfsStatusName(stfs.status));setDetail('stfsTitleId',stfs.titleId?hex(stfs.titleId):'Not found');setDetail('stfsMediaId',stfs.mediaId?hex(stfs.mediaId):'Not found');setDetail('stfsHeaderSize',stfs.headerSize?formatBytes(stfs.headerSize):'—');setDetail('stfsFileTable',`${stfs.fileTableBlockCount} block${stfs.fileTableBlockCount===1?'':'s'} @ #${stfs.fileTableBlockNumber}`);setDetail('stfsBlocks',stfs.totalBlockCount.toLocaleString());setDetail('stfsFormat',stfs.readOnly?'Read-only STFS':'Resilient STFS');setDetail('stfsEntries',mount?mount.entries.length.toLocaleString():String(stfs.entryCount??0));setDetail('stfsRequests',mount?`${mount.requestCount} mount reads · ${formatBytes(mount.totalBytesRead)}`:'—');
  if(mount?.defaultXex){setDetail('stfsDefaultXex',`${formatBytes(mount.defaultXex.length)} · block ${mount.defaultXex.startBlock}`);setDetail('stfsDefaultKind',mount.defaultXexKind===2?'XEX2':mount.defaultXexKind===1?'XEX1':'Unknown')}else if(mount){setDetail('stfsDefaultXex','Not found');setDetail('stfsDefaultKind','—')}
  if(mount?.defaultXexExtract){const ex=mount.defaultXexExtract;setDetail('stfsExtractStatus',`${ex.statusName} · ${ex.blocksDone} blocks`);setDetail('stfsExtractCapture',ex.fullyCaptured?`${formatBytes(ex.bytesDone)} complete`:`${formatBytes(ex.captured.byteLength)} of ${formatBytes(ex.bytesTotal)}`)}
  const list=$('stfsFileList');if(list&&mount){const shown=mount.entries.slice(0,80);list.innerHTML=shown.map(e=>`<div class="stfs-file-row"><span>${e.directory?'DIR':'FILE'}</span><b>${escapeHtml(e.name)}</b><em>${e.directory?'':formatBytes(e.length)}</em></div>`).join('')+(mount.entries.length>shown.length?`<div class="stfs-file-more">+ ${mount.entries.length-shown.length} more entries</div>`:'')}
}

function enterArena(reason='manual'){
  arenaActive=true;$('stage')?.classList.add('arena-active');$('lookZone').classList.remove('hidden');$('arenaHud').classList.remove('hidden');$('gameChip').classList.toggle('hidden',!loadedFile);three.setPlaying(true);three.setEnabled(true);runtime.setSession({kind:loadedSession.kind||0,stage:90,titleId:loadedSession.titleId||0});
  log('ok',`Playable test arena active${reason==='after-load'?' · Xbox content remains mounted/inspected separately':''}`);
}
function leaveArena(){arenaActive=false;$('stage')?.classList.remove('arena-active');$('lookZone').classList.add('hidden');$('arenaHud').classList.add('hidden');$('gameChip').classList.add('hidden');three.setPlaying(false);runtime.setSession(loadedSession);if(loadedFile){$('gameState').classList.remove('hidden');$('emptyState').classList.add('hidden')}else{$('gameState').classList.add('hidden');$('emptyState').classList.remove('hidden')}}
function showLoadedCard(){if(!loadedFile)return;arenaActive=false;$('stage').classList.remove('arena-active');$('lookZone').classList.add('hidden');$('arenaHud').classList.add('hidden');$('gameChip').classList.add('hidden');three.setPlaying(false);$('emptyState').classList.add('hidden');$('gameState').classList.remove('hidden');runtime.setSession(loadedSession)}

async function boot(){
  log('ok','Render360 Xenia-Web V32 starting · complete STFS default.xex streaming enabled');
  let savedProfile='performance',savedAuto=true;try{savedProfile=localStorage.getItem('render360.performanceProfile')||'performance';savedAuto=localStorage.getItem('render360.autoScale')!=='0'}catch{}
  $('performanceProfile').value=perfPresets[savedProfile]?savedProfile:'performance';$('autoScaleToggle').checked=savedAuto;applyPerformanceProfile($('performanceProfile').value,false);
  const tasks=[];
  tasks.push((async()=>{try{await core.init();$('wasmStatus').textContent='ONLINE';$('buildStatus').textContent=`V${core.buildVersion}`;$('abiStatus').textContent=`${core.abiVersion>>>16}.${core.abiVersion&0xFFFF}`;log('ok',`Main WASM core V${core.buildVersion} · ABI 0x${core.abiVersion.toString(16).padStart(8,'0')} · features 0x${core.featureBits.toString(16)}`)}catch(e){$('wasmStatus').textContent='FAILED';log('error',e.message)}})());
  tasks.push((async()=>{try{const backend=await gpu.init();$('gpuStatus').textContent=backend.toUpperCase()}catch(e){$('gpuStatus').textContent='FAILED';log('error',e.message)}})());
  tasks.push((async()=>{try{await runtime.init();live.worker=true;$('workerStatus').textContent='ACTIVE';log('ok','Continuous native runtime loop is executing in a Web Worker')}catch(e){$('workerStatus').textContent='FAILED';log('error',`Worker startup failed: ${e.message}`)}})());
  tasks.push((async()=>{try{const info=await three.init();$('threeStatus').textContent=`r${info.revision}`;three.setPlaying(false)}catch{$('threeStatus').textContent='OFFLINE'}})());
  await Promise.allSettled(tasks);renderTelemetry();
}

$('gameInput').addEventListener('change',async e=>{
  const file=e.target.files?.[0];if(!file)return;loadedFile=file;resetXexDetails();resetStfsDetails();resetFrameGate();if(!core.exports){log('error','Cannot inspect file: WASM core is offline');return}runtime.reset();three.setPlaying(false);
  try{
    const probe=await core.probeFile(file);let name=containerName(probe.kind);const iso=/\.iso$/i.test(file.name||'');if(probe.kind===0&&iso)name='Xbox ISO / XDVDFS';
    $('gameName').textContent=file.name||'Xbox 360 content';$('gameChipName').textContent=file.name||'Xbox content';$('gameType').textContent=name;$('gameSize').textContent=formatBytes(file.size);$('gameCore').textContent=`WASM V${core.buildVersion}`;$('emptyState').classList.add('hidden');$('gameState').classList.remove('hidden');
    loadedSession={kind:probe.kind,stage:1,titleId:probe.xex?.titleId||0};runtime.setSession(loadedSession);
    if(probe.kind===1||probe.kind===2){const x=probe.xex;showXexDetails(x);loadedSession={kind:probe.kind,stage:4,titleId:x.titleId||0};runtime.setSession(loadedSession);if(x.inspectStatus===1){$('boundaryTitle').textContent=`${name} header validated — execution core still required`;$('boundaryText').textContent='The real XEX header is interpreted in native WASM. The browser cannot execute the game until XEX image preparation, PowerPC execution, kernel/XAM and Xenos rendering are ported.';log('ok',`${name} validated · flags ${hex(x.moduleFlags)} · header ${hex(x.headerSize)} · security ${hex(x.securityOffset)} · optional ${x.headerCount}`)}else if(x.inspectStatus===2){$('boundaryTitle').textContent=`${name} header needs more bytes`;$('boundaryText').textContent='The XEX magic is valid but the staged prefix did not contain the full header table.';log('warn',`${name} header truncated in staged prefix`)}else{$('boundaryTitle').textContent=`${name} header rejected`;$('boundaryText').textContent='Structural validation failed.';log('error',`${name} structural validation failed · status ${x.inspectStatus}`)}}
    else if(probe.kind>=10&&probe.kind<=12){
      $('boundaryTitle').textContent=`${name} recognized — mounting + streaming default.xex…`;
      $('boundaryText').textContent='Native C++/WASM is walking the STFS package and will stream the complete default.xex block chain. Keep this page open.';
      let lastPct=-1;
      const mount=await core.mountStfs(file,{onExtractProgress:snap=>{const pct=snap.bytesTotal?Math.floor(snap.bytesDone*100/snap.bytesTotal):0;if(pct>=lastPct+10||pct===100){lastPct=pct;$('boundaryText').textContent=`Streaming real default.xex… ${pct}% · ${formatBytes(snap.bytesDone)} / ${formatBytes(snap.bytesTotal)}`}}});
      showStfsDetails(mount.stfs,mount);showFrameGate(mount);
      loadedSession={kind:probe.kind,stage:mount.defaultXexExtract?.complete?4:mount.mounted?2:1,titleId:mount.stfs.titleId||0};runtime.setSession(loadedSession);
      log(mount.mounted?'ok':'error',`${name} native mount · ${mount.stfs.statusName} · ${mount.requestCount} mount reads · ${mount.entries.length} entries`);
      if(!mount.mounted){$('boundaryTitle').textContent=`${name} native STFS mount stopped`;$('boundaryText').textContent=mount.stfs.status===103?'This is an SVOD volume; that path is not ported yet.':`Native mount status: ${mount.stfs.statusName}.`}
      else if(mount.defaultXex){
        const kindText=mount.defaultXexKind===2?'XEX2':mount.defaultXexKind===1?'XEX1':'unrecognized',ex=mount.defaultXexExtract;
        if(mount.defaultXexInspection)showXexDetails(mount.defaultXexInspection);
        if(ex?.complete){$('boundaryTitle').textContent='Real default.xex fully streamed from the Xbox package';$('boundaryText').textContent=`${formatBytes(ex.bytesDone)} extracted in ${ex.requestCount} data reads. Package loading is no longer the blocker. The first real Braid frame now requires the Xenia PowerPC backend, Kernel/XAM startup and Xenos→WebGPU port; V32 does not fake that frame.`;log('ok',`default.xex FULL · ${formatBytes(ex.bytesDone)} · ${ex.blocksDone} blocks · ${kindText} · ${ex.contiguous?'contiguous':'hash-chained'}`)}
        else{$('boundaryTitle').textContent='default.xex extraction stopped';$('boundaryText').textContent=ex?`${ex.statusName} after ${formatBytes(ex.bytesDone)}.`:'Extraction ABI unavailable.';log('error',$('boundaryText').textContent)}
      }else{$('boundaryTitle').textContent='STFS mounted — default.xex not located';$('boundaryText').textContent=`Parsed ${mount.entries.length} file-table entries but no root default.xex was found.`}
    }
    else if(probe.kind===20){loadedSession={kind:20,stage:1,titleId:0};$('boundaryTitle').textContent='PowerPC ELF recognized';$('boundaryText').textContent='PowerPC execution is not yet wired to Xenia HIR/interpreter code.';log('ok','PowerPC ELF recognized')}
    else if(iso){loadedSession={kind:30,stage:1,titleId:0};runtime.setSession(loadedSession);$('boundaryTitle').textContent='ISO selected — use the XBLA/STFS package for Braid';$('boundaryText').textContent='Braid XBLA does not need conversion to ISO. V32 now streams its full default.xex from LIVE/PIRS/CON. Disc ISO/XDVDFS is a separate filesystem adapter and does not solve the missing browser CPU/GPU backends.';log('warn','ISO selected · XDVDFS support is a future mount path, not a fix for retail execution')}
    else{$('boundaryTitle').textContent='Unknown Xbox container';$('boundaryText').textContent='No supported XEX/LIVE/PIRS/CON magic was recognized.';log('warn',`Unknown container · first ${probe.bytesRead} bytes inspected`)}
  }catch(err){$('boundaryTitle').textContent='Native mount/inspection stopped';$('boundaryText').textContent=err.message;log('error',`File mount/probe failed: ${err.message}`)}
  renderTelemetry();
});

$('playNowButton').onclick=()=>enterArena();$('arenaButton').onclick=()=>arenaActive?leaveArena():enterArena();$('leaveArena').onclick=leaveArena;$('hideGameButton').onclick=()=>enterArena('after-load');$('gameChip').onclick=showLoadedCard;
$('ejectButton').onclick=()=>{loadedFile=null;loadedSession={kind:0,stage:0,titleId:0};$('gameInput').value='';$('gameState').classList.add('hidden');$('emptyState').classList.remove('hidden');resetXexDetails();resetStfsDetails();runtime.reset();runtime.setSession({});$('gameChip').classList.add('hidden');three.setPlaying(false);log('ok','Container ejected; native runtime session reset')};
$('consoleButton').onclick=()=>openSheet('consoleSheet');$('settingsButton').onclick=()=>openSheet('statusSheet');$('closeConsole').onclick=closeSheets;$('closeStatus').onclick=closeSheets;$('scrim').onclick=closeSheets;$('clearLogs').onclick=()=>{logs.length=0;renderLogs()};$('copyLogs').onclick=async()=>{try{await navigator.clipboard.writeText(logs.map(x=>x.text).join('\n'));log('ok','Console copied')}catch{log('warn','Clipboard permission unavailable')}};$('performanceProfile').addEventListener('change',()=>applyPerformanceProfile($('performanceProfile').value,true));$('autoScaleToggle').addEventListener('change',()=>applyPerformanceProfile($('performanceProfile').value,true));

// Real virtual analog stick -------------------------------------------------
const stick=$('moveStick'),knob=$('moveKnob');let stickPointer=null;
function setStickFromPointer(e){const r=stick.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,max=r.width*.32;let dx=e.clientX-cx,dy=e.clientY-cy;const d=Math.hypot(dx,dy);if(d>max){dx=dx/d*max;dy=dy/d*max}touchMove={x:dx/max,y:dy/max};knob.style.transform=`translate3d(${dx}px,${dy}px,0)`;three.setMove(touchMove.x,touchMove.y);runtime.setAnalog(touchMove.x,touchMove.y,rightAnalog.x,rightAnalog.y)}
stick.addEventListener('pointerdown',e=>{e.preventDefault();stickPointer=e.pointerId;stick.setPointerCapture?.(e.pointerId);stick.classList.add('active');setStickFromPointer(e)});
stick.addEventListener('pointermove',e=>{if(e.pointerId!==stickPointer)return;e.preventDefault();setStickFromPointer(e)});
function releaseStick(e){if(stickPointer!==null&&e.pointerId!==undefined&&e.pointerId!==stickPointer)return;stickPointer=null;touchMove={x:0,y:0};knob.style.transform='translate3d(0,0,0)';stick.classList.remove('active');applyCombinedMovement()}
stick.addEventListener('pointerup',releaseStick);stick.addEventListener('pointercancel',releaseStick);stick.addEventListener('lostpointercapture',releaseStick);

// Right analog look stick + drag-look ---------------------------------------
const lookZone=$('lookZone'),lookStick=$('lookStick'),lookKnob=$('lookKnob');let lookPointer=null,lastLookX=0,lastLookY=0,lookStickPointer=null;
function commitRightAnalog(x,y,{camera=true}={}){rightAnalog={x:Math.max(-1,Math.min(1,x||0)),y:Math.max(-1,Math.min(1,y||0))};runtime.setAnalog(touchMove.x,touchMove.y,rightAnalog.x,rightAnalog.y);if(camera&&arenaActive&&(Math.abs(rightAnalog.x)+Math.abs(rightAnalog.y)>.015))three.lookDelta(rightAnalog.x*7,rightAnalog.y*5)}
function setLookStickFromPointer(e){const r=lookStick.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,max=r.width*.31;let dx=e.clientX-cx,dy=e.clientY-cy;const d=Math.hypot(dx,dy);if(d>max){dx=dx/d*max;dy=dy/d*max}lookKnob.style.transform=`translate3d(${dx}px,${dy}px,0)`;commitRightAnalog(dx/max,dy/max)}
lookStick.addEventListener('pointerdown',e=>{e.preventDefault();lookStickPointer=e.pointerId;lookStick.setPointerCapture?.(e.pointerId);lookStick.classList.add('active');setLookStickFromPointer(e)});
lookStick.addEventListener('pointermove',e=>{if(e.pointerId!==lookStickPointer)return;e.preventDefault();setLookStickFromPointer(e)});
function releaseLookStick(e){if(lookStickPointer!==null&&e.pointerId!==undefined&&e.pointerId!==lookStickPointer)return;lookStickPointer=null;lookKnob.style.transform='translate3d(0,0,0)';lookStick.classList.remove('active');commitRightAnalog(0,0,{camera:false})}
lookStick.addEventListener('pointerup',releaseLookStick);lookStick.addEventListener('pointercancel',releaseLookStick);lookStick.addEventListener('lostpointercapture',releaseLookStick);
lookZone.addEventListener('pointerdown',e=>{if(!arenaActive)return;e.preventDefault();lookPointer=e.pointerId;lastLookX=e.clientX;lastLookY=e.clientY;lookZone.setPointerCapture?.(e.pointerId)});
lookZone.addEventListener('pointermove',e=>{if(e.pointerId!==lookPointer||!arenaActive)return;e.preventDefault();const dx=e.clientX-lastLookX,dy=e.clientY-lastLookY;lastLookX=e.clientX;lastLookY=e.clientY;three.lookDelta(dx,dy);commitRightAnalog(dx/22,dy/22,{camera:false})});
function releaseLook(e){if(lookPointer!==null&&e.pointerId!==undefined&&e.pointerId!==lookPointer)return;lookPointer=null;if(lookStickPointer===null)commitRightAnalog(0,0,{camera:false})}
lookZone.addEventListener('pointerup',releaseLook);lookZone.addEventListener('pointercancel',releaseLook);lookZone.addEventListener('lostpointercapture',releaseLook);

// Face/trigger/shoulder buttons ---------------------------------------------
document.querySelectorAll('.control').forEach(btn=>{const key=btn.dataset.key;let pid=null;const down=e=>{e.preventDefault();if(pid!==null)return;pid=e.pointerId;btn.setPointerCapture?.(e.pointerId);btn.classList.add('pressed');runtime.setKey(key,true);if(arenaActive&&key==='A')three.jump();if(arenaActive&&key==='RT')three.setSprint(true);if(arenaActive&&key==='X')three.resetPlayer()};const up=e=>{if(pid!==null&&e.pointerId!==undefined&&e.pointerId!==pid)return;e.preventDefault();pid=null;btn.classList.remove('pressed');runtime.setKey(key,false);if(arenaActive&&key==='RT')three.setSprint(false)};btn.addEventListener('pointerdown',down);btn.addEventListener('pointerup',up);btn.addEventListener('pointercancel',up);btn.addEventListener('lostpointercapture',up)});
let runtimePaused=false;$('pauseRuntimeButton').addEventListener('pointerdown',e=>{e.preventDefault();runtimePaused=!runtimePaused;$('pauseRuntimeButton').textContent=runtimePaused?'Resume':'Pause';$('pauseRuntimeButton').classList.toggle('pressed',runtimePaused);if(runtimePaused){runtime.pause();three.setPlaying(false);log('info','Runtime paused by host control')}else{runtime.resume();if(arenaActive)three.setPlaying(true);log('ok','Runtime resumed')}});

// Keyboard + physical controller ------------------------------------------
function applyCombinedMovement(){let x=touchMove.x,y=touchMove.y;if(keys.has('KeyA')||keys.has('ArrowLeft'))x-=1;if(keys.has('KeyD')||keys.has('ArrowRight'))x+=1;if(keys.has('KeyW')||keys.has('ArrowUp'))y-=1;if(keys.has('KeyS')||keys.has('ArrowDown'))y+=1;const l=Math.hypot(x,y);if(l>1){x/=l;y/=l}three.setMove(x,y);runtime.setAnalog(x,y,rightAnalog.x,rightAnalog.y)}
window.addEventListener('keydown',e=>{if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)){keys.add(e.code);applyCombinedMovement();e.preventDefault()}if(e.code==='Space'&&!e.repeat){three.jump();runtime.setKey('A',true);e.preventDefault()}if(e.code==='ShiftLeft'||e.code==='ShiftRight'){three.setSprint(true);runtime.setKey('RT',true)}if(e.code==='KeyR'&&!e.repeat)three.resetPlayer()});
window.addEventListener('keyup',e=>{keys.delete(e.code);applyCombinedMovement();if(e.code==='Space')runtime.setKey('A',false);if(e.code==='ShiftLeft'||e.code==='ShiftRight'){three.setSprint(false);runtime.setKey('RT',false)}});

let previousPadButtons=[];
function pollGamepad(){const gp=Array.from(navigator.getGamepads?.()||[]).find(Boolean);if(gp){const dz=v=>Math.abs(v)<.12?0:v;const lx=dz(gp.axes[0]||0),ly=dz(gp.axes[1]||0),rx=dz(gp.axes[2]||0),ry=dz(gp.axes[3]||0);runtime.setAnalog(lx,ly,rx,ry);if(arenaActive){three.setMove(lx,ly);if(Math.abs(rx)+Math.abs(ry)>.05)three.lookDelta(rx*7,ry*5)}const mapping=[['A',0],['B',1],['X',2],['Y',3],['LB',4],['RB',5],['LT',6],['RT',7],['BACK',8],['START',9]];for(const[key,i]of mapping){const pressed=!!gp.buttons[i]?.pressed;if(pressed!==!!previousPadButtons[i]){runtime.setKey(key,pressed);if(arenaActive&&pressed&&key==='A')three.jump();if(arenaActive&&pressed&&key==='X')three.resetPlayer();if(arenaActive&&key==='RT')three.setSprint(pressed);previousPadButtons[i]=pressed}}}requestAnimationFrame(pollGamepad)}requestAnimationFrame(pollGamepad);

document.addEventListener('visibilitychange',()=>{if(document.hidden)log('info','Page hidden · iOS/browser may throttle render and worker timers');else log('ok','Page visible · render/runtime cadence restored')});
boot();
