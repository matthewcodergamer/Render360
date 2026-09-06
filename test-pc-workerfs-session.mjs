import assert from 'node:assert/strict';
import {mountPlayerOwnedFolderWithWorkerFs,workerFsMountContract} from './runtime/pc-workerfs-session.js';

const mounted=[];
const WORKERFS={name:'workerfs'};
const FS={
  filesystems:{WORKERFS},
  mkdirTree(){},
  mount(type,opts,path){mounted.push({type,opts,path});},
  unmount(){},
};
const fakeFile={size:12,slice(){return this;}};
const content={entries(){return [
  {path:'portal/gameinfo.txt',file:fakeFile,size:12},
  {path:'portal/portal_pak_dir.vpk',file:fakeFile,size:12},
  {path:'hl2/hl2_misc_dir.vpk',file:fakeFile,size:12},
  {path:'platform/platform_misc_dir.vpk',file:fakeFile,size:12},
];}};
const stages=[];
const result=await mountPlayerOwnedFolderWithWorkerFs({module:{FS},content,emitStage:stage=>stages.push(stage)});
assert.equal(result.mode,'workerfs-player-folder');
assert.equal(result.wholeInstallCopiedToHeap,false);
assert.equal(result.files,4);
assert.deepEqual(mounted.map(item=>item.path),['/portal','/hl2','/platform']);
assert.equal(mounted[0].type,WORKERFS);
assert.equal(mounted[0].opts.blobs[0].name,'gameinfo.txt');
assert.equal(stages.at(-1).stage,'pc-content-workerfs-ready');

const contract=workerFsMountContract();
assert.equal(contract.playerOwnedFiles,true);
assert.equal(contract.wholeInstallCopiedToHeap,false);
assert.equal(contract.blobBacked,true);

console.log('PORTAL_FULL_FOLDER_WORKERFS=PASS');
console.log('PORTAL_NO_WHOLE_GAME_HEAP_COPY=PASS');
