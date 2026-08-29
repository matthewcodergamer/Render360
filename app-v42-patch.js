import {listGames,putGame,putCover} from './library/game-library.js?v=43';
import {resolveTitleCover} from './library/cover-resolver.js?v=43';
import {clearGamesDirectory,storageInfo} from './storage/game-storage.js?v=43';

const $=id=>document.getElementById(id);
const holdState=new WeakMap();
const coverUrls=new Map();
let artworkHydrationRunning=false;
let storageClearRunning=false;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hex8=value=>(Number(value||0)>>>0).toString(16).toUpperCase().padStart(8,'0');
const fmtBytes=value=>{const n=Number(value)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`;};

function syncThemeChrome(){
  const root=document.documentElement;
  const light=root.dataset.theme==='light';
  const bg=light?'#f2f2f7':'#000000';
  root.style.backgroundColor=bg;
  root.style.colorScheme=light?'light':'dark';
  if(document.body)document.body.style.backgroundColor=bg;
  $('app')?.style.setProperty('background-color',bg,'important');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',bg);
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content',light?'default':'black-translucent');
}

function playBadge(){
  const badge=document.createElement('span');
  badge.className='tile-play-badge';
  badge.innerHTML='<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 1.2v9.6L10 6 2.2 1.2Z"/></svg><span>Play</span>';
  return badge;
}

function coverSurface(url,label='Xbox 360 game cover'){
  const surface=document.createElement('span');
  surface.className='cover-art-surface';
  surface.setAttribute('role','img');
  surface.setAttribute('aria-label',label);
  surface.setAttribute('draggable','false');
  surface.style.backgroundImage=`url(${JSON.stringify(String(url)).slice(1,-1)})`;
  return surface;
}

function convertNativeCoverImages(root=document){
  root.querySelectorAll?.('.cover-shell img,.detail-cover img').forEach(img=>{
    const src=img.currentSrc||img.src;
    if(!src){img.remove();return;}
    const label=img.alt||'Xbox 360 game cover';
    img.replaceWith(coverSurface(src,label));
  });
}

function setCoverSurface(container,url,label){
  if(!container||!url)return;
  container.querySelectorAll('img,.cover-art-surface').forEach(node=>node.remove());
  container.querySelector('.cover-placeholder')?.remove();
  container.prepend(coverSurface(url,label));
}

function applyCachedCover(tile){
  const url=coverUrls.get(tile.dataset.gameId);
  if(!url)return;
  const shell=tile.querySelector('.cover-shell');if(!shell)return;
  const title=tile.querySelector('.game-tile-title')?.textContent||'Xbox 360 game';
  setCoverSurface(shell,url,`${title} cover`);
}

function decorateTile(tile){
  if(!(tile instanceof HTMLElement))return;
  const shell=tile.querySelector('.cover-shell');if(!shell)return;
  convertNativeCoverImages(shell);
  if(!shell.querySelector('.tile-play-badge'))shell.appendChild(playBadge());
  if(!tile.querySelector('.game-tile-hint')){
    const hint=document.createElement('span');hint.className='game-tile-hint';hint.textContent='Tap to play · hold for details';tile.appendChild(hint);
  }
  const title=tile.querySelector('.game-tile-title')?.textContent||'Game';
  tile.setAttribute('aria-label',`${title}. Tap to play. Press and hold for game details.`);
  tile.setAttribute('draggable','false');
  applyCachedCover(tile);
}

function decorateTiles(){document.querySelectorAll('#gameGrid .game-tile').forEach(decorateTile);convertNativeCoverImages(document);}

function applyCoverToVisible(game,blob){
  let url=coverUrls.get(game.id);
  if(!url){url=URL.createObjectURL(blob);coverUrls.set(game.id,url);}
  document.querySelectorAll('#gameGrid .game-tile').forEach(tile=>{if(tile.dataset.gameId===game.id)applyCachedCover(tile);});
  const detailTid=$('detailTitleId')?.textContent?.trim();
  if(!document.getElementById('detailView')?.classList.contains('hidden')&&detailTid===hex8(game.titleId)){
    const cover=$('detailCover');if(cover)setCoverSurface(cover,url,`${game.name||'Xbox 360 game'} cover`);
  }
}

async function hydrateMissingArtwork(){
  if(artworkHydrationRunning)return;artworkHydrationRunning=true;
  try{
    const games=await listGames();
    for(const game of games.filter(g=>!g.coverKey&&Number(g.titleId)).slice(0,12)){
      try{
        const resolved=await resolveTitleCover({titleId:game.titleId,timeoutMs:6500});
        if(!resolved?.blob)continue;
        game.coverKey=await putCover(resolved.blob);
        if(resolved.name&&(!game.name||game.name===game.sourceName))game.name=resolved.name;
        game.coverSource=resolved.source||'network';
        await putGame(game);
        applyCoverToVisible(game,resolved.blob);
        console.log(`[Render360 V43] Artwork cached for ${game.name} from ${game.coverSource}`);
      }catch(error){console.warn(`[Render360 V43] Artwork lookup failed for ${game.name}: ${error.message}`);}
    }
  }catch(error){console.warn(`[Render360 V43] Artwork backfill unavailable: ${error.message}`);}
  finally{artworkHydrationRunning=false;}
}

async function scheduleAutoPlay(tile){
  const gameId=tile.dataset.gameId;if(!gameId)return;
  let expected=null;
  try{expected=(await listGames()).find(game=>game.id===gameId)||null;}catch{}
  const expectedTid=expected?.titleId?hex8(expected.titleId):null;
  for(let i=0;i<100;i++){
    await sleep(20);
    if(document.body.dataset.state!=='GAME_DETAILS')continue;
    const sameGame=expectedTid?$('detailTitleId')?.textContent?.trim()===expectedTid:(!$('detailName')||$('detailName').textContent===tile.querySelector('.game-tile-title')?.textContent);
    if(!sameGame)continue;
    $('playGameButton')?.click();
    return;
  }
}

function clearHoldTimer(state){if(state?.timer){clearTimeout(state.timer);state.timer=null;}}

function bindLibraryLaunchGestures(){
  const grid=$('gameGrid');if(!grid)return;
  const ownedTile=event=>event.target.closest?.('.game-tile')||null;
  const suppressNative=event=>{if(ownedTile(event))event.preventDefault();};
  grid.addEventListener('dragstart',suppressNative,true);
  grid.addEventListener('selectstart',suppressNative,true);
  grid.addEventListener('webkitmouseforcewillbegin',suppressNative,true);
  grid.addEventListener('pointerdown',event=>{
    const tile=ownedTile(event);if(!tile)return;
    if(event.pointerType==='mouse'&&event.button!==0)return;
    const state={timer:null,held:false,startX:event.clientX,startY:event.clientY,pointerId:event.pointerId,blockTrustedUntil:0,allowSyntheticDetails:false};
    state.timer=setTimeout(()=>{state.timer=null;state.held=true;tile.classList.add('v42-holding');navigator.vibrate?.(10);try{tile.setPointerCapture?.(event.pointerId);}catch{}},500);
    holdState.set(tile,state);
  },true);
  grid.addEventListener('pointermove',event=>{
    const tile=ownedTile(event);if(!tile)return;const state=holdState.get(tile);if(!state||state.pointerId!==event.pointerId||state.held)return;
    if(Math.hypot(event.clientX-state.startX,event.clientY-state.startY)>12)clearHoldTimer(state);
  },true);
  const endPointer=event=>{
    const tile=ownedTile(event);if(!tile)return;const state=holdState.get(tile);if(!state||state.pointerId!==event.pointerId)return;
    clearHoldTimer(state);
    if(state.held){event.preventDefault();event.stopPropagation();state.blockTrustedUntil=Date.now()+900;state.allowSyntheticDetails=true;try{tile.releasePointerCapture?.(event.pointerId);}catch{}queueMicrotask(()=>tile.click());setTimeout(()=>tile.classList.remove('v42-holding'),160);}
  };
  grid.addEventListener('pointerup',endPointer,true);
  grid.addEventListener('pointercancel',event=>{const tile=ownedTile(event);const state=tile&&holdState.get(tile);clearHoldTimer(state);tile?.classList.remove('v42-holding');},true);
  grid.addEventListener('click',event=>{
    const tile=ownedTile(event);if(!tile)return;const state=holdState.get(tile);
    if(state?.allowSyntheticDetails&&!event.isTrusted){state.allowSyntheticDetails=false;return;}
    if(event.isTrusted&&state?.blockTrustedUntil>Date.now()){event.preventDefault();event.stopImmediatePropagation();return;}
    if(!event.isTrusted)return;scheduleAutoPlay(tile);
  },true);
  grid.addEventListener('contextmenu',event=>{
    const tile=ownedTile(event);if(!tile)return;event.preventDefault();event.stopImmediatePropagation();
    const state=holdState.get(tile)||{};clearHoldTimer(state);state.allowSyntheticDetails=true;state.blockTrustedUntil=Date.now()+900;holdState.set(tile,state);queueMicrotask(()=>tile.click());
  },true);
}

function bindGlobalCoverProtection(){
  const app=$('app');if(!app)return;
  const block=event=>{const target=event.target.closest?.('.game-tile,.cover-shell,.detail-cover,.cover-art-surface');if(!target)return;if(event.type==='contextmenu'&&target.closest?.('.game-tile'))return;event.preventDefault();};
  app.addEventListener('dragstart',block,true);app.addEventListener('selectstart',block,true);
  app.addEventListener('contextmenu',event=>{if(event.target.closest?.('.detail-cover,.cover-art-surface')&&!event.target.closest?.('.game-tile'))event.preventDefault();},true);
}

function closePatchAlert(){
  $('iosAlert')?.classList.add('hidden');
  $('scrim')?.classList.add('hidden');
}
function patchAlert(title,message,actions=[{label:'OK'}]){
  const alert=$('iosAlert'),wrap=$('alertActions');if(!alert||!wrap)return;
  if($('alertTitle'))$('alertTitle').textContent=title;if($('alertMessage'))$('alertMessage').textContent=message;
  wrap.innerHTML='';wrap.style.gridTemplateColumns=`repeat(${Math.min(2,actions.length)},1fr)`;
  for(const action of actions){
    const button=document.createElement('button');button.textContent=action.label;
    button.addEventListener('click',async()=>{
      if(button.disabled)return;button.disabled=true;
      if(!action.keepOpen)closePatchAlert();
      try{await action.action?.();}
      catch(error){console.error('[Render360 V43]',error);setTimeout(()=>patchAlert('Action Failed',error?.message||String(error),[{label:'OK'}]),0);}
    },{once:true});wrap.appendChild(button);
  }
  $('scrim')?.classList.remove('hidden');alert.classList.remove('hidden');
}
async function refreshStorageNumbers(){
  const info=await storageInfo();
  if($('storagePersisted'))$('storagePersisted').textContent=!info.supported?'Unavailable':info.persisted?'Protected':'Best effort';
  if($('storageNumbers'))$('storageNumbers').textContent=info.quota?`${fmtBytes(info.usage)} / ${fmtBytes(info.quota)}`:'Unavailable';
  if($('storageMeterFill'))$('storageMeterFill').style.width=`${info.quota?Math.min(100,info.usage/info.quota*100):0}%`;
  if($('storageSummary'))$('storageSummary').textContent=info.supported?`${fmtBytes(info.free)} estimated free in this browser origin. Large ISO imports are only copied when enough quota is available.`:'Persistent browser game storage is unavailable.';
}
async function clearGameCopiesV43(){
  if(storageClearRunning)return;storageClearRunning=true;
  try{
    const games=await listGames();let affected=0;
    await clearGamesDirectory();
    for(const game of games){
      if(!String(game.opfsPath||'').startsWith('Render360/Games/'))continue;
      game.opfsPath=null;game.persistentSource=false;game.needsRelink=true;affected++;await putGame(game);
    }
    await refreshStorageNumbers();
    patchAlert('Game Copies Cleared',affected?`${affected} stored game cop${affected===1?'y was':'ies were'} removed. Library entries and covers were kept. Reload Render360 now so no deleted file remains linked in memory.`:'Render360/Games is empty. No stored game copies were found.',[{label:'Done',action:()=>location.reload()}]);
  }finally{storageClearRunning=false;}
}
function bindReliableStorageClear(){
  const button=$('clearGameStorage');if(!button)return;
  // Capture phase owns this control before the older async fire-and-forget
  // listener. This makes completion/errors visible and synchronizes metadata.
  button.addEventListener('click',event=>{
    event.preventDefault();event.stopImmediatePropagation();
    patchAlert('Clear Game Copies?','Delete files stored inside Render360/Games? Library entries and artwork stay, but affected games will need their original file selected again.',[{label:'Cancel'},{label:'Clear',action:clearGameCopiesV43}]);
  },true);
}

function patchDiagnosticsRelease(){setTimeout(()=>{const log=$('diagnosticsLog');if(log)log.textContent=log.textContent.replace('"release": 41','"release": 43').replace('"release": 42','"release": 43');},0);}

function bootV43Patch(){
  syncThemeChrome();
  new MutationObserver(syncThemeChrome).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  bindLibraryLaunchGestures();bindGlobalCoverProtection();bindReliableStorageClear();decorateTiles();
  const app=$('app');if(app)new MutationObserver(()=>queueMicrotask(decorateTiles)).observe(app,{childList:true,subtree:true});
  $('diagnosticsButton')?.addEventListener('click',patchDiagnosticsRelease);$('appDiagnosticsButton')?.addEventListener('click',patchDiagnosticsRelease);
  setTimeout(hydrateMissingArtwork,450);
  console.log('[Render360 V43] Direct-play library, reliable storage management, app-owned covers, iOS chrome, and runtime compatibility fixes active');
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootV43Patch,{once:true});else bootV43Patch();
