import {checkCommunityRuntimeRequirements,createCommunityPcSession,mountIndexedPcContent} from './community-wasm-package.js';
import {normalizePcPath} from './pc-content-source.js';

function fmtBytes(value=0){const n=Number(value)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`;}
function ensureMountPoint(FS,path){try{FS.mkdirTree?.(path);return;}catch{}try{FS.mkdir?.(path);}catch(error){if(!/exist/i.test(error?.message||''))throw error;}}

export function workerFsMountContract(){return {schema:'render360-pc-workerfs-mount-v1',playerOwnedFiles:true,wholeInstallCopiedToHeap:false,blobBacked:true,topLevelMounts:['portal','hl2','platform'],fallback:'indexed-working-set'};}

export async function mountPlayerOwnedFolderWithWorkerFs({module,content,emitStage=()=>{},emitLog=()=>{}}={}){
  const FS=module?.FS,WORKERFS=FS?.filesystems?.WORKERFS||module?.WORKERFS||globalThis.WORKERFS;
  const entries=typeof content?.entries==='function'?content.entries().filter(entry=>entry?.file&&typeof entry.file.slice==='function'):[];
  if(!FS?.mount||!WORKERFS||!entries.length)return null;
  const groups=new Map();let bytes=0;
  for(const entry of entries){
    const path=normalizePcPath(entry.path),slash=path.indexOf('/');if(slash<=0)continue;
    const root=path.slice(0,slash).toLowerCase(),relative=path.slice(slash+1);if(!relative)continue;
    if(!groups.has(root))groups.set(root,[]);groups.get(root).push({name:relative,data:entry.file});bytes+=Number(entry.size||entry.file.size||0);
  }
  const preferred=['portal','hl2','platform'],ordered=[...preferred.filter(root=>groups.has(root)),...[...groups.keys()].filter(root=>!preferred.includes(root))];
  if(!ordered.includes('portal')||!ordered.includes('hl2'))return null;
  const mounts=[];
  try{
    emitStage({stage:'pc-content-workerfs',message:`Linking ${entries.length.toLocaleString()} Portal installation files without copying ${fmtBytes(bytes)} into the Wasm heap…`,files:entries.length,bytes});
    for(const root of ordered){
      const blobs=groups.get(root);if(!blobs?.length)continue;
      const mountPoint=`/${root}`;ensureMountPoint(FS,mountPoint);FS.mount(WORKERFS,{blobs},mountPoint);mounts.push({root,mountPoint,files:blobs.length});
    }
    emitStage({stage:'pc-content-workerfs-ready',message:`Portal installation linked · ${mounts.length} folders · ${entries.length.toLocaleString()} files · lazy browser File reads`,mounts,files:entries.length,bytes});
    emitLog('info',`Portal WORKERFS linked ${entries.length} player-owned files across ${mounts.map(item=>item.mountPoint).join(', ')}.`);
    return {schema:'render360-pc-workerfs-mount-v1',mode:'workerfs-player-folder',files:entries.length,bytes,mounts,wholeInstallCopiedToHeap:false};
  }catch(error){
    for(const item of mounts.reverse())try{FS.unmount?.(item.mountPoint);}catch{}
    emitLog('warn',`Portal WORKERFS mount unavailable; falling back to indexed working set: ${error?.message||error}`);return null;
  }
}

export async function createPortalPcSession({package:pkg,host}){
  if(pkg?.manifest?.format!=='emscripten-esm')return createCommunityPcSession({package:pkg,host});
  const capability=checkCommunityRuntimeRequirements(pkg.manifest);if(!capability.ok)throw new Error(`This community runtime requires ${capability.missing.join(', ')}.`);
  const manifest=pkg.manifest,url=pkg.url(manifest.entry),mod=await import(/* @vite-ignore */url),factory=mod.default||mod[manifest.factoryExport||'createModule'];
  if(typeof factory!=='function')throw new Error('Portal Emscripten package does not export a module factory.');
  const locateFile=name=>{const clean=normalizePcPath(name);return pkg.has(clean)?pkg.url(clean):(manifest.wasm&&/\.wasm(?:\?|$)/i.test(name)?pkg.url(manifest.wasm):name);};
  const module=await factory({canvas:host.canvas,noInitialRun:true,locateFile,render360GraphicsPreference:manifest.graphics?.preferred||'webgpu',print:text=>host.emitLog?.('info',String(text)),printErr:text=>host.emitLog?.('warn',String(text))});
  let contentMount=null;
  if(typeof module.render360MountPcContent==='function')contentMount=await module.render360MountPcContent(host.content);
  if(!contentMount)contentMount=await mountPlayerOwnedFolderWithWorkerFs({module,content:host.content,emitStage:host.emitStage,emitLog:host.emitLog});
  if(!contentMount&&manifest.contentIndex)contentMount=await mountIndexedPcContent({module,host,pkg});
  if(!contentMount)throw new Error('Portal files were recognized, but this browser/runtime could not expose the selected installation to Source. WORKERFS and the indexed fallback are both unavailable.');
  let stopped=false;
  return {module,contentMount,async start(){if(stopped)throw new Error('PC WebAssembly session is stopped');if(typeof module.callMain==='function')module.callMain(Array.isArray(manifest.arguments)?manifest.arguments:[]);return {runtimeBoundary:'pc-wasm-running',format:'emscripten-esm',contentMount,graphics:manifest.graphics||{}};},pause(){module.render360Pause?.();return true;},resume(){module.render360Resume?.();return true;},stop(){stopped=true;module.render360Stop?.();pkg.dispose?.();},inspect(){return {format:'emscripten-esm',contentMount,graphics:manifest.graphics||{}};}};
}
