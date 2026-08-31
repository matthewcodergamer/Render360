import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const patch=readFileSync('app-v42-patch.js','utf8'),ui=readFileSync('render360-xenios-ui.mjs','utf8'),css=readFileSync('ui-v44-xenios.css','utf8'),ref=readFileSync('ui-v44-xenios-v16.css','utf8'),mobile=readFileSync('ui-v44-mobile-fix.css','utf8'),app=readFileSync('app-v41.js','utf8');
assert.ok(patch.includes("import './render360-xenios-ui.mjs?v=44.16';"),'XeniOS UI module not live');
for(const token of ['installSystemIcons','installLibraryChrome','centerNavigation','installPerformanceHud','installStickGuides','compactSettings','installBootOverlayGuard','installViewportRecovery','render360:telemetry','navigator.gpu.requestAdapter','estimateRefreshRate','hudGpuName','hudResolution','hudFpsRange','ui-v44-xenios-v16.css?v=44.17','ui-v44-mobile-fix.css?v=44.17','guestPresented'])assert.ok(ui.includes(token),`missing UI token: ${token}`);
assert.ok(ui.includes('<svg viewBox="0 0 24 24"'),'toolbar icons must use deterministic SVG');
assert.ok(!ui.includes('0x1008CC')&&!ui.includes('0x100185'),'Safari toolbar must not depend on SF Symbols private Unicode code points');
for(const token of ['.r360-brand','.r360-centered-nav','.performance-hud','.x-hud-table','@media(orientation:landscape)','.ios-icon-button'])assert.ok(css.includes(token),`missing base UI token: ${token}`);
for(const token of ['#developerToggle.developer-toggle','--x16-move:#1e1b1e','--x16-pause:#33281b','--x16-back:#473962','--x16-start:#734c6b','border-radius:5.5804vw 5.5804vw 5.4688vw 5.4688vw','left:12.0536%','top:55.0725%','.r360-sf-symbol'])assert.ok(ref.includes(token),`missing V44.16 reference token: ${token}`);
for(const token of ['--r360-vh','.boot-overlay','.r360-advanced-settings','#settingsButton svg','orientation:landscape'])assert.ok(mobile.includes(token),`missing mobile UI token: ${token}`);
for(const id of ['hudFps','hudFrame','hudCpu','hudGpu','hudScale','hudRam','hudPm4','hudDraws','hudBackend']){assert.ok(ui.includes(`id="${id}"`));assert.ok(app.includes(`'${id}'`));}
assert.ok(app.includes('guestPresented'));assert.ok(app.includes("'CPU ONLY'"));
assert.ok(ui.includes("$('hudFps').textContent=guestPresented&&fps>0?fps.toFixed(1):'—'"),'UI must not display browser polling as guest FPS');
console.log('R360_XENIOS_IOS_UI_CONTRACT=PASS');
