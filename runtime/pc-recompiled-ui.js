import {makeGameId,putGame,getGame} from '../library/game-library.js';
import {createPcFileListSource,detectPcGame} from './pc-content-source.js';
import {loadCommunityWasmPackageFromFiles,loadCommunityWasmPackageFromZip,checkCommunityRuntimeRequirements} from './community-wasm-package.js';

const $=id=>document.getElementById(id);
let installed=false;
let relinkGameId=null,content=null,detection=null,runtimePackage=null,capability=null;

function fmtBytes(value=0){const n=Number(value)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`;}
function appBridge(){return globalThis.render360AppBridge||null;}

function installStylesheet(){
  if(document.querySelector('link[data-r360-pc-wasm-ui]'))return;
  const link=document.createElement('link');
  link.rel='stylesheet';link.href=new URL('../styles/pc-recompiled.css',import.meta.url).href;link.dataset.r360PcWasmUi='1';
  document.head.append(link);
}

function createWizard(){
  if($('pcWasmWizard'))return $('pcWasmWizard');
  installStylesheet();
  const root=document.createElement('div');root.id='pcWasmWizard';root.innerHTML=`
    <div class="pc-wasm-card" role="dialog" aria-modal="true" aria-labelledby="pcWasmTitle">
      <div class="pc-wasm-hero">
        <div class="pc-wasm-head">
          <div>
            <div class="pc-wasm-kicker"><span class="pc-wasm-kicker-dot"></span>PC · Source → WebAssembly</div>
            <h2 id="pcWasmTitle">Portal 1 WebAssembly</h2>
            <p>Link your installed PC copy of Portal to a separately built community Source/Emscripten runtime. Game files stay on your device.</p>
          </div>
          <button class="pc-wasm-close" type="button" aria-label="Close">×</button>
        </div>
      </div>
      <div class="pc-wasm-body">
        <div class="pc-wasm-progress" aria-hidden="true"><span id="pcProgressGame"></span><span id="pcProgressRuntime"></span><span id="pcProgressReady"></span></div>

        <div class="pc-wasm-step">
          <div class="pc-wasm-step-head"><span class="pc-wasm-step-index">1</span><div class="pc-wasm-step-copy"><strong>Link your Portal installation</strong><small>Select the folder that contains the <code>portal</code>, <code>hl2</code> and <code>platform</code> content. Render360 indexes it locally and streams files on demand.</small></div></div>
          <div id="pcGameStatus" class="pc-wasm-status">No Portal folder linked yet.</div>
          <div class="pc-wasm-actions"><button id="pcChooseGameFolder" class="primary" type="button">Choose Portal Folder</button></div>
          <div id="pcGameDrop" class="pc-wasm-drop">On desktop you can also drop the Portal folder here.</div>
        </div>

        <div class="pc-wasm-step">
          <div class="pc-wasm-step-head"><span class="pc-wasm-step-index">2</span><div class="pc-wasm-step-copy"><strong>Link the community WebAssembly build</strong><small>Choose a trusted Render360 runtime package containing <code>render360-port.json</code>. ZIP is the cleanest option.</small></div></div>
          <div id="pcRuntimeStatus" class="pc-wasm-status">No WebAssembly runtime linked yet.</div>
          <div class="pc-wasm-actions"><button id="pcChooseRuntimeZip" type="button">Choose Runtime ZIP</button><button id="pcChooseRuntimeFolder" type="button">Runtime Folder</button></div>
          <div id="pcRuntimeDrop" class="pc-wasm-drop">Drop a runtime ZIP or unpacked runtime folder here.</div>
          <div class="pc-wasm-capability"><div><strong>Browser preflight</strong><p id="pcCapabilityText">Waiting for a runtime manifest so Render360 can check its WebAssembly, graphics and threading requirements.</p></div><span id="pcCapabilityBadge" class="pc-wasm-capability-badge">CHECK</span></div>
        </div>

        <details class="pc-wasm-guide">
          <summary>How to install Portal on PC</summary>
          <div class="pc-wasm-guide-content"><ol><li>Install the original <strong>Portal</strong> (Steam App 400) from your Steam Library.</li><li>In Steam, open Portal → Manage → Browse local files.</li><li>Choose that game folder here. Render360 looks for Portal VPKs, <code>portal/gameinfo.txt</code>, and the shared HL2 content.</li></ol><a href="https://store.steampowered.com/app/400/Portal/" target="_blank" rel="noopener noreferrer">Open Portal on Steam ↗</a></div>
        </details>

        <details class="pc-wasm-guide">
          <summary>What the WebAssembly runtime is</summary>
          <div class="pc-wasm-guide-content">The Windows <code>portal.exe</code> is not converted in the browser. The Source engine must be compiled for WebAssembly/Emscripten. Render360 then provides the player-owned content mount, canvas, input, logs and lifecycle bridge. Threaded builds additionally require <code>SharedArrayBuffer</code> and cross-origin isolation.</div>
        </details>

        <div class="pc-wasm-warning">Render360 does not bundle Portal, Valve game assets, or a hidden Windows executable. Only use a community runtime you trust and are permitted to use.</div>
        <button id="pcWasmLaunch" class="pc-wasm-launch" type="button" disabled>Add Portal to Library</button>
        <div class="pc-wasm-footnote">Portal is the first PC recompile target. The Xbox 360/Xenia runtime is not changed by this importer.</div>

        <input id="pcGameFolderInput" type="file" multiple webkitdirectory directory hidden>
        <input id="pcRuntimeZipInput" type="file" accept=".zip,application/zip" hidden>
        <input id="pcRuntimeFolderInput" type="file" multiple webkitdirectory directory hidden>
      </div>
    </div>`;
  document.body.append(root);return root;
}

function installButton(){
  const row=document.querySelector('#libraryView .r360-library-title-row');if(!row)return;
  const importButton=row.querySelector('#importButton');if(!importButton)return;
  let actions=row.querySelector('.r360-library-import-actions');
  if(!actions){actions=document.createElement('div');actions.className='r360-library-import-actions';row.insertBefore(actions,importButton);actions.append(importButton);}
  if($('pcWasmImportButton'))return;
  const button=document.createElement('button');button.id='pcWasmImportButton';button.className='ios-icon-button';button.type='button';button.setAttribute('aria-label','Add PC WebAssembly game');button.title='Add PC WebAssembly game';
  button.innerHTML='<svg class="r360-pc-screen" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="12" rx="2.2"></rect><path d="M9 20h6M12 16.5V20"></path></svg>';
  actions.insertBefore(button,importButton);button.addEventListener('click',()=>openWizard());
}

function setStatus(id,text,state='idle'){
  const el=$(id);if(!el)return;el.textContent=text;el.classList.toggle('ok',state==='ok');el.classList.toggle('error',state==='error');
}
function setProgress(){
  $('pcProgressGame')?.classList.toggle('active',Boolean(detection?.matched));
  $('pcProgressRuntime')?.classList.toggle('active',Boolean(runtimePackage));
  $('pcProgressReady')?.classList.toggle('active',Boolean(detection?.matched&&runtimePackage&&capability?.ok));
}
function updateCapability(){
  capability=runtimePackage?checkCommunityRuntimeRequirements(runtimePackage.manifest):null;
  const badge=$('pcCapabilityBadge'),text=$('pcCapabilityText');if(!badge||!text)return;
  badge.classList.remove('ok','bad');
  if(!runtimePackage){badge.textContent='CHECK';text.textContent='Waiting for a runtime manifest so Render360 can check its WebAssembly, graphics and threading requirements.';return;}
  if(capability.ok){badge.textContent='READY';badge.classList.add('ok');text.textContent='This browser satisfies the requirements declared by this community runtime.';}
  else{badge.textContent='BLOCKED';badge.classList.add('bad');text.textContent=`Missing: ${capability.missing.join(', ')}. Choose a compatible build or enable the required browser isolation/features.`;}
}
function updateLaunch(){
  updateCapability();setProgress();
  const button=$('pcWasmLaunch');if(!button)return;button.disabled=!(detection?.matched&&runtimePackage&&capability?.ok);button.textContent=relinkGameId?'Relink Portal & Return':'Add Portal to Library';
}
function resetWizard({keepRelink=false}={}){
  content=null;detection=null;runtimePackage?.dispose?.();runtimePackage=null;capability=null;if(!keepRelink)relinkGameId=null;
  setStatus('pcGameStatus','No Portal folder linked yet.');setStatus('pcRuntimeStatus','No WebAssembly runtime linked yet.');updateLaunch();
}

async function openWizard({gameId=null}={}){
  const wizard=createWizard();resetWizard();relinkGameId=gameId||null;updateLaunch();
  if(relinkGameId){const game=await getGame(relinkGameId).catch(()=>null);$('pcWasmTitle').textContent=game?`Relink ${game.name}`:'Relink PC WebAssembly Game';}
  else $('pcWasmTitle').textContent='Portal 1 WebAssembly';
  wizard.classList.add('open');
}
function closeWizard(){runtimePackage?.dispose?.();runtimePackage=null;$('pcWasmWizard')?.classList.remove('open');}

async function handleGameFiles(files){
  try{
    setStatus('pcGameStatus','Indexing Portal files…');content=createPcFileListSource(files,{name:'Portal PC installation'});detection=detectPcGame(content);
    if(!detection.matched){const missing=detection.candidates?.[0]?.missing?.join(', ')||'required Portal / HL2 content';setStatus('pcGameStatus',`Portal was not fully recognized. Missing: ${missing}.`,'error');content=null;detection=null;}
    else setStatus('pcGameStatus',`Portal recognized · ${content.paths().length.toLocaleString()} files · ${fmtBytes(content.size)} · Steam App ${detection.steamAppId}.`,'ok');
  }catch(error){content=null;detection=null;setStatus('pcGameStatus',error.message,'error');}
  updateLaunch();
}
async function handleRuntimeZip(file){
  runtimePackage?.dispose?.();runtimePackage=null;
  try{
    setStatus('pcRuntimeStatus',`Indexing ${file.name}…`);runtimePackage=await loadCommunityWasmPackageFromZip(file,{expectedGameId:'portal-1-pc',onProgress:p=>{if(p.name)setStatus('pcRuntimeStatus',`Loading runtime · ${p.name}${p.percent!=null?` · ${Math.round(p.percent)}%`:''}`);}});
    setStatus('pcRuntimeStatus',`${runtimePackage.manifest.name||'Portal runtime'} · ${runtimePackage.manifest.format} · ${runtimePackage.paths().length} package files.`,'ok');
  }catch(error){runtimePackage=null;setStatus('pcRuntimeStatus',error.message,'error');}
  updateLaunch();
}
async function handleRuntimeFolder(files){
  runtimePackage?.dispose?.();runtimePackage=null;
  try{runtimePackage=await loadCommunityWasmPackageFromFiles(files,{expectedGameId:'portal-1-pc'});setStatus('pcRuntimeStatus',`${runtimePackage.manifest.name||'Portal runtime'} · ${runtimePackage.manifest.format} · ${runtimePackage.paths().length} package files.`,'ok');}
  catch(error){runtimePackage=null;setStatus('pcRuntimeStatus',error.message,'error');}
  updateLaunch();
}

function fileFromEntry(entry,path){return new Promise((resolve,reject)=>entry.file(file=>{try{Object.defineProperty(file,'relativePath',{value:path,configurable:true});}catch{}resolve(file);},reject));}
function readEntryBatch(reader){return new Promise((resolve,reject)=>reader.readEntries(resolve,reject));}
async function walkDroppedEntry(entry,prefix=''){
  const path=prefix?`${prefix}/${entry.name}`:entry.name;
  if(entry.isFile)return [await fileFromEntry(entry,path)];
  if(!entry.isDirectory)return [];
  const reader=entry.createReader(),children=[];for(;;){const batch=await readEntryBatch(reader);if(!batch.length)break;children.push(...batch);}
  const nested=[];for(const child of children)nested.push(...await walkDroppedEntry(child,path));return nested;
}
async function collectDroppedFiles(dataTransfer){
  const items=[...dataTransfer?.items||[]],entries=items.map(item=>item.webkitGetAsEntry?.()).filter(Boolean);
  if(entries.length){const files=[];for(const entry of entries)files.push(...await walkDroppedEntry(entry));return files;}
  return [...dataTransfer?.files||[]];
}
async function handleDrop(kind,event){
  event.preventDefault();event.currentTarget?.classList.remove('dragover');
  try{
    const files=await collectDroppedFiles(event.dataTransfer);if(!files.length)throw new Error('No readable files were dropped.');
    if(kind==='game')return handleGameFiles(files);
    const zip=files.length===1&&/\.zip$/i.test(files[0].name)?files[0]:null;return zip?handleRuntimeZip(zip):handleRuntimeFolder(files);
  }catch(error){setStatus(kind==='game'?'pcGameStatus':'pcRuntimeStatus',error.message,'error');updateLaunch();}
}
function wireDrop(id,kind){
  const zone=$(id);if(!zone)return;
  for(const type of ['dragenter','dragover'])zone.addEventListener(type,event=>{event.preventDefault();zone.classList.add('dragover');});
  for(const type of ['dragleave','dragend'])zone.addEventListener(type,()=>zone.classList.remove('dragover'));
  zone.addEventListener('drop',event=>handleDrop(kind,event));
}

async function addOrRelink(){
  const bridge=appBridge();if(!bridge?.runtime)throw new Error('Render360 app bridge is not ready yet.');
  if(!content||!detection?.matched||!runtimePackage)throw new Error('Choose both the Portal PC folder and the community WebAssembly runtime.');
  const currentCapability=checkCommunityRuntimeRequirements(runtimePackage.manifest);if(!currentCapability.ok)throw new Error(`This browser is missing ${currentCapability.missing.join(', ')}.`);
  const id=relinkGameId||makeGameId(),source={kind:'pc-recompiled-source',name:'Portal PC',size:content.size,content,detection,runtimePackage,createdAt:Date.now()};
  bridge.runtime.bindSource(id,source);
  let game=relinkGameId?await getGame(id):null;
  game={...(game||{}),id,name:'Portal',platform:'pc',pcGameId:'portal-1-pc',steamAppId:400,titleId:0,mediaId:0,contentType:'PC WebAssembly Port',sourceType:'pc-wasm',sourceName:'Portal PC folder + community WASM',size:content.size,compatibility:'PC WASM Bring-up',profileId:'pc-portal-1',importedAt:game?.importedAt||Date.now(),lastPlayed:game?.lastPlayed||0,persistentSource:false,needsRelink:true,communityRuntime:runtimePackage.manifest.name||'Community runtime'};
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
  $('pcWasmLaunch')?.addEventListener('click',()=>addOrRelink().catch(error=>setStatus('pcRuntimeStatus',error.message,'error')));
  wireDrop('pcGameDrop','game');wireDrop('pcRuntimeDrop','runtime');
}

export function installPcRecompiledUi(){
  if(installed)return;installed=true;installStylesheet();
  const install=()=>{installButton();wireWizard();};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();setTimeout(install,0);
  globalThis.addEventListener('render360:openPcImport',event=>openWizard({gameId:event.detail?.gameId||null}));
}

installPcRecompiledUi();
