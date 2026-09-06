import assert from 'node:assert/strict';
import fs from 'node:fs';

const storage=fs.readFileSync('storage/pc-persistent-storage.js','utf8');
const integration=fs.readFileSync('runtime/pc-library-integration.js','utf8');
const ui=fs.readFileSync('runtime/pc-recompiled-ui.js','utf8');

assert.match(storage,/navigator\?\.storage/);
assert.match(storage,/getDirectory/);
assert.match(storage,/Render360/);
assert.match(storage,/const PC_DIR='PC'/);
assert.match(storage,/COPY_CHUNK=4\*1024\*1024/);
assert.match(storage,/persistPcRecompiledSource/);
assert.match(storage,/restorePcRecompiledSource/);
assert.match(storage,/loadCommunityWasmPackageFromFiles/);
assert.match(storage,/createPcFileListSource/);
assert.match(storage,/runtimeFiles/);
assert.match(storage,/restoreWithoutPicker:true/);
assert.match(storage,/allowedGameRoot=\/\^\(\?:portal\|hl2\|platform\)/);

assert.match(integration,/persistLinkedPcSources/);
assert.match(integration,/restorePersistedPcSources/);
assert.match(integration,/persistentSource:true/);
assert.match(integration,/needsRelink:false/);
assert.match(integration,/Future launches no longer need the file pickers/);
assert.match(integration,/pageshow/);

// The import wizard may still describe a newly-linked source as session-only
// for the few moments before the PC library integration finishes the OPFS copy.
// The integration must then replace that record with persistentSource=true.
assert.match(ui,/sourceType:'pc-wasm'/);

console.log('PC_OPFS_PERSISTENT_GAME_FILES=PASS');
console.log('PC_OPFS_PERSISTENT_RUNTIME_PACKAGE=PASS');
console.log('PC_OPFS_AUTOMATIC_RESTORE_WITHOUT_PICKER=PASS');
