import {listGames,putGame,putCover} from '../library/game-library.js';
import {resolvePcGameCover} from '../library/cover-resolver.js';

const $=id=>document.getElementById(id);
let installed=false,artworkRunning=false,decorateQueued=false;
const isPcGame=game=>String(game?.platform||'').toLowerCase()==='pc'||Boolean(game?.pcGameId);
const bridge=()=>globalThis.render360AppBridge||null;
const currentPcGame=()=>{const game=bridge()?.getCurrentGame?.();return isPcGame(game)?game:null;};

function installStyles(){
  if(typeof document==='undefined'||document.querySelector('link[data-r360-pc-library]'))return;
  const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('../styles/pc-library-integration.css',import.meta.url).href;link.dataset.r360PcLibrary='1';document.head.append(link);
}

async function pcGamesById(){const map=new Map();for(const game of await listGames())if(isPcGame(game))map.set(String(game.id),game);return map;}
async function decoratePcLibrary(){
  decorateQueued=false;if(typeof document==='undefined')return;
  let games;try{games=await pcGamesById();}catch{return;}
  document.querySelectorAll('#gameGrid .game-tile').forEach(tile=>{
    const game=games.get(String(tile.dataset.gameId||''));if(!game)return;
    tile.classList.add('r360-pc-game-tile');
    const shell=tile.querySelector('.cover-shell');if(shell&&!shell.querySelector('.r360-platform-corner')){const badge=document.createElement('span');badge.className='r360-platform-corner pc';badge.textContent='PC';badge.setAttribute('aria-label','PC version');shell.append(badge);}
    const meta=tile.querySelector('.game-tile-meta');if(meta)meta.dataset.platform='pc';
  });
  const game=currentPcGame(),detail=$('detailCover');if(game&&detail&&!detail.querySelector('.r360-platform-corner')){const badge=document.createElement('span');badge.className='r360-platform-corner pc';badge.textContent='PC';detail.append(badge);}
}
function queueDecorate(){if(decorateQueued)return;decorateQueued=true;queueMicrotask(()=>decoratePcLibrary());}

async function hydratePcArtwork(){
  if(artworkRunning)return;artworkRunning=true;
  try{
    const games=(await listGames()).filter(game=>isPcGame(game)&&!game.coverKey&&Number(game.steamAppId||0));
    let changed=false;
    for(const game of games.slice(0,6)){
      try{
        const resolved=await resolvePcGameCover({steamAppId:game.steamAppId,pcGameId:game.pcGameId,timeoutMs:6500});if(!resolved?.blob)continue;
        game.coverKey=await putCover(resolved.blob);game.coverSource=resolved.source||'steam-library-art';game.platform='pc';game.platformLabel='PC';game.artworkPlatform='pc';await putGame(game);changed=true;
      }catch(error){console.warn(`[Render360] PC artwork lookup failed for ${game.name}: ${error?.message||error}`);}
    }
    if(changed)await bridge()?.refreshLibrary?.();
  }catch(error){console.warn(`[Render360] PC artwork hydration unavailable: ${error?.message||error}`);}finally{artworkRunning=false;queueDecorate();}
}

function ensurePcLookStick(){
  if(typeof document==='undefined')return null;let zone=$('pcRightStick');if(zone)return zone;
  const layer=$('controllerLayer');if(!layer)return null;
  zone=document.createElement('div');zone.id='pcRightStick';zone.className='r360-pc-look-stick';zone.innerHTML='<div id="pcRightStickKnob" class="r360-pc-look-knob"></div><span>LOOK</span>';layer.append(zone);return zone;
}
function pcTouchActive(){const state=document?.body?.dataset?.state;return Boolean(currentPcGame()&&['BOOTING_GAME','RUNNING','PAUSED'].includes(state));}
function normalizedStick(zone,event){const r=zone.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,max=Math.max(1,Math.min(r.width,r.height)*.36),dx=event.clientX-cx,dy=event.clientY-cy,d=Math.hypot(dx,dy)||1,s=Math.min(1,max/d);return {x:dx*s,y:dy*s,nx:Math.max(-1,Math.min(1,dx*s/max)),ny:Math.max(-1,Math.min(1,dy*s/max))};}
function wirePcStick(zone,side,{knob=null}={}){
  if(!zone||zone.dataset.r360PcStickWired)return;zone.dataset.r360PcStickWired='1';let pointer=null;
  const move=event=>{
    if(pointer!==event.pointerId||!pcTouchActive())return;event.preventDefault();event.stopImmediatePropagation();const pos=normalizedStick(zone,event);if(knob)knob.style.transform=`translate(${pos.x}px,${pos.y}px)`;
    const session=bridge()?.runtime?.recompiledSession;if(side==='move')session?.setMoveAnalog?.(pos.nx,pos.ny);else session?.setLookAnalog?.(pos.nx,pos.ny);
  };
  const end=event=>{
    if(pointer!==event.pointerId)return;if(pcTouchActive()){event.preventDefault();event.stopImmediatePropagation();}pointer=null;if(knob)knob.style.transform='';const session=bridge()?.runtime?.recompiledSession;if(side==='move')session?.setMoveAnalog?.(0,0);else session?.setLookAnalog?.(0,0);
  };
  zone.addEventListener('pointerdown',event=>{if(!pcTouchActive())return;event.preventDefault();event.stopImmediatePropagation();pointer=event.pointerId;try{zone.setPointerCapture?.(pointer);}catch{}move(event);},true);
  zone.addEventListener('pointermove',move,true);zone.addEventListener('pointerup',end,true);zone.addEventListener('pointercancel',end,true);
}
function syncControllerPlatform(){const layer=$('controllerLayer');if(!layer)return;layer.dataset.platform=currentPcGame()?'pc':'xbox360';}
function installPcTouchController(){
  const right=ensurePcLookStick();wirePcStick(right,'look',{knob:$('pcRightStickKnob')});
  wirePcStick($('leftStick'),'move',{knob:$('leftStickKnob')});syncControllerPlatform();
}

function bootPcLibraryIntegration(){
  if(installed||typeof document==='undefined')return;installed=true;installStyles();installPcTouchController();queueDecorate();setTimeout(hydratePcArtwork,700);
  const root=$('app')||document.body;if(root)new MutationObserver(()=>{queueDecorate();syncControllerPlatform();if(!$('pcRightStick'))installPcTouchController();}).observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['data-state']});
  globalThis.addEventListener?.('render360:titleStarted',()=>{syncControllerPlatform();installPcTouchController();});
  globalThis.addEventListener?.('render360:framePresented',syncControllerPlatform);
  console.log('[Render360] Unified PC library + Portal Xbox-controller overlay integration active');
}

if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootPcLibraryIntegration,{once:true});else bootPcLibraryIntegration();}

export {decoratePcLibrary,hydratePcArtwork,installPcTouchController};
