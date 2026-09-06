import {inspectZip,extractZipEntry} from '../import/zip-importer.js';
import {normalizePcPath} from './pc-content-source.js';

export const PC_WASM_PACKAGE_SCHEMA='render360-pc-wasm-package-v1';
const MANIFEST_NAME='render360-port.json';
const MAX_MANIFEST_BYTES=512*1024;
const allowedFormats=new Set(['render360-adapter','emscripten-esm']);
const isRemote=value=>/^[a-z][a-z0-9+.-]*:/i.test(String(value||''));

function assertLocalPath(value,label){const path=normalizePcPath(value);if(!path||isRemote(value)||String(value).startsWith('/')||String(value).includes('..'))throw new Error(`${label} must be a relative file inside the community runtime package.`);return path;}

export function validateCommunityWasmManifest(manifest,{expectedGameId=null}={}){
  if(!manifest||typeof manifest!=='object')throw new Error('Community runtime manifest must be a JSON object.');
  if(manifest.schema!==PC_WASM_PACKAGE_SCHEMA)throw new Error(`Unsupported community runtime schema ${manifest.schema||'(missing)'}. Expected ${PC_WASM_PACKAGE_SCHEMA}.`);
  const gameId=String(manifest.gameId||'').trim().toLowerCase();if(!gameId)throw new Error('Community runtime manifest is missing gameId.');
  if(expectedGameId&&gameId!==String(expectedGameId).toLowerCase())throw new Error(`This runtime package targets ${gameId}, not ${expectedGameId}.`);
  const format=String(manifest.format||'render360-adapter');if(!allowedFormats.has(format))throw new Error(`Unsupported PC WebAssembly package format: ${format}`);
  const entry=assertLocalPath(manifest.entry,'entry');
  const wasm=manifest.wasm?assertLocalPath(manifest.wasm,'wasm'):null;
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
  return {...manifest,gameId,format,entry,wasm,adapterExport,requirements};
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
  for(const required of [manifest.entry,manifest.wasm].filter(Boolean))if(!lookup(required))throw new Error(`Community runtime package is missing ${required}.`);
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
    descriptor(){return {kind:'community-wasm-package',gameId:manifest.gameId,name:manifest.name||sourceName,format:manifest.format,fileCount:map.size,requirements:{...manifest.requirements}};},
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
  const wanted=new Set([MANIFEST_NAME,manifest.entry,manifest.wasm,...(Array.isArray(manifest.files)?manifest.files.map(v=>assertLocalPath(v,'files entry')):[])].filter(Boolean).map(v=>normalizePcPath(v).toLowerCase()));
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
  if(typeof factory!=='function')throw new Error('Emscripten ESM package does not export a module factory.');
  const locateFile=name=>{const clean=normalizePcPath(name);return pkg.has(clean)?pkg.url(clean):(manifest.wasm&&/\.wasm(?:\?|$)/i.test(name)?pkg.url(manifest.wasm):name);};
  const module=await factory({canvas:host.canvas,noInitialRun:true,locateFile,print:text=>host.emitLog?.('info',String(text)),printErr:text=>host.emitLog?.('warn',String(text))});
  if(typeof module.render360MountPcContent!=='function')throw new Error('This Emscripten build does not expose render360MountPcContent(). Use a Render360-aware Portal community build so the player-owned PC files can be mounted without copying the whole install into WASM memory.');
  await module.render360MountPcContent(host.content);
  let stopped=false;
  return {module,async start(){if(stopped)throw new Error('PC WebAssembly session is stopped');if(typeof module.callMain==='function')module.callMain(Array.isArray(manifest.arguments)?manifest.arguments:[]);return {runtimeBoundary:'pc-wasm-running',format:'emscripten-esm'};},pause(){module.render360Pause?.();return true;},resume(){module.render360Resume?.();return true;},stop(){stopped=true;module.render360Stop?.();pkg.dispose?.();}};
}

export function communityWasmPackageContract(){return {schema:PC_WASM_PACKAGE_SCHEMA,manifest:MANIFEST_NAME,formats:[...allowedFormats],remoteEntriesAllowed:false,userSuppliedRuntime:true,userSuppliedGameData:true,wholeGameEmbeddedInWasm:false};}
