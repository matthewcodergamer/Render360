const EOCD_SIG=0x06054b50;
const ZIP64_EOCD_SIG=0x06064b50;
const ZIP64_LOCATOR_SIG=0x07064b50;
const CENTRAL_SIG=0x02014b50;
const LOCAL_SIG=0x04034b50;
const MAX_EOCD_SEARCH=66*1024;
const GAME_EXTENSIONS=['.iso','.xex','.live','.pirs','.con'];
const COVER_NAMES=['cover.jpg','cover.jpeg','cover.png','folder.jpg','folder.png'];

const u16=(v,o)=>v.getUint16(o,true);
const u32=(v,o)=>v.getUint32(o,true);
const u64=(v,o)=>Number(v.getBigUint64(o,true));
const decodeName=bytes=>new TextDecoder('utf-8',{fatal:false}).decode(bytes);

async function readView(blob,start,length){
  const buffer=await blob.slice(start,start+length).arrayBuffer();
  return new DataView(buffer);
}
async function readBytes(blob,start,length){return new Uint8Array(await blob.slice(start,start+length).arrayBuffer());}

function findEocd(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let i=bytes.length-22;i>=0;i--)if(u32(view,i)===EOCD_SIG)return i;
  return -1;
}

function parseZip64Extra(extra,{compressedSize,uncompressedSize,localOffset,diskStart}){
  let p=0;
  while(p+4<=extra.length){
    const view=new DataView(extra.buffer,extra.byteOffset+p,extra.byteLength-p);
    const id=u16(view,0),len=u16(view,2);p+=4;
    if(p+len>extra.length)break;
    if(id===0x0001){
      const data=new DataView(extra.buffer,extra.byteOffset+p,len);let q=0;
      if(uncompressedSize===0xffffffff&&q+8<=len){uncompressedSize=u64(data,q);q+=8;}
      if(compressedSize===0xffffffff&&q+8<=len){compressedSize=u64(data,q);q+=8;}
      if(localOffset===0xffffffff&&q+8<=len){localOffset=u64(data,q);q+=8;}
      if(diskStart===0xffff&&q+4<=len)diskStart=u32(data,q);
      return {compressedSize,uncompressedSize,localOffset,diskStart};
    }
    p+=len;
  }
  return {compressedSize,uncompressedSize,localOffset,diskStart};
}

export async function inspectZip(file){
  if(!(file instanceof Blob))throw new TypeError('ZIP input must be a File/Blob');
  const tailStart=Math.max(0,file.size-MAX_EOCD_SEARCH);
  const tail=await readBytes(file,tailStart,file.size-tailStart);
  const eocdAt=findEocd(tail);
  if(eocdAt<0)throw new Error('ZIP end-of-central-directory record not found');
  const eocd=new DataView(tail.buffer,tail.byteOffset+eocdAt,tail.byteLength-eocdAt);
  let entryCount=u16(eocd,10),centralSize=u32(eocd,12),centralOffset=u32(eocd,16);
  if(entryCount===0xffff||centralSize===0xffffffff||centralOffset===0xffffffff){
    const absoluteEocd=tailStart+eocdAt;
    if(absoluteEocd<20)throw new Error('ZIP64 locator missing');
    const locator=await readView(file,absoluteEocd-20,20);
    if(u32(locator,0)!==ZIP64_LOCATOR_SIG)throw new Error('ZIP64 locator signature missing');
    const zip64Offset=u64(locator,8);
    const zip64=await readView(file,zip64Offset,56);
    if(u32(zip64,0)!==ZIP64_EOCD_SIG)throw new Error('ZIP64 end record signature missing');
    entryCount=u64(zip64,32);centralSize=u64(zip64,40);centralOffset=u64(zip64,48);
  }
  if(!Number.isSafeInteger(centralOffset)||!Number.isSafeInteger(centralSize)||centralOffset+centralSize>file.size)throw new Error('ZIP central directory is out of bounds');
  if(centralSize>128*1024*1024)throw new Error('ZIP central directory is too large for browser indexing');
  const central=await readBytes(file,centralOffset,centralSize);
  const entries=[];let p=0;
  for(let i=0;i<entryCount&&p+46<=central.length;i++){
    const view=new DataView(central.buffer,central.byteOffset+p,central.byteLength-p);
    if(u32(view,0)!==CENTRAL_SIG)throw new Error(`ZIP central directory entry ${i} has invalid signature`);
    const method=u16(view,10),flags=u16(view,8);
    let compressedSize=u32(view,20),uncompressedSize=u32(view,24),localOffset=u32(view,42),diskStart=u16(view,34);
    const nameLen=u16(view,28),extraLen=u16(view,30),commentLen=u16(view,32);
    const end=p+46+nameLen+extraLen+commentLen;if(end>central.length)throw new Error('ZIP central directory entry is truncated');
    const nameBytes=central.subarray(p+46,p+46+nameLen);
    const extra=central.subarray(p+46+nameLen,p+46+nameLen+extraLen);
    ({compressedSize,uncompressedSize,localOffset,diskStart}=parseZip64Extra(extra,{compressedSize,uncompressedSize,localOffset,diskStart}));
    const name=decodeName(nameBytes).replace(/\\/g,'/');
    entries.push({name,method,flags,compressedSize,uncompressedSize,localOffset,diskStart,directory:name.endsWith('/')});
    p=end;
  }
  return {entries,entryCount:entries.length,centralOffset,centralSize,zip64:entryCount>=0xffff||centralOffset>0xffffffff||centralSize>0xffffffff};
}

async function dataOffset(file,entry){
  const header=await readView(file,entry.localOffset,30);
  if(u32(header,0)!==LOCAL_SIG)throw new Error(`ZIP local header missing for ${entry.name}`);
  return entry.localOffset+30+u16(header,26)+u16(header,28);
}

function sanitizeName(name){return name.split('/').pop().replace(/[^a-z0-9._ -]+/gi,'_').slice(0,180)||'game.bin';}
function mimeFor(name){const lower=name.toLowerCase();return lower.endsWith('.png')?'image/png':lower.endsWith('.jpg')||lower.endsWith('.jpeg')?'image/jpeg':'application/octet-stream';}

async function estimateStorage(required){
  if(!navigator.storage?.estimate)return {ok:true};
  const {quota=0,usage=0}=await navigator.storage.estimate();
  const free=Math.max(0,quota-usage);
  return {ok:free>=required,quota,usage,free};
}

export async function extractZipEntry(file,entry,{onProgress=()=>{},persistent=true}={}){
  if(entry.directory)throw new Error('Cannot extract a ZIP directory entry');
  if(entry.flags&1)throw new Error('Encrypted ZIP entries are not supported');
  const start=await dataOffset(file,entry);
  if(start+entry.compressedSize>file.size)throw new Error(`ZIP data for ${entry.name} is out of bounds`);
  if(entry.method===0){
    onProgress({phase:'extract',name:entry.name,done:entry.uncompressedSize,total:entry.uncompressedSize,percent:100,stored:true});
    const slice=file.slice(start,start+entry.compressedSize,mimeFor(entry.name));
    return {file:new File([slice],sanitizeName(entry.name),{type:mimeFor(entry.name)}),persistent:false,stored:true};
  }
  if(entry.method!==8)throw new Error(`ZIP compression method ${entry.method} is not supported yet`);
  if(!('DecompressionStream' in globalThis))throw new Error('This browser cannot stream Deflate ZIP entries');
  const estimate=await estimateStorage(Math.ceil(entry.uncompressedSize*1.08));
  if(!estimate.ok)throw new Error(`Not enough browser storage to extract ${entry.name}`);
  const source=file.slice(start,start+entry.compressedSize).stream();
  const inflated=source.pipeThrough(new DecompressionStream('deflate-raw'));
  const safeName=`zip-${Date.now()}-${sanitizeName(entry.name)}`;
  if(persistent&&navigator.storage?.getDirectory){
    const root=await navigator.storage.getDirectory();
    const render360=await root.getDirectoryHandle('Render360',{create:true});
    const dir=await render360.getDirectoryHandle('Games',{create:true});
    const handle=await dir.getFileHandle(safeName,{create:true});
    const writer=await handle.createWritable();
    const reader=inflated.getReader();let done=0;
    try{
      for(;;){const part=await reader.read();if(part.done)break;await writer.write(part.value);done+=part.value.byteLength;onProgress({phase:'extract',name:entry.name,done,total:entry.uncompressedSize,percent:entry.uncompressedSize?Math.min(100,done*100/entry.uncompressedSize):0});}
      await writer.close();
    }catch(error){try{await writer.abort();}catch{}throw error;}
    const extracted=await handle.getFile();
    return {file:new File([extracted],sanitizeName(entry.name),{type:mimeFor(entry.name)}),persistent:true,opfsPath:`Render360/Games/${safeName}`,stored:false};
  }
  if(entry.uncompressedSize>256*1024*1024)throw new Error('Large compressed ZIP extraction requires Origin Private File System support');
  const blob=await new Response(inflated).blob();onProgress({phase:'extract',name:entry.name,done:blob.size,total:entry.uncompressedSize,percent:100});
  return {file:new File([blob],sanitizeName(entry.name),{type:mimeFor(entry.name)}),persistent:false,stored:false};
}

export function chooseGameEntry(entries){
  const files=entries.filter(e=>!e.directory);
  const rank=name=>{const n=name.toLowerCase();const i=GAME_EXTENSIONS.findIndex(ext=>n.endsWith(ext));return i<0?999:i;};
  return files.filter(e=>rank(e.name)<999).sort((a,b)=>rank(a.name)-rank(b.name)||b.uncompressedSize-a.uncompressedSize)[0]||null;
}

export function chooseCoverEntry(entries){
  const files=entries.filter(e=>!e.directory);
  return files.find(e=>COVER_NAMES.includes(e.name.split('/').pop().toLowerCase()))||files.find(e=>/\.(png|jpe?g)$/i.test(e.name)&&/(cover|box|folder|icon)/i.test(e.name))||null;
}

export async function prepareZipGame(file,{onProgress=()=>{}}={}){
  onProgress({phase:'index',name:file.name,done:0,total:file.size,percent:0});
  const zip=await inspectZip(file);
  const gameEntry=chooseGameEntry(zip.entries);
  if(!gameEntry)throw new Error('No .iso, .xex, LIVE, PIRS or CON game content was found in this ZIP');
  onProgress({phase:'index',name:gameEntry.name,done:1,total:1,percent:100});
  const game=await extractZipEntry(file,gameEntry,{onProgress,persistent:true});
  let cover=null;const coverEntry=chooseCoverEntry(zip.entries);
  if(coverEntry&&coverEntry.uncompressedSize<=32*1024*1024){try{cover=await extractZipEntry(file,coverEntry,{persistent:false});}catch{}}
  return {zip,gameEntry,gameFile:game.file,gameStorage:game,coverFile:cover?.file||null};
}
