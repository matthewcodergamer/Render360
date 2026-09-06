import {createPcFileListSource,detectPcGame,normalizePcPath} from '../runtime/pc-content-source.js';
import {loadCommunityWasmPackageFromFiles} from '../runtime/community-wasm-package.js';

const ROOT_DIR='Render360';
const PC_DIR='PC';
const META_FILE='render360-pc-source.json';
const COPY_CHUNK=4*1024*1024;
const ignoredGameFile=/\.(?:exe|dll|pdb|sys|bat|cmd|lnk)$/i;
const allowedGameRoot=/^(?:portal|hl2|platform)\//i;

function safeId(value){const id=String(value||'').trim().replace(/[^a-z0-9._-]+/gi,'-').replace(/^-+|-+$/g,'');if(!id)throw new Error('Persistent PC source needs a game id.');return id.slice(0,120);}
function safePath(value){const path=normalizePcPath(value);if(!path||path.startsWith('/')||path.includes('..'))throw new Error(`Unsafe persistent PC path: ${value}`);return path;}
function pathParts(value){return safePath(value).split('/').filter(Boolean);}
function filePath(file){return normalizePcPath(file?.relativePath||file?.webkitRelativePath||file?.name||'');}

async function rootDirectory(storageManager=globalThis.navigator?.storage){
  if(!storageManager?.getDirectory)throw new Error('This browser does not expose Origin Private File System storage.');
  const root=await storageManager.getDirectory();
  const render360=await root.getDirectoryHandle(ROOT_DIR,{create:true});
  return render360.getDirectoryHandle(PC_DIR,{create:true});
}
async function gameDirectory(gameId,{create=false,storageManager=globalThis.navigator?.storage}={}){const pc=await rootDirectory(storageManager);return pc.getDirectoryHandle(safeId(gameId),{create});}
async function ensureDirectory(base,parts){let dir=base;for(const part of parts)dir=await dir.getDirectoryHandle(part,{create:true});return dir;}
async function fileHandleAt(base,path,{create=false}={}){const parts=pathParts(path),name=parts.pop();const dir=create?await ensureDirectory(base,parts):await (async()=>{let d=base;for(const part of parts)d=await d.getDirectoryHandle(part);return d;})();return dir.getFileHandle(name,{create});}

async function writeBlob(base,path,blob,{onChunk=()=>{}}={}){
  const handle=await fileHandleAt(base,path,{create:true});const writable=await handle.createWritable();
  try{for(let offset=0;offset<blob.size;offset+=COPY_CHUNK){const end=Math.min(blob.size,offset+COPY_CHUNK);await writable.write(blob.slice(offset,end));onChunk(end-offset);}}finally{await writable.close();}
}
function withRelativePath(file,path){try{Object.defineProperty(file,'relativePath',{value:path,configurable:true});}catch{}return file;}
async function readStoredFile(base,path){const handle=await fileHandleAt(base,path);return withRelativePath(await handle.getFile(),path);}
async function writeJson(base,path,value){const blob=new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'});await writeBlob(base,path,blob);}
async function readJson(base,path){return JSON.parse(await (await readStoredFile(base,path)).text());}

function collectGameEntries(content){
  const entries=[];
  for(const item of content?.entries?.()||[]){const path=safePath(item.path||filePath(item.file));const file=item.file;if(!(file instanceof Blob)||!allowedGameRoot.test(path)||ignoredGameFile.test(path))continue;entries.push({path,file,size:Number(file.size||0),type:file.type||''});}
  if(!entries.some(item=>item.path.toLowerCase()==='portal/gameinfo.txt'))throw new Error('Portal gameinfo.txt is missing from the persistent source copy.');
  return entries;
}
function collectRuntimeEntries(runtimePackage){
  const entries=[];
  for(const raw of runtimePackage?.paths?.()||[]){const path=safePath(raw),file=runtimePackage.file?.(path);if(!(file instanceof Blob))continue;entries.push({path,file,size:Number(file.size||0),type:file.type||''});}
  if(!entries.some(item=>item.path.toLowerCase()==='render360-port.json'))throw new Error('The Source WebAssembly runtime manifest is missing.');
  return entries;
}

export async function requestPcPersistentStorage(storageManager=globalThis.navigator?.storage){
  if(!storageManager?.persist)return false;try{return Boolean(await storageManager.persist());}catch{return false;}
}
export async function pcStorageEstimate(storageManager=globalThis.navigator?.storage){
  try{const info=await storageManager?.estimate?.();return {quota:Number(info?.quota||0),usage:Number(info?.usage||0),free:Math.max(0,Number(info?.quota||0)-Number(info?.usage||0))};}catch{return {quota:0,usage:0,free:0};}
}

export async function persistPcRecompiledSource(gameId,source,{storageManager=globalThis.navigator?.storage,onProgress=()=>{}}={}){
  if(!source?.content||!source?.runtimePackage)throw new Error('Portal PC source is missing its game files or WebAssembly runtime.');
  const id=safeId(gameId),gameEntries=collectGameEntries(source.content),runtimeEntries=collectRuntimeEntries(source.runtimePackage);
  const totalBytes=[...gameEntries,...runtimeEntries].reduce((sum,item)=>sum+item.size,0),estimate=await pcStorageEstimate(storageManager);
  if(estimate.quota&&estimate.free&&totalBytes>estimate.free)throw new Error(`Not enough persistent browser storage for Portal. Need ${(totalBytes/1073741824).toFixed(2)} GB but only ${(estimate.free/1073741824).toFixed(2)} GB is currently available to this site.`);
  await requestPcPersistentStorage(storageManager);
  const pc=await rootDirectory(storageManager);try{await pc.removeEntry(id,{recursive:true});}catch{}
  const base=await pc.getDirectoryHandle(id,{create:true});let copied=0,filesDone=0,totalFiles=gameEntries.length+runtimeEntries.length;
  const progress=(phase,item)=>onProgress({phase,path:item.path,filesDone,totalFiles,bytesDone:copied,totalBytes,percent:totalBytes?copied*100/totalBytes:100});
  try{
    for(const item of gameEntries){await writeBlob(base,`game/${item.path}`,item.file,{onChunk:n=>{copied+=n;progress('game',item);}});filesDone++;progress('game',item);}
    for(const item of runtimeEntries){await writeBlob(base,`runtime/${item.path}`,item.file,{onChunk:n=>{copied+=n;progress('runtime',item);}});filesDone++;progress('runtime',item);}
    const manifest={schema:'render360-pc-persistent-source-v1',gameId:id,pcGameId:source.detection?.gameId||'portal-1-pc',name:source.name||'Portal PC',createdAt:Number(source.createdAt||Date.now()),savedAt:Date.now(),size:Number(source.content.size||0),gameFiles:gameEntries.map(({path,size,type})=>({path,size,type})),runtimeFiles:runtimeEntries.map(({path,size,type})=>({path,size,type})),runtimeName:source.runtimePackage.manifest?.name||'Source WebAssembly runtime'};
    await writeJson(base,META_FILE,manifest);onProgress({phase:'complete',filesDone:totalFiles,totalFiles,bytesDone:copied,totalBytes,percent:100});
    return {gameId:id,key:id,bytes:copied,files:totalFiles,manifest,persisted:true};
  }catch(error){try{await pc.removeEntry(id,{recursive:true});}catch{}throw new Error(`Could not save Portal locally: ${error?.message||error}`);}
}

export async function restorePcRecompiledSource(gameId,{storageManager=globalThis.navigator?.storage}={}){
  const id=safeId(gameId),base=await gameDirectory(id,{storageManager});const manifest=await readJson(base,META_FILE);
  if(manifest?.schema!=='render360-pc-persistent-source-v1')throw new Error('Saved Portal source metadata is invalid.');
  const gameFiles=[];for(const item of manifest.gameFiles||[])gameFiles.push(await readStoredFile(base,`game/${safePath(item.path)}`));
  const runtimeFiles=[];for(const item of manifest.runtimeFiles||[])runtimeFiles.push(await readStoredFile(base,`runtime/${safePath(item.path)}`));
  const content=createPcFileListSource(gameFiles,{name:'Portal PC persistent installation',stripCommonRoot:false});const detection=detectPcGame(content);if(!detection.matched)throw new Error(`Saved Portal files are incomplete: ${(detection.candidates?.[0]?.missing||[]).join(', ')}`);
  const runtimePackage=await loadCommunityWasmPackageFromFiles(runtimeFiles,{expectedGameId:detection.gameId});
  return {kind:'pc-recompiled-source',name:manifest.name||'Portal PC',size:content.size,content,detection,runtimePackage,createdAt:Number(manifest.createdAt||manifest.savedAt||Date.now()),persistent:true,pcStorageKey:id};
}

export async function pcPersistentSourceExists(gameId,{storageManager=globalThis.navigator?.storage}={}){try{const base=await gameDirectory(gameId,{storageManager});await base.getFileHandle(META_FILE);return true;}catch{return false;}}
export async function deletePersistentPcSource(gameId,{storageManager=globalThis.navigator?.storage}={}){const pc=await rootDirectory(storageManager);try{await pc.removeEntry(safeId(gameId),{recursive:true});return true;}catch{return false;}}

export const pcPersistentStorageContract=()=>({schema:'render360-pc-persistent-source-v1',root:`${ROOT_DIR}/${PC_DIR}`,chunkBytes:COPY_CHUNK,gameRoots:['portal','hl2','platform'],runtimeFiles:true,restoreWithoutPicker:true});
