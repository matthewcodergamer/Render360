import assert from 'node:assert/strict';
import {extractStfsEntryBrowser,browserStfsExtractorContract} from './render360-stfs-browser-extractor.mjs';

const BLOCK=0x1000;
const headerSize=0x971a;
const base=Math.ceil(headerSize/BLOCK)*BLOCK;
const bytes=new Uint8Array(base+BLOCK*3);

// Read-only STFS: L0 hash table occupies the first block after the rounded
// XContent header. File block 0 is the next block; file block 1 follows it.
const hash=base;
bytes[hash+0x14]=0x00;
bytes[hash+0x15]=0x00;
bytes[hash+0x16]=0x00;
bytes[hash+0x17]=0x01;
bytes.fill(0x11,base+BLOCK,base+BLOCK*2);
bytes.fill(0x22,base+BLOCK*2,base+BLOCK*3);

const file=new Blob([bytes]);
const stfs={headerSize,descriptorFlags:1,totalBlockCount:2};
const entry={index:7,directory:false,contiguous:false,startBlock:0,length:6000,validBlocks:2,allocatedBlocks:2};
const progress=[];
const out=await extractStfsEntryBrowser(file,{entry,stfs,captureLimit:6000,onProgress:p=>progress.push({...p})});

assert.equal(out.complete,true);
assert.equal(out.status,2);
assert.equal(out.bytesDone,6000);
assert.equal(out.blocksDone,2);
assert.equal(out.fullyCaptured,true);
assert.equal(out.fallback,'browser-stfs-v32-semantics');
assert.equal(out.captured.length,6000);
assert.ok(out.captured.subarray(0,4096).every(v=>v===0x11));
assert.ok(out.captured.subarray(4096).every(v=>v===0x22));
assert.ok(out.requestCount>=3,'non-contiguous two-block file must read data + hash metadata');
assert.equal(progress.at(-1).status,2);

const contiguous={...entry,index:8,contiguous:true};
const out2=await extractStfsEntryBrowser(file,{entry:contiguous,stfs,captureLimit:6000});
assert.equal(out2.complete,true);
assert.equal(out2.requestCount,2,'contiguous extraction must not need hash-table reads');
assert.deepEqual(out2.captured,out.captured);

const contract=browserStfsExtractorContract();
assert.equal(contract.version,43);
assert.equal(contract.nativePreferred,true);
assert.equal(contract.failClosed,true);

await assert.rejects(
  extractStfsEntryBrowser(file,{entry:{...entry,length:9000,validBlocks:1},stfs,captureLimit:9000}),
  /valid block count/
);

console.log('STFS_BROWSER_EXTRACTOR PASS');
