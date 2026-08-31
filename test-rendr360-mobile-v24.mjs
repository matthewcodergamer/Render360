import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const runtime=readFileSync('rendr360-mobile-runtime-fix.mjs','utf8');
const css=readFileSync('ui-v44-mobile-fix-v24.css','utf8');
const manifest=readFileSync('manifest.webmanifest','utf8');
const sw=readFileSync('render360-sw.js','utf8');

assert.match(runtime,/ui-v44-mobile-fix-v24\.css\?v=44\.24/,'V44.24 authoritative mobile stylesheet must load last');
assert.ok(runtime.includes("root.dataset.r360MobileFix='44.24'"),'runtime recovery version must be V44.24');
assert.ok(runtime.includes("runtime.style.setProperty('left','0','important')")&&runtime.includes("runtime.style.setProperty('top','0','important')"),'runtime must ignore stale visualViewport offsets during rotation');
assert.ok(runtime.includes('webkitfullscreenchange')&&runtime.includes('webkitRequestFullscreen'),'iPhone fullscreen escape must cover WebKit APIs');
assert.ok(runtime.includes('releaseOrientationLock')&&runtime.includes("screenOrientation,'lock'"),'iPhone runtime must stay rotatable instead of retaining landscape lock');
assert.ok(runtime.includes('apple-touch-icon-precomposed')&&runtime.includes('rendr360-apple-touch-icon.png?v=44.24'),'iOS Add to Home Screen icon must be restored and cache-busted');
assert.ok(runtime.includes('actions.appendChild(settings)')&&runtime.includes('actions.appendChild(profile)'),'header DOM order must be Settings then Profile');
assert.ok(runtime.includes('compactRuntimeStatus')&&runtime.includes('Runtime V${runtimeVersion} · Core V${coreVersion}'),'runtime status must be concise without losing version information');

assert.ok(css.includes('background:rgba(118,118,128,.16)!important'),'runtime status must use the XeniOS-like system-gray pill');
assert.ok(css.includes('#libraryView .r360-360')&&css.includes('color:var(--green,#30d158)!important'),'Rendr360 suffix must remain green');
assert.ok(css.includes('.nav-actions>#settingsButton{order:1!important}')&&css.includes('.nav-actions>#profileButton{order:2!important}'),'CSS order must be Settings then Profile');
assert.ok(css.includes('left:0!important;top:0!important'),'runtime CSS must remain anchored to the viewport origin');

const manifestJson=JSON.parse(manifest);
assert.equal(manifestJson.name,'Rendr360');
assert.ok(manifestJson.icons.some(icon=>String(icon.src).includes('rendr360-apple-touch-icon.png?v=44.24')),'manifest must expose the V44.24 PNG icon');
assert.ok(sw.includes("const VERSION='44.24'"),'service worker must evict the prior mobile shell cache');

console.log('RENDR360_MOBILE_V24_CONTRACT=PASS');
