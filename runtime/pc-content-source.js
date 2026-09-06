import {createSourceVpkOverlay} from './source-vpk-source.js';

const normalizePath=value=>String(value||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+|\/+$/g,'').split('/').filter(part=>part&&part!=='.'&&part!=='..').join('/');
const lowerPath=value=>normalizePath(value).toLowerCase();

function commonRoot(paths){
  if(!paths.length)return '';
  const first=normalizePath(paths[0]).split('/');
  let count=first.length;
  for(const path of paths.slice(1)){
    const parts=normalizePath(path).split('/');
    count=Math.min(count,parts.length);
    for(let i=0;i<count;i++)if(parts[i]!==first[i]){count=i;break;}
  }
  return first.slice(0,count).join('/');
}

function browserFilePath(file){return normalizePath(file?.webkitRelativePath||file?.relativePath||file?.name||'');}

export function createPcFileListSource(files,{name='PC game folder',stripCommonRoot=true}={}){
  const input=[...files||[]].filter(file=>file&&typeof file.slice==='function');
  if(!input.length)throw new Error('The PC game folder does not contain any readable files.');
  const rawPaths=input.map(browserFilePath);
  let root=stripCommonRoot?commonRoot(rawPaths):'';
  if(root&&rawPaths.some(path=>path===root))root='';
  const byPath=new Map();
  let size=0;
  for(let i=0;i<input.length;i++){
    const file=input[i];
    let path=rawPaths[i];
    if(root&&path.startsWith(`${root}/`))path=path.slice(root.length+1);
    path=normalizePath(path);
    if(!path)continue;
    byPath.set(lowerPath(path),{path,file,size:Number(file.size||0)});
    size+=Number(file.size||0);
  }
  const paths=[...byPath.values()].map(item=>item.path).sort();
  const base={
    kind:'pc-file-list',name,rootName:root||null,size,files:input,
    paths(){return [...paths];},
    entries(){return paths.map(path=>{const item=byPath.get(lowerPath(path));return {path:item.path,file:item.file,size:item.size};});},
    has(path){return byPath.has(lowerPath(path));},
    stat(path){const item=byPath.get(lowerPath(path));return item?{path:item.path,size:item.size,file:true}:null;},
    file(path){return byPath.get(lowerPath(path))?.file||null;},
    async read(path,{offset=0,length=null}={}){
      const item=byPath.get(lowerPath(path));if(!item)throw new Error(`PC game file not found: ${normalizePath(path)}`);
      const start=Math.max(0,Number(offset)||0),end=length==null?item.size:Math.min(item.size,start+Math.max(0,Number(length)||0));
      return new Uint8Array(await item.file.slice(start,end).arrayBuffer());
    },
    descriptor(){return {kind:'pc-file-list',name,rootName:root||null,size,fileCount:paths.length,linkedFolder:true};},
  };
  return createSourceVpkOverlay(base);
}

export function createPcMemorySource(entries,{name='PC game fixture'}={}){
  const byPath=new Map();let size=0;
  for(const [rawPath,value] of Object.entries(entries||{})){
    const path=normalizePath(rawPath);if(!path)continue;
    const bytes=value instanceof Uint8Array?value:new TextEncoder().encode(String(value??''));
    byPath.set(lowerPath(path),{path,bytes});size+=bytes.byteLength;
  }
  const paths=[...byPath.values()].map(v=>v.path).sort();
  return {kind:'pc-memory',name,size,paths:()=>[...paths],entries:()=>paths.map(path=>{const item=byPath.get(lowerPath(path));return {path:item.path,size:item.bytes.byteLength,bytes:item.bytes};}),has:path=>byPath.has(lowerPath(path)),async hasAsync(path){return byPath.has(lowerPath(path));},stat(path){const item=byPath.get(lowerPath(path));return item?{path:item.path,size:item.bytes.byteLength,file:true}:null;},async read(path,{offset=0,length=null}={}){const item=byPath.get(lowerPath(path));if(!item)throw new Error(`PC game file not found: ${normalizePath(path)}`);const start=Math.max(0,Number(offset)||0),end=length==null?item.bytes.byteLength:Math.min(item.bytes.byteLength,start+Math.max(0,Number(length)||0));return item.bytes.slice(start,end);},descriptor(){return {kind:'pc-memory',name,size,fileCount:paths.length};}};
}

const PORTAL_STRONG_MARKERS=[
  'portal/gameinfo.txt',
  'portal/portal_pak_dir.vpk',
];
const PORTAL_SUPPORT_MARKERS=[
  'hl2/hl2_misc_dir.vpk',
  'hl2/hl2_textures_dir.vpk',
  'platform/platform_misc_dir.vpk',
  'portal/bin/client.dll',
  'portal/bin/server.dll',
  'bin/engine.dll',
  'hl2.exe',
  'portal.exe',
];

export function detectPortalPcContent(source){
  if(!source||typeof source.has!=='function')return {matched:false,gameId:'portal-1-pc',reason:'invalid-source',confidence:0,missing:[...PORTAL_STRONG_MARKERS]};
  const presentStrong=PORTAL_STRONG_MARKERS.filter(path=>source.has(path));
  const presentSupport=PORTAL_SUPPORT_MARKERS.filter(path=>source.has(path));
  const gameInfo=source.has('portal/gameinfo.txt');
  const portalPak=source.has('portal/portal_pak_dir.vpk')||source.paths?.().some(path=>/^portal\/portal_pak_\d+\.vpk$/i.test(path));
  const hl2Base=source.has('hl2/hl2_misc_dir.vpk')||source.has('hl2/gameinfo.txt')||source.paths?.().some(path=>/^hl2\/hl2_.+\.vpk$/i.test(path));
  const matched=Boolean(gameInfo&&portalPak&&hl2Base);
  const confidence=matched?1:Math.min(.95,(Number(gameInfo)+Number(portalPak)+Number(hl2Base)+Math.min(2,presentSupport.length)*.25)/3.5);
  const missing=[];if(!gameInfo)missing.push('portal/gameinfo.txt');if(!portalPak)missing.push('portal/portal_pak_dir.vpk (or numbered Portal VPKs)');if(!hl2Base)missing.push('hl2 base content/VPKs');
  return {matched,gameId:'portal-1-pc',name:'Portal',engine:'Source',steamAppId:400,confidence:Number(confidence.toFixed(2)),present:[...new Set([...presentStrong,...presentSupport])],missing,reason:matched?'portal-content-recognized':'portal-content-incomplete'};
}

export function detectPcGame(source){
  const portal=detectPortalPcContent(source);
  if(portal.matched)return portal;
  return {matched:false,gameId:null,name:null,engine:null,confidence:portal.confidence,candidates:[portal],reason:'unsupported-pc-game'};
}

export function pcContentContract(){return {schema:'render360-pc-content-v1',streaming:true,wholeGameCopyRequired:false,folderFiles:true,linkedFolderEntries:true,lazySourceVpkReads:true,portal:{gameId:'portal-1-pc',steamAppId:400,strongMarkers:[...PORTAL_STRONG_MARKERS],supportMarkers:[...PORTAL_SUPPORT_MARKERS]}};}

export {normalizePath as normalizePcPath};
