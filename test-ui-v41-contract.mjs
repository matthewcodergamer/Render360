import fs from 'node:fs';

const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const html=read('./index.html');
const app=read('./app-v41.js');
const css=read('./ui-v41.css');
const runtime=read('./runtime/render360-runtime.js');
const bridge=read('./render360-browser-modern-content-bridge.mjs');
const storage=read('./storage/game-storage.js');
const settings=read('./settings/app-settings-store.js');
const profile=read('./profiles/title-profile-store.js');
const failures=[];
const must=(v,m)=>{if(!v)failures.push(m);};
const has=(s,n)=>s.includes(n);

must(has(html,'app-v41.js?v=41'),'deployed page must load app-v41.js');
must(has(html,'ui-v41.css?v=41'),'deployed page must load ui-v41.css');
must(!has(html,'app-v40.js'),'V40 app must not be deployed');
must(!has(html,'ui-v40.css'),'V40 stylesheet must not be deployed');
must(!has(html,'threeCanvas')&&!/TEST ARENA|Controller test arena/i.test(html),'Three.js arena must remain removed');
must((html.match(/id="gpuCanvas"/g)||[]).length===1,'exactly one GPU canvas must be deployed');
must(['libraryView','detailView','gameSettingsView','appSettingsView','runtimeView'].every(id=>has(html,`id="${id}"`)),'all V41 primary views must exist');
must(has(html,'interactive-widget=resizes-content'),'viewport must request keyboard-safe resizing');

must(has(app,'visualViewport'),'V41 must use visualViewport for iOS Safari chrome-safe sizing');
must(has(app,'persistGameSource')&&has(app,'openPersistentSource'),'V41 must persist and restore direct game imports');
must(has(app,'resolveTitleProfile'),'V41 must resolve global and per-game runtime profiles');
must(has(app,'pollGamepads'),'V41 must bridge physical gamepads');
must(has(app,'APP_SETTINGS')&&has(app,'GAME_SETTINGS'),'V41 must use dedicated settings states');

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
must(has(css,'--app-height:100dvh')&&has(css,'overflow-y:auto')&&has(css,'@media(orientation:portrait)'),'V41 CSS must be portrait-safe and independently scrollable');
must(has(css,':root[data-theme="light"]'),'light theme must exist');

if(failures.length){console.error('UI_V41_CONTRACT FAIL');for(const f of failures)console.error(` - ${f}`);process.exit(1);}console.log('UI_V41_CONTRACT PASS');
