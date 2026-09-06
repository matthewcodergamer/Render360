import {makeGameId,putGame,getGame} from '../library/game-library.js';
import {createPcFileListSource,detectPcGame} from './pc-content-source.js';
import {loadCommunityWasmPackageFromFiles,loadCommunityWasmPackageFromZip} from './community-wasm-package.js';

const $=id=>document.getElementById(id);
let installed=false;

function fmtBytes(value=0){const n=Number(value)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`;}
function appBridge(){return globalThis.render360AppBridge||null;}

function styles(){
  if($('pcWasmWizardStyle'))return;
  const style=document.createElement('style');style.id='pcWasmWizardStyle';style.textContent=`
  #pcWasmWizard{position:fixed;inset:0;z-index:12000;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.5);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);padding:env(safe-area-inset-top) 12px max(12px,env(safe-area-inset-bottom))}
  #pcWasmWizard.open{display:flex}.pc-wasm-card{width:min(620px,100%);max-height:min(820px,calc(100dvh - 24px));overflow:auto;border:1px solid rgba(255,255,255,.12);border-radius:26px;background:rgba(20,20,22,.96);color:#fff;box-shadow:0 22px 80px rgba(0,0,0,.45);padding:20px}.pc-wasm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}.pc-wasm-head h2{font-size:24px;margin:0 0 4px}.pc-wasm-head p,.pc-wasm-note{margin:0;color:#a1a1a8;font-size:13px;line-height:1.45}.pc-wasm-close{border:0;border-radius:999px;background:#303035;color:#fff;width:34px;height:34px;font-size:20px}.pc-wasm-step{padding:16px;border-radius:18px;background:#2a2a2e;margin:10px 0}.pc-wasm-step strong{display:block;font-size:15px;margin-bottom:4px}.pc-wasm-status{font-size:12px;color:#a8a8b0;margin:6px 0 12px;word-break:break-word}.pc-wasm-actions{display:flex;gap:8px;flex-wrap:wrap}.pc-wasm-actions button,.pc-wasm-launch{border:0;border-radius:12px;padding:11px 14px;font-weight:650;font-size:14px;background:#3a3a40;color:#fff}.pc-wasm-actions button.primary,.pc-wasm-launch{background:#30d158;color:#08150b}.pc-wasm-launch{width:100%;margin-top:12px;padding:14px}.pc-wasm-launch:disabled{opacity:.42}.pc-wasm-warning{padding:12px 14px;border-radius:14px;background:rgba(255,159,10,.12);color:#ffc66b;font-size:12px;line-height:1.45;margin-top:12px}#pcWasmImportButton{min-width:42px;padding:0 10px;font-size:11px;font-weight:750;letter-spacing:.02em}
  @media(min-width:700px){#pcWasmWizard{align-items:center}.pc-wasm-card{padding:24px}}
  `;document.head.append(style);
}

function createWizard(){
  if($('pcWasmWizard'))return $('pcWasmWizard');styles();
  const root=document.createElement('div');root.id='pcWasmWizard';root.innerHTML=`<div class="pc-wasm-card" role="dialog" aria-modal="true" aria-labelledby="pcWasmTitle"><div class="pc-wasm-head"><div><h2 id="pcWasmTitle">PC WebAssembly Port</h2><p>Portal 1 is the first PC target. Your game files stay local; Render360 only links them to a separately supplied community WebAssembly runtime.</p></div><button class="pc-wasm-close" type="button" aria-label="Close">×</button></div><div class="pc-wasm-step"><strong>1 · Choose your Portal PC folder</strong><div id="pcGameStatus" class="pc-wasm-status">Select the installed Portal folder containing the <code>portal</code> and <code>hl2</code> content directories.</div><div class="pc-wasm-actions"><button id="pcChooseGameFolder" class="primary" type="button">Choose Game Folder</button></div></div><div class="pc-wasm-step"><strong>2 · Choose the community WebAssembly runtime</strong><div id="pcRuntimeStatus" class="pc-wasm-status">Select a Render360 runtime ZIP/folder with <code>render360-port.json</code>. The package is executable code, so use one you trust.</div><div class="pc-wasm-actions"><button id="pcChooseRuntimeZip" type="button">Runtime ZIP</button><button id="pcChooseRuntimeFolder" type="button">Runtime Folder</button></div></div><div class="pc-wasm-warning">Render360 does not ship Portal, Valve assets, or a leaked Source Engine build. The PC installation and the community runtime are supplied separately. A normal Windows <code>portal.exe</code> cannot simply be renamed to <code>.wasm</code>.</div><button id="pcWasmLaunch" class="pc-wasm-launch" type="button" disabled>Add Portal to Library</button><input id="pcGameFolderInput" type="file" multiple webkitdirectory directory hidden><input id="pcRuntimeZipInput" type="file" accept=".zip,application/zip" hidden><input id="pcRuntimeFolderInput" type="file" multiple webkitdirectory directory hidden></div>`;
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
function resetWizard({keepRelink=false}={}){content=null;detection=null;runtimePackage?.dispose?.();runtimePackage=null;if(!keepRelink)relinkGameId=null;setStatus('pcGameStatus','Select the installed Portal folder containing the portal and hl2 content directories.');setStatus('pcRuntimeStatus','Select a Render360 runtime ZIP/folder with render360-port.json. The package is executable code, so use one you trust.');updateLaunch();}

async function openWizard({gameId=null}={}){
  const wizard=createWizard();resetWizard();relinkGameId=gameId||null;updateLaunch();
  if(relinkGameId){const game=await getGame(relinkGameId).catch(()=>null);$('pcWasmTitle').textContent=game?`Relink ${game.name}`:'Relink PC WebAssembly Game';}
  else $('pcWasmTitle').textContent='PC WebAssembly Port';
  wizard.classList.add('open');
}
function closeWizard(){runtimePackage?.dispose?.();runtimePackage=null;$('pcWasmWizard')?.classList.remove('open');}

async function handleGameFiles(files){
  try{content=createPcFileListSource(files,{name:'Portal PC installation'});detection=detectPcGame(content);if(!detection.matched){setStatus('pcGameStatus',`Portal was not fully recognized. Missing: ${detection.candidates?.[0]?.missing?.join(', ')||'required Portal/HL2 content'}.`);content=null;detection=null;}else setStatus('pcGameStatus',`Portal recognized · ${content.paths().length.toLocaleString()} files · ${fmtBytes(content.size)} · Steam App ${detection.steamAppId}.`,true);}catch(error){content=null;detection=null;setStatus('pcGameStatus',error.message);}updateLaunch();
}
async function handleRuntimeZip(file){
  runtimePackage?.dispose?.();runtimePackage=null;try{setStatus('pcRuntimeStatus',`Indexing ${file.name}…`);runtimePackage=await loadCommunityWasmPackageFromZip(file,{expectedGameId:'portal-1-pc',onProgress:p=>{if(p.name)setStatus('pcRuntimeStatus',`Loading runtime · ${p.name}${p.percent!=null?` · ${Math.round(p.percent)}%`:''}`);}});setStatus('pcRuntimeStatus',`${runtimePackage.manifest.name||'Portal runtime'} · ${runtimePackage.manifest.format} · ${runtimePackage.paths().length} package files.`,true);}catch(error){runtimePackage=null;setStatus('pcRuntimeStatus',error.message);}updateLaunch();
}
async function handleRuntimeFolder(files){runtimePackage?.dispose?.();runtimePackage=null;try{runtimePackage=await loadCommunityWasmPackageFromFiles(files,{expectedGameId:'portal-1-pc'});setStatus('pcRuntimeStatus',`${runtimePackage.manifest.name||'Portal runtime'} · ${runtimePackage.manifest.format} · ${runtimePackage.paths().length} package files.`,true);}catch(error){runtimePackage=null;setStatus('pcRuntimeStatus',error.message);}updateLaunch();}

async function addOrRelink(){
  const bridge=appBridge();if(!bridge?.runtime)throw new Error('Render360 app bridge is not ready yet.');if(!content||!detection?.matched||!runtimePackage)throw new Error('Choose both the Portal PC folder and the community WebAssembly runtime.');
  const id=relinkGameId||makeGameId(),source={kind:'pc-recompiled-source',name:'Portal PC',size:content.size,content,detection,runtimePackage,createdAt:Date.now()};
  bridge.runtime.bindSource(id,source);
  let game=relinkGameId?await getGame(id):null;game={...(game||{}),id,name:'Portal',platform:'pc',pcGameId:'portal-1-pc',steamAppId:400,titleId:0,mediaId:0,contentType:'PC WebAssembly Port',sourceType:'pc-wasm',sourceName:'Portal PC folder + community WASM',size:content.size,compatibility:'PC WASM Bring-up',profileId:'pc-portal-1',importedAt:game?.importedAt||Date.now(),lastPlayed:game?.lastPlayed||0,persistentSource:false,needsRelink:true,communityRuntime:runtimePackage.manifest.name||'Community runtime'};
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
