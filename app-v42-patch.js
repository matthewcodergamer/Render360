import {listGames,putGame,putCover} from './library/game-library.js';
import {resolveTitleCover} from './library/cover-resolver.js?v=42';

const $=id=>document.getElementById(id);
const holdState=new WeakMap();
const coverUrls=new Map();
let artworkHydrationRunning=false;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hex8=value=>(Number(value||0)>>>0).toString(16).toUpperCase().padStart(8,'0');

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

function applyCachedCover(tile){
  const url=coverUrls.get(tile.dataset.gameId);
  if(!url)return;
  const shell=tile.querySelector('.cover-shell');if(!shell)return;
  shell.querySelector('.cover-placeholder')?.remove();
  let img=shell.querySelector('img');
  if(!img){img=document.createElement('img');img.alt=`${tile.querySelector('.game-tile-title')?.textContent||'Xbox 360 game'} cover`;shell.prepend(img);}
  if(img.src!==url)img.src=url;
}

function decorateTile(tile){
  if(!(tile instanceof HTMLElement))return;
  const shell=tile.querySelector('.cover-shell');if(!shell)return;
  if(!shell.querySelector('.tile-play-badge'))shell.appendChild(playBadge());
  if(!tile.querySelector('.game-tile-hint')){
    const hint=document.createElement('span');hint.className='game-tile-hint';hint.textContent='Tap to play · hold for details';tile.appendChild(hint);
  }
  const title=tile.querySelector('.game-tile-title')?.textContent||'Game';
  tile.setAttribute('aria-label',`${title}. Tap to play. Press and hold for game details.`);
  applyCachedCover(tile);
}

function decorateTiles(){document.querySelectorAll('#gameGrid .game-tile').forEach(decorateTile);}

function applyCoverToVisible(game,blob){
  let url=coverUrls.get(game.id);
  if(!url){url=URL.createObjectURL(blob);coverUrls.set(game.id,url);}
  document.querySelectorAll('#gameGrid .game-tile').forEach(tile=>{if(tile.dataset.gameId===game.id)applyCachedCover(tile);});
  const detailTid=$('detailTitleId')?.textContent?.trim();
  if(!document.getElementById('detailView')?.classList.contains('hidden')&&detailTid===hex8(game.titleId)){
    const cover=$('detailCover');if(cover){cover.innerHTML='';const img=document.createElement('img');img.src=url;img.alt=`${game.name||'Xbox 360 game'} cover`;cover.appendChild(img);}
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
        console.log(`[Render360 V42] Artwork cached for ${game.name} from ${game.coverSource}`);
      }catch(error){console.warn(`[Render360 V42] Artwork lookup failed for ${game.name}: ${error.message}`);}
    }
  }catch(error){console.warn(`[Render360 V42] Artwork backfill unavailable: ${error.message}`);}
  finally{artworkHydrationRunning=false;}
}

async function scheduleAutoPlay(tile){
  const gameId=tile.dataset.gameId;if(!gameId)return;
  let expected=null;
  try{expected=(await listGames()).find(game=>game.id===gameId)||null;}catch{}
  const expectedTid=expected?.titleId?hex8(expected.titleId):null;
  for(let i=0;i<72;i++){
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

  grid.addEventListener('pointerdown',event=>{
    const tile=event.target.closest?.('.game-tile');if(!tile)return;
    if(event.pointerType==='mouse'&&event.button!==0)return;
    const state={timer:null,held:false,startX:event.clientX,startY:event.clientY,pointerId:event.pointerId,blockTrustedUntil:0,allowSyntheticDetails:false};
    state.timer=setTimeout(()=>{state.timer=null;state.held=true;tile.classList.add('v42-holding');navigator.vibrate?.(10);},520);
    holdState.set(tile,state);
  },true);

  grid.addEventListener('pointermove',event=>{
    const tile=event.target.closest?.('.game-tile');if(!tile)return;const state=holdState.get(tile);if(!state||state.pointerId!==event.pointerId||state.held)return;
    if(Math.hypot(event.clientX-state.startX,event.clientY-state.startY)>12)clearHoldTimer(state);
  },true);

  const endPointer=event=>{
    const tile=event.target.closest?.('.game-tile');if(!tile)return;const state=holdState.get(tile);if(!state||state.pointerId!==event.pointerId)return;
    clearHoldTimer(state);
    if(state.held){
      event.preventDefault();
      state.blockTrustedUntil=Date.now()+900;
      state.allowSyntheticDetails=true;
      queueMicrotask(()=>tile.click());
      setTimeout(()=>tile.classList.remove('v42-holding'),160);
    }
  };
  grid.addEventListener('pointerup',endPointer,true);grid.addEventListener('pointercancel',event=>{const tile=event.target.closest?.('.game-tile');const state=tile&&holdState.get(tile);clearHoldTimer(state);tile?.classList.remove('v42-holding');},true);

  grid.addEventListener('click',event=>{
    const tile=event.target.closest?.('.game-tile');if(!tile)return;const state=holdState.get(tile);
    if(state?.allowSyntheticDetails&&!event.isTrusted){state.allowSyntheticDetails=false;return;}
    if(event.isTrusted&&state?.blockTrustedUntil>Date.now()){
      event.preventDefault();event.stopImmediatePropagation();return;
    }
    if(!event.isTrusted)return;
    scheduleAutoPlay(tile);
  },true);

  grid.addEventListener('contextmenu',event=>{
    const tile=event.target.closest?.('.game-tile');if(!tile)return;event.preventDefault();
    const state=holdState.get(tile)||{};clearHoldTimer(state);state.allowSyntheticDetails=true;state.blockTrustedUntil=Date.now()+500;holdState.set(tile,state);tile.click();
  },true);
}

function patchDiagnosticsRelease(){
  setTimeout(()=>{const log=$('diagnosticsLog');if(log)log.textContent=log.textContent.replace('"release": 41','"release": 42');},0);
}

function bootV42Patch(){
  syncThemeChrome();
  new MutationObserver(syncThemeChrome).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  bindLibraryLaunchGestures();decorateTiles();
  const grid=$('gameGrid');if(grid)new MutationObserver(()=>queueMicrotask(decorateTiles)).observe(grid,{childList:true,subtree:true});
  $('diagnosticsButton')?.addEventListener('click',patchDiagnosticsRelease);$('appDiagnosticsButton')?.addEventListener('click',patchDiagnosticsRelease);
  setTimeout(hydrateMissingArtwork,450);
  console.log('[Render360 V42] Direct-play library, hold-for-details, x360db artwork backfill, and iOS theme chrome active');
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootV42Patch,{once:true});else bootV42Patch();
