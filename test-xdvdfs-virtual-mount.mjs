import assert from 'node:assert/strict';
import {mountXdvdfs,xdvdfsLayouts} from './render360-xdvdfs.mjs';

const SECTOR=2048,MAGIC='MICROSOFT*XBOX*MEDIA';
const le16w=(b,o,v)=>{b[o]=v&255;b[o+1]=(v>>>8)&255;};
const le32w=(b,o,v)=>{b[o]=v&255;b[o+1]=(v>>>8)&255;b[o+2]=(v>>>16)&255;b[o+3]=(v>>>24)&255;};
const ascii=(b,o,s)=>{for(let i=0;i<s.length;i++)b[o+i]=s.charCodeAt(i)};

function entry(name,start,size,attr=0x80,left=0,right=0){const n=Buffer.from(name,'ascii'),len=(14+n.length+3)&~3,b=Buffer.alloc(len,0xff);le16w(b,0,left);le16w(b,2,right);le32w(b,4,start);le32w(b,8,size);b[12]=attr;b[13]=n.length;n.copy(b,14);return b;}
function fixture(partitionOffset=0){
  const rootSector=40,rootSize=2048,xexSector=60,xex=Buffer.alloc(0x80);ascii(xex,0,'XEX2');
  const total=partitionOffset+(xexSector+1)*SECTOR;const image=Buffer.alloc(total);
  const d=partitionOffset+32*SECTOR;ascii(image,d,MAGIC);le32w(image,d+0x14,rootSector);le32w(image,d+0x18,rootSize);ascii(image,d+0x7ec,MAGIC);
  const root=Buffer.alloc(rootSize,0xff);const e=entry('default.xex',xexSector,xex.length);e.copy(root,0);root.copy(image,partitionOffset+rootSector*SECTOR);xex.copy(image,partitionOffset+xexSector*SECTOR);
  return {image,xex};
}

for(const layout of xdvdfsLayouts()){
  const {image,xex}=fixture(layout.partitionOffset);const v=await mountXdvdfs(image);
  assert.equal(v.layout,layout.layout);assert.equal(v.partitionOffset,layout.partitionOffset);
  const node=await v.stat('/DEFAULT.XEX');assert.equal(node.size,xex.length);assert.equal(node.isDirectory,false);
  assert.deepEqual(Buffer.from(await v.readDefaultXex()),xex);
  assert.deepEqual(Buffer.from(await v.readFileRange('/default.xex',1,3)),xex.subarray(1,4));
  assert.ok(v.telemetry.maxRead<=2048,'mount must use bounded metadata reads');
}

{
  const {image}=fixture(0);image[32*SECTOR]=0;await assert.rejects(()=>mountXdvdfs(image),/volume not found/);
}
{
  const {image}=fixture(0);const root=40*SECTOR;le16w(image,root,1);await assert.rejects(async()=>{const v=await mountXdvdfs(image);await v.list('/')},/cycle|filename|entry|pointer/i);
}
{
  const {image}=fixture(0);const v=await mountXdvdfs(image);await assert.rejects(()=>v.readFileRange('/default.xex',0,0x1000),/range out of bounds/);
}

console.log('XDVDFS_VIRTUAL_MOUNT=PASS');
console.log('XDVDFS_LAYOUTS=XISO,XGD3,XGD2,XGD1');
console.log('XDVDFS_DEFAULT_XEX_EXACT=PASS');
console.log('XDVDFS_BOUNDED_RANGE_READS=PASS');
console.log('XDVDFS_MALFORMED_TREE_FAIL_CLOSED=PASS');
