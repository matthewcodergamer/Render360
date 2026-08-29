// Render360 V44 STFS extraction compatibility path.
//
// This mirrors the native V32 extractor's block/hash-chain rules and is used
// only when a deployed legacy package core can mount STFS but does not expose
// r360_stfs_extract_begin. The native extractor remains authoritative whenever
// it is available.

const BLOCK_SIZE=0x1000;
const BLOCKS_L0=170;
const BLOCKS_L1=BLOCKS_L0*BLOCKS_L0;
const HASH_ENTRY_SIZE=0x18;
const HASH_INFO_OFFSET=0x14;
const HASH_ACTIVE_INDEX_BIT=0x40000000;
const END_OF_CHAIN=0x00FFFFFF;

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const roundBlock=n=>Math.ceil(Number(n)/BLOCK_SIZE)*BLOCK_SIZE;
const floorDiv=(a,b)=>Math.floor(a/b);

function assertSafe(value,label){
  if(!Number.isSafeInteger(value)||value<0)throw new RangeError(`${label} is outside the browser safe integer range`);
  return value;
}

function layout(stfs){
  const flags=Number(stfs?.descriptorFlags||0)>>>0;
  const blocksPerHashTable=(flags&1)?1:2;
  return {flags,blocksPerHashTable,step0:BLOCKS_L0+blocksPerHashTable,step1:BLOCKS_L1+((BLOCKS_L0+1)*blocksPerHashTable),dataBase:roundBlock(Number(stfs?.headerSize||0)),totalBlocks:Number(stfs?.totalBlockCount||0)>>>0};
}

function blockOffset(blockIndex,l){
  const index=assertSafe(Number(blockIndex),'STFS block index');
  let base=BLOCKS_L0,block=index;
  for(let i=0;i<3;i++){block+=floorDiv(index+base,base)*l.blocksPerHashTable;if(index<base)break;base*=BLOCKS_L0;}
  return assertSafe(l.dataBase+block*BLOCK_SIZE,'STFS data offset');
}

function hashBlockNumber(blockIndex,level,l){
  const index=Number(blockIndex)>>>0;
  if(level===0){if(index<BLOCKS_L0)return 0;let block=floorDiv(index,BLOCKS_L0)*l.step0;block+=(floorDiv(index,BLOCKS_L1)+1)*l.blocksPerHashTable;return index<BLOCKS_L1?block:block+l.blocksPerHashTable;}
  if(level===1){if(index<BLOCKS_L1)return l.step0;return floorDiv(index,BLOCKS_L1)*l.step1+l.blocksPerHashTable;}
  return l.step1;
}
function hashOffset(blockIndex,level,l){return assertSafe(l.dataBase+hashBlockNumber(blockIndex,level,l)*BLOCK_SIZE,'STFS hash offset');}

async function readExact(file,offset,size,counter,maxRequests){
  if(++counter.count>maxRequests)throw new Error(`STFS extraction exceeded ${maxRequests} browser read requests`);
  if(offset<0||size<=0||offset>file.size||size>file.size-offset)throw new Error(`STFS extraction read outside package at 0x${offset.toString(16)} (${size} bytes)`);
  const bytes=new Uint8Array(await file.slice(offset,offset+size).arrayBuffer());
  if(bytes.length!==size)throw new Error(`Short STFS browser read at 0x${offset.toString(16)} (${bytes.length}/${size})`);
  counter.bytes+=bytes.length;return bytes;
}

async function nextBlock(file,current,l,counter,maxRequests){
  let secondary=(l.flags&1)?0:((l.flags&2)?BLOCK_SIZE:0);
  if(l.totalBlocks>BLOCKS_L1){const table=await readExact(file,hashOffset(current,2,l)+secondary,BLOCK_SIZE,counter,maxRequests);const record=floorDiv(current,BLOCKS_L1)%BLOCKS_L0;const off=record*HASH_ENTRY_SIZE+HASH_INFO_OFFSET;if(off+4>table.length)throw new Error('STFS L2 hash record is out of bounds');secondary=(be32(table,off)&HASH_ACTIVE_INDEX_BIT)?BLOCK_SIZE:0;}
  if(l.totalBlocks>BLOCKS_L0){const table=await readExact(file,hashOffset(current,1,l)+secondary,BLOCK_SIZE,counter,maxRequests);const record=floorDiv(current,BLOCKS_L0)%BLOCKS_L0;const off=record*HASH_ENTRY_SIZE+HASH_INFO_OFFSET;if(off+4>table.length)throw new Error('STFS L1 hash record is out of bounds');secondary=(be32(table,off)&HASH_ACTIVE_INDEX_BIT)?BLOCK_SIZE:0;}
  const table=await readExact(file,hashOffset(current,0,l)+secondary,BLOCK_SIZE,counter,maxRequests);const record=current%BLOCKS_L0;const off=record*HASH_ENTRY_SIZE+HASH_INFO_OFFSET;if(off+4>table.length)throw new Error('STFS L0 hash record is out of bounds');return be32(table,off)&0xFFFFFF;
}

function snapshot({entry,current,bytesDone,blocksDone,status=1}){return {status,statusName:status===2?'Complete':'Working',entryIndex:entry.index>>>0,currentBlock:current>>>0,logicalOffset:bytesDone>>>0,bytesTotal:entry.length>>>0,bytesDone:bytesDone>>>0,blocksDone:blocksDone>>>0,contiguous:!!entry.contiguous};}

export async function extractStfsEntryBrowser(file,{entry,stfs,captureLimit=32*1024*1024,maxRequests=65536,onProgress=null}={}){
  if(!file||typeof file.slice!=='function')throw new TypeError('STFS extraction requires a browser File/Blob');
  if(!entry||entry.directory)throw new Error('STFS extraction target is not a file');
  const total=Number(entry.length||0)>>>0,expected=Math.ceil(total/BLOCK_SIZE),l=layout(stfs);
  if(expected&&l.totalBlocks&&expected>l.totalBlocks)throw new Error('STFS file declares more blocks than the package contains');
  if(entry.validBlocks&&expected>Number(entry.validBlocks))throw new Error('STFS file exceeds its declared valid block count');
  if(entry.allocatedBlocks&&expected>Number(entry.allocatedBlocks))throw new Error('STFS file exceeds its declared allocated block count');
  if(total===0){const captured=new Uint8Array();return {...snapshot({entry,current:entry.startBlock||0,bytesDone:0,blocksDone:0,status:2}),complete:true,requestCount:0,totalBytesRead:0,captured,fullyCaptured:true,fallback:'browser-stfs-v32-semantics'};}
  let current=Number(entry.startBlock)>>>0;if(l.totalBlocks&&current>=l.totalBlocks)throw new Error('STFS file starts outside the package block range');
  const visited=new Set([current]),counter={count:0,bytes:0},captureBytes=Math.min(total,Math.max(0,Number(captureLimit)||0)),captured=new Uint8Array(captureBytes);let bytesDone=0,blocksDone=0;
  onProgress?.(snapshot({entry,current,bytesDone,blocksDone}));
  while(bytesDone<total){
    const size=Math.min(BLOCK_SIZE,total-bytesDone),data=await readExact(file,blockOffset(current,l),size,counter,maxRequests);
    if(bytesDone<captured.length)captured.set(data.subarray(0,Math.min(data.length,captured.length-bytesDone)),bytesDone);
    bytesDone+=size;blocksDone++;onProgress?.(snapshot({entry,current,bytesDone,blocksDone}));if(bytesDone>=total)break;
    const next=entry.contiguous?(current+1)>>>0:await nextBlock(file,current,l,counter,maxRequests);
    if(next===END_OF_CHAIN)throw new Error(`STFS file block chain ended early at ${bytesDone}/${total} bytes`);
    if(l.totalBlocks&&next>=l.totalBlocks)throw new Error(`STFS next block ${next} is outside the package block range`);
    if(visited.has(next))throw new Error(`STFS file block chain cycle detected at block ${next}`);
    visited.add(next);current=next;
  }
  if(blocksDone!==expected||bytesDone!==total)throw new Error(`STFS extraction accounting mismatch ${bytesDone}/${total} bytes, ${blocksDone}/${expected} blocks`);
  const done=snapshot({entry,current,bytesDone,blocksDone,status:2});onProgress?.(done);
  return {...done,complete:true,requestCount:counter.count,totalBytesRead:counter.bytes,captured,fullyCaptured:captured.length===total,fallback:'browser-stfs-v32-semantics'};
}

export function browserStfsExtractorContract(){return {version:44,nativePreferred:true,blockSize:BLOCK_SIZE,hashLevels:3,failClosed:true};}
