import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const patch=readFileSync('app-v42-patch.js','utf8');
const ui=readFileSync('render360-xenios-ui.mjs','utf8');
const css=readFileSync('ui-v44-xenios.css','utf8');
const app=readFileSync('app-v41.js','utf8');

assert.ok(patch.includes("import './render360-xenios-ui.mjs?v=44.13';"),'V44.13 UI module is not loaded by the live app');
for(const token of [
  'installSystemIcons',
  'installLibraryChrome',
  'centerNavigation',
  'installPerformanceHud',
  'installStickGuides',
  'render360:telemetry',
  'navigator.gpu.requestAdapter',
  'estimateRefreshRate',
  'hudGpuName',
  'hudResolution',
  'hudFpsRange',
])assert.ok(ui.includes(token),`missing UI integration token: ${token}`);

for(const token of [
  '.r360-brand',
  '.r360-centered-nav',
  '.performance-hud',
  '.x-hud-table',
  '.r360-stick-guide',
  '@media(orientation:landscape)',
  '#libraryView:not(.has-games) .search-wrap',
  '.ios-icon-button',
])assert.ok(css.includes(token),`missing UI styling contract: ${token}`);

for(const id of ['hudFps','hudFrame','hudCpu','hudGpu','hudScale','hudRam','hudPm4','hudDraws','hudBackend']){
  assert.ok(ui.includes(`id="${id}"`),`new compact HUD must preserve app telemetry ID ${id}`);
  assert.ok(app.includes(`'${id}'`),`app telemetry writer missing ${id}`);
}

assert.ok(css.includes('font-family:-apple-system'),'native Apple font stack is required');
assert.ok(css.includes('backdrop-filter:blur(11px)'),'controller glass treatment missing');
console.log('R360_XENIOS_IOS_UI_CONTRACT=PASS');
