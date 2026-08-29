import {Render360Runtime,fmtHex,stripExtension} from './runtime/render360-runtime.js';
import {listGames,putGame,getGame,deleteGame,putCover,getCover,makeGameId,markPlayed,sourceKindFromName} from './library/game-library.js';
import {prepareZipGame} from './import/zip-importer.js';
import {loadTitleProfile,saveTitleProfile,resetTitleProfile} from './profiles/title-profile-store.js';

const $=id=>document.getElementById(id);
const runtime=new Render360Runtime();
const coverUrls=new Map();
const logs=[];
let games=[];
let currentGame=null;
let relinkTarget=null;
let appState='BOOT';
let lastTelemetry=null;
let hudHistory=[];
let stickState={lx:0,ly:0,rx:0,ry:0};

function log(level,message){
  const item={at:Date.now(),level,message:String(message)};logs.push(item);if(logs.length>600)logs.shift();
  console[level==='error'?'error':level==='warn'?'warn':'log'](`[Render360] ${item.message}`);
}
function formatBytes(n=0){if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`;}
function titleIdText(game){return game?.titleId?fmtHex(game.titleId).slice(2):'Unknown';}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function setState(next){
  appState=next;
  for(const id of['libraryView','detailView','settingsView','runtimeView'])$(id)?.classList.add('hidden');
  if(next==='LIBRARY')$('libraryView')?.classList.remove('hidden');
  if(next==='GAME_DETAILS')$('detailView')?.classList.remove('hidden');
  if(next==='SETTINGS')$('settingsView')?.classList.remove('hidden');
  if(['BOOTING_GAME','RUNNING','PAUSED'].includes(next))$('runtimeView')?.classList.remove('hidden');
  document.body.dataset.state=next;
}

async function coverUrl(game){
  if(!game?.coverKey)return null;
  if(coverUrls.has(game.coverKey))return coverUrls.get(game.coverKey);
  const blob=await getCover(game.coverKey);if(!blob)return null;
  const url=URL.createObjectURL(blob);coverUrls.set(game.coverKey,url);return url;
}
function coverMarkup(game,url,detail=false){
  if(url)return`<img src="${url}" alt="${escapeHtml(game.name)} cover">`;
  return `<div class="cover-placeholder"><div><b>${escapeHtml(game.name)}</b><span>XBOX 360</span></div></div>`;
}

async function refreshLibrary(){games=await listGames();renderLibrary();}
async function renderLibrary(){
  const query=($('librarySearch')?.value||'').trim().toLowerCase();
  const filtered=games.filter(g=>!query||g.name.toLowerCase().includes(query)||titleIdText(g).toLowerCase().includes(query));
  $('emptyLibrary')?.classList.toggle('hidden',games.length>0);
  const grid=$('gameGrid');if(!grid)return;grid.innerHTML='';
  for(const game of filtered){
    const url=await coverUrl(game);const button=document.createElement('button');button.className='game-tile';button.type='button';button.dataset.gameId=game.id;
    const linked=!!runtime.getSource(game.id);button.innerHTML=`<div class="cover-shell">${coverMarkup(game,url)}</div><span class="game-tile-title">${escapeHtml(game.name)}</span><span class="game-tile-meta"><i class="status-dot ${linked?'ready':'link'}"></i>${linked?'Ready':'Needs file'} · ${escapeHtml(String(game.sourceType||'game').toUpperCase())}</span>`;
    button.addEventListener('click',()=>openGame(game.id));grid.appendChild(button);
  }
}

async function openGame(id){currentGame=await getGame(id);if(!currentGame)return;await renderDetail();setState('GAME_DETAILS');}
async function renderDetail(){
  const game=currentGame;if(!game)return;const url=await coverUrl(game);
  $('detailCover').innerHTML=coverMarkup(game,url,true);$('detailName').textContent=game.name;$('detailTitleId').textContent=titleIdText(game);
  $('detailType').textContent=String(game.sourceType||'Unknown').toUpperCase();$('detailSize').textContent=formatBytes(game.size||0);
  $('detailCompatibility').textContent=game.compatibility||'Testing';$('detailSource').textContent=game.archiveName||game.sourceName||'Imported game';
  $('playGameButton').textContent=runtime.getSource(game.id)?'Play':'Choose File & Play';
}

function openImport(){const input=$('importInput');input.value='';input.click();}
async function importSelectedFile(file){
  if(!file)return;setImportProgress('Preparing game…',0,`Indexing ${file.name}`);showSheet('importSheet');
  let gameFile=file,coverFile=null,archiveName=null,storage=null;
  try{
    if(sourceKindFromName(file.name)==='zip'){
      archiveName=file.name;
      const prepared=await prepareZipGame(file,{onProgress:p=>{
        const text=p.phase==='index'?'Indexing archive…':`Extracting ${p.name}`;setImportProgress(text,p.percent||0,p.total?`${formatBytes(p.done||0)} / ${formatBytes(p.total)}`:'Reading ZIP…');
      }});
      gameFile=prepared.gameFile;coverFile=prepared.coverFile;storage=prepared.gameStorage;
    }
    setImportProgress('Reading Xbox metadata…',96,gameFile.name);
    const info=await runtime.inspectFile(gameFile);
    const id=makeGameId();let coverKey=null;if(coverFile)coverKey=await putCover(coverFile);
    const game={
      id,name:info.name||stripExtension(gameFile.name),titleId:Number(info.titleId||0)>>>0,mediaId:Number(info.mediaId||0)>>>0,
      contentType:info.displayType||'Xbox 360 Game',sourceType:info.sourceType||sourceKindFromName(gameFile.name),sourceName:gameFile.name,
      archiveName,size:gameFile.size,coverKey,compatibility:'Testing',profileId:`title-${Number(info.titleId||0).toString(16)}`,
      importedAt:Date.now(),lastPlayed:0,opfsPath:storage?.opfsPath||null,persistentSource:Boolean(storage?.persistent),needsRelink:!storage?.persistent,
      inspectionWarning:info.inspectionWarning||null,
    };
    runtime.bindSource(id,gameFile);await putGame(game);games.unshift(game);currentGame=game;
    setImportProgress('Added to Library',100,`${game.name} is ready`);setTimeout(()=>{closeSheets();renderLibrary();renderDetail();setState('GAME_DETAILS');},450);
  }catch(error){log('error',error.message);closeSheets();showAlert('Import Failed',error.message,[{label:'OK'}]);}
}
function setImportProgress(title,percent,meta=''){$('importTitle').textContent=title;$('importProgressFill').style.width=`${Math.max(0,Math.min(100,percent||0))}%`;$('importProgressPercent').textContent=`${Math.round(percent||0)}%`;$('importProgressMeta').textContent=meta;}

async function playCurrent(){
  if(!currentGame)return;let source=runtime.getSource(currentGame.id);
  if(!source){relinkTarget=currentGame;$('relinkInput').value='';$('relinkInput').click();return;}
  closeSheets();setState('BOOTING_GAME');$('bootOverlay').classList.remove('frame-live');$('bootTitle').textContent=currentGame.name;$('bootMessage').textContent='Mounting Xbox 360 title…';
  try{await markPlayed(currentGame.id);await runtime.play(currentGame,source);$('bootMessage').textContent='Guest execution is running. Waiting for real title pixels…';setState('RUNNING');}
  catch(error){setState('GAME_DETAILS');showAlert('Game Stopped',error.message,[{label:'Done'}]);}
}
async function handleRelink(file){
  if(!relinkTarget||!file)return;
  const expected=relinkTarget.sourceType,actual=sourceKindFromName(file.name);
  if(expected&&expected!=='unknown'&&actual!==expected){showAlert('Wrong File',`This library entry expects a ${expected.toUpperCase()} source.`,[{label:'OK'}]);return;}
  runtime.bindSource(relinkTarget.id,file);currentGame=relinkTarget;relinkTarget=null;await renderLibrary();await playCurrent();
}

function renderSettings(){
  const game=currentGame;if(!game)return;const p=loadTitleProfile(game);
  $('settingsGameName').textContent=game.name;$('settingResolution').value=p.resolution;$('settingRenderer').value=p.renderer;$('settingDynamic').checked=!!p.dynamicResolution;
  $('settingHalfPixel').checked=!!p.halfPixelOffset;$('setting3DTextures').checked=!!p.treat3DTexturesAs2D;$('settingInvalidFetch').checked=!!p.allowInvalidFetchConstants;$('settingReadback').checked=!!p.readbackResolves;
  $('settingTargetFps').value=String(p.targetFps||30);$('settingDeveloper').checked=!!p.developerMode;
}
function saveSettings(){
  if(!currentGame)return;const p=loadTitleProfile(currentGame);Object.assign(p,{resolution:$('settingResolution').value,renderer:$('settingRenderer').value,dynamicResolution:$('settingDynamic').checked,halfPixelOffset:$('settingHalfPixel').checked,treat3DTexturesAs2D:$('setting3DTextures').checked,allowInvalidFetchConstants:$('settingInvalidFetch').checked,readbackResolves:$('settingReadback').checked,targetFps:Number($('settingTargetFps').value)||30,developerMode:$('settingDeveloper').checked});saveTitleProfile(currentGame,p);setState('GAME_DETAILS');
}

async function chooseCover(file){if(!currentGame||!file)return;if(!/^image\//.test(file.type)&&!/[.](png|jpe?g)$/i.test(file.name))return;currentGame.coverKey=await putCover(file,currentGame.coverKey||undefined);await putGame(currentGame);if(coverUrls.has(currentGame.coverKey)){URL.revokeObjectURL(coverUrls.get(currentGame.coverKey));coverUrls.delete(currentGame.coverKey);}await renderDetail();await refreshLibrary();}
async function removeCurrentGame(){if(!currentGame)return;const id=currentGame.id;await deleteGame(id);runtime.sources.delete(id);currentGame=null;await refreshLibrary();setState('LIBRARY');}

function showSheet(id){$('scrim').classList.remove('hidden');$(id).classList.remove('hidden');}
function closeSheets(){$('scrim').classList.add('hidden');for(const el of document.querySelectorAll('.sheet,.alert'))el.classList.add('hidden');}
function showAlert(title,message,actions=[{label:'OK'}]){
  const alert=$('iosAlert');$('alertTitle').textContent=title;$('alertMessage').textContent=message;const wrap=$('alertActions');wrap.innerHTML='';wrap.style.gridTemplateColumns=`repeat(${Math.min(2,actions.length)},1fr)`;
  actions.forEach(a=>{const b=document.createElement('button');b.textContent=a.label;b.addEventListener('click',()=>{closeSheets();a.action?.();},{once:true});wrap.appendChild(b);});$('scrim').classList.remove('hidden');alert.classList.remove('hidden');
}
function showDiagnostics(){const state=globalThis.render360ModernTitle;const summary={appState,game:currentGame?{name:currentGame.name,titleId:titleIdText(currentGame),type:currentGame.sourceType}:null,telemetry:lastTelemetry?{fps:lastTelemetry.fps,pm4:lastTelemetry.pm4Packets,draws:lastTelemetry.draws,swaps:lastTelemetry.swaps,shaders:lastTelemetry.shaderStatus,realFrame:lastTelemetry.realFrame}:null,runtime:state?{runtimeBoundary:state.result?.runtimeBoundary,schedulerBlocker:state.schedulerBlocker||null}:null};$('diagnosticsLog').textContent=`${logs.slice(-80).map(x=>`${new Date(x.at).toLocaleTimeString()} ${x.level.toUpperCase()} ${x.message}`).join('\n')}\n\nSTATE\n${JSON.stringify(summary,null,2)}`;showSheet('diagnosticsSheet');}

function updateHud(t){
  lastTelemetry=t;$('hudFps').textContent=t.fps?t.fps.toFixed(1):'—';$('hudFrame').textContent=t.frameMs?`${t.frameMs.toFixed(1)} ms`:'—';$('hudCpu').textContent=t.cpuMs?`${t.cpuMs.toFixed(2)} ms`:'—';$('hudGpu').textContent=t.gpuMs?`${t.gpuMs.toFixed(2)} ms`:'—';$('hudScale').textContent=`${t.scale.toFixed(2)}x`;$('hudRam').textContent=t.ramBytes?formatBytes(t.ramBytes):'—';$('hudPm4').textContent=t.pm4Packets.toLocaleString();$('hudDraws').textContent=t.draws.toLocaleString();
  $('hudBackend').textContent=t.realFrame?'REAL FRAME':t.shaderStatus.toUpperCase();hudHistory.push(t.fps||0);if(hudHistory.length>70)hudHistory.shift();drawHudGraph();
  if(t.realFrame)$('bootOverlay').classList.add('frame-live');
  if(t.blocker&&['RUNNING','BOOTING_GAME'].includes(appState))$('bootMessage').textContent=blockerText(t.blocker);
}
function blockerText(b){if(b?.message)return b.message;if(b?.ordinal!==undefined)return`Kernel blocker ordinal 0x${(b.ordinal>>>0).toString(16).toUpperCase()}`;if(b?.lastOpcode!==undefined)return`GPU blocker PM4 0x${(b.lastOpcode>>>0).toString(16).toUpperCase()}`;return 'Title runtime reached a concrete blocker.';}
function drawHudGraph(){const c=$('hudGraph'),ctx=c?.getContext('2d');if(!ctx)return;const dpr=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.floor(c.clientWidth*dpr)),h=Math.max(1,Math.floor(c.clientHeight*dpr));if(c.width!==w||c.height!==h){c.width=w;c.height=h;}ctx.clearRect(0,0,w,h);ctx.strokeStyle='rgba(48,209,88,.88)';ctx.lineWidth=Math.max(1,dpr);ctx.beginPath();hudHistory.forEach((v,i)=>{const x=i/(Math.max(1,hudHistory.length-1))*w,y=h-Math.min(1,v/60)*h*.9-2*dpr;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}

function wireDigitalControls(){
  document.querySelectorAll('[data-key]').forEach(button=>{
    const key=button.dataset.key;const down=e=>{e.preventDefault();button.classList.add('pressed');runtime.setKey(key,true);};const up=e=>{e.preventDefault();button.classList.remove('pressed');runtime.setKey(key,false);};
    button.addEventListener('pointerdown',down);button.addEventListener('pointerup',up);button.addEventListener('pointercancel',up);button.addEventListener('pointerleave',e=>{if(e.buttons)up(e);});
  });
}
function wireStick(element,knob,side='left'){
  let pointer=null;const reset=()=>{pointer=null;knob.style.transform='translate(0,0)';if(side==='left'){stickState.lx=0;stickState.ly=0}else{stickState.rx=0;stickState.ry=0}runtime.setAnalog(stickState.lx,stickState.ly,stickState.rx,stickState.ry);};
  element.addEventListener('pointerdown',e=>{pointer=e.pointerId;element.setPointerCapture(pointer);move(e);});element.addEventListener('pointermove',e=>{if(e.pointerId===pointer)move(e);});element.addEventListener('pointerup',reset);element.addEventListener('pointercancel',reset);
  function move(e){const r=element.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,max=r.width*.30;let dx=e.clientX-cx,dy=e.clientY-cy;const len=Math.hypot(dx,dy);if(len>max){dx=dx/len*max;dy=dy/len*max;}knob.style.transform=`translate(${dx}px,${dy}px)`;const x=dx/max,y=-dy/max;if(side==='left'){stickState.lx=x;stickState.ly=y}else{stickState.rx=x;stickState.ry=y}runtime.setAnalog(stickState.lx,stickState.ly,stickState.rx,stickState.ry);}
}

function pauseGame(){runtime.pause();setState('PAUSED');$('controllerLayer').classList.add('paused');showSheet('pauseSheet');}
function resumeGame(){runtime.resume();$('controllerLayer').classList.remove('paused');closeSheets();setState('RUNNING');}
function leaveGame(){runtime.resetInput();$('controllerLayer').classList.remove('paused');closeSheets();setState('GAME_DETAILS');renderDetail();}

async function boot(){
  setState('LIBRARY');$('libraryBootStatus').textContent='Starting emulator…';await refreshLibrary();
  runtime.addEventListener('log',e=>log(e.detail.level,e.detail.message));runtime.addEventListener('telemetry',e=>updateHud(e.detail));runtime.addEventListener('framePresented',()=>{$('bootOverlay').classList.add('frame-live');if(appState==='BOOTING_GAME')setState('RUNNING');});runtime.addEventListener('bootStage',e=>{if($('bootMessage'))$('bootMessage').textContent=e.detail.message;});runtime.addEventListener('fatalError',e=>log('error',e.detail.message));
  try{await runtime.init();$('libraryBootStatus').textContent='Xenia-Web ready';log('ok',`Core V${runtime.core.buildVersion} ready`);}catch(error){$('libraryBootStatus').textContent='Emulator core unavailable';log('error',error.message);}
}

$('importButton').addEventListener('click',openImport);$('emptyImportButton').addEventListener('click',openImport);$('importInput').addEventListener('change',e=>importSelectedFile(e.target.files?.[0]));$('librarySearch').addEventListener('input',renderLibrary);
$('detailBack').addEventListener('click',()=>{setState('LIBRARY');renderLibrary();});$('playGameButton').addEventListener('click',playCurrent);$('gameSettingsButton').addEventListener('click',()=>{renderSettings();setState('SETTINGS');});$('settingsBack').addEventListener('click',()=>setState('GAME_DETAILS'));$('saveSettings').addEventListener('click',saveSettings);$('resetSettings').addEventListener('click',()=>{resetTitleProfile(currentGame);renderSettings();});
$('chooseCoverButton').addEventListener('click',()=>{$('coverInput').value='';$('coverInput').click();});$('coverInput').addEventListener('change',e=>chooseCover(e.target.files?.[0]));$('deleteGameButton').addEventListener('click',()=>showAlert('Delete Game?',`Remove ${currentGame?.name||'this game'} from the Render360 library? The original game file is not modified.`,[{label:'Cancel'},{label:'Delete',action:removeCurrentGame}]));
$('relinkInput').addEventListener('change',e=>handleRelink(e.target.files?.[0]));$('pauseButton').addEventListener('click',pauseGame);$('resumeButton').addEventListener('click',resumeGame);$('leaveGameButton').addEventListener('click',leaveGame);$('runtimeBack').addEventListener('click',pauseGame);$('diagnosticsButton').addEventListener('click',showDiagnostics);$('settingsButton').addEventListener('click',()=>showDiagnostics());
$('scrim').addEventListener('click',()=>{if(appState==='PAUSED')return;closeSheets();});document.querySelectorAll('[data-close-sheet]').forEach(b=>b.addEventListener('click',closeSheets));
wireDigitalControls();wireStick($('leftStick'),$('leftStickKnob'),'left');wireStick($('rightStick'),$('rightStickKnob'),'right');
window.addEventListener('keydown',e=>{const map={Enter:'START',Escape:'BACK',q:'LB',e:'RB',z:'LT',c:'RT',x:'X',y:'Y',a:'A',b:'B'};const k=map[e.key]||map[e.key.toLowerCase?.()];if(k)runtime.setKey(k,true);});window.addEventListener('keyup',e=>{const map={Enter:'START',Escape:'BACK',q:'LB',e:'RB',z:'LT',c:'RT',x:'X',y:'Y',a:'A',b:'B'};const k=map[e.key]||map[e.key.toLowerCase?.()];if(k)runtime.setKey(k,false);});

boot();
