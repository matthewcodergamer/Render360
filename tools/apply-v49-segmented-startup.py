from pathlib import Path
import re

MARK='R360_SEGMENTED_BOOT_V49'

def replace_once(text, old, new, label):
    if new and new in text:
        return text
    if old not in text:
        raise SystemExit(f'{label}: expected source marker missing')
    return text.replace(old, new, 1)

# 1) Keep the normal startup module graph small. The embedded package core is a
# fallback, so do not parse/decode its base64 JavaScript unless the cached/network
# WASM path actually fails.
p=Path('wasm-core.js')
s=p.read_text()
if MARK not in s:
    s=replace_once(
        s,
        "import {CORE_WASM_GZIP_BASE64} from './render360_xenia_core_embedded.js';\n",
        '',
        'wasm-core static embedded import',
    )
    marker="import {extractStfsEntryBrowser,browserStfsExtractorContract} from './render360-stfs-browser-extractor.mjs';\n"
    s=replace_once(
        s,
        marker,
        marker+f"// {MARK}: cold fallback modules stay out of the normal startup path.\nlet embeddedCorePromise=null;\nconst embeddedCore=()=>embeddedCorePromise??=import('./render360_xenia_core_embedded.js');\n",
        'wasm-core fallback helper',
    )
    old="""    if(!result&&CORE_WASM_GZIP_BASE64){
      try{result=await WebAssembly.instantiate(await gunzip(decodeBase64(CORE_WASM_GZIP_BASE64)),{});validateInstance(result.instance,'Embedded');this.source='embedded';}
      catch(error){embeddedError=error;result=null;}
    }"""
    new="""    if(!result){
      try{
        const {CORE_WASM_GZIP_BASE64}=await embeddedCore();
        if(!CORE_WASM_GZIP_BASE64)throw new Error('Embedded core unavailable');
        result=await WebAssembly.instantiate(await gunzip(decodeBase64(CORE_WASM_GZIP_BASE64)),{});
        validateInstance(result.instance,'Embedded');this.source='embedded';
      }catch(error){embeddedError=error;result=null;}
    }"""
    s=replace_once(s,old,new,'wasm-core embedded fallback')
    p.write_text(s)

# 2) App shell: keep ZIP/cover-network code cold, paint library tiles immediately,
# then hydrate artwork in idle time instead of serially blocking the library.
p=Path('app.js')
s=p.read_text()
if MARK not in s:
    s=replace_once(s,"import {resolveTitleCover} from './library/cover-resolver.js';\n",'', 'app cover resolver import')
    s=replace_once(s,"import {prepareZipGame} from './import/zip-importer.js';\n",'', 'app zip importer import')
    settings_marker="import {storageSupported,ensureGamesDirectory,storageInfo,requestPersistentStorage,persistGameSource,openPersistentSource,deletePersistentSource,clearGamesDirectory,cleanupGameStorage} from './storage/game-storage.js';\n"
    lazy=f"""{settings_marker}
// {MARK}: load import-only modules only when the user asks for them.
let coverResolverPromise=null,zipImporterPromise=null;
const coverResolver=()=>coverResolverPromise??=import('./library/cover-resolver.js');
const zipImporter=()=>zipImporterPromise??=import('./import/zip-importer.js');
const scheduleIdle=(fn,timeout=1500)=>{{if(typeof requestIdleCallback==='function')requestIdleCallback(()=>fn(),{{timeout}});else setTimeout(fn,60);}};
const yieldUi=()=>new Promise(resolve=>setTimeout(resolve,0));
"""
    s=replace_once(s,settings_marker,lazy,'app lazy helpers')
    s=replace_once(
        s,
        "const resolved=await resolveTitleCover({titleId:info.titleId,timeoutMs:4200});",
        "const {resolveTitleCover}=await coverResolver();const resolved=await resolveTitleCover({titleId:info.titleId,timeoutMs:4200});",
        'app lazy cover resolver call',
    )
    # Both ZIP call sites are intentionally converted.
    s=s.replace("const prepared=await prepareZipGame(file,{onProgress:","const {prepareZipGame}=await zipImporter();const prepared=await prepareZipGame(file,{onProgress:")
    if s.count("prepareZipGame(file") < 2:
        raise SystemExit('app zip importer call sites missing')

    start=s.find('async function renderLibrary(){')
    end=s.find('async function restorePersistentSources(){')
    if start<0 or end<0 or end<=start:
        raise SystemExit('app renderLibrary block missing')
    new_render="""async function renderLibrary(){
  const q=($('librarySearch')?.value||'').trim().toLowerCase(),filtered=games.filter(g=>!q||String(g.name).toLowerCase().includes(q)||titleIdText(g).toLowerCase().includes(q));
  $('emptyLibrary')?.classList.toggle('hidden',games.length>0);const grid=$('gameGrid');if(!grid)return;grid.innerHTML='';
  const hydrate=[];
  for(const game of filtered){
    const cached=game?.coverKey?coverUrls.get(game.coverKey):null,button=document.createElement('button');button.type='button';button.className='game-tile';button.dataset.gameId=game.id;const linked=!!runtime.getSource(game.id),persistent=!!game.persistentSource;button.innerHTML=`<div class="cover-shell">${coverMarkup(game,cached)}</div><span class="game-tile-title">${escapeHtml(game.name)}</span><span class="game-tile-meta"><i class="status-dot ${linked?'ready':'link'}"></i>${linked?'Ready':persistent?'Restoring…':'Needs file'} · ${escapeHtml(String(game.sourceType||'game').toUpperCase())}</span>`;button.addEventListener('click',()=>openGame(game.id));grid.appendChild(button);
    if(game.coverKey&&!cached)hydrate.push(async()=>{const url=await coverUrl(game);if(!url||!button.isConnected)return;const shell=button.querySelector('.cover-shell');if(shell)shell.innerHTML=coverMarkup(game,url);});
  }
  if(hydrate.length)scheduleIdle(()=>Promise.allSettled(hydrate.map(task=>task())).catch(()=>{}),900);
}
"""
    s=s[:start]+new_render+s[end:]

    # Yield while re-linking large OPFS libraries so Safari can keep scrolling/taps smooth.
    old_restore="async function restorePersistentSources(){let restored=0;for(const game of games){if(!game.persistentSource||!game.opfsPath||runtime.getSource(game.id))continue;try{const file=await openPersistentSource(game.opfsPath,game.sourceName);if(file){runtime.bindSource(game.id,file);game.needsRelink=false;restored++;}}catch(error){log('warn',`Stored source unavailable for ${game.name}: ${error.message}`);game.needsRelink=true;game.persistentSource=false;game.opfsPath=null;await putGame(game);}}if(restored)await renderLibrary();return restored;}"
    new_restore="async function restorePersistentSources(){let restored=0,seen=0;for(const game of games){if(!game.persistentSource||!game.opfsPath||runtime.getSource(game.id))continue;try{const file=await openPersistentSource(game.opfsPath,game.sourceName);if(file){runtime.bindSource(game.id,file);game.needsRelink=false;restored++;}}catch(error){log('warn',`Stored source unavailable for ${game.name}: ${error.message}`);game.needsRelink=true;game.persistentSource=false;game.opfsPath=null;await putGame(game);}if((++seen&1)===0)await yieldUi();}if(restored)await renderLibrary();return restored;}"
    s=replace_once(s,old_restore,new_restore,'app persistent restore')

    old_boot="""  await libraryPromise;
  if(runtimeReady)void restorePersistentSources().catch(error=>log('warn',`Saved game restore: ${error.message}`));
  void cleanupGameStorage(games.map(game=>game.opfsPath).filter(Boolean)).catch(error=>log('warn',`Storage cleanup skipped: ${error.message}`));
  void updateStorageUi().catch(error=>log('warn',`Storage status: ${error.message}`));"""
    new_boot="""  // The visible shell and core are ready independently. Everything below is maintenance.
  void libraryPromise.then(()=>{
    if(runtimeReady)scheduleIdle(()=>restorePersistentSources().catch(error=>log('warn',`Saved game restore: ${error.message}`)),700);
    scheduleIdle(()=>cleanupGameStorage(games.map(game=>game.opfsPath).filter(Boolean)).catch(error=>log('warn',`Storage cleanup skipped: ${error.message}`)),2400);
    scheduleIdle(()=>updateStorageUi().catch(error=>log('warn',`Storage status: ${error.message}`)),1800);
  });"""
    s=replace_once(s,old_boot,new_boot,'app boot maintenance')
    p.write_text(s)

# 3) Secondary UI features are preserved, but stop forcing dev console, browser
# feature packs and the profile UI into the first-load module graph.
p=Path('ui-behavior.js')
s=p.read_text()
if MARK not in s:
    for line in [
        "import './developer-console.js';\n",
        "import './developer-console-fab.js';\n",
        "import './render360-browser-features.mjs';\n",
        "import './ui.js';\n",
    ]:
        s=s.replace(line,'',1)
    insert="""import {clearGamesDirectory,storageInfo} from './storage/game-storage.js';

// R360_SEGMENTED_BOOT_V49: secondary feature packs load after first paint or on demand.
let secondaryUiPromise=null,secondaryUiReady=false,developerToolsPromise=null;
function loadSecondaryUi(){
  if(!secondaryUiPromise)secondaryUiPromise=Promise.allSettled([import('./render360-browser-features.mjs'),import('./ui.js').then(()=>import('./v47-ui.js'))]).then(result=>{secondaryUiReady=true;return result;});
  return secondaryUiPromise;
}
function loadDeveloperTools(){return developerToolsPromise??=Promise.allSettled([import('./developer-console.js'),import('./developer-console-fab.js')]);}
function idleTask(fn,timeout=1800){if(typeof requestIdleCallback==='function')requestIdleCallback(()=>fn(),{timeout});else setTimeout(fn,500);}
function bindLazySecondaryUi(){
  const profile=$('profileButton');
  profile?.addEventListener('pointerdown',()=>{void loadSecondaryUi();},{capture:true});
  profile?.addEventListener('click',event=>{if(secondaryUiReady)return;event.preventDefault();event.stopImmediatePropagation();void loadSecondaryUi().then(()=>requestAnimationFrame(()=>profile.click()));},true);
  const maybeDev=()=>{const state=document.body?.dataset?.state||'';if(['BOOTING_GAME','RUNNING','PAUSED'].includes(state))void loadDeveloperTools();};
  maybeDev();new MutationObserver(maybeDev).observe(document.body,{attributes:true,attributeFilter:['data-state']});
  idleTask(()=>loadSecondaryUi(),1700);
}
"""
    marker="import {clearGamesDirectory,storageInfo} from './storage/game-storage.js';\n"
    s=replace_once(s,marker,insert,'ui behavior segmented helpers')
    old="setTimeout(hydrateMissingArtwork,450);console.log('[Render360] Direct-play library and iOS interaction behavior active');"
    new="bindLazySecondaryUi();idleTask(()=>hydrateMissingArtwork(),4200);console.log('[Render360] Direct-play library and segmented startup behavior active');"
    s=replace_once(s,old,new,'ui behavior background artwork')
    p.write_text(s)

# 4) The console FAB must not be the thing that eagerly imports profile UI.
p=Path('developer-console-fab.js')
s=p.read_text()
if s.startswith("import './v47-ui.js';\n"):
    s=s.replace("import './v47-ui.js';\n",f"// {MARK}: profile UI is loaded by the secondary UI lane, not the console FAB.\n",1)
    p.write_text(s)
elif MARK not in s:
    raise SystemExit('developer console FAB profile import marker missing')

# 5) Profile UI owns its stylesheet now that the FAB is lazy.
p=Path('v47-ui.js')
s=p.read_text()
if MARK not in s:
    marker="const $=id=>document.getElementById(id);\n"
    add=marker+"// R360_SEGMENTED_BOOT_V49: profile styling follows the profile module.\nif(!document.querySelector('link[data-r360-ui=\"v47\"]')){const link=document.createElement('link');link.rel='stylesheet';link.href='./styles/v47.css';link.dataset.r360Ui='v47';document.head.appendChild(link);}\n"
    s=replace_once(s,marker,add,'v47 stylesheet ownership')
    p.write_text(s)

# 6) Do not separately start the console FAB module from index.html. It is loaded
# automatically when entering a title runtime.
p=Path('index.html')
s=p.read_text()
old='<script type="module" src="developer-console-fab.js"></script>\n'
if old in s:
    s=s.replace(old,'',1)
    p.write_text(s)

print('Render360 V49 segmented startup patch applied')
