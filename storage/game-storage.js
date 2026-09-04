const ROOT_DIR='Render360';
const GAMES_DIR='Games';
const LEGACY_IMPORT_DIR='render360-imports';
const CHUNK_BYTES=8*1024*1024;

const safeName=name=>String(name||'game.bin').replace(/[\\/:*?"<>|\u0000-\u001F]/g,'_').slice(0,180)||'game.bin';
const normPath=value=>String(value||'').split('/').filter(Boolean).join('/');

export function storageSupported(){return typeof navigator!=='undefined'&&!!navigator.storage?.getDirectory;}

async function rootDirectory(){
  if(!storageSupported())throw new Error('Persistent browser game storage is unavailable in this browser');
  return navigator.storage.getDirectory();
}

export async function ensureGamesDirectory(){
  const root=await rootDirectory();
  const render360=await root.getDirectoryHandle(ROOT_DIR,{create:true});
  const games=await render360.getDirectoryHandle(GAMES_DIR,{create:true});
  return {root,render360,games,path:`${ROOT_DIR}/${GAMES_DIR}`};
}

export async function requestPersistentStorage(){
  if(!navigator.storage?.persist)return false;
  try{return await navigator.storage.persist();}catch{return false;}
}

async function directoryUsage(dir){
  let bytes=0,files=0;
  if(!dir?.entries)return {bytes,files};
  for await(const [,handle] of dir.entries()){
    if(handle.kind==='file'){
      try{const file=await handle.getFile();bytes+=Number(file.size||0);files++;}catch{}
    }else if(handle.kind==='directory'){
      const child=await directoryUsage(handle);bytes+=child.bytes;files+=child.files;
    }
  }
  return {bytes,files};
}

async function managedUsage(){
  if(!storageSupported())return {bytes:0,files:0,legacyBytes:0,legacyFiles:0};
  const root=await rootDirectory();
  let bytes=0,files=0,legacyBytes=0,legacyFiles=0;
  try{
    const render360=await root.getDirectoryHandle(ROOT_DIR);
    const games=await render360.getDirectoryHandle(GAMES_DIR);
    const current=await directoryUsage(games);bytes+=current.bytes;files+=current.files;
  }catch{}
  try{
    const legacy=await root.getDirectoryHandle(LEGACY_IMPORT_DIR);
    const old=await directoryUsage(legacy);legacyBytes=old.bytes;legacyFiles=old.files;bytes+=old.bytes;files+=old.files;
  }catch{}
  return {bytes,files,legacyBytes,legacyFiles};
}

export async function storageInfo(){
  const supported=storageSupported();
  let usage=0,quota=0,persisted=false;
  if(navigator.storage?.estimate){
    try{const estimate=await navigator.storage.estimate();usage=Number(estimate.usage||0);quota=Number(estimate.quota||0);}catch{}
  }
  if(navigator.storage?.persisted){try{persisted=await navigator.storage.persisted();}catch{}}
  const managed=supported?await managedUsage():{bytes:0,files:0,legacyBytes:0,legacyFiles:0};
  const browserFree=Math.max(0,quota-usage);
  return {
    supported,usage,quota,free:browserFree,browserFree,persisted,
    gameUsage:managed.bytes,gameFiles:managed.files,
    legacyUsage:managed.legacyBytes,legacyFiles:managed.legacyFiles,
    otherUsage:Math.max(0,usage-managed.bytes),
    deviceFree:null,deviceFreeAvailable:false,
    path:`${ROOT_DIR}/${GAMES_DIR}`,
  };
}

async function removeGameIdSiblings(games,gameId,keepName){
  if(!games?.entries)return;
  const prefix=`${safeName(gameId)}-`;
  for await(const [name,handle] of games.entries()){
    if(handle.kind!=='file'||name===keepName||!name.startsWith(prefix))continue;
    try{await games.removeEntry(name);}catch{}
  }
}

export async function persistGameSource(file,gameId,{onProgress=null}={}){
  if(!file||typeof file.slice!=='function')throw new TypeError('A browser File/Blob is required');
  const info=await storageInfo();
  if(!info.supported)throw new Error('Persistent browser game storage is unavailable');
  if(info.quota&&file.size>info.browserFree)throw new Error(`Not enough Safari site storage. Need ${(file.size/1073741824).toFixed(2)} GB, site quota headroom ${(info.browserFree/1073741824).toFixed(2)} GB.`);
  const {games}=await ensureGamesDirectory();
  const filename=`${safeName(gameId)}-${safeName(file.name||'game.bin')}`;
  await removeGameIdSiblings(games,gameId,filename);
  const handle=await games.getFileHandle(filename,{create:true});
  const writable=await handle.createWritable();
  let done=0;
  try{
    while(done<file.size){
      const end=Math.min(file.size,done+CHUNK_BYTES);
      await writable.write(file.slice(done,end));
      done=end;
      onProgress?.({done,total:file.size,percent:file.size?done/file.size*100:100,name:file.name||filename});
    }
    await writable.close();
  }catch(error){
    try{await writable.abort?.();}catch{}
    try{await games.removeEntry(filename);}catch{}
    throw error;
  }
  return {persistent:true,opfsPath:`${ROOT_DIR}/${GAMES_DIR}/${filename}`,filename};
}

export async function openPersistentSource(opfsPath,sourceName='Xbox 360 Game'){
  if(!storageSupported()||!opfsPath)return null;
  const parts=normPath(opfsPath).split('/').filter(Boolean);if(!parts.length)return null;
  let dir=await rootDirectory();
  for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);
  const handle=await dir.getFileHandle(parts.at(-1));
  const stored=await handle.getFile();
  // A File composed from another File is a lightweight Blob view; it does not
  // create another OPFS copy. Preserve the original user-facing source name so
  // extension-based launch adapters keep working after a reload.
  return new File([stored],sourceName||stored.name,{type:stored.type||'application/octet-stream',lastModified:stored.lastModified||Date.now()});
}

export async function deletePersistentSource(opfsPath){
  if(!storageSupported()||!opfsPath)return false;
  const parts=normPath(opfsPath).split('/').filter(Boolean);if(!parts.length)return false;
  let dir=await rootDirectory();
  try{
    for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);
    await dir.removeEntry(parts.at(-1),{recursive:true});return true;
  }catch{return false;}
}

async function clearDirectory(root,name){
  try{await root.removeEntry(name,{recursive:true});return true;}catch{return false;}
}

export async function clearGamesDirectory(){
  if(!storageSupported())return {supported:false,removed:false};
  const root=await rootDirectory();
  let removed=false;
  try{
    const render360=await root.getDirectoryHandle(ROOT_DIR,{create:true});
    try{await render360.removeEntry(GAMES_DIR,{recursive:true});removed=true;}catch{}
    await render360.getDirectoryHandle(GAMES_DIR,{create:true});
  }catch{}
  // Versions before v45 streamed compressed ZIP contents here. Clearing only
  // Render360/Games left these multi-gigabyte files behind in Safari.
  if(await clearDirectory(root,LEGACY_IMPORT_DIR))removed=true;
  return {supported:true,removed};
}

export async function cleanupGameStorage(keepPaths=[]){
  if(!storageSupported())return {supported:false,removedFiles:0,removedBytes:0};
  const keep=new Set((keepPaths||[]).map(normPath).filter(Boolean));
  const root=await rootDirectory();
  let removedFiles=0,removedBytes=0;
  const sweep=async(dir,prefix)=>{
    if(!dir?.entries)return;
    for await(const [name,handle] of dir.entries()){
      const path=normPath(`${prefix}/${name}`);
      if(handle.kind==='directory'){
        await sweep(handle,path);
        continue;
      }
      if(keep.has(path))continue;
      let size=0;try{size=Number((await handle.getFile()).size||0);}catch{}
      try{await dir.removeEntry(name);removedFiles++;removedBytes+=size;}catch{}
    }
  };
  try{
    const render360=await root.getDirectoryHandle(ROOT_DIR);
    const games=await render360.getDirectoryHandle(GAMES_DIR);
    await sweep(games,`${ROOT_DIR}/${GAMES_DIR}`);
  }catch{}
  try{
    const legacy=await root.getDirectoryHandle(LEGACY_IMPORT_DIR);
    await sweep(legacy,LEGACY_IMPORT_DIR);
    let hasEntry=false;if(legacy.entries){for await(const _ of legacy.entries()){hasEntry=true;break;}}
    if(!hasEntry)try{await root.removeEntry(LEGACY_IMPORT_DIR,{recursive:true});}catch{}
  }catch{}
  return {supported:true,removedFiles,removedBytes};
}

/**
 * Opens an OPFS game as a bounded range reader. This is the preferred API for
 * disc/package code that does not need a browser File object and must avoid
 * whole-image buffering for multi-gigabyte titles.
 */
export async function openPersistentRangeSource(opfsPath,{blockBytes=1024*1024,maxBlocks=32,cache=true}={}){
  if(!storageSupported()||!opfsPath)throw new Error('Persistent range source unavailable');
  const {createOPFSRangeSource,BlockCachedRangeSource}=await import('../render360-streaming-source.mjs');
  const source=await createOPFSRangeSource(opfsPath);
  return cache?new BlockCachedRangeSource(source,{blockBytes,maxBlocks}):source;
}
