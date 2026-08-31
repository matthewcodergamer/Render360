import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const patch=readFileSync('app-v42-patch.js','utf8'),ui=readFileSync('render360-xenios-ui.mjs','utf8'),css=readFileSync('ui-v44-xenios.css','utf8'),ref=readFileSync('ui-v44-xenios-v16.css','utf8'),patchCss=readFileSync('ui-v42-patch.css','utf8'),app=readFileSync('app-v41.js','utf8');
assert.ok(patch.includes("import './render360-xenios-ui.mjs?v=44.17';"),'V44.17 restored UI module not live');
for(const token of ['installSystemIcons','installProfile','profileButton','profileSheet','r360-svg-icon','r360-profile-svg','installLibraryChrome','centerNavigation','installPerformanceHud','installStickGuides','render360:telemetry','navigator.gpu.requestAdapter','estimateRefreshRate','hudGpuName','hudResolution','hudFpsRange','ui-v44-xenios-v16.css?v=44.17','guestPresented'])assert.ok(ui.includes(token),`missing UI token: ${token}`);
assert.ok(!ui.includes('0x1008CC')&&!ui.includes('0x100185'),'private SF Symbol code points must not be used for toolbar controls');
for(const token of ['.r360-brand','.r360-centered-nav','.performance-hud','.x-hud-table','@media(orientation:landscape)','.ios-icon-button'])assert.ok(css.includes(token),`missing base UI token: ${token}`);
for(const token of ['#developerToggle.developer-toggle','--x16-move:#1e1b1e','--x16-pause:#33281b','border-radius:5.5804vw 5.5804vw 5.4688vw 5.4688vw','left:12.0536%','top:55.0725%'])assert.ok(ref.includes(token),`missing measured reference token: ${token}`);
for(const token of ['#libraryView #settingsButton','#libraryView #profileButton','.r360-profile-sheet','#runtimeView [data-key="BACK"]','#18181c','#13191f','#151c1b','#1e1519'])assert.ok(patchCss.includes(token),`missing restored UI/palette token: ${token}`);
for(const id of ['hudFps','hudFrame','hudCpu','hudGpu','hudScale','hudRam','hudPm4','hudDraws','hudBackend']){assert.ok(ui.includes(`id="${id}"`));assert.ok(app.includes(`'${id}'`));}
assert.ok(app.includes('guestPresented'));assert.ok(app.includes("'CPU ONLY'"));
assert.ok(ui.includes("$('hudFps').textContent=guestPresented&&fps>0?fps.toFixed(1):'—'"),'UI must not display browser polling as guest FPS');
console.log('R360_XENIOS_IOS_UI_CONTRACT=PASS');
