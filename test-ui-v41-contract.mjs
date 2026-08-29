import fs from 'node:fs';

const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const html=read('./index.html');
const app=read('./app-v41.js');
const patch=read('./app-v42-patch.js');
const css=read('./ui-v41.css');
const patchCss=read('./ui-v42-patch.css');
const runtime=read('./runtime/render360-runtime.js');
const bridge=read('./render360-browser-modern-content-bridge.mjs');
const storage=read('./storage/game-storage.js');
const settings=read('./settings/app-settings-store.js');
const profile=read('./profiles/title-profile-store.js');
const covers=read('./library/cover-resolver.js');
const version=read('./VERSION').trim();
const failures=[];
const must=(v,m)=>{if(!v)failures.push(m);};
const has=(s,n)=>s.includes(n);

must(version==='42','VERSION must be 42');
must(has(html,'app-v41.js?v=42'),'deployed page must load the synchronized V41 runtime shell with V42 cache busting');
must(has(html,'app-v42-patch.js?v=42'),'deployed page must load V42 direct-play behavior');
must(has(html,'ui-v41.css?v=42')&&has(html,'ui-v42-patch.css?v=42'),'deployed page must load base and V42 UI styles');
must(has(html,'Render360 42')&&has(html,'<span class="value">42</span>'),'Settings must visibly report UI release 42');
must(!has(html,'app-v40.js'),'V40 app must not be deployed');
must(!has(html,'threeCanvas')&&!/TEST ARENA|Controller test arena/i.test(html),'Three.js arena must remain removed');
must((html.match(/id="gpuCanvas"/g)||[]).length===1,'exactly one GPU canvas must be deployed');
must(['libraryView','detailView','gameSettingsView','appSettingsView','runtimeView'].every(id=>has(html,`id="${id}"`)),'all primary views must exist');
must(has(html,'interactive-widget=resizes-content'),'viewport must request keyboard-safe resizing');

must(has(app,'visualViewport'),'base shell must use visualViewport for iOS Safari chrome-safe sizing');
must(has(app,'persistGameSource')&&has(app,'openPersistentSource'),'base shell must persist and restore direct game imports');
must(has(app,'resolveTitleProfile'),'base shell must resolve global and per-game runtime profiles');
must(has(app,'pollGamepads'),'base shell must bridge physical gamepads');
must(has(app,'APP_SETTINGS')&&has(app,'GAME_SETTINGS'),'base shell must use dedicated settings states');

must(has(patch,'scheduleAutoPlay')&&has(patch,"$('playGameButton')?.click()"),'V42 library tap must launch through the existing Play path');
must(has(patch,"setTimeout(()=>{state.timer=null;state.held=true")&&has(patch,'520'),'V42 must reserve press-and-hold for details');
must(has(patch,'hydrateMissingArtwork')&&has(patch,'resolveTitleCover'),'V42 must backfill artwork for existing library entries');
must(has(patch,'syncThemeChrome')&&has(patch,"apple-mobile-web-app-status-bar-style"),'V42 must synchronize iOS outer chrome with appearance');

must(has(covers,'xenia-manager/x360db')&&has(covers,"source:'x360db'"),'cover resolver must use x360db Title-ID artwork first');
must(has(covers,'download.xbox.com')&&has(covers,"source:'xbox-marketplace'"),'cover resolver must retain original Xbox Marketplace fallback');
must(has(covers,'xboxunity.net'),'XboxUnity must remain a secondary fallback');

must(has(runtime,"['iso','xex','live','pirs','con']"),'runtime contract must advertise all supported runnable inputs');
must(has(runtime,'runModernXboxContent'),'runtime must use the modern XEX/STFS content bridge');
must(!has(runtime,"if(type!=='iso')"),'runtime must not reject all non-ISO inputs');
must(has(runtime,'REQUIRED_CORE_BUILD=30')&&has(runtime,'REQUIRED_ABI=0x00030002'),'frontend/backend version contract must be explicit');

must(has(bridge,"['xex','con','live','pirs']"),'content bridge must accept XEX and STFS package types');
must(has(bridge,'core.mountStfs')&&has(bridge,'extractStfsEntry'),'STFS launch must stream-mount and extract default.xex');
must(has(bridge,'handoffDefaultXex')&&has(bridge,'createBrowserTitleThreadScheduler'),'content launch must reach generated-WASM guest scheduling');
must(has(bridge,'submitCapturedTitleGpuTraffic')&&has(bridge,'captureTitleFrontbuffer'),'content launch must connect to Xenos/frontbuffer inspection');

must(has(storage,"ROOT_DIR='Render360'")&&has(storage,"GAMES_DIR='Games'"),'persistent game folder must be Render360/Games');
must(has(storage,'navigator.storage.getDirectory')&&has(storage,'createWritable'),'storage must use OPFS and streaming writes');
must(has(settings,"appearance:'system'")&&has(settings,'autoPersistImports:true'),'global settings defaults must include appearance and persistent imports');
must(has(profile,"renderer:'inherit'")&&has(profile,'schedulerQuantum:1'),'per-game profile schema must include runtime overrides');
must(has(css,'--app-height:100dvh')&&has(css,'overflow-y:auto')&&has(css,'@media(orientation:portrait)'),'base CSS must remain portrait-safe and independently scrollable');
must(has(css,':root[data-theme="light"]'),'light theme must exist');
must(has(patchCss,'.detail-cover{position:relative}'),'missing cover placeholder must stay inside the detail cover');
must(has(patchCss,':root[data-theme="light"] body')&&has(patchCss,'background-color:#f2f2f7!important'),'V42 must eliminate dark light-mode root edges');
must(has(patchCss,'.tile-play-badge'),'library tiles must visibly advertise Play');

if(failures.length){console.error('UI_V42_CONTRACT FAIL');for(const f of failures)console.error(` - ${f}`);process.exit(1);}console.log('UI_V42_CONTRACT PASS');
