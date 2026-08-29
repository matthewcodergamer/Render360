const SECTOR=2048;
const MAGIC='MICROSOFT*XBOX*MEDIA';
const PARTITIONS=[['XISO',0x00000000],['XGD3',0x02080000],['XGD2',0x0FD90000],['XGD1',0x18300000]];
const ATTR_DIRECTORY=0x10;

const le16=(b,o)=>b[o]|(b[o+1]<<8);
const le32=(b,o)=>(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;
const ascii=(b,o,n)=>String.fromCharCode(...b.subarray(o,o+n));
const checkedAdd=(a,b,label)=>{const n=a+b;if(!Number.isSafeInteger(n)||n<a)throw new RangeError(`${label} overflow`);return n;};

function sourceSize(source){
  const n=Number(source?.size ?? source?.byteLength ?? source?.length);
  if(!Number.isSafeInteger(n)||n<0)throw new TypeError('XDVDFS source size unavailable');
  return n;
}
async function sourceRead(source,offset,length,telemetry){
  const size=sourceSize(source);
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset>size||length>size-offset)throw new RangeError(`XDVDFS read out of bounds off=${offset} len=${length} size=${size}`);
  telemetry.reads++;telemetry.bytes+=length;telemetry.maxRead=Math.max(telemetry.maxRead,length);
  if(typeof source.slice==='function'&&typeof Blob!=='undefined'&&source instanceof Blob){return new Uint8Array(await source.slice(offset,offset+length).arrayBuffer());}
  if(source instanceof Uint8Array)return source.subarray(offset,offset+length);
  if(ArrayBuffer.isView(source))return new Uint8Array(source.buffer,source.byteOffset+offset,length);
  if(source instanceof ArrayBuffer)return new Uint8Array(source,offset,length);
  if(typeof source.readRange==='function'){
    const out=await source.readRange(offset,length);const u=out instanceof Uint8Array?out:new Uint8Array(out);
    if(u.length!==length)throw new Error(`short XDVDFS source read ${u.length}/${length}`);return u;
  }
  throw new TypeError('unsupported XDVDFS source; provide Blob, Uint8Array, ArrayBuffer, or readRange()');
}

function parseEntry(table,offset){
  if(!Number.isInteger(offset)||offset<0||offset+14>table.length)throw new Error(`XDVDFS directory entry out of bounds 0x${offset.toString(16)}`);
  const nameLen=table[offset+13];const end=offset+14+nameLen;
  if(!nameLen||end>table.length)throw new Error(`XDVDFS directory filename out of bounds 0x${offset.toString(16)}`);
  const name=ascii(table,offset+14,nameLen);
  if(name.includes('\0')||name.includes('/')||name.includes('\\'))throw new Error('invalid XDVDFS filename');
  return {offset,leftDword:le16(table,offset),rightDword:le16(table,offset+2),startSector:le32(table,offset+4),size:le32(table,offset+8),attributes:table[offset+12],name,isDirectory:(table[offset+12]&ATTR_DIRECTORY)!==0};
}

function walkTree(table){
  if(!table.length)return [];
  const out=[],stack=[0],seen=new Set();
  while(stack.length){
    const off=stack.pop();
    if(seen.has(off))throw new Error(`XDVDFS directory tree cycle at 0x${off.toString(16)}`);
    seen.add(off);if(seen.size>65536)throw new Error('XDVDFS directory entry guard exceeded');
    const e=parseEntry(table,off);out.push(e);
    for(const d of [e.rightDword,e.leftDword])if(d){const child=d*4;if(child>=table.length)throw new Error(`XDVDFS child pointer out of bounds 0x${child.toString(16)}`);stack.push(child);}
  }
  return out;
}

export class XdvdfsVolume{
  constructor(source,layout,partitionOffset,rootSector,rootSize,telemetry){Object.assign(this,{source,layout,partitionOffset,rootSector,rootSize,telemetry});this.size=sourceSize(source);}
  async _table(sector,size){
    if(size===0)return new Uint8Array();
    if(size>16*1024*1024)throw new Error(`XDVDFS directory table too large ${size}`);
    const off=checkedAdd(this.partitionOffset,sector*SECTOR,'directory offset');
    return sourceRead(this.source,off,size,this.telemetry);
  }
  async list(path='/'){
    const node=await this.stat(path);
    if(path!=='/'&&!node.isDirectory)throw new Error(`${path} is not a directory`);
    const sector=path==='/'?this.rootSector:node.startSector,size=path==='/'?this.rootSize:node.size;
    return walkTree(await this._table(sector,size));
  }
  async stat(path){
    const parts=String(path).split(/[\\/]+/).filter(Boolean);
    if(!parts.length)return {name:'/',isDirectory:true,startSector:this.rootSector,size:this.rootSize,attributes:ATTR_DIRECTORY};
    let sector=this.rootSector,size=this.rootSize,node=null;
    for(let i=0;i<parts.length;i++){
      const entries=walkTree(await this._table(sector,size));
      node=entries.find(e=>e.name.toLowerCase()===parts[i].toLowerCase());
      if(!node)throw new Error(`XDVDFS path not found: ${path}`);
      if(i+1<parts.length){if(!node.isDirectory)throw new Error(`XDVDFS path component is not a directory: ${parts[i]}`);sector=node.startSector;size=node.size;}
    }
    return node;
  }
  async readFileRange(path,offset=0,length=null){
    const node=await this.stat(path);if(node.isDirectory)throw new Error(`${path} is a directory`);
    if(!Number.isSafeInteger(offset)||offset<0||offset>node.size)throw new RangeError('XDVDFS file offset out of bounds');
    const len=length===null?node.size-offset:Number(length);if(!Number.isSafeInteger(len)||len<0||len>node.size-offset)throw new RangeError('XDVDFS file range out of bounds');
    const base=checkedAdd(this.partitionOffset,node.startSector*SECTOR,'file offset');
    return sourceRead(this.source,base+offset,len,this.telemetry);
  }
  async readFile(path,{maxBytes=256*1024*1024}={}){const node=await this.stat(path);if(node.size>maxBytes)throw new Error(`XDVDFS file exceeds bounded read limit ${node.size}/${maxBytes}`);return this.readFileRange(path,0,node.size);}
  async readDefaultXex(options={}){return this.readFile('/default.xex',options);}
}

export async function mountXdvdfs(source){
  const telemetry={reads:0,bytes:0,maxRead:0};const size=sourceSize(source);
  for(const [layout,partitionOffset] of PARTITIONS){
    const descriptorOffset=partitionOffset+32*SECTOR;if(descriptorOffset+SECTOR>size)continue;
    let d;try{d=await sourceRead(source,descriptorOffset,SECTOR,telemetry);}catch{continue;}
    if(ascii(d,0,20)!==MAGIC||ascii(d,0x7ec,20)!==MAGIC)continue;
    const rootSector=le32(d,0x14),rootSize=le32(d,0x18);
    if(!rootSector||!rootSize)throw new Error('XDVDFS root directory is empty');
    if(rootSize>16*1024*1024)throw new Error('XDVDFS root directory size unreasonable');
    const rootOffset=partitionOffset+rootSector*SECTOR;if(!Number.isSafeInteger(rootOffset)||rootOffset>size||rootSize>size-rootOffset)throw new Error('XDVDFS root directory outside image');
    return new XdvdfsVolume(source,layout,partitionOffset,rootSector,rootSize,telemetry);
  }
  throw new Error('XDVDFS volume not found (XISO/XGD1/XGD2/XGD3)');
}

export function xdvdfsLayouts(){return PARTITIONS.map(([layout,partitionOffset])=>({layout,partitionOffset}));}
