import assert from 'node:assert/strict';
import {createPcMemorySource,detectPortalPcContent,detectPcGame,normalizePcPath,pcContentContract} from './runtime/pc-content-source.js';

const portal=createPcMemorySource({
  'Portal/portal/gameinfo.txt':'Game Portal',
  'Portal/portal/portal_pak_dir.vpk':new Uint8Array([1,2,3]),
  'Portal/hl2/hl2_misc_dir.vpk':new Uint8Array([4,5]),
  'Portal/hl2/hl2_textures_dir.vpk':new Uint8Array([6]),
});
// The memory fixture intentionally keeps the supplied root. A browser folder
// source strips one common selected-directory root, so build the normalized
// fixture as the actual runtime sees it.
const normalized=createPcMemorySource({
  'portal/gameinfo.txt':'Game Portal',
  'portal/portal_pak_dir.vpk':new Uint8Array([1,2,3]),
  'hl2/hl2_misc_dir.vpk':new Uint8Array([4,5]),
  'hl2/hl2_textures_dir.vpk':new Uint8Array([6]),
});
const detected=detectPortalPcContent(normalized);
assert.equal(detected.matched,true);
assert.equal(detected.gameId,'portal-1-pc');
assert.equal(detected.steamAppId,400);
assert.equal(detectPcGame(normalized).name,'Portal');
assert.equal((await normalized.read('portal/gameinfo.txt')).byteLength,'Game Portal'.length);

const incomplete=createPcMemorySource({'portal/gameinfo.txt':'Portal','portal/portal_pak_dir.vpk':'x'});
const miss=detectPortalPcContent(incomplete);
assert.equal(miss.matched,false);
assert.ok(miss.missing.some(value=>value.includes('hl2')));
assert.equal(normalizePcPath('../portal/./gameinfo.txt'),'portal/gameinfo.txt');
assert.equal(pcContentContract().portal.gameId,'portal-1-pc');
assert.equal(portal.paths().length,4);

console.log('PC_CONTENT_SOURCE=PASS');
console.log('PORTAL_PC_DETECTION=PASS');
console.log('PORTAL_PLAYER_OWNED_FILES=PASS');
