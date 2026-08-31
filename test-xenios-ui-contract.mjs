import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const patch=readFileSync('app-v42-patch.js','utf8'),ui=readFileSync('render360-xenios-ui.mjs','utf8'),css=readFileSync('ui-v44-xenios.css','utf8'),ref=readFileSync('ui-v44-xenios-v15.css','utf8'),app=readFileSync('app-v41.js','utf8');
assert.ok(patch.includes("import './render360-xenios-ui.mjs?v=44.15';"),'V44.15 UI module not live');
for(const token of ['installSystemIcons','installLibraryChrome','centerNavigation','installPerformanceHud','installStickGuides','render360:telemetry','navigator.gpu.requestAdapter','estimateRefreshRate','hudGpuName','hudResolution','hudFpsRange','ui-v44-xenios-v15.css?v=44.15','⚙︎','＋'])assert.ok(ui.includes(token),`missing UI token: ${token}`);
for(const token of ['.r360-brand','.r360-centered-nav','.performance-hud','.x-hud-table','.r360-stick-guide','@media(orientation:landscape)','.ios-icon-button'])assert.ok(css.includes(token),`missing base UI token: ${token}`);
for(const token of ['#developerToggle.developer-toggle','width:148px!important','height:110px!important','--x15-move:#1e1b1e','--x15-pause:#33281b','.r360-native-ios-symbol'])assert.ok(ref.includes(token),`missing reference token: ${token}`);
for(const id of ['hudFps','hudFrame','hudCpu','hudGpu','hudScale','hudRam','hudPm4','hudDraws','hudBackend']){assert.ok(ui.includes(`id="${id}"`));assert.ok(app.includes(`'${id}'`));}
assert.ok(app.includes('guestPresented')); assert.ok(app.includes("'CPU ONLY'"));
console.log('R360_XENIOS_IOS_UI_CONTRACT=PASS');
