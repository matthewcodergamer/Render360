import fs from 'node:fs';

const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const html=read('./index.html');
const app=read('./app-v40.js');
const css=read('./ui-v40.css');
const polish=read('./ui-v40-polish.css');
const runtime=read('./runtime/render360-runtime.js');
const titleControls=read('./runtime/title-controls.js');
const scheduler=read('./render360-browser-thread-scheduler.mjs');
const zip=read('./import/zip-importer.js');
const library=read('./library/game-library.js');

const failures=[];
const must=(condition,message)=>{if(!condition)failures.push(message);};
const has=(text,needle)=>text.includes(needle);

must(has(html,'app-v40.js?v=40'),'index must load app-v40.js');
must(has(html,'ui-v40.css?v=40'),'index must load ui-v40.css');
must(has(html,'ui-v40-polish.css?v=40.1'),'index must load V40 polish layer');
must(!has(html,'app-v32.js'),'legacy app-v32.js must not be deployed');
must(!has(html,'threeCanvas'),'Three.js canvas must not be deployed');
must(!/TEST ARENA|Controller test arena|arenaHud/i.test(html),'test arena UI must not be deployed');
must(!has(html,'rightStick'),'overlapping right-stick control must stay removed');
must((html.match(/id="gpuCanvas"/g)||[]).length===1,'deployed shell must have exactly one GPU canvas');
must(has(html,'id="libraryView"')&&has(html,'id="detailView"')&&has(html,'id="settingsView"')&&has(html,'id="runtimeView"'),'state views must exist');
must(has(html,'id="performanceHud"')&&has(html,'id="controllerLayer"'),'runtime HUD/controller surfaces must exist');
must(has(html,'accept=".zip,.iso,.xex,.live,.pirs,.con'),'game importer must accept ZIP and Xbox content');
must(has(html,'settingResolution')&&has(html,'disabled'),'unsupported settings must be visibly fail-closed');

must(has(app,"./runtime/render360-runtime.js"),'V40 app must use runtime adapter');
must(has(app,"./import/zip-importer.js"),'V40 app must use ZIP importer');
must(has(app,"./library/game-library.js"),'V40 app must use persistent game library');
must(!/ThreeDiagnosticHost|three-host|threeFps|enterArena|leaveArena/.test(app),'V40 app must not contain Three.js arena runtime');
must(has(app,'restorePersistentSources'),'V40 app must restore OPFS game sources');
must(has(app,'resolveTitleCover'),'V40 app must attempt Title-ID artwork resolution');

must(has(runtime,'runModernXboxIso'),'runtime adapter must preserve modern ISO execution');
must(has(runtime,'mountXdvdfs'),'runtime adapter must inspect disc XDVDFS metadata');
must(has(runtime,'RuntimeHost'),'runtime adapter must preserve controller/input bridge');
must(has(runtime,'pauseActiveTitle')&&has(runtime,'resumeActiveTitle'),'runtime pause UI must control active title scheduler');
must(!/WebGraphicsHost|ThreeDiagnosticHost/.test(runtime),'runtime adapter must not start diagnostic renderers');
must(has(titleControls,'render360ModernTitle')&&has(titleControls,'.pause')&&has(titleControls,'.resume'),'title controls must target the published modern scheduler');
must(has(scheduler,'let paused=false')&&has(scheduler,'pauseResume:true'),'browser title scheduler must have cooperative pause/resume');

must(has(zip,'DecompressionStream')&&has(zip,"'deflate-raw'"),'ZIP importer must stream Deflate entries');
must(has(zip,'navigator.storage.getDirectory'),'large ZIP entries must support OPFS extraction');
must(has(zip,'ZIP64_EOCD_SIG'),'ZIP64 archives must be indexed');
must(has(library,'indexedDB.open'),'library must be persistent IndexedDB storage');
must(has(css,'.performance-hud')&&has(css,'.controller-layer')&&has(css,'.game-grid'),'V40 stylesheet must contain player/library surfaces');
must(has(polish,'body[data-state="BOOTING_GAME"] .controller-layer'),'controller must stay hidden while a title boots');

if(failures.length){
  console.error('UI_V40_CONTRACT FAIL');
  for(const failure of failures)console.error(` - ${failure}`);
  process.exit(1);
}
console.log('UI_V40_CONTRACT PASS');
