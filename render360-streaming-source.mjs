const DEFAULT_BLOCK_BYTES=1024*1024;
function rangeCheck(offset,length,size=Number.MAX_SAFE_INTEGER){offset=Number(offset);length=Number(length);if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>size)throw new RangeError('range outside source');return {offset,length,end:offset+length};}

export function createBlobRangeSource(blob,{name=blob?.name||'blob'}={}){
  if(!blob||typeof blob.slice!=='function')throw new TypeError('Blob/File required');
  return {kind:'blob-range-source',name,size:Number(blob.size||0),async read(offset,length){const r=rangeCheck(offset,length,blob.size);return new Uint8Array(await blob.slice(r.offset,r.end).arrayBuffer());}};
}

async function resolveOPFSFile(path){const parts=String(path||'').split('/').filter(Boolean);if(!parts.length)throw new Error('OPFS path required');if(typeof globalThis.navigator?.storage?.getDirectory!=='function')throw new Error('OPFS unavailable');let dir=await globalThis.navigator.storage.getDirectory();for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);const handle=await dir.getFileHandle(parts.at(-1));return handle.getFile();}
export async function createOPFSRangeSource(path){const file=await resolveOPFSFile(path);const source=createBlobRangeSource(file,{name:path});return {...source,kind:'opfs-range-source',path};}

export async function createHttpRangeSource(url,{fetchImpl=globalThis.fetch,requireRanges=true}={}){
  if(typeof fetchImpl!=='function')throw new Error('fetch unavailable');url=String(url);
  let size=0,acceptRanges=false,etag='';
  try{const head=await fetchImpl(url,{method:'HEAD',cache:'no-store'});if(head.ok){size=Number(head.headers.get('content-length')||0);acceptRanges=/bytes/i.test(head.headers.get('accept-ranges')||'');etag=head.headers.get('etag')||'';}}catch{}
  return {kind:'http-range-source',url,size,acceptRanges,etag,async read(offset,length){if(size)rangeCheck(offset,length,size);else rangeCheck(offset,length);if(length===0)return new Uint8Array();const end=offset+length-1;const response=await fetchImpl(url,{headers:{Range:`bytes=${offset}-${end}`},cache:'no-store'});if(response.status!==206){if(requireRanges)throw new Error(`HTTP range request was not honored (status ${response.status})`);if(!response.ok)throw new Error(`HTTP source failed (${response.status})`);}const bytes=new Uint8Array(await response.arrayBuffer());if(response.status===206&&bytes.byteLength!==length)throw new Error(`Short HTTP range read ${bytes.byteLength}/${length}`);if(response.status!==206&&bytes.byteLength>=offset+length)return bytes.slice(offset,offset+length);return bytes;}};
}

export class BlockCachedRangeSource{
  constructor(source,{blockBytes=DEFAULT_BLOCK_BYTES,maxBlocks=32}={}){if(!source||typeof source.read!=='function')throw new TypeError('range source required');this.source=source;this.blockBytes=Math.max(4096,Number(blockBytes)||DEFAULT_BLOCK_BYTES);this.maxBlocks=Math.max(1,Number(maxBlocks)||32);this.blocks=new Map();this.pending=new Map();this.tick=0;this.stats={reads:0,hits:0,misses:0,bytesFromSource:0};}
  async block(index){if(this.blocks.has(index)){const entry=this.blocks.get(index);entry.lastUsed=++this.tick;this.stats.hits++;return entry.bytes;}if(this.pending.has(index)){this.stats.hits++;return this.pending.get(index);}this.stats.misses++;const start=index*this.blockBytes;const remaining=this.source.size?Math.max(0,this.source.size-start):this.blockBytes;const length=Math.min(this.blockBytes,remaining||this.blockBytes);const promise=(async()=>{const bytes=await this.source.read(start,length);this.stats.bytesFromSource+=bytes.byteLength;this.blocks.set(index,{bytes,lastUsed:++this.tick});this.pending.delete(index);this.evict();return bytes;})().catch(error=>{this.pending.delete(index);throw error;});this.pending.set(index,promise);return promise;}
  evict(){if(this.blocks.size<=this.maxBlocks)return;const entries=[...this.blocks.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed);while(this.blocks.size>this.maxBlocks&&entries.length)this.blocks.delete(entries.shift()[0]);}
  async read(offset,length){const size=this.source.size||Number.MAX_SAFE_INTEGER;const r=rangeCheck(offset,length,size);this.stats.reads++;if(!length)return new Uint8Array();const first=Math.floor(r.offset/this.blockBytes),last=Math.floor((r.end-1)/this.blockBytes);const out=new Uint8Array(length);let outPos=0;for(let i=first;i<=last;i++){const bytes=await this.block(i);const blockStart=i*this.blockBytes;const from=Math.max(r.offset,blockStart)-blockStart;const to=Math.min(r.end,blockStart+bytes.byteLength)-blockStart;if(to<from)throw new Error('range cache source returned an invalid short block');out.set(bytes.subarray(from,to),outPos);outPos+=to-from;}if(outPos!==length)throw new Error(`range cache short read ${outPos}/${length}`);return out;}
  clear(){this.blocks.clear();this.pending.clear();}
  inspect(){return {...this.stats,blockBytes:this.blockBytes,maxBlocks:this.maxBlocks,cachedBlocks:this.blocks.size,pendingBlocks:this.pending.size,sourceKind:this.source.kind||'custom'};}
}

export function streamingSourceContract(){return {blobRanges:true,opfsRanges:true,httpByteRanges:true,wholeGameBufferRequired:false,lruBlockCache:true,defaultBlockBytes:DEFAULT_BLOCK_BYTES,workerFriendly:true};}
