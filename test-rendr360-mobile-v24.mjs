import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const runtime=readFileSync('rendr360-mobile-runtime-fix.mjs','utf8');
const css=readFileSync('ui-v44-mobile-fix-v25.css','utf8');
const manifest=readFileSync('manifest.webmanifest','utf8');
const sw=readFileSync('render360-sw.js','utf8');
const storage=readFileSync('storage/game-storage.js','utf8');

assert.match(runtime,/ui-v44-mobile-fix-v25\.css\?v=44\.25/,'V44.25 authoritative mobile stylesheet must load last');
assert.ok(runtime.includes("root.dataset.r360MobileFix='44.25'"),'runtime recovery version must be V44.25');
assert.ok(runtime.includes("runtime.style.setProperty('left','0','important')")&&runtime.includes("runtime.style.setProperty('top','0','important')"),'runtime must ignore stale visualViewport offsets during rotation');
assert.ok(runtime.includes('webkitfullscreenchange')&&runtime.includes('webkitRequestFullscreen'),'iPhone fullscreen escape must cover WebKit APIs');
assert.ok(runtime.includes('scheduleViewportSync')&&runtime.includes('[0,120,360,720]'),'viewport recovery must be bounded instead of producing resize-event storms');
assert.ok(runtime.includes('r360RuntimeDisplayText')&&runtime.includes('compactFromSource'),'compact status must mirror rather than overwrite the runtime source text');
assert.ok(runtime.includes('apple-touch-icon-precomposed')&&runtime.includes('rendr360-apple-touch-icon.png?v=44.25'),'iOS Add to Home Screen icon must remain cache-busted');
assert.ok(runtime.includes("actions.insertBefore(settings,actions.firstElementChild)")&&runtime.includes("actions.insertBefore(profile,settings.nextElementSibling)"),'header DOM order must be Settings then Profile');
assert.ok(runtime.includes('Runtime V${runtimeVersion} · Core V${coreVersion}'),'runtime status must be concise without losing version information');

assert.ok(css.includes('background:rgba(118,118,128,.22)!important'),'runtime status must use the lighter XeniOS-like system-gray pill');
assert.ok(css.includes('#libraryView .r360-360')&&css.includes('color:var(--green,#30d158)!important'),'Rendr360 suffix must remain green');
assert.ok(css.includes('grid-template-columns:44px 44px!important')&&css.includes('gap:8px!important'),'Settings and Profile must have separate non-overlapping 44pt hit targets');
assert.ok(css.includes('left:0!important;top:0!important'),'runtime CSS must remain anchored to the viewport origin');

const manifestJson=JSON.parse(manifest);
assert.equal(manifestJson.name,'Rendr360');
assert.ok(manifestJson.icons.some(icon=>String(icon.src).includes('rendr360-apple-touch-icon.png')),'manifest must expose the Rendr360 PNG icon');
assert.ok(sw.includes("const VERSION='44.26'"),'service worker must evict the prior shell cache');
assert.ok(sw.includes('fetchBounded')&&sw.includes('runtimeAsset')&&sw.includes('RUNTIME_CACHE'),'startup resources must use bounded cached fetches rather than unbounded network-only loading');
assert.ok(sw.includes("cache.match('./index.html')")&&sw.includes('if(cached){network.catch'),'navigation must paint cached HTML immediately while refreshing in the background');
assert.ok(storage.includes('return stored;')&&!storage.includes('return new File([stored]'),'persistent restore must not duplicate large game blobs during app startup');

console.log('RENDR360_MOBILE_V26_STARTUP_CONTRACT=PASS');
