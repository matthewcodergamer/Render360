from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new, label):
    text = path.read_text()
    if old not in text:
        raise SystemExit(f'{label}: source anchor changed in {path}')
    path.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# 1) Replace the storage layer with one managed game-storage namespace.
#    Also understand the old render360-imports namespace so stale ZIP extracts
#    can be removed instead of silently occupying Safari storage forever.
# ---------------------------------------------------------------------------
storage = ROOT / 'storage/game-storage.js'
storage.write_text(r'''const ROOT_DIR='Render360';
const GAMES_DIR='Games';
const LEGACY_IMPORT_DIR='render360-imports';
const CHUNK_BYTES=8*1024*1024;

const safeName=name=>String(name||'game.bin').replace(/[\\/:*?"<>|\u0000-\u001F]/g,'_').slice(0,180)||'game.bin';
const normPath=value=>String(value||'').split('/').filter(Boolean).join('/');

export function storageSupported(){return typeof navigator!=='undefined'&&!!navigator.storage?.getDirectory;}

async function rootDirectory(){
  if(!storageSupported())throw new Error('Persistent browser game storage is unavailable in this browser');
  return navigator.storage.getDirectory();
}

export async function ensureGamesDirectory(){
  const root=await rootDirectory();
  const render360=await root.getDirectoryHandle(ROOT_DIR,{create:true});
  const games=await render360.getDirectoryHandle(GAMES_DIR,{create:true});
  return {root,render360,games,path:`${ROOT_DIR}/${GAMES_DIR}`};
}

export async function requestPersistentStorage(){
  if(!navigator.storage?.persist)return false;
  try{return await navigator.storage.persist();}catch{return false;}
}

async function directoryUsage(dir){
  let bytes=0,files=0;
  if(!dir?.entries)return {bytes,files};
  for await(const [,handle] of dir.entries()){
    if(handle.kind==='file'){
      try{const file=await handle.getFile();bytes+=Number(file.size||0);files++;}catch{}
    }else if(handle.kind==='directory'){
      const child=await directoryUsage(handle);bytes+=child.bytes;files+=child.files;
    }
  }
  return {bytes,files};
}

async function managedUsage(){
  if(!storageSupported())return {bytes:0,files:0,legacyBytes:0,legacyFiles:0};
  const root=await rootDirectory();
  let bytes=0,files=0,legacyBytes=0,legacyFiles=0;
  try{
    const render360=await root.getDirectoryHandle(ROOT_DIR);
    const games=await render360.getDirectoryHandle(GAMES_DIR);
    const current=await directoryUsage(games);bytes+=current.bytes;files+=current.files;
  }catch{}
  try{
    const legacy=await root.getDirectoryHandle(LEGACY_IMPORT_DIR);
    const old=await directoryUsage(legacy);legacyBytes=old.bytes;legacyFiles=old.files;bytes+=old.bytes;files+=old.files;
  }catch{}
  return {bytes,files,legacyBytes,legacyFiles};
}

export async function storageInfo(){
  const supported=storageSupported();
  let usage=0,quota=0,persisted=false;
  if(navigator.storage?.estimate){
    try{const estimate=await navigator.storage.estimate();usage=Number(estimate.usage||0);quota=Number(estimate.quota||0);}catch{}
  }
  if(navigator.storage?.persisted){try{persisted=await navigator.storage.persisted();}catch{}}
  const managed=supported?await managedUsage():{bytes:0,files:0,legacyBytes:0,legacyFiles:0};
  const browserFree=Math.max(0,quota-usage);
  return {
    supported,usage,quota,free:browserFree,browserFree,persisted,
    gameUsage:managed.bytes,gameFiles:managed.files,
    legacyUsage:managed.legacyBytes,legacyFiles:managed.legacyFiles,
    otherUsage:Math.max(0,usage-managed.bytes),
    deviceFree:null,deviceFreeAvailable:false,
    path:`${ROOT_DIR}/${GAMES_DIR}`,
  };
}

async function removeGameIdSiblings(games,gameId,keepName){
  if(!games?.entries)return;
  const prefix=`${safeName(gameId)}-`;
  for await(const [name,handle] of games.entries()){
    if(handle.kind!=='file'||name===keepName||!name.startsWith(prefix))continue;
    try{await games.removeEntry(name);}catch{}
  }
}

export async function persistGameSource(file,gameId,{onProgress=null}={}){
  if(!file||typeof file.slice!=='function')throw new TypeError('A browser File/Blob is required');
  const info=await storageInfo();
  if(!info.supported)throw new Error('Persistent browser game storage is unavailable');
  if(info.quota&&file.size>info.browserFree)throw new Error(`Not enough Safari site storage. Need ${(file.size/1073741824).toFixed(2)} GB, site quota headroom ${(info.browserFree/1073741824).toFixed(2)} GB.`);
  const {games}=await ensureGamesDirectory();
  const filename=`${safeName(gameId)}-${safeName(file.name||'game.bin')}`;
  await removeGameIdSiblings(games,gameId,filename);
  const handle=await games.getFileHandle(filename,{create:true});
  const writable=await handle.createWritable();
  let done=0;
  try{
    while(done<file.size){
      const end=Math.min(file.size,done+CHUNK_BYTES);
      await writable.write(file.slice(done,end));
      done=end;
      onProgress?.({done,total:file.size,percent:file.size?done/file.size*100:100,name:file.name||filename});
    }
    await writable.close();
  }catch(error){
    try{await writable.abort?.();}catch{}
    try{await games.removeEntry(filename);}catch{}
    throw error;
  }
  return {persistent:true,opfsPath:`${ROOT_DIR}/${GAMES_DIR}/${filename}`,filename};
}

export async function openPersistentSource(opfsPath,sourceName='Xbox 360 Game'){
  if(!storageSupported()||!opfsPath)return null;
  const parts=normPath(opfsPath).split('/').filter(Boolean);if(!parts.length)return null;
  let dir=await rootDirectory();
  for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);
  const handle=await dir.getFileHandle(parts.at(-1));
  const stored=await handle.getFile();
  // A File composed from another File is a lightweight Blob view; it does not
  // create another OPFS copy. Preserve the original user-facing source name so
  // extension-based launch adapters keep working after a reload.
  return new File([stored],sourceName||stored.name,{type:stored.type||'application/octet-stream',lastModified:stored.lastModified||Date.now()});
}

export async function deletePersistentSource(opfsPath){
  if(!storageSupported()||!opfsPath)return false;
  const parts=normPath(opfsPath).split('/').filter(Boolean);if(!parts.length)return false;
  let dir=await rootDirectory();
  try{
    for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);
    await dir.removeEntry(parts.at(-1),{recursive:true});return true;
  }catch{return false;}
}

async function clearDirectory(root,name){
  try{await root.removeEntry(name,{recursive:true});return true;}catch{return false;}
}

export async function clearGamesDirectory(){
  if(!storageSupported())return {supported:false,removed:false};
  const root=await rootDirectory();
  let removed=false;
  try{
    const render360=await root.getDirectoryHandle(ROOT_DIR,{create:true});
    try{await render360.removeEntry(GAMES_DIR,{recursive:true});removed=true;}catch{}
    await render360.getDirectoryHandle(GAMES_DIR,{create:true});
  }catch{}
  // Versions before v45 streamed compressed ZIP contents here. Clearing only
  // Render360/Games left these multi-gigabyte files behind in Safari.
  if(await clearDirectory(root,LEGACY_IMPORT_DIR))removed=true;
  return {supported:true,removed};
}

export async function cleanupGameStorage(keepPaths=[]){
  if(!storageSupported())return {supported:false,removedFiles:0,removedBytes:0};
  const keep=new Set((keepPaths||[]).map(normPath).filter(Boolean));
  const root=await rootDirectory();
  let removedFiles=0,removedBytes=0;
  const sweep=async(dir,prefix)=>{
    if(!dir?.entries)return;
    for await(const [name,handle] of dir.entries()){
      const path=normPath(`${prefix}/${name}`);
      if(handle.kind==='directory'){
        await sweep(handle,path);
        continue;
      }
      if(keep.has(path))continue;
      let size=0;try{size=Number((await handle.getFile()).size||0);}catch{}
      try{await dir.removeEntry(name);removedFiles++;removedBytes+=size;}catch{}
    }
  };
  try{
    const render360=await root.getDirectoryHandle(ROOT_DIR);
    const games=await render360.getDirectoryHandle(GAMES_DIR);
    await sweep(games,`${ROOT_DIR}/${GAMES_DIR}`);
  }catch{}
  try{
    const legacy=await root.getDirectoryHandle(LEGACY_IMPORT_DIR);
    await sweep(legacy,LEGACY_IMPORT_DIR);
    let hasEntry=false;if(legacy.entries){for await(const _ of legacy.entries()){hasEntry=true;break;}}
    if(!hasEntry)try{await root.removeEntry(LEGACY_IMPORT_DIR,{recursive:true});}catch{}
  }catch{}
  return {supported:true,removedFiles,removedBytes};
}

/**
 * Opens an OPFS game as a bounded range reader. This is the preferred API for
 * disc/package code that does not need a browser File object and must avoid
 * whole-image buffering for multi-gigabyte titles.
 */
export async function openPersistentRangeSource(opfsPath,{blockBytes=1024*1024,maxBlocks=32,cache=true}={}){
  if(!storageSupported()||!opfsPath)throw new Error('Persistent range source unavailable');
  const {createOPFSRangeSource,BlockCachedRangeSource}=await import('../render360-streaming-source.mjs');
  const source=await createOPFSRangeSource(opfsPath);
  return cache?new BlockCachedRangeSource(source,{blockBytes,maxBlocks}):source;
}
''')

# ---------------------------------------------------------------------------
# 2) ZIP extraction: stop creating a second, invisible OPFS namespace.
# ---------------------------------------------------------------------------
zip_path = ROOT / 'import/zip-importer.js'
replace_once(
    zip_path,
    "  const safeName=`${Date.now()}-${sanitizeName(entry.name)}`;\n  if(persistent&&navigator.storage?.getDirectory){\n    const root=await navigator.storage.getDirectory();\n    const dir=await root.getDirectoryHandle('render360-imports',{create:true});\n    const handle=await dir.getFileHandle(safeName,{create:true});",
    "  const safeName=`zip-${Date.now()}-${sanitizeName(entry.name)}`;\n  if(persistent&&navigator.storage?.getDirectory){\n    const root=await navigator.storage.getDirectory();\n    const render360=await root.getDirectoryHandle('Render360',{create:true});\n    const dir=await render360.getDirectoryHandle('Games',{create:true});\n    const handle=await dir.getFileHandle(safeName,{create:true});",
    'ZIP OPFS namespace',
)
replace_once(
    zip_path,
    "    return {file:new File([extracted],sanitizeName(entry.name),{type:mimeFor(entry.name)}),persistent:true,opfsPath:`render360-imports/${safeName}`,stored:false};",
    "    return {file:new File([extracted],sanitizeName(entry.name),{type:mimeFor(entry.name)}),persistent:true,opfsPath:`Render360/Games/${safeName}`,stored:false};",
    'ZIP persistent path',
)

# ---------------------------------------------------------------------------
# 3) Canonical app storage behavior.
# ---------------------------------------------------------------------------
app = ROOT / 'app.js'
replace_once(
    app,
    "import {storageSupported,ensureGamesDirectory,storageInfo,requestPersistentStorage,persistGameSource,openPersistentSource,deletePersistentSource,clearGamesDirectory} from './storage/game-storage.js';",
    "import {storageSupported,ensureGamesDirectory,storageInfo,requestPersistentStorage,persistGameSource,openPersistentSource,deletePersistentSource,clearGamesDirectory,cleanupGameStorage} from './storage/game-storage.js';",
    'app storage imports',
)
replace_once(
    app,
    "async function restorePersistentSources(){let restored=0;for(const game of games){if(!game.persistentSource||!game.opfsPath||runtime.getSource(game.id))continue;try{const file=await openPersistentSource(game.opfsPath,game.sourceName);if(file){runtime.bindSource(game.id,file);restored++;}}catch(error){log('warn',`Stored source unavailable for ${game.name}: ${error.message}`);game.needsRelink=true;await putGame(game);}}if(restored)await renderLibrary();return restored;}",
    "async function restorePersistentSources(){let restored=0;for(const game of games){if(!game.persistentSource||!game.opfsPath||runtime.getSource(game.id))continue;try{const file=await openPersistentSource(game.opfsPath,game.sourceName);if(file){runtime.bindSource(game.id,file);game.needsRelink=false;restored++;}}catch(error){log('warn',`Stored source unavailable for ${game.name}: ${error.message}`);game.needsRelink=true;game.persistentSource=false;game.opfsPath=null;await putGame(game);}}if(restored)await renderLibrary();return restored;}",
    'persistent source restore',
)
replace_once(app,"game.persistentSource?'Render360/Games':linked?'Current browser session':'Needs file'","game.persistentSource?'Saved in Render360':linked?'Current browser session':'Needs file'",'detail storage label')
replace_once(
    app,
    "async function updateStorageUi(){const info=await storageInfo();setText('gamesFolderPath',info.path||'Render360/Games');setText('storagePersisted',!info.supported?'Unavailable':info.persisted?'Protected':'Best effort');const pct=info.quota?Math.min(100,info.usage/info.quota*100):0;$('storageMeterFill').style.width=`${pct}%`;setText('storageNumbers',info.quota?`${formatBytes(info.usage)} / ${formatBytes(info.quota)}`:'Unavailable');setText('storageSummary',info.supported?`${formatBytes(info.free)} estimated free in this browser origin. Large ISO imports are only copied when enough quota is available.`:'This browser does not expose Origin Private File System storage. Imported games remain linked for the current session.');}",
    "async function updateStorageUi(){const info=await storageInfo();setText('gamesFolderPath',info.path||'Render360/Games');setText('storagePersisted',!info.supported?'Unavailable':info.persisted?'Protected':'Best effort');const pct=info.quota?Math.min(100,info.usage/info.quota*100):0;$('storageMeterFill').style.width=`${pct}%`;setText('storageNumbers',info.supported?`${formatBytes(info.gameUsage)} games · ${info.gameFiles||0} file${info.gameFiles===1?'':'s'}`:'Unavailable');setText('storageSummary',info.supported?`Safari site usage ${formatBytes(info.usage)} of a ${formatBytes(info.quota)} site allowance. ${formatBytes(info.browserFree)} is browser quota headroom, not iPhone free space; iOS does not expose exact device free storage to websites.${info.legacyUsage?` Legacy copies: ${formatBytes(info.legacyUsage)}.`:''}`:'This browser does not expose Origin Private File System storage. Imported games remain linked for the current session.');}",
    'app storage UI',
)
replace_once(
    app,
    "async function removeCurrentGame(){if(!currentGame)return;const game=currentGame;if(game.opfsPath)await deletePersistentSource(game.opfsPath);await deleteGame(game.id);runtime.unbindSource(game.id);currentGame=null;await refreshLibrary();setState('LIBRARY');}",
    "async function removeCurrentGame(){if(!currentGame)return;const game=currentGame;if(game.opfsPath)await deletePersistentSource(game.opfsPath);await deleteGame(game.id);runtime.unbindSource(game.id);currentGame=null;await refreshLibrary();await cleanupGameStorage(games.map(item=>item.opfsPath).filter(Boolean)).catch(()=>{});await updateStorageUi();setState('LIBRARY');}",
    'remove current game cleanup',
)
replace_once(
    app,
    "async function clearStoredGames(){const affected=games.filter(game=>String(game.opfsPath||'').startsWith('Render360/Games/'));await clearGamesDirectory();for(const game of affected){game.opfsPath=null;game.persistentSource=false;game.needsRelink=true;runtime.unbindSource(game.id);await putGame(game);}await refreshLibrary();await updateStorageUi();if(currentGame)await renderDetail();showAlert('Game Copies Cleared',affected.length?`${affected.length} stored game cop${affected.length===1?'y was':'ies were'} removed. Library entries and artwork were kept.`:'Render360/Games is already empty.',[{label:'Done'}]);}",
    "async function clearStoredGames(){const affected=games.filter(game=>game.persistentSource||game.opfsPath);await clearGamesDirectory();for(const game of affected){game.opfsPath=null;game.persistentSource=false;game.needsRelink=true;runtime.unbindSource(game.id);await putGame(game);}await refreshLibrary();await updateStorageUi();if(currentGame)await renderDetail();showAlert('Game Copies Cleared',affected.length?`${affected.length} saved game cop${affected.length===1?'y was':'ies were'} removed, including legacy ZIP extracts. Library entries and artwork were kept. Safari storage accounting may take a moment to refresh.`:'No saved Render360 game copies were found.',[{label:'Done'}]);}",
    'clear all managed game copies',
)
replace_once(
    app,
    "  }catch(error){log('error',error.message);closeSheets();showAlert('Import Failed',error.message,[{label:'OK'}]);}\n}",
    "  }catch(error){if(storage?.persistent&&storage?.opfsPath)await deletePersistentSource(storage.opfsPath).catch(()=>{});log('error',error.message);closeSheets();showAlert('Import Failed',error.message,[{label:'OK'}]);}\n}",
    'failed import cleanup',
)
replace_once(
    app,
    "  setState('LIBRARY');$('importButton').disabled=true;$('emptyImportButton').disabled=true;await refreshLibrary();",
    "  setState('LIBRARY');$('importButton').disabled=true;$('emptyImportButton').disabled=true;await refreshLibrary();await cleanupGameStorage(games.map(game=>game.opfsPath).filter(Boolean)).catch(error=>log('warn',`Storage cleanup skipped: ${error.message}`));",
    'boot orphan cleanup',
)

# ---------------------------------------------------------------------------
# 4) UI behavior duplicated the storage meter and clear handler; update it too.
# ---------------------------------------------------------------------------
behavior = ROOT / 'ui-behavior.js'
replace_once(
    behavior,
    "import {clearGamesDirectory,storageInfo} from './storage/game-storage.js';",
    "import {clearGamesDirectory,storageInfo} from './storage/game-storage.js';",
    'behavior storage import contract',
)
replace_once(behavior,"light?'default':'black-translucent'","light?'default':'black'",'opaque iOS status bar')
replace_once(
    behavior,
    "async function refreshStorageNumbers(){const info=await storageInfo();if($('storagePersisted'))$('storagePersisted').textContent=!info.supported?'Unavailable':info.persisted?'Protected':'Best effort';if($('storageNumbers'))$('storageNumbers').textContent=info.quota?`${fmtBytes(info.usage)} / ${fmtBytes(info.quota)}`:'Unavailable';if($('storageMeterFill'))$('storageMeterFill').style.width=`${info.quota?Math.min(100,info.usage/info.quota*100):0}%`;if($('storageSummary'))$('storageSummary').textContent=info.supported?`${fmtBytes(info.free)} estimated free in this browser origin. Large ISO imports are only copied when enough quota is available.`:'Persistent browser game storage is unavailable.';}",
    "async function refreshStorageNumbers(){const info=await storageInfo();if($('storagePersisted'))$('storagePersisted').textContent=!info.supported?'Unavailable':info.persisted?'Protected':'Best effort';if($('storageNumbers'))$('storageNumbers').textContent=info.supported?`${fmtBytes(info.gameUsage)} games · ${info.gameFiles||0} file${info.gameFiles===1?'':'s'}`:'Unavailable';if($('storageMeterFill'))$('storageMeterFill').style.width=`${info.quota?Math.min(100,info.usage/info.quota*100):0}%`;if($('storageSummary'))$('storageSummary').textContent=info.supported?`Safari site usage ${fmtBytes(info.usage)} of a ${fmtBytes(info.quota)} site allowance. ${fmtBytes(info.browserFree)} is browser quota headroom, not iPhone free space; iOS does not expose exact device free storage to websites.${info.legacyUsage?` Legacy copies: ${fmtBytes(info.legacyUsage)}.`:''}`:'Persistent browser game storage is unavailable.';}",
    'behavior storage meter',
)
replace_once(
    behavior,
    "async function clearGameCopies(){if(storageClearRunning)return;storageClearRunning=true;try{const games=await listGames();let affected=0;await clearGamesDirectory();for(const game of games){if(!String(game.opfsPath||'').startsWith('Render360/Games/'))continue;game.opfsPath=null;game.persistentSource=false;game.needsRelink=true;affected++;await putGame(game);}await refreshStorageNumbers();patchAlert('Game Copies Cleared',affected?`${affected} stored game cop${affected===1?'y was':'ies were'} removed. Library entries and covers were kept. Reload Render360 now so no deleted file remains linked in memory.`:'Render360/Games is empty. No stored game copies were found.',[{label:'Done',action:()=>location.reload()}]);}finally{storageClearRunning=false;}}",
    "async function clearGameCopies(){if(storageClearRunning)return;storageClearRunning=true;try{const games=await listGames();let affected=0;await clearGamesDirectory();for(const game of games){if(!game.persistentSource&&!game.opfsPath)continue;game.opfsPath=null;game.persistentSource=false;game.needsRelink=true;affected++;await putGame(game);}await refreshStorageNumbers();patchAlert('Game Copies Cleared',affected?`${affected} saved game cop${affected===1?'y was':'ies were'} removed, including legacy ZIP extracts. Library entries and covers were kept. Safari may take a moment to show the reclaimed storage.`:'No saved Render360 game copies were found.',[{label:'Done',action:()=>location.reload()}]);}finally{storageClearRunning=false;}}",
    'behavior clear all game copies',
)
replace_once(
    behavior,
    "function bindReliableStorageClear(){const button=$('clearGameStorage');if(!button)return;button.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();patchAlert('Clear Game Copies?','Delete files stored inside Render360/Games? Library entries and artwork stay, but affected games will need their original file selected again.',[{label:'Cancel'},{label:'Clear',action:clearGameCopies}]);},true);}",
    "function bindReliableStorageClear(){const button=$('clearGameStorage');if(!button)return;button.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();patchAlert('Clear Saved Game Copies?','Delete every game file Render360 stored in Safari, including old ZIP extracts? Library entries and artwork stay, but affected games will need their original file selected again.',[{label:'Cancel'},{label:'Clear',action:clearGameCopies}]);},true);}",
    'behavior storage clear confirmation',
)

# ---------------------------------------------------------------------------
# 5) Mobile Safari glass fix and a movable/dockable developer console handle.
# ---------------------------------------------------------------------------
mobile_css = ROOT / 'styles/mobile-safari-fixes.css'
mobile_css.write_text(r'''/* Render360 v45 mobile Safari refinements. */
@supports (-webkit-touch-callout:none){
  /* Avoid stacking Render360's own 28px blur under iOS Liquid Glass. The
     double compositing is what makes the Render360 title/status look smeared. */
  #libraryView .navbar{
    background:var(--bg)!important;
    -webkit-backdrop-filter:none!important;
    backdrop-filter:none!important;
    isolation:isolate;
  }
  #libraryView .r360-brand,#libraryView .nav-actions,#libraryView .r360-library-title-row{
    filter:none!important;
    -webkit-filter:none!important;
  }
}

.r360-console-fab.r360-fab-v45{
  position:fixed!important;
  inset:auto!important;
  left:18px;
  top:max(82px,calc(env(safe-area-inset-top) + 58px));
  transform:none!important;
  z-index:100500!important;
  touch-action:none!important;
  user-select:none!important;
  -webkit-user-select:none!important;
  cursor:grab;
  box-shadow:0 4px 18px rgba(0,0,0,.32)!important;
  transition:width .18s ease,border-radius .18s ease,background .18s ease;
}
.r360-console-fab.r360-fab-v45:active{cursor:grabbing}
.r360-console-fab.r360-fab-docked{
  width:30px!important;
  height:58px!important;
  border-radius:15px 0 0 15px!important;
  padding:0!important;
  font-size:22px!important;
  background:rgba(32,32,34,.88)!important;
}
.r360-console-fab.r360-fab-docked[data-dock="left"]{border-radius:0 15px 15px 0!important}
#r360DevConsole{box-sizing:border-box;padding-top:max(8px,env(safe-area-inset-top))}
#r360DevConsole .r360-dev-panel{height:min(74dvh,700px)!important;max-height:calc(100dvh - max(64px,env(safe-area-inset-top)))!important}
''')

fab = ROOT / 'developer-console-fab.js'
fab.write_text(r'''// Render360 v45 movable developer-console launcher.
const KEY='render360.dev-console-fab.v45';
const BUTTON_ID='r360RuntimeConsole';
const EDGE=42;
const PAD=8;
const MIN_TOP=72;
const BOTTOM_PAD=70;
let activeButton=null;

function loadState(){try{return {...JSON.parse(localStorage.getItem(KEY)||'{}')}}catch{return {}}}
function saveState(state){try{localStorage.setItem(KEY,JSON.stringify(state))}catch{}}
function viewport(){const v=visualViewport;return {w:Math.max(220,Math.round(v?.width||innerWidth||320)),h:Math.max(320,Math.round(v?.height||innerHeight||568))}}
function clamp(value,min,max){return Math.max(min,Math.min(max,value))}
function dimensions(button){const r=button.getBoundingClientRect();return {w:Math.max(28,r.width||48),h:Math.max(42,r.height||42)}}

function apply(button,state){
  const {w:vw,h:vh}=viewport();
  const dock=state.dock==='left'||state.dock==='right'?state.dock:null;
  button.classList.toggle('r360-fab-docked',!!dock);
  button.dataset.dock=dock||'';
  button.textContent=dock?(dock==='left'?'›':'‹'):'>_';
  button.setAttribute('aria-label',dock?'Expand Developer Console launcher':'Open Developer Console');
  const size=dimensions(button);
  let x=Number.isFinite(state.x)?state.x:Math.round(vw/2-size.w/2);
  let y=Number.isFinite(state.y)?state.y:Math.max(MIN_TOP,Math.round(vh*.18));
  y=clamp(y,MIN_TOP,Math.max(MIN_TOP,vh-size.h-BOTTOM_PAD));
  if(dock)x=dock==='left'?-4:vw-size.w+4;else x=clamp(x,PAD,Math.max(PAD,vw-size.w-PAD));
  button.style.left=`${Math.round(x)}px`;button.style.top=`${Math.round(y)}px`;
  state.x=x;state.y=y;saveState(state);
}

function bind(button){
  if(!button||button.dataset.r360FabV45==='1')return;
  button.dataset.r360FabV45='1';button.classList.add('r360-fab-v45');button.onclick=null;activeButton=button;
  const state=loadState();apply(button,state);
  let drag=null;
  button.addEventListener('pointerdown',event=>{
    if(event.pointerType==='mouse'&&event.button!==0)return;
    const r=button.getBoundingClientRect();drag={id:event.pointerId,startX:event.clientX,startY:event.clientY,offsetX:event.clientX-r.left,offsetY:event.clientY-r.top,moved:false};
    try{button.setPointerCapture(event.pointerId)}catch{}
    event.preventDefault();
  });
  button.addEventListener('pointermove',event=>{
    if(!drag||drag.id!==event.pointerId)return;
    const {w:vw,h:vh}=viewport(),size=dimensions(button);
    if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>5)drag.moved=true;
    if(!drag.moved)return;
    state.dock=null;button.classList.remove('r360-fab-docked');button.dataset.dock='';button.textContent='>_';
    state.x=clamp(event.clientX-drag.offsetX,PAD,Math.max(PAD,vw-size.w-PAD));
    state.y=clamp(event.clientY-drag.offsetY,MIN_TOP,Math.max(MIN_TOP,vh-size.h-BOTTOM_PAD));
    button.style.left=`${state.x}px`;button.style.top=`${state.y}px`;event.preventDefault();
  });
  const finish=event=>{
    if(!drag||drag.id!==event.pointerId)return;
    const moved=drag.moved;drag=null;try{button.releasePointerCapture(event.pointerId)}catch{}
    const {w:vw}=viewport(),r=button.getBoundingClientRect();
    if(moved){
      if(r.left<=EDGE)state.dock='left';else if(vw-r.right<=EDGE)state.dock='right';else state.dock=null;
      state.x=r.left;state.y=r.top;apply(button,state);return;
    }
    if(state.dock){
      const dock=state.dock;state.dock=null;state.x=dock==='left'?PAD+8:Math.max(PAD,vw-64);apply(button,state);return;
    }
    globalThis.render360DeveloperConsole?.open?.();
  };
  button.addEventListener('pointerup',finish);button.addEventListener('pointercancel',()=>{drag=null;apply(button,state)});
}

function scan(){const button=document.getElementById(BUTTON_ID);if(button)bind(button)}
new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true});
visualViewport?.addEventListener('resize',()=>{if(activeButton)apply(activeButton,loadState())});
window.addEventListener('orientationchange',()=>setTimeout(()=>{if(activeButton)apply(activeButton,loadState())},100));
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scan,{once:true});else scan();
''')

# ---------------------------------------------------------------------------
# 6) Settings copy + load the mobile fixes.
# ---------------------------------------------------------------------------
html = ROOT / 'index.html'
replace_once(html,'  <link rel="stylesheet" href="styles/controller.css" data-r360-ui="controller">','  <link rel="stylesheet" href="styles/controller.css" data-r360-ui="controller">\n  <link rel="stylesheet" href="styles/mobile-safari-fixes.css">','mobile Safari stylesheet include')
replace_once(html,'<span>Keep Imported Games</span><small>Copy direct imports into Render360 browser storage so they can reopen after a reload.</small>','<span>Keep One Local Game Copy</span><small>Save one Render360 copy in Safari so a game can reopen after a reload without choosing the file again. Turn this off to avoid permanent game copies.</small>','storage toggle wording')
replace_once(html,'<span>Browser Storage</span>','<span>Safari Site Storage</span>','storage heading')
replace_once(html,'<span>Clear Render360 Game Copies</span>','<span>Remove All Saved Game Copies</span>','clear storage label')
replace_once(html,'<script type="module" src="ui-behavior.js"></script>','<script type="module" src="ui-behavior.js"></script>\n<script type="module" src="developer-console-fab.js"></script>','floating console include')

# ---------------------------------------------------------------------------
# 7) Static regression critic.
# ---------------------------------------------------------------------------
(ROOT / 'test-storage-ui-v45.mjs').write_text(r'''import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const storage=read('./storage/game-storage.js');
const zip=read('./import/zip-importer.js');
const app=read('./app.js');
const behavior=read('./ui-behavior.js');
const html=read('./index.html');
const fab=read('./developer-console-fab.js');
const css=read('./styles/mobile-safari-fixes.css');
const fail=[];const must=(v,m)=>{if(!v)fail.push(m)};
must(storage.includes("LEGACY_IMPORT_DIR='render360-imports'"),'legacy ZIP namespace must be known');
must(storage.includes('cleanupGameStorage'),'orphan cleanup API missing');
must(storage.includes('deviceFreeAvailable:false'),'storage UI must not fake iPhone free-space access');
must(zip.includes('Render360/Games/${safeName}'),'ZIP extracts must live in managed game storage');
must(!zip.includes('opfsPath:`render360-imports/'),'new ZIP extracts must not use legacy root');
must(app.includes('cleanupGameStorage(games.map'),'app must sweep orphan copies');
must(app.includes('browser quota headroom, not iPhone free space'),'app must label quota honestly');
must(behavior.includes('including legacy ZIP extracts'),'reliable clear path must include legacy copies');
must(html.includes('Keep One Local Game Copy')&&html.includes('Safari Site Storage'),'settings copy must explain persistent storage');
must(html.includes('developer-console-fab.js')&&html.includes('mobile-safari-fixes.css'),'mobile UI patch assets must load');
must(fab.includes('setPointerCapture')&&fab.includes("state.dock='left'")&&fab.includes("state.dock='right'"),'developer console launcher must drag and dock');
must(css.includes('-webkit-backdrop-filter:none!important'),'iOS library navbar blur must be disabled');
if(fail.length){console.error('STORAGE_UI_V45 FAIL');for(const m of fail)console.error(' - '+m);process.exit(1)}
console.log('STORAGE_UI_V45 PASS');
''')

# One-shot surgery: the bot commit keeps only the real product files + critic.
(ROOT / '.github/workflows/render360-storage-ui-v45.yml').unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
print('RENDER360_STORAGE_UI_V45_SURGERY=PASS')
