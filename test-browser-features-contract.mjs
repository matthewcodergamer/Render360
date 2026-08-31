import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const feature=readFileSync('render360-browser-features.mjs','utf8');
const sw=readFileSync('render360-sw.js','utf8');
const manifest=JSON.parse(readFileSync('manifest.webmanifest','utf8'));
const settings=readFileSync('settings/app-settings-store.js','utf8');
const app=readFileSync('app-v41.js','utf8');
const patch=readFileSync('app-v42-patch.js','utf8');
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
assert.ok(sw.includes("cache:'no-store'"),'runtime refreshes must bypass stale HTTP cache');
assert.ok(sw.includes("const VERSION='44.28'")&&sw.includes('RUNTIME_ASSETS'),'service worker must warm the V44.28 runtime cache');
assert.ok(sw.includes("'./render360_xenia_core.wasm?v=44.28'"),'service worker must pre-cache the expensive WASM core');
assert.ok(!settings.includes('render360-browser-features.mjs'),'settings storage must not auto-load browser capability UI on the critical startup path');
assert.ok(app.includes("app-settings-store.js?v=44.11"),'app entrypoint must cache-bust browser settings dependency');
assert.ok(patch.includes("render360-browser-features.mjs?v=44.11"),'V44 patch must retain on-demand browser feature loading');
assert.ok(patch.includes('loadBrowserFeatures')&&patch.includes("$('settingsButton')?.addEventListener"),'browser capabilities must load only after Settings is requested');
assert.ok(!patch.includes('scheduleDeferredTools()'),'diagnostics must not auto-wake on startup');
assert.ok(patch.includes('render360:fatalError')&&patch.includes('render360:runtimeBlocker'),'diagnostics must wake after concrete runtime failures');
assert.ok(/app-v41\.js\?v=44(?:\.|["'])/.test(index)&&/app-v42-patch\.js\?v=44(?:\.|["'])/.test(index),'HTML V44 entrypoints must be cache-busted');
assert.ok(/manifest\.webmanifest\?v=44(?:\.|["'])/.test(index),'manifest URL must be cache-busted for V44');
assert.ok(gl.includes('EXT_disjoint_timer_query_webgl2'),'WebGL2 presenter must support GPU timer queries');
assert.ok(icon.includes('<svg')&&icon.includes('#30D158'),'Rendr360 vector app icon missing');
assert.ok(Array.isArray(manifest.icons)&&manifest.icons.some(i=>i.src.includes('render360-app-icon.svg')),'manifest must retain vector app icon fallback');
assert.ok(manifest.icons.some(i=>i.src.includes('rendr360-apple-touch-icon.png')&&i.type==='image/png'),'manifest must advertise the iOS PNG app icon');
console.log('R360_BROWSER_FEATURE_INTEGRATION=PASS');
