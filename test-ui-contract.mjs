import fs from 'node:fs';

const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const html=read('./index.html');
const app=read('./app.js');
const behavior=read('./ui-behavior.js');
const ui=read('./ui.js');
const developerConsole=read('./developer-console.js');
const baseCss=read('./styles/base.css');
const interactionCss=read('./styles/interactions.css');
const xeniosCss=read('./styles/xenios.css');
const controllerCss=read('./styles/controller.css');
const runtime=read('./runtime/render360-runtime.js');
const host=read('./runtime-host.js');
const worker=read('./runtime-worker.js');
const core=read('./wasm-core.js');
const version=read('./VERSION').trim();
const failures=[];
const must=(value,message)=>{if(!value)failures.push(message);};
const has=(source,token)=>source.includes(token);

must(version==='44','VERSION must remain release 44');
for(const path of ['styles/base.css','styles/interactions.css','styles/xenios.css','styles/controller.css','app.js','ui-behavior.js'])must(has(html,path),`index must load canonical ${path}`);
for(const legacy of ['app-v41.js','app-v42-patch.js','ui-v41.css','ui-v42-patch.css','ui-v44-xenios.css','ui-v44-xenios-v16.css'])must(!has(html,legacy),`index must not load legacy ${legacy}`);
must(!has(html,'&#x1008CC;')&&!has(html,'&#x100185;'),'initial toolbar must not depend on private SF Symbol code points');
must(['libraryView','detailView','gameSettingsView','appSettingsView','runtimeView'].every(id=>has(html,`id="${id}"`)),'all primary views must remain deployed');
must(has(html,'id="performanceHud"')&&has(html,'id="hudGraph"'),'runtime HUD must remain deployed');

must(has(app,'Render360Runtime')&&has(app,'persistGameSource')&&has(app,'pollGamepads'),'canonical app must retain runtime, storage and gamepad behavior');
must(has(behavior,"import './ui.js';")&&has(behavior,"import './developer-console.js';"),'UI behavior must use canonical modules');
must(has(behavior,'scheduleAutoPlay')&&has(behavior,'hydrateMissingArtwork')&&has(behavior,'clearGameCopies'),'canonical UI behavior must retain launch, artwork and storage behavior');
must(has(ui,"'./styles/xenios.css'")&&has(ui,"'./styles/controller.css'"),'UI module must reference semantic stylesheet names');
for(const token of ['installSystemIcons','installProfile','centerNavigation','installPerformanceHud','recordHudActivity','drawActivityGraph','guestPresented'])must(has(ui,token),`canonical UI missing ${token}`);
must(!has(ui,'Math.random'),'HUD graph must remain truthful and never synthesize random motion');
for(const token of ['--app-height:100dvh','@media(orientation:portrait)',':root[data-theme="light"]'])must(has(baseCss,token),`base CSS missing ${token}`);
for(const token of ['.cover-art-surface','#libraryView #profileButton'])must(has(interactionCss,token),`interaction CSS missing ${token}`);
for(const token of ['.r360-brand','.performance-hud','.x-hud-table'])must(has(xeniosCss,token),`XeniOS CSS missing ${token}`);
for(const token of ['--x16-move:#1e1b1e','left:12.0536%','top:55.0725%'])must(has(controllerCss,token),`controller CSS missing ${token}`);

must(has(runtime,"'../wasm-core.js'")&&has(runtime,"'../runtime-host.js'"),'runtime must use canonical core/host names');
must(has(host,"'./runtime-worker.js'"),'runtime host must launch canonical worker');
must(has(worker,"from './wasm-core.js'"),'runtime worker must load canonical core');
must(has(core,'render360_xenia_core.wasm'),'canonical core loader must still load the package WASM artifact');
for(const token of ['runtimeBlocker','fatalError','render360-blocker-report-v1','render360PpcRuntimeIdentity'])must(has(developerConsole,token),`developer console missing ${token}`);
for(const token of ['instructionKind','direct-branch','branchTarget','fault-not-derived-from-boundary-instruction','ppcDiagnosticSummary'])must(has(developerConsole,token),`developer console missing opcode-aware diagnostic ${token}`);
for(const token of ['Braid CPU Diagnostic','problemFocus','STACK_FRAME_TEARDOWN_MISMATCH','codeWindows','PPC around last r1 write','Ruled out right now','Next diagnostic target'])must(has(developerConsole,token),`developer console missing problem-first diagnostic ${token}`);
must(has(developerConsole,'Full event log')&&has(developerConsole,'Copy Report still includes the complete JSON'),'problem-first console must preserve complete raw diagnostics');

if(failures.length){console.error('UI_CANONICAL_CONTRACT FAIL');for(const failure of failures)console.error(` - ${failure}`);process.exit(1);}
console.log('UI_CANONICAL_CONTRACT PASS');
