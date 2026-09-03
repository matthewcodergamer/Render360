const ROOT_DIR='Render360';
const GAMES_DIR='Games';
const CHUNK_BYTES=8*1024*1024;

const safeName=name=>String(name||'game.bin').replace(/[\\/:*?"<>|\u0000-\u001F]/g,'_').slice(0,180)||'game.bin';

export function storageSupported(){return typeof navigator!=='undefined'&&!!navigator.storage?.getDirectory;}

export async function ensureGamesDirectory(){
  if(!storageSupported())throw new Error('Persistent browser game storage is unavailable in this browser');
  const root=await navigator.storage.getDirectory();
  const render360=await root.getDirectoryHandle(ROOT_DIR,{create:true});
  const games=await render360.getDirectoryHandle(GAMES_DIR,{create:true});
  return {root,render360,games,path:`${ROOT_DIR}/${GAMES_DIR}`};
}

export async function requestPersistentStorage(){
  if(!navigator.storage?.persist)return false;
  try{return await navigator.storage.persist();}catch{return false;}
}

export async function storageInfo(){
  const supported=storageSupported();
  let usage=0,quota=0,persisted=false;
  if(navigator.storage?.estimate){
    try{const estimate=await navigator.storage.estimate();usage=Number(estimate.usage||0);quota=Number(estimate.quota||0);}catch{}
  }
  if(navigator.storage?.persisted){try{persisted=await navigator.storage.persisted();}catch{}}
  return {supported,usage,quota,free:Math.max(0,quota-usage),persisted,path:`${ROOT_DIR}/${GAMES_DIR}`};
}

export async function persistGameSource(file,gameId,{onProgress=null}={}){
  if(!file||typeof file.slice!=='function')throw new TypeError('A browser File/Blob is required');
  const info=await storageInfo();
  if(!info.supported)throw new Error('Persistent browser game storage is unavailable');
  if(info.quota&&file.size>info.free)throw new Error(`Not enough browser storage. Need ${(file.size/1073741824).toFixed(2)} GB, free ${(info.free/1073741824).toFixed(2)} GB.`);
  const {games}=await ensureGamesDirectory();
  const filename=`${safeName(gameId)}-${safeName(file.name||'game.bin')}`;
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
  const parts=String(opfsPath).split('/').filter(Boolean);if(!parts.length)return null;
  let dir=await navigator.storage.getDirectory();
  for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);
  const handle=await dir.getFileHandle(parts.at(-1));
  const stored=await handle.getFile();
  return new File([stored],sourceName||stored.name,{type:stored.type||'application/octet-stream',lastModified:stored.lastModified||Date.now()});
}

export async function deletePersistentSource(opfsPath){
  if(!storageSupported()||!opfsPath)return false;
  const parts=String(opfsPath).split('/').filter(Boolean);if(!parts.length)return false;
  let dir=await navigator.storage.getDirectory();
  try{
    for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);
    await dir.removeEntry(parts.at(-1));return true;
  }catch{return false;}
}

export async function clearGamesDirectory(){
  if(!storageSupported())return false;
  const root=await navigator.storage.getDirectory();
  try{
    const render360=await root.getDirectoryHandle(ROOT_DIR);
    await render360.removeEntry(GAMES_DIR,{recursive:true});
    await render360.getDirectoryHandle(GAMES_DIR,{create:true});
    return true;
  }catch{
    await ensureGamesDirectory();return true;
  }
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
