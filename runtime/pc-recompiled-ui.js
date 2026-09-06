import {makeGameId,putGame,getGame,putCover} from '../library/game-library.js';
import {createPcFileListSource,detectPcGame} from './pc-content-source.js';
import {loadCommunityWasmPackageFromFiles,loadCommunityWasmPackageFromZip} from './community-wasm-package.js';

const $=id=>document.getElementById(id);
const PORTAL_STORE_URL='https://store.steampowered.com/app/400/Portal/';
const PORTAL_ART_URL='https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/400/header.jpg';
const PORTAL_RUNTIME_ACTIONS='https://github.com/matthewcodergamer/Render360/actions/workflows/portal-source-wasm.yml';
let installed=false;

function fmtBytes(value=0){const n=Number(value)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`;}
function appBridge(){return globalThis.render360AppBridge||null;}

function styles(){
  if($('pcWasmWizardStyle'))return;
  const style=document.createElement('style');style.id='pcWasmWizardStyle';style.textContent=`
  #pcWasmWizard{position:fixed;inset:0;z-index:12000;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.56);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);padding:env(safe-area-inset-top) 12px max(12px,env(safe-area-inset-bottom))}
  #pcWasmWizard.open{display:flex}.pc-wasm-card{width:min(640px,100%);max-height:min(850px,calc(100dvh - 24px));overflow:auto;border:1px solid rgba(255,255,255,.12);border-radius:28px;background:rgba(18,18,20,.97);color:#fff;box-shadow:0 28px 90px rgba(0,0,0,.5);padding:18px}.pc-wasm-hero{position:relative;overflow:hidden;border-radius:20px;min-height:150px;background:#0d2533;margin-bottom:16px}.pc-wasm-hero img{width:100%;height:100%;min-height:150px;object-fit:cover;display:block}.pc-wasm-hero:after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.02),rgba(0,0,0,.54))}.pc-wasm-hero-copy{position:absolute;z-index:2;left:16px;right:16px;bottom:14px;display:flex;align-items:end;justify-content:space-between;gap:12px}.pc-wasm-badge{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:6px 9px;border-radius:999px;background:rgba(10,10,12,.72);backdrop-filter:blur(10px)}
  .pc-wasm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}.pc-wasm-head h2{font-size:24px;margin:0 0 4px}.pc-wasm-head p,.pc-wasm-note{margin:0;color:#a1a1a8;font-size:13px;line-height:1.45}.pc-wasm-close{border:0;border-radius:999px;background:#303035;color:#fff;width:34px;height:34px;font-size:20px;flex:0 0 auto}.pc-wasm-step{padding:15px;border-radius:18px;background:#29292d;margin:10px 0}.pc-wasm-step strong{display:block;font-size:15px;margin-bottom:4px}.pc-wasm-status{font-size:12px;color:#a8a8b0;margin:6px 0 12px;word-break:break-word;line-height:1.45}.pc-wasm-actions{display:flex;gap:8px;flex-wrap:wrap}.pc-wasm-actions button,.pc-wasm-actions a,.pc-wasm-launch{border:0;border-radius:12px;padding:11px 14px;font-weight:650;font-size:14px;background:#3a3a40;color:#fff;text-decoration:none}.pc-wasm-actions button.primary,.pc-wasm-launch{background:#30d158;color:#08150b}.pc-wasm-actions a.steam{background:#1b2838}.pc-wasm-launch{width:100%;margin-top:12px;padding:14px}.pc-wasm-launch:disabled{opacity:.42}.pc-wasm-warning{padding:12px 14px;border-radius:14px;background:rgba(10,132,255,.1);color:#9ccaff;font-size:12px;line-height:1.5;margin-top:12px}#pcWasmImportButton{min-width:42px;padding:0 10px;font-size:11px;font-weight:750;letter-spacing:.02em}.pc-wasm-list{margin:8px 0 0 18px;padding:0;color:#b7b7bd;font-size:12px;line-height:1.55}.pc-wasm-list li+li{margin-top:5px}
  @media(min-width:700px){#pcWasmWizard{align-items:center}.pc-wasm-card{padding:22px}.pc-wasm-hero{min-height:180px}.pc-wasm-hero img{min-height:180px}}
  `;document.head.append(style);
}

function createWizard(){
  if($('pcWasmWizard'))return $('pcWasmWizard');styles();
  const root=document.createElement('div');root.id='pcWasmWizard';root.innerHTML=`<div class="pc-wasm-card" role="dialog" aria-modal="true" aria-labelledby="pcWasmTitle"><div class="pc-wasm-hero"><img src="${PORTAL_ART_URL}" alt="Portal"><div class="pc-wasm-hero-copy"><span class="pc-wasm-badge">PC · Source → WebAssembly</span><span class="pc-wasm-badge">First target</span></div></div><div class="pc-wasm-head"><div><h2 id="pcWasmTitle">Portal · WebAssembly</h2><p>The community Source Engine is compiled to WebAssembly. You provide your own Portal install; Render360 does not distribute Valve game data.</p></div><button class="pc-wasm-close" type="button" aria-label="Close">×</button></div><div class="pc-wasm-step"><strong>1 · Get and install Portal</strong><div class="pc-wasm-status">Portal is Steam App 400. Install it normally on a PC. If you are launching on iPhone/iPad, copy the installed <code>Portal</code> folder to Files, iCloud Drive, or attached storage first.</div><div class="pc-wasm-actions"><a class="steam" href="${PORTAL_STORE_URL}" target="_blank" rel="noopener">Open Portal on Steam</a></div><ol class="pc-wasm-list"><li>Steam → Library → Portal → Manage/Browse local files.</li><li>Keep the <code>portal/</code>, <code>hl2/</code>, and <code>platform/</code> folders together.</li><li>Render360 reads the selected local files; it does not upload them to a game-data server.</li></ol></div><div class="pc-wasm-step"><strong>2 · Choose your Portal PC folder</strong><div id="pcGameStatus" class="pc-wasm-status">Select the installed Portal folder containing the <code>portal</code> and <code>hl2</code> content directories.</div><div class="pc-wasm-actions"><button id="pcChooseGameFolder" class="primary" type="button">Choose Portal Folder</button></div></div><div class="pc-wasm-step"><strong>3 · Choose the Source WebAssembly runtime</strong><div id="pcRuntimeStatus" class="pc-wasm-status">Use the Render360 engine-only Portal runtime built from the pinned community Source port. It contains executable WebAssembly code but no Portal VPK/BSP assets.</div><div class="pc-wasm-actions"><a href="${PORTAL_RUNTIME_ACTIONS}" target="_blank" rel="noopener">Runtime Builds</a><button id="pcChooseRuntimeZip" type="button">Runtime ZIP</button><button id="pcChooseRuntimeFolder" type="button">Runtime Folder</button></div></div><div class="pc-wasm-warning">The first runtime profile uses a dedicated Web Worker + Emscripten WORKERFS so large player-owned files can be read in slices instead of copying the whole Portal install into Wasm memory. The renderer target is WebGL 2 first; WebGPU comes after the Source port boots reliably.</div><button id="pcWasmLaunch" class="pc-wasm-launch" type="button" disabled>Add Portal to Library</button><input id="pcGameFolderInput" type="file" multiple webkitdirectory directory hidden><input id="pcRuntimeZipInput" type="file" accept=".zip,application/zip" hidden><input id="pcRuntimeFolderInput" type="file" multiple webkitdirectory directory hidden></div>`;
  document.body.append(root);return root;
}

function installButton(){
  if($('pcWasmImportButton'))return;
  const row=document.querySelector('#libraryView .r360-library-title-row');if(!row)return;
  const button=document.createElement('button');button.id='pcWasmImportButton';button.className='ios-icon-button';button.type='button';button.textContent='PC';button.setAttribute('aria-label','Import PC WebAssembly game');button.title='Import PC WebAssembly game';
  row.querySelector('#importButton')?.before(button);button.addEventListener('click',()=>openWizard());
}

let relinkGameId=null,content=null,detection=null,runtimePackage=null;
function setStatus(id,text,ok=false){const el=$(id);if(!el)return;el.textContent=text;el.style.color=ok?'#79e890':'#a8a8b0';}
function updateLaunch(){const button=$('pcWasmLaunch');if(!button)return;button.disabled=!(detection?.matched&&runtimePackage);button.textContent=relinkGameId?'Relink Portal & Return':'Add Portal to Library';}
function resetWizard({keepRelink=false}={}){content=null;detection=null;runtimePackage?.dispose?.();runtimePackage=null;if(!keepRelink)relinkGameId=null;setStatus('pcGameStatus','Select the installed Portal folder containing the portal and hl2 content directories.');setStatus('pcRuntimeStatus','Choose the engine-only Render360 Portal Source WebAssembly runtime ZIP/folder containing render360-port.json.');updateLaunch();}

async function openWizard({gameId=null}={}){
  const wizard=createWizard();resetWizard();relinkGameId=gameId||null;updateLaunch();
  if(relinkGameId){const game=await getGame(relinkGameId).catch(()=>null);$('pcWasmTitle').textContent=game?`Relink ${game.name}`:'Relink PC WebAssembly Game';}
  else $('pcWasmTitle').textContent='Portal · WebAssembly';
  wizard.classList.add('open');
}
function closeWizard(){runtimePackage?.dispose?.();runtimePackage=null;$('pcWasmWizard')?.classList.remove('open');}

async function handleGameFiles(files){
  try{content=createPcFileListSource(files,{name:'Portal PC installation'});detection=detectPcGame(content);if(!detection.matched){setStatus('pcGameStatus',`Portal was not fully recognized. Missing: ${detection.candidates?.[0]?.missing?.join(', ')||'required Portal/HL2 content'}.`);content=null;detection=null;}else setStatus('pcGameStatus',`Portal recognized · ${content.paths().length.toLocaleString()} files · ${fmtBytes(content.size)} · Steam App ${detection.steamAppId}.`,true);}catch(error){content=null;detection=null;setStatus('pcGameStatus',error.message);}updateLaunch();
}
async function handleRuntimeZip(file){
  runtimePackage?.dispose?.();runtimePackage=null;try{setStatus('pcRuntimeStatus',`Indexing ${file.name}…`);runtimePackage=await loadCommunityWasmPackageFromZip(file,{expectedGameId:'portal-1-pc',onProgress:p=>{if(p.name)setStatus('pcRuntimeStatus',`Loading runtime · ${p.name}${p.percent!=null?` · ${Math.round(p.percent)}%`:''}`);}});setStatus('pcRuntimeStatus',`${runtimePackage.manifest.name||'Portal runtime'} · ${runtimePackage.manifest.format} · ${runtimePackage.paths().length} engine files · no retail game data bundled.`,true);}catch(error){runtimePackage=null;setStatus('pcRuntimeStatus',error.message);}updateLaunch();
}
async function handleRuntimeFolder(files){runtimePackage?.dispose?.();runtimePackage=null;try{runtimePackage=await loadCommunityWasmPackageFromFiles(files,{expectedGameId:'portal-1-pc'});setStatus('pcRuntimeStatus',`${runtimePackage.manifest.name||'Portal runtime'} · ${runtimePackage.manifest.format} · ${runtimePackage.paths().length} engine files.`,true);}catch(error){runtimePackage=null;setStatus('pcRuntimeStatus',error.message);}updateLaunch();}

async function ensurePortalCover(existingKey=null){
  if(existingKey)return existingKey;
  try{const response=await fetch(PORTAL_ART_URL,{mode:'cors',credentials:'omit',cache:'force-cache'});if(!response.ok)return null;const blob=await response.blob();if(!blob.type.startsWith('image/'))return null;return await putCover(blob,`steam-400-${Date.now().toString(36)}`);}catch{return null;}
}

async function addOrRelink(){
  const bridge=appBridge();if(!bridge?.runtime)throw new Error('Render360 app bridge is not ready yet.');if(!content||!detection?.matched||!runtimePackage)throw new Error('Choose both the Portal PC folder and the Source WebAssembly runtime.');
  const id=relinkGameId||makeGameId(),source={kind:'pc-recompiled-source',name:'Portal PC',size:content.size,content,detection,runtimePackage,createdAt:Date.now()};
  bridge.runtime.bindSource(id,source);
  let game=relinkGameId?await getGame(id):null;const coverKey=await ensurePortalCover(game?.coverKey||null);
  game={...(game||{}),id,name:'Portal',platform:'pc',pcGameId:'portal-1-pc',steamAppId:400,titleId:0,mediaId:0,contentType:'PC Source WebAssembly',sourceType:'pc-wasm',sourceName:'Player-owned Portal folder + Source WASM',size:content.size,compatibility:'Portal Source WASM Bring-up',profileId:'pc-portal-1-source-wasm',importedAt:game?.importedAt||Date.now(),lastPlayed:game?.lastPlayed||0,persistentSource:false,needsRelink:true,communityRuntime:runtimePackage.manifest.name||'Portal Source community runtime',coverKey:coverKey||game?.coverKey||null,artUrl:PORTAL_ART_URL,storeUrl:PORTAL_STORE_URL};
  await putGame(game);runtimePackage=null;relinkGameId=null;$('pcWasmWizard')?.classList.remove('open');await bridge.refreshLibrary?.();await bridge.openGame?.(id);
}

function wireWizard(){
  const wizard=createWizard();if(wizard.dataset.wired)return;wizard.dataset.wired='1';
  wizard.querySelector('.pc-wasm-close')?.addEventListener('click',closeWizard);wizard.addEventListener('click',event=>{if(event.target===wizard)closeWizard();});
  $('pcChooseGameFolder')?.addEventListener('click',()=>{const input=$('pcGameFolderInput');input.value='';input.click();});
  $('pcChooseRuntimeZip')?.addEventListener('click',()=>{const input=$('pcRuntimeZipInput');input.value='';input.click();});
  $('pcChooseRuntimeFolder')?.addEventListener('click',()=>{const input=$('pcRuntimeFolderInput');input.value='';input.click();});
  $('pcGameFolderInput')?.addEventListener('change',event=>handleGameFiles(event.target.files));
  $('pcRuntimeZipInput')?.addEventListener('change',event=>event.target.files?.[0]&&handleRuntimeZip(event.target.files[0]));
  $('pcRuntimeFolderInput')?.addEventListener('change',event=>handleRuntimeFolder(event.target.files));
  $('pcWasmLaunch')?.addEventListener('click',()=>addOrRelink().catch(error=>setStatus('pcRuntimeStatus',error.message)));
}

export function installPcRecompiledUi(){if(installed)return;installed=true;const install=()=>{installButton();wireWizard();};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();setTimeout(install,0);globalThis.addEventListener('render360:openPcImport',event=>openWizard({gameId:event.detail?.gameId||null}));}

installPcRecompiledUi();
