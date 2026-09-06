// Lazy Source VPK reader for player-owned PC installs.
// Reads only VPK directory trees and requested payload ranges; it never copies an entire archive.

const VPK_SIGNATURE=0x55aa1234;
const VPK_ARCHIVE_SELF=0x7fff;
const textDecoder=new TextDecoder();

function normalize(value){return String(value||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+|\/+$/g,'').split('/').filter(part=>part&&part!=='.'&&part!=='..').join('/');}
function lower(value){return normalize(value).toLowerCase();}
function dirname(path){const clean=normalize(path),i=clean.lastIndexOf('/');return i<0?'':clean.slice(0,i);}
function basename(path){const clean=normalize(path),i=clean.lastIndexOf('/');return i<0?clean:clean.slice(i+1);}
function join(...parts){return normalize(parts.filter(Boolean).join('/'));}

function readCString(bytes,state){
  const start=state.offset;let end=start;
  while(end<bytes.length&&bytes[end]!==0)end++;
  if(end>=bytes.length)throw new Error('VPK directory tree contains an unterminated string.');
  state.offset=end+1;return textDecoder.decode(bytes.subarray(start,end));
}
function u16(view,state){if(state.offset+2>view.byteLength)throw new Error('Unexpected end of VPK directory tree.');const v=view.getUint16(state.offset,true);state.offset+=2;return v;}
function u32(view,state){if(state.offset+4>view.byteLength)throw new Error('Unexpected end of VPK directory tree.');const v=view.getUint32(state.offset,true);state.offset+=4;return v;}

function archivePathFor(dirPath,index){
  const file=basename(dirPath),folder=dirname(dirPath),stem=file.replace(/_dir\.vpk$/i,'');
  return join(folder,`${stem}_${String(index).padStart(3,'0')}.vpk`);
}
function mountRootFor(dirPath){return dirname(dirPath);}
function logicalPath(root,path,name,ext){
  const treePath=path===' '||path==='.'?'':path;
  const treeExt=ext===' '?'':`.${ext}`;
  return lower(join(root,treePath,`${name}${treeExt}`));
}

async function parseDirectory(base,dirPath){
  const file=base.file?.(dirPath);if(!file)throw new Error(`VPK directory file is no longer linked: ${dirPath}`);
  const head=new DataView(await file.slice(0,28).arrayBuffer());
  if(head.byteLength<12||head.getUint32(0,true)!==VPK_SIGNATURE)throw new Error(`${dirPath} is not a Source VPK directory archive.`);
  const version=head.getUint32(4,true),treeSize=head.getUint32(8,true);
  if(version!==1&&version!==2)throw new Error(`Unsupported VPK version ${version} in ${dirPath}.`);
  const headerSize=version===2?28:12;
  if(treeSize<=0||treeSize>64*1024*1024)throw new Error(`VPK directory tree size is invalid in ${dirPath}.`);
  const treeBytes=new Uint8Array(await file.slice(headerSize,headerSize+treeSize).arrayBuffer());
  const view=new DataView(treeBytes.buffer,treeBytes.byteOffset,treeBytes.byteLength),state={offset:0},entries=new Map(),root=mountRootFor(dirPath);
  for(;;){
    const ext=readCString(treeBytes,state);if(!ext)break;
    for(;;){
      const path=readCString(treeBytes,state);if(!path)break;
      for(;;){
        const name=readCString(treeBytes,state);if(!name)break;
        const crc=u32(view,state),preloadBytes=u16(view,state),archiveIndex=u16(view,state),entryOffset=u32(view,state),entryLength=u32(view,state),terminator=u16(view,state);
        if(terminator!==0xffff)throw new Error(`Bad VPK entry terminator in ${dirPath}.`);
        if(state.offset+preloadBytes>treeBytes.length)throw new Error(`Bad VPK preload range in ${dirPath}.`);
        const preload=preloadBytes?treeBytes.slice(state.offset,state.offset+preloadBytes):new Uint8Array();state.offset+=preloadBytes;
        const key=logicalPath(root,path,name,ext);
        entries.set(key,{key,crc,preload,archiveIndex,entryOffset,entryLength,dirPath,headerSize,treeSize});
      }
    }
  }
  return {dirPath,root,version,headerSize,treeSize,entries};
}

function concat(a,b){if(!a?.byteLength)return b;if(!b?.byteLength)return a;const out=new Uint8Array(a.byteLength+b.byteLength);out.set(a,0);out.set(b,a.byteLength);return out;}

export function createSourceVpkOverlay(base){
  if(!base||typeof base.paths!=='function'||typeof base.file!=='function')return base;
  const dirPaths=base.paths().filter(path=>/_dir\.vpk$/i.test(path)).sort((a,b)=>{
    const rank=p=>/^portal\//i.test(p)?0:/^hl2\//i.test(p)?1:/^platform\//i.test(p)?2:3;
    return rank(a)-rank(b)||a.localeCompare(b);
  });
  const parsed=new Map(),resolved=new Map();
  async function directory(path){const key=lower(path);if(!parsed.has(key))parsed.set(key,parseDirectory(base,path));return parsed.get(key);}
  async function resolve(path){
    const key=lower(path);if(base.has?.(path))return {kind:'direct',path:normalize(path)};
    if(resolved.has(key))return resolved.get(key);
    const promise=(async()=>{for(const dirPath of dirPaths){const dir=await directory(dirPath);const entry=dir.entries.get(key);if(entry)return {kind:'vpk',entry};}return null;})();
    resolved.set(key,promise);return promise;
  }
  async function readVpk(entry){
    let payload=new Uint8Array();
    if(entry.entryLength){
      let archiveFile,offset=entry.entryOffset;
      if(entry.archiveIndex===VPK_ARCHIVE_SELF){archiveFile=base.file(entry.dirPath);offset+=entry.headerSize+entry.treeSize;}
      else archiveFile=base.file(archivePathFor(entry.dirPath,entry.archiveIndex));
      if(!archiveFile)throw new Error(`VPK payload archive is missing for ${entry.key} (${entry.archiveIndex===VPK_ARCHIVE_SELF?entry.dirPath:archivePathFor(entry.dirPath,entry.archiveIndex)}).`);
      payload=new Uint8Array(await archiveFile.slice(offset,offset+entry.entryLength).arrayBuffer());
      if(payload.byteLength!==entry.entryLength)throw new Error(`Short VPK read for ${entry.key}.`);
    }
    return concat(entry.preload,payload);
  }
  return {
    ...base,
    kind:`${base.kind||'pc-content'}+source-vpk`,
    vpkDirectoryCount:dirPaths.length,
    async hasAsync(path){return Boolean(await resolve(path));},
    async resolve(path){return resolve(path);},
    async read(path,options={}){
      if(base.has?.(path))return base.read(path,options);
      const item=await resolve(path);if(!item)throw new Error(`PC game file not found: ${normalize(path)}`);
      if(item.kind==='direct')return base.read(item.path,options);
      const bytes=await readVpk(item.entry),start=Math.max(0,Number(options.offset)||0),end=options.length==null?bytes.byteLength:Math.min(bytes.byteLength,start+Math.max(0,Number(options.length)||0));
      return bytes.slice(start,end);
    },
    descriptor(){return {...(base.descriptor?.()||{}),vpkOverlay:true,vpkDirectoryCount:dirPaths.length};},
  };
}

export function sourceVpkContract(){return {signature:VPK_SIGNATURE,versions:[1,2],lazyDirectoryTree:true,lazyPayloadRanges:true,wholeArchiveCopy:false,archiveSelfIndex:VPK_ARCHIVE_SELF};}
