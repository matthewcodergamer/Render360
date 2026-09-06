import {inspectZip,extractZipEntry} from '../import/zip-importer.js';
import {normalizePcPath} from './pc-content-source.js';

export const PC_WASM_PACKAGE_SCHEMA='render360-pc-wasm-package-v1';
export const PC_CONTENT_INDEX_SCHEMA='render360-pc-content-index-v1';
const MANIFEST_NAME='render360-port.json';
const MAX_MANIFEST_BYTES=512*1024;
const MAX_CONTENT_INDEX_BYTES=4*1024*1024;
const MAX_CONTENT_INDEX_ENTRIES=24000;
const allowedFormats=new Set(['render360-adapter','emscripten-esm']);
const isRemote=value=>/^[a-z][a-z0-9+.-]*:/i.test(String(value||''));

function assertLocalPath(value,label){const path=normalizePcPath(value);if(!path||isRemote(value)||String(value).startsWith('/')||String(value).includes('..'))throw new Error(`${label} must be a relative file inside the community runtime package.`);return path;}
function assertGamePath(value,label='game content path'){const path=normalizePcPath(value);if(!path||String(value).startsWith('/')||String(value).includes('..')||isRemote(value))throw new Error(`${label} must be a safe relative game path.`);return path;}

export function validateCommunityWasmManifest(manifest,{expectedGameId=null}={}){
  if(!manifest||typeof manifest!=='object')throw new Error('Community runtime manifest must be a JSON object.');
  if(manifest.schema!==PC_WASM_PACKAGE_SCHEMA)throw new Error(`Unsupported community runtime schema ${manifest.schema||'(missing)'}. Expected ${PC_WASM_PACKAGE_SCHEMA}.`);
  const gameId=String(manifest.gameId||'').trim().toLowerCase();if(!gameId)throw new Error('Community runtime manifest is missing gameId.');
  if(expectedGameId&&gameId!==String(expectedGameId).toLowerCase())throw new Error(`This runtime package targets ${gameId}, not ${expectedGameId}.`);
  const format=String(manifest.format||'render360-adapter');if(!allowedFormats.has(format))throw new Error(`Unsupported PC WebAssembly package format: ${format}`);
  const entry=assertLocalPath(manifest.entry,'entry');
  const wasm=manifest.wasm?assertLocalPath(manifest.wasm,'wasm'):null;
  const contentIndex=manifest.contentIndex?assertLocalPath(manifest.contentIndex,'contentIndex'):null;
  if(format==='emscripten-esm'&&!wasm)throw new Error('Emscripten runtime packages must declare their .wasm file.');
  const adapterExport=String(manifest.adapterExport||'createRender360PcPort');
  const requirements={
    webassembly:manifest.requirements?.webassembly!==false,
    webgl2:Boolean(manifest.requirements?.webgl2),
    webgpu:Boolean(manifest.requirements?.webgpu),
    sharedArrayBuffer:Boolean(manifest.requirements?.sharedArrayBuffer),
    crossOriginIsolated:Boolean(manifest.requirements?.crossOriginIsolated),
    threads:Boolean(manifest.requirements?.threads),
  };
  return {...manifest,gameId,format,entry,wasm,contentIndex,adapterExport,requirements};
}

export function validateCommunityContentIndex(index){
  const payload=Array.isArray(index)?{schema:PC_CONTENT_INDEX_SCHEMA,files:index}:index;
  if(!payload||typeof payload!=='object')throw new Error('PC content index must be a JSON object or an array of paths.');
  if(payload.schema&&payload.schema!==PC_CONTENT_INDEX_SCHEMA)throw new Error(`Unsupported PC content index schema ${payload.schema}. Expected ${PC_CONTENT_INDEX_SCHEMA}.`);
  const files=payload.files;if(!Array.isArray(files)||!files.length)throw new Error('PC content index must contain a non-empty files array.');
  if(files.length>MAX_CONTENT_INDEX_ENTRIES)throw new Error(`PC content index has too many entries (${files.length}). Maximum is ${MAX_CONTENT_INDEX_ENTRIES}.`);
  const normalized=files.map((item,index)=>{
    const record=typeof item==='string'?{path:item}:item;
    if(!record||typeof record!=='object')throw new Error(`Invalid PC content index entry at ${index}.`);
    const path=assertGamePath(record.path,`content index path ${index}`),target=assertGamePath(record.target||path,`content index target ${index}`);
    return {path,target,optional:Boolean(record.optional),group:String(record.group||'base')};
  });
  return {...payload,schema:PC_CONTENT_INDEX_SCHEMA,files:normalized};
}

function mapFileList(files){
  const input=[...files||[]].filter(file=>file&&typeof file.slice==='function');
  if(!input.length)throw new Error('Community runtime package is empty.');
  const raw=input.map(file=>normalizePcPath(file.webkitRelativePath||file.relativePath||file.name));
  const manifestIndex=raw.findIndex(path=>path.toLowerCase()===MANIFEST_NAME||path.toLowerCase().endsWith(`/${MANIFEST_NAME}`));
  if(manifestIndex<0)throw new Error(`Community runtime folder must contain ${MANIFEST_NAME}.`);
  const manifestRaw=raw[manifestIndex];const root=manifestRaw.slice(0,Math.max(0,manifestRaw.length-MANIFEST_NAME.length)).replace(/\/$/,'');
  const map=new Map();
  input.forEach((file,index)=>{let path=raw[index];if(root&&path.startsWith(`${root}/`))path=path.slice(root.length+1);map.set(path.toLowerCase(),{path,file});});
  return map;
}

function packageFromMap(map,manifest,{sourceName='community runtime'}={}){
  const urls=new Map();
  const lookup=path=>map.get(normalizePcPath(path).toLowerCase())||null;
  for(const required of [manifest.entry,manifest.wasm,manifest.contentIndex].filter(Boolean))if(!lookup(required))throw new Error(`Community runtime package is missing ${required}.`);
  return {
    kind:'render360-community-wasm-package',manifest,sourceName,
    paths(){return [...map.values()].map(v=>v.path).sort();},
    has(path){return Boolean(lookup(path));},
    file(path){return lookup(path)?.file||null;},
    async read(path){const file=lookup(path)?.file;if(!file)throw new Error(`Runtime package file not found: ${path}`);return new Uint8Array(await file.arrayBuffer());},
    url(path){
      const item=lookup(path);if(!item)throw new Error(`Runtime package file not found: ${path}`);
      const key=item.path.toLowerCase();if(urls.has(key))return urls.get(key);
      const type=item.path.endsWith('.mjs')||item.path.endsWith('.js')?'text/javascript':item.path.endsWith('.wasm')?'application/wasm':item.file.type||'application/octet-stream';
      const url=URL.createObjectURL(new Blob([item.file],{type}));urls.set(key,url);return url;
    },
    dispose(){for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();},
    descriptor(){return {kind:'community-wasm-package',gameId:manifest.gameId,name:manifest.name||sourceName,format:manifest.format,fileCount:map.size,contentIndex:manifest.contentIndex||null,requirements:{...manifest.requirements}};},
  };
}

export async function loadCommunityWasmPackageFromFiles(files,{expectedGameId=null}={}){
  const map=mapFileList(files),manifestFile=map.get(MANIFEST_NAME)||[...map.values()].find(item=>item.path.toLowerCase()===MANIFEST_NAME);
  if(!manifestFile||manifestFile.file.size>MAX_MANIFEST_BYTES)throw new Error('Community runtime manifest is missing or too large.');
  let parsed;try{parsed=JSON.parse(await manifestFile.file.text());}catch(error){throw new Error(`Invalid ${MANIFEST_NAME}: ${error.message}`);}
  const manifest=validateCommunityWasmManifest(parsed,{expectedGameId});return packageFromMap(map,manifest,{sourceName:'selected runtime folder'});
}

export async function loadCommunityWasmPackageFromZip(zipFile,{expectedGameId=null,onProgress=()=>{}}={}){
  if(!(zipFile instanceof Blob))throw new TypeError('Community runtime ZIP must be a browser File/Blob.');
  const zip=await inspectZip(zipFile),files=zip.entries.filter(entry=>!entry.directory);
  const manifestEntry=files.find(entry=>normalizePcPath(entry.name).toLowerCase()===MANIFEST_NAME)||files.find(entry=>normalizePcPath(entry.name).toLowerCase().endsWith(`/${MANIFEST_NAME}`));
  if(!manifestEntry)throw new Error(`Community runtime ZIP must contain ${MANIFEST_NAME}.`);
  if(manifestEntry.uncompressedSize>MAX_MANIFEST_BYTES)throw new Error('Community runtime manifest is too large.');
  const manifestExtract=await extractZipEntry(zipFile,manifestEntry,{persistent:false});
  let parsed;try{parsed=JSON.parse(await manifestExtract.file.text());}catch(error){throw new Error(`Invalid ${MANIFEST_NAME}: ${error.message}`);}
  const manifest=validateCommunityWasmManifest(parsed,{expectedGameId});
  const root=normalizePcPath(manifestEntry.name).slice(0,-MANIFEST_NAME.length).replace(/\/$/,'');
  const wanted=new Set([MANIFEST_NAME,manifest.entry,manifest.wasm,manifest.contentIndex,...(Array.isArray(manifest.files)?manifest.files.map(v=>assertLocalPath(v,'files entry')):[])].filter(Boolean).map(v=>normalizePcPath(v).toLowerCase()));
  const map=new Map();let completed=0;
  for(const entry of files){
    let path=normalizePcPath(entry.name);if(root&&path.startsWith(`${root}/`))path=path.slice(root.length+1);
    if(!wanted.has(path.toLowerCase()))continue;
    const extracted=path.toLowerCase()===MANIFEST_NAME?manifestExtract:await extractZipEntry(zipFile,entry,{persistent:false,onProgress:p=>onProgress({...p,packagePath:path})});
    map.set(path.toLowerCase(),{path,file:new File([extracted.file],path,{type:extracted.file.type||'application/octet-stream'})});completed++;onProgress({phase:'runtime-package',done:completed,total:wanted.size,percent:wanted.size?completed*100/wanted.size:100,name:path});
  }
  if(!map.has(MANIFEST_NAME))map.set(MANIFEST_NAME,{path:MANIFEST_NAME,file:manifestExtract.file});
  return packageFromMap(map,manifest,{sourceName:zipFile.name||'community runtime ZIP'});
}

export function checkCommunityRuntimeRequirements(manifest,{navigatorImpl=globalThis.navigator,crossOriginIsolatedValue=globalThis.crossOriginIsolated}={}){
  const req=manifest?.requirements||{},missing=[];
  if(req.webassembly!==false&&typeof WebAssembly==='undefined')missing.push('WebAssembly');
  if(req.webgl2&&typeof document!=='undefined'){
    const canvas=document.createElement('canvas');if(!canvas.getContext('webgl2'))missing.push('WebGL 2');
  }
  if(req.webgpu&&!navigatorImpl?.gpu)missing.push('WebGPU');
  if((req.sharedArrayBuffer||req.threads)&&typeof SharedArrayBuffer==='undefined')missing.push('SharedArrayBuffer');
  if((req.crossOriginIsolated||req.threads)&&crossOriginIsolatedValue!==true)missing.push('cross-origin isolation');
  return {ok:missing.length===0,missing,requirements:{...req}};
}

async function importPackageModule(pkg){const url=pkg.url(pkg.manifest.entry);return import(/* @vite-ignore */url);}

function ensureFsDirectory(FS,target){
  const parts=String(target||'').split('/').filter(Boolean);parts.pop();let current='';
  for(const part of parts){current+=`/${part}`;try{FS.mkdir(current);}catch(error){if(error?.errno!==20&&error?.code!=='EEXIST'&&!/exist/i.test(error?.message||''))throw error;}}
}

async function loadContentIndex(pkg){
  const path=pkg?.manifest?.contentIndex;if(!path)return null;
  const file=pkg.file(path);if(!file)throw new Error(`Community runtime content index is missing: ${path}`);
  if(file.size>MAX_CONTENT_INDEX_BYTES)throw new Error(`Community runtime content index is too large (${fmtBytes(file.size)}).`);
  let parsed;try{parsed=JSON.parse(await file.text());}catch(error){throw new Error(`Invalid ${path}: ${error.message}`);}
  return validateCommunityContentIndex(parsed);
}
function fmtBytes(value=0){const n=Number(value)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`;}

export async function mountIndexedPcContent({module,host,pkg}){
  const index=await loadContentIndex(pkg);if(!index)throw new Error('No contentIndex was declared for the generic Emscripten content mount.');
  const FS=module?.FS;if(!FS||typeof FS.writeFile!=='function')throw new Error('This Emscripten module must export FS (for example with -sFORCE_FILESYSTEM and exported runtime methods) to use a Render360 content index.');
  let mounted=0,missingOptional=0,bytes=0;
  host.emitStage?.({stage:'pc-content-index',message:`Mounting ${index.files.length.toLocaleString()} player-owned Portal files into the Emscripten working set…`,files:index.files.length});
  for(let i=0;i<index.files.length;i++){
    const entry=index.files[i];
    if(!host.content.has(entry.path)){
      if(entry.optional){missingOptional++;continue;}
      throw new Error(`Portal working set requires ${entry.path}, but it is missing from the selected installation.`);
    }
    const data=await host.content.read(entry.path),target=`/${entry.target}`;ensureFsDirectory(FS,target);FS.writeFile(target,data);mounted++;bytes+=data.byteLength;
    if(i===0||i===index.files.length-1||i%100===0)host.emitStage?.({stage:'pc-content-index-progress',message:`Portal working set · ${mounted.toLocaleString()}/${index.files.length.toLocaleString()} files · ${fmtBytes(bytes)}`,done:mounted,total:index.files.length,bytes});
  }
  host.emitStage?.({stage:'pc-content-index-ready',message:`Portal working set mounted · ${mounted.toLocaleString()} files · ${fmtBytes(bytes)}`,files:mounted,bytes,missingOptional});
  return {schema:PC_CONTENT_INDEX_SCHEMA,mounted,bytes,missingOptional,total:index.files.length};
}

export async function createCommunityPcSession({package:pkg,host}){
  if(!pkg?.manifest||!host)throw new Error('Community PC runtime package and host are required.');
  const capability=checkCommunityRuntimeRequirements(pkg.manifest);if(!capability.ok)throw new Error(`This community runtime requires ${capability.missing.join(', ')}.`);
  const mod=await importPackageModule(pkg),manifest=pkg.manifest;
  if(manifest.format==='render360-adapter'){
    const create=mod[manifest.adapterExport]||mod.createRender360PcPort||mod.default;
    if(typeof create!=='function')throw new Error(`Community runtime entry must export ${manifest.adapterExport}().`);
    const session=await create({...host,package:pkg,packageManifest:manifest});
    if(!session||typeof session!=='object')throw new Error('Community runtime adapter did not return a session object.');
    return session;
  }
  const factory=mod.default||mod[manifest.factoryExport||'createModule'];
  if(typeof factory!=='function')throw new Error('Emscripten ESM package does not export a module factory. Build with MODULARIZE + EXPORT_ES6 or provide a Render360 adapter package.');
  const locateFile=name=>{const clean=normalizePcPath(name);return pkg.has(clean)?pkg.url(clean):(manifest.wasm&&/\.wasm(?:\?|$)/i.test(name)?pkg.url(manifest.wasm):name);};
  const module=await factory({canvas:host.canvas,noInitialRun:true,locateFile,print:text=>host.emitLog?.('info',String(text)),printErr:text=>host.emitLog?.('warn',String(text))});
  let contentMount=null;
  if(typeof module.render360MountPcContent==='function')contentMount=await module.render360MountPcContent(host.content);
  else if(manifest.contentIndex)contentMount=await mountIndexedPcContent({module,host,pkg});
  else throw new Error('This Emscripten build does not expose render360MountPcContent() and does not declare contentIndex. Add a Render360 mount bridge or an indexed player-owned working set.');
  let stopped=false;
  return {module,contentMount,async start(){if(stopped)throw new Error('PC WebAssembly session is stopped');if(typeof module.callMain==='function')module.callMain(Array.isArray(manifest.arguments)?manifest.arguments:[]);return {runtimeBoundary:'pc-wasm-running',format:'emscripten-esm',contentMount};},pause(){module.render360Pause?.();return true;},resume(){module.render360Resume?.();return true;},stop(){stopped=true;module.render360Stop?.();pkg.dispose?.();}};
}

export function communityWasmPackageContract(){return {schema:PC_WASM_PACKAGE_SCHEMA,contentIndexSchema:PC_CONTENT_INDEX_SCHEMA,manifest:MANIFEST_NAME,formats:[...allowedFormats],remoteEntriesAllowed:false,userSuppliedRuntime:true,userSuppliedGameData:true,indexedWorkingSet:true,wholeGameEmbeddedInWasm:false};}
