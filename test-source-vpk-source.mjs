import assert from 'node:assert/strict';
import {createSourceVpkOverlay,sourceVpkContract} from './runtime/source-vpk-source.js';

const enc=new TextEncoder();
const cstr=s=>new Uint8Array([...enc.encode(s),0]);
const chunks=[];
const push=u=>chunks.push(u);
function le16(v){const a=new Uint8Array(2);new DataView(a.buffer).setUint16(0,v,true);return a;}
function le32(v){const a=new Uint8Array(4);new DataView(a.buffer).setUint32(0,v,true);return a;}

push(cstr('txt'));push(cstr('materials'));push(cstr('hello'));
push(le32(0));push(le16(3));push(le16(0x7fff));push(le32(0));push(le32(4));push(le16(0xffff));push(enc.encode('pre'));
push(cstr(''));push(cstr(''));push(cstr(''));
const treeSize=chunks.reduce((n,a)=>n+a.length,0),header=new Uint8Array(12),hv=new DataView(header.buffer);
hv.setUint32(0,0x55aa1234,true);hv.setUint32(4,1,true);hv.setUint32(8,treeSize,true);
const dirFile=new File([header,...chunks,enc.encode('data')],'portal_pak_dir.vpk');
const base={
  kind:'fixture',
  paths:()=>['portal/portal_pak_dir.vpk'],
  has:path=>path==='portal/portal_pak_dir.vpk',
  file:path=>path==='portal/portal_pak_dir.vpk'?dirFile:null,
  async read(){throw new Error('direct read not expected');},
  descriptor:()=>({kind:'fixture'}),
};
const overlay=createSourceVpkOverlay(base);
assert.equal(overlay.vpkDirectoryCount,1);
assert.equal(await overlay.hasAsync('portal/materials/hello.txt'),true);
assert.equal(new TextDecoder().decode(await overlay.read('portal/materials/hello.txt')),'predata');
assert.equal(await overlay.hasAsync('portal/materials/missing.txt'),false);
assert.equal(sourceVpkContract().wholeArchiveCopy,false);
console.log('SOURCE_VPK_DIRECTORY_PARSE=PASS');
console.log('SOURCE_VPK_LAZY_PAYLOAD=PASS');
