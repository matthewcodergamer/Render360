import fs from 'node:fs';

const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const html=read('./index.html');
const app=read('./app-v41.js');
const patch=read('./app-v42-patch.js');
const developerConsole=read('./developer-console-v44.js');
const css=read('./ui-v41.css');
const patchCss=read('./ui-v42-patch.css');
const runtime=read('./runtime/render360-runtime.js');
const bridge=read('./render360-browser-modern-content-bridge.mjs');
const coreLoader=read('./wasm-core-v32.js');
const extractor=read('./render360-stfs-browser-extractor.mjs');
const storage=read('./storage/game-storage.js');
const settings=read('./settings/app-settings-store.js');
const profile=read('./profiles/title-profile-store.js');
const covers=read('./library/cover-resolver.js');
const library=read('./library/game-library.js');
const version=read('./VERSION').trim();
const failures=[];
const must=(v,m)=>{if(!v)failures.push(m);};
const has=(s,n)=>s.includes(n);

must(version==='44','VERSION must be 44');
must(has(html,'app-v41.js?v=44'),'deployed page must cache-bust the synchronized runtime shell at V44');
must(has(html,'app-v42-patch.js?v=44'),'deployed page must cache-bust the direct-play/iOS patch at V44');
must(has(html,'ui-v41.css?v=44')&&has(html,'ui-v42-patch.css?v=44'),'deployed page must cache-bust base and patch UI styles at V44');
must(has(html,'manifest.webmanifest?v=44'),'deployed manifest must be cache-busted with the V44 release');
must(has(html,'Render360 44')&&has(html,'UI Release</span><span class="value">44'),'visible settings must identify the active V44 release');
must(!has(html,'app-v40.js'),'V40 app must not be deployed');
must(!has(html,'threeCanvas')&&!/TEST ARENA|Controller test arena/i.test(html),'Three.js arena must remain removed');
must((html.match(/id="gpuCanvas"/g)||[]).length===1,'exactly one GPU canvas must be deployed');
must(['libraryView','detailView','gameSettingsView','appSettingsView','runtimeView'].every(id=>has(html,`id="${id}"`)),'all primary views must exist');
must(has(html,'interactive-widget=resizes-content'),'viewport must request keyboard-safe resizing');
must(has(html,'id="performanceHud"')&&has(html,'id="hudFps"')&&has(html,'id="hudGraph"'),'runtime view must contain the live performance HUD and graph');

must(has(app,'RENDER360_RELEASE'),'active shell must consume the runtime release constant rather than hardcoding an old UI version');
must(has(app,'visualViewport'),'base shell must use visualViewport for iOS Safari chrome-safe sizing');
must(has(app,'persistGameSource')&&has(app,'openPersistentSource'),'base shell must persist and restore direct game imports');
must(has(app,'resolveTitleProfile'),'base shell must resolve global and per-game runtime profiles');
must(has(app,'pollGamepads'),'base shell must bridge physical gamepads');
must(has(app,'APP_SETTINGS')&&has(app,'GAME_SETTINGS'),'base shell must use dedicated settings states');
must(has(app,'workerHz')&&has(app,'swaps')&&has(app,'hudPm4')&&has(app,'hudDraws'),'HUD must display real runtime counters rather than a decorative FPS-only value');
must(has(app,'await a.action?.()')&&has(app,"showAlert('Action Failed'"),'iOS alerts must await asynchronous destructive actions and surface failures');

must(has(patch,"import './developer-console-v44.js?v=44'"),'active V44 patch must load the live developer console');
must(has(patch,'scheduleAutoPlay')&&has(patch,"$('playGameButton')?.click()"),'library tap must launch through the existing Play path');
must(has(patch,'state.held=true')&&has(patch,'500'),'press-and-hold must remain reserved for details');
must(has(patch,'coverSurface(')&&has(patch,'convertNativeCoverImages')&&has(patch,'img.replaceWith(coverSurface'),'V44 must replace native cover IMG elements with app-owned surfaces on iOS interaction views');
must(has(patch,"grid.addEventListener('dragstart'")&&has(patch,"grid.addEventListener('selectstart'")&&has(patch,"grid.addEventListener('contextmenu'"),'V44 must suppress native image drag, selection and context-menu paths');
must(has(patch,'hydrateMissingArtwork')&&has(patch,'resolveTitleCover'),'artwork backfill must remain active for existing library entries');
must(has(patch,'syncThemeChrome')&&has(patch,'apple-mobile-web-app-status-bar-style'),'patch must synchronize iOS outer chrome with appearance');
must(has(patch,'Render360 V44')&&has(patch,'clearGameCopiesV44')&&has(patch,'clearGamesDirectory'),'V44 patch must identify the release and own reliable game-copy deletion');

must(PIPELINE_NAMES.every(name=>has(developerConsole,name)),'developer console must expose every commercial-title boot boundary');
must(has(developerConsole,'render360:runtimeBlocker')&&has(developerConsole,'render360:fatalError')&&has(developerConsole,'render360:telemetry'),'developer console must subscribe to blocker, fatal and telemetry events');
must(has(developerConsole,'unhandledrejection')&&has(developerConsole,"globalThis.addEventListener('error'"),'developer console must capture browser errors and unhandled promise failures');
must(has(developerConsole,'firstKernelBlocker')&&has(developerConsole,'reachedKernelBlocker')&&has(developerConsole,'lastOpcode'),'developer console must expose Xenia kernel-import and Xenos PM4 blockers');
must(has(developerConsole,'navigator.clipboard.writeText')&&has(developerConsole,'navigator.share'),'developer console must support copying/sharing an actionable report from iPhone');
must(has(developerConsole,'render360DeveloperConsole')&&has(developerConsole,'Developer Console'),'developer console must expose both an in-app UI and a programmatic debug handle');

must(has(library,"if(/^[0-9a-f]{32,64}$/.test(base))return 'con';"),'V44 must recognize extensionless hash-named STFS content such as the Braid package selected from iOS Files');

must(has(covers,'xenia-manager/x360db')&&has(covers,"source:'x360db'"),'cover resolver must use x360db Title-ID artwork first');
must(has(covers,'download.xbox.com')&&has(covers,"source:'xbox-marketplace'"),'cover resolver must retain original Xbox Marketplace fallback');
must(has(covers,'xboxunity.net'),'XboxUnity must remain a secondary fallback');

must(has(runtime,'RENDER360_RELEASE=44'),'runtime must expose V44 as its single active browser release');
must(has(runtime,"['iso','xex','live','pirs','con']"),'runtime contract must advertise all supported runnable inputs');
must(has(runtime,'runModernXboxContent'),'runtime must use the modern XEX/STFS content bridge');
must(!has(runtime,"if(type!=='iso')"),'runtime must not reject all non-ISO inputs');
must(has(runtime,'REQUIRED_CORE_BUILD=30')&&has(runtime,'REQUIRED_ABI=0x00030002'),'frontend/backend version contract must be explicit');
must(has(runtime,'coreSource')&&has(runtime,'stfsExtraction'),'runtime diagnostics must expose which core and extraction path Safari actually loaded');
must(has(runtime,'render360:${type}')&&has(runtime,'globalThis.dispatchEvent'),'runtime must mirror structured emulator events onto the global developer-console bus');

const networkPos=coreLoader.indexOf('const response=await fetch(this.url');
const embeddedPos=coreLoader.indexOf('if(!result&&CORE_WASM_GZIP_BASE64)');
must(networkPos>=0&&embeddedPos>networkPos,'package core loader must try the cache-busted network artifact before the embedded fallback');
must(has(coreLoader,"cache:'no-store'")&&has(coreLoader,"render360_xenia_core.wasm?v=44"),'package core loader must avoid stale Safari core artifacts');
must(has(coreLoader,'extractStfsEntryBrowser')&&has(coreLoader,'stfsExtractionMode'),'package core must recover STFS extraction when a legacy mounted core lacks the native V32 extractor');
must(has(extractor,'HASH_ACTIVE_INDEX_BIT')&&has(extractor,'END_OF_CHAIN')&&has(extractor,'visited.has(next)'),'browser STFS fallback must preserve hash-table selection, end-of-chain and cycle guards');
must(has(extractor,'nativePreferred:true')&&has(extractor,'version:44'),'STFS compatibility contract must identify V44 and keep native extraction preferred');

must(has(bridge,"['xex','con','live','pirs']"),'content bridge must accept XEX and STFS package types');
must(has(bridge,'core.mountStfs')&&has(bridge,'extractStfsEntry'),'STFS launch must stream-mount and extract default.xex');
must(has(bridge,'handoffDefaultXex')&&has(bridge,'createBrowserTitleThreadScheduler'),'content launch must reach generated-WASM guest scheduling');
must(has(bridge,'submitCapturedTitleGpuTraffic')&&has(bridge,'captureTitleFrontbuffer'),'content launch must connect to Xenos/frontbuffer inspection');

must(has(storage,"ROOT_DIR='Render360'")&&has(storage,"GAMES_DIR='Games'"),'persistent game folder must be Render360/Games');
must(has(storage,'navigator.storage.getDirectory')&&has(storage,'createWritable'),'storage must use OPFS and streaming writes');
must(has(settings,"const KEY='render360.settings.v44'")&&has(settings,"appearance:'system'")&&has(settings,'autoPersistImports:true')&&has(settings,'performanceHud:true'),'V44 settings must migrate to a synchronized key with HUD enabled by default');
must(has(profile,"renderer:'inherit'")&&has(profile,'schedulerQuantum:1'),'per-game profile schema must include runtime overrides');
must(has(css,'--app-height:100dvh')&&has(css,'overflow-y:auto')&&has(css,'@media(orientation:portrait)'),'base CSS must remain portrait-safe and independently scrollable');
must(has(css,':root[data-theme="light"]'),'light theme must exist');
must(has(patchCss,'.detail-cover{position:relative}'),'missing cover placeholder must stay inside the detail cover');
must(has(patchCss,':root[data-theme="light"] body')&&has(patchCss,'background-color:#f2f2f7!important'),'patch must eliminate dark light-mode root edges');
must(has(patchCss,'.cover-art-surface')&&has(patchCss,'background-size:cover')&&has(patchCss,'-webkit-touch-callout:none!important'),'V44 CSS must render cover art without exposing a native iOS image target');
must(has(patchCss,'.tile-play-badge'),'library tiles must visibly advertise Play');

if(failures.length){console.error('UI_V44_CONTRACT FAIL');for(const f of failures)console.error(` - ${f}`);process.exit(1);}console.log('UI_V44_CONTRACT PASS');

function PIPELINE_NAMES(){return ['Source / Core','Disc / Package','XEX2 / Security','PE / Guest Memory','PPC / Scheduler','xboxkrnl / XAM','Xenos / Frame'];}
