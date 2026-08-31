import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const feature=readFileSync('render360-browser-features.mjs','utf8');
const sw=readFileSync('render360-sw.js','utf8');
const manifest=JSON.parse(readFileSync('manifest.webmanifest','utf8'));
const settings=readFileSync('settings/app-settings-store.js','utf8');
const app=readFileSync('app.js','utf8');
const behavior=readFileSync('ui-behavior.js','utf8');
const index=readFileSync('index.html','utf8');
const gl=readFileSync('render360-webgl2-xenos.mjs','utf8');
const icon=readFileSync('render360-app-icon.svg','utf8');

for(const token of [
  'vibrationActuator',
  "'trigger-rumble'",
  "screen.orientation.lock('landscape')",
  'requestFullscreen',
  "keyboardLock:'browser'",
  'navigator.wakeLock.request',
  'EXT_disjoint_timer_query_webgl2',
  'navigator.serviceWorker.register',
  'navigationPreload',
  'Background Fetch',
  'WebAssembly ES Modules',
  'File Handle Serialization',
])assert.ok(feature.includes(token),`missing browser feature integration: ${token}`);

assert.ok(sw.includes('navigationPreload.enable'),'service worker must enable navigation preload');
assert.ok(sw.includes('isMutableRuntime'),'service worker must separate mutable runtime assets');
assert.ok(sw.includes("cache:'no-store'"),'mutable JS/WASM must remain network-first/no-store');
assert.ok(settings.includes('render360-browser-features.mjs'),'app settings store must load browser feature bridge');
assert.ok(app.includes('app-settings-store.js'),'app entrypoint must load browser settings dependency');
assert.ok(behavior.includes("import './render360-browser-features.mjs';"),'UI behavior must directly load browser feature bridge');
assert.ok(index.includes('src="app.js"')&&index.includes('src="ui-behavior.js"'),'HTML must use canonical entrypoints');
assert.ok(index.includes('manifest.webmanifest'),'manifest must be linked');
assert.ok(gl.includes('EXT_disjoint_timer_query_webgl2'),'WebGL2 presenter must support GPU timer queries');
assert.ok(icon.includes('<svg')&&icon.includes('#30D158'),'Render360 vector app icon missing');
assert.ok(Array.isArray(manifest.icons)&&manifest.icons.some(i=>i.src.includes('render360-app-icon.svg')),'manifest must advertise app icon');
console.log('R360_BROWSER_FEATURE_INTEGRATION=PASS');
