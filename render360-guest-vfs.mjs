// Render360 guest virtual file system bridge.
//
// Registers the title's disc or package contents with the native kernel VFS
// (kernel_xboxkrnl_services.cpp), which serves NtCreateFile/NtReadFile the way
// Xenia's VirtualFileSystem + DiscImageDevice/StfsContainerDevice do. Paths are
// relative to \Device\Cdrom0; the kernel maps game: and d: onto it.
//
// File bytes reach the kernel in one of two ways:
//   * attached into wasm memory up front (small files, or prefetched), or
//   * a host descriptor registered with the WASI host whose readSync() can
//     answer synchronously (Node title runner, FileReaderSync in a worker,
//     or a warm in-memory cache in the page).
// A read the host cannot answer synchronously stops the guest at an exact
// "host I/O" boundary; callers may fetch that file and re-run the title.

const pick=(bootstrap,name)=>bootstrap?.exports?.[name]??bootstrap?.exports?.[`_${name}`];
const FILE_ATTRIBUTE_READONLY=0x01;
const FILE_ATTRIBUTE_DIRECTORY=0x10;
const FILE_ATTRIBUTE_NORMAL=0x80;

export function hasGuestVfs(bootstrap){
  return ['r360_vfs_reset','r360_vfs_path_buffer','r360_vfs_register','r360_vfs_data_buffer'].every(n=>typeof pick(bootstrap,n)==='function');
}

/**
 * Register files with the native kernel VFS.
 * @param files [{path, size, directory?, hostFd?, hostOffset?, data?}]
 * @returns {{registered:number, attachedBytes:number, entries:Map<string,number>}}
 */
export function registerGuestVfs(bootstrap,files,{reset=true}={}){
  if(!hasGuestVfs(bootstrap))return {available:false,registered:0,attachedBytes:0,entries:new Map()};
  if(reset)pick(bootstrap,'r360_vfs_reset')();
  const memory=bootstrap.exports.memory;
  const pathBuffer=pick(bootstrap,'r360_vfs_path_buffer')()>>>0;
  const register=pick(bootstrap,'r360_vfs_register');
  const encoder=new TextEncoder();
  const entries=new Map();
  let attachedBytes=0;
  for(const file of files){
    const path=String(file.path).replace(/\//g,'\\').replace(/^\\+/,'');
    if(!path)continue;
    const bytes=encoder.encode(path);
    if(bytes.length>=1024)throw new Error(`guest path too long for VFS: ${path}`);
    new Uint8Array(memory.buffer,pathBuffer,bytes.length).set(bytes);
    const size=file.directory?0:Number(file.size||0);
    const attributes=file.directory?(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_READONLY):(FILE_ATTRIBUTE_NORMAL|FILE_ATTRIBUTE_READONLY);
    const hostOffset=Number(file.hostOffset||0);
    const id=register(bytes.length,size>>>0,Math.floor(size/2**32)>>>0,attributes,(file.hostFd||0)>>>0,hostOffset>>>0,Math.floor(hostOffset/2**32)>>>0)>>>0;
    if(!id)throw new Error(`native VFS rejected ${path}`);
    entries.set(path.toLowerCase(),id);
    if(file.data&&!file.directory){attachGuestVfsData(bootstrap,id,file.data);attachedBytes+=file.data.byteLength;}
  }
  return {available:true,registered:entries.size,attachedBytes,entries};
}

export function attachGuestVfsData(bootstrap,id,data){
  const bytes=data instanceof Uint8Array?data:new Uint8Array(data);
  const ptr=pick(bootstrap,'r360_vfs_data_buffer')(id>>>0)>>>0;
  if(!ptr)throw new Error(`native VFS could not allocate ${bytes.byteLength} bytes for entry ${id}`);
  if(bytes.byteLength)new Uint8Array(bootstrap.exports.memory.buffer,ptr,bytes.byteLength).set(bytes);
}

/** The file a host-I/O boundary is waiting for, or null. */
export function pendingGuestVfsRead(bootstrap){
  const entry=pick(bootstrap,'r360_vfs_host_io_entry')?.()>>>0;
  if(!entry)return null;
  const length=pick(bootstrap,'r360_vfs_entry_path')(entry)>>>0;
  const pathBuffer=pick(bootstrap,'r360_vfs_path_buffer')()>>>0;
  const path=new TextDecoder().decode(new Uint8Array(bootstrap.exports.memory.buffer,pathBuffer,length));
  return {entry,path,offset:pick(bootstrap,'r360_vfs_host_io_offset')()>>>0,length:pick(bootstrap,'r360_vfs_host_io_length')()>>>0,hostErrno:pick(bootstrap,'r360_vfs_host_io_errno')()>>>0};
}

/** Recursively list an XDVDFS volume as VFS files with absolute image offsets. */
export async function listXdvdfsVfsFiles(volume){
  const files=[];
  const walk=async(dir,prefix)=>{
    const entries=await volume.list(dir);
    for(const entry of entries){
      const path=prefix?`${prefix}\\${entry.name}`:entry.name;
      if(entry.isDirectory){
        files.push({path,directory:true});
        await walk(`${dir==='/'?'':dir}/${entry.name}`,path);
      }else{
        files.push({path,size:entry.size,imageOffset:volume.partitionOffset+entry.startSector*2048});
      }
    }
  };
  await walk('/','');
  return files;
}

/** List a mounted STFS package (wasm-core mountStfs result) as VFS files. */
export function listStfsVfsFiles(mount){
  const entries=Array.isArray(mount?.entries)?mount.entries:[];
  const byIndex=new Map(entries.map(e=>[e.index,e]));
  const pathOf=(entry,depth=0)=>{
    if(depth>64)throw new Error('STFS directory chain too deep');
    const parent=byIndex.get(entry.parentIndex);
    return parent&&parent!==entry?`${pathOf(parent,depth+1)}\\${entry.name}`:entry.name;
  };
  return entries.map(entry=>({path:pathOf(entry),directory:!!entry.directory,size:entry.directory?0:entry.length>>>0,stfsIndex:entry.index}));
}

/**
 * Reader over a Blob/File for the WASI host. In a worker it reads through
 * FileReaderSync; on the page it serves ranges from a cache that
 * prefetch()/ensure() fill asynchronously and otherwise reports "not yet".
 */
export function createBlobHostReader(blob,{maxCacheBytes=96*1024*1024}={}){
  const cache=new Map();let cachedBytes=0;
  const syncReader=typeof FileReaderSync==='function'?new FileReaderSync():null;
  const key=(offset,length)=>`${offset}:${length}`;
  return {
    readSync(offset,length){
      if(syncReader)return new Uint8Array(syncReader.readAsArrayBuffer(blob.slice(offset,offset+length)));
      for(const [k,bytes] of cache){const [o,l]=k.split(':').map(Number);if(offset>=o&&offset+length<=o+l)return bytes.subarray(offset-o,offset-o+length);}
      return null;
    },
    async ensure(offset,length){
      if(syncReader)return;
      const bytes=new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());
      if(cachedBytes+bytes.byteLength>maxCacheBytes)cache.clear(),cachedBytes=0;
      cache.set(key(offset,length),bytes);cachedBytes+=bytes.byteLength;
    },
    get cachedBytes(){return cachedBytes;},
    synchronous:!!syncReader,
  };
}

/**
 * Re-run a title handoff while it stops only because a game file is not yet
 * readable synchronously. fetchPending(pending) must make that file readable
 * (attach it or warm the host cache) and resolve true, or false to stop.
 * Title boots are deterministic, so a re-run reaches the same read again.
 */
export async function runWithGuestVfsRetries(runOnce,{bootstrap,fetchPending,maxRetries=128,onRetry=null}={}){
  let result=await runOnce();
  const fetched=[];
  for(let attempt=1;attempt<=maxRetries;attempt++){
    if(result?.kernelBoundary?.kind!=='guest-wait-blocked'||result.kernelBoundary.waitReason!==4)break;
    const pending=pendingGuestVfsRead(bootstrap);
    if(!pending||!(await fetchPending(pending)))break;
    fetched.push(pending.path);
    onRetry?.(pending,attempt);
    result=await runOnce();
  }
  if(result&&typeof result==='object')result.guestVfsFetched=fetched;
  return result;
}

// ---------------------------------------------------------------------------
// Launch-flow helpers used by the browser bridges.

const EAGER_FILE_LIMIT=512*1024;
const EAGER_TOTAL_LIMIT=24*1024*1024;
const MAX_ON_DEMAND_FILE=256*1024*1024;

/** A bare default.xex launch: the executable is the only disc file. */
export function prepareXexGuestVfs({bootstrap,defaultXex}){
  const registration=registerGuestVfs(bootstrap,[{path:'default.xex',size:defaultXex.byteLength,data:defaultXex}]);
  return {...registration,source:'xex',fetchPending:async()=>false};
}

/**
 * STFS/LIVE/PIRS/CON package: small files are extracted up front, everything
 * else is extracted the first time the title reads it (followed by a
 * deterministic re-run of the boot).
 */
export async function prepareStfsGuestVfs({core,bootstrap,file,mount,defaultXex=null,onProgress=null,eagerFileLimit=EAGER_FILE_LIMIT,eagerTotalLimit=EAGER_TOTAL_LIMIT}){
  const files=listStfsVfsFiles(mount);
  const byPath=new Map(files.map(f=>[f.path.toLowerCase(),f]));
  let eagerBytes=0;
  for(const f of files){
    if(f.directory)continue;
    if(defaultXex&&f.path.toLowerCase()==='default.xex'){f.data=defaultXex;continue;}
    if(f.size>eagerFileLimit||eagerBytes+f.size>eagerTotalLimit)continue;
    const extracted=await core.extractStfsEntry(file,f.stfsIndex,{captureLimit:Math.max(1,f.size)});
    if(extracted.complete&&extracted.fullyCaptured){f.data=extracted.captured;eagerBytes+=f.size;onProgress?.({path:f.path,bytes:eagerBytes});}
  }
  const registration=registerGuestVfs(bootstrap,files);
  const fetchPending=async pending=>{
    const f=byPath.get(pending.path);
    if(!f||f.directory||f.size>MAX_ON_DEMAND_FILE)return false;
    const extracted=await core.extractStfsEntry(file,f.stfsIndex,{captureLimit:Math.max(1,f.size),maxRequests:1<<20});
    if(!extracted.complete||!extracted.fullyCaptured)return false;
    attachGuestVfsData(bootstrap,pending.entry,extracted.captured);
    return true;
  };
  return {...registration,source:'stfs',eagerBytes,fetchPending};
}

/**
 * XDVDFS disc image: every file is a contiguous extent of the image, served
 * through one host descriptor. Small files are warmed into the reader cache.
 */
export async function prepareIsoGuestVfs({bootstrap,host,volume,file,eagerFileLimit=EAGER_FILE_LIMIT,eagerTotalLimit=EAGER_TOTAL_LIMIT}){
  const listed=await listXdvdfsVfsFiles(volume);
  const reader=createBlobHostReader(file);
  const hostFd=host?.registerHostFile?host.registerHostFile(reader):0;
  const byPath=new Map();
  let eagerBytes=0;
  const files=listed.map(f=>{
    if(f.directory)return f;
    byPath.set(f.path.toLowerCase(),f);
    return {...f,hostFd,hostOffset:f.imageOffset};
  });
  if(hostFd&&!reader.synchronous){
    for(const f of byPath.values()){
      if(f.size>eagerFileLimit||eagerBytes+f.size>eagerTotalLimit)continue;
      await reader.ensure(f.imageOffset,f.size);eagerBytes+=f.size;
    }
  }
  const registration=registerGuestVfs(bootstrap,files);
  const fetchPending=async pending=>{
    const f=byPath.get(pending.path);
    if(!f||!hostFd)return false;
    // Fetch the requested range plus read-ahead, never the whole large file.
    const start=Math.min(pending.offset,f.size);
    const length=Math.min(f.size-start,Math.max(pending.length,8*1024*1024));
    if(length<=0)return false;
    await reader.ensure(f.imageOffset+start,length);
    return true;
  };
  return {...registration,source:'xdvdfs',hostFd,eagerBytes,synchronousReads:reader.synchronous,fetchPending};
}
