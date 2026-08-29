import assert from 'node:assert/strict';
import {mountXdvdfs} from './render360-xdvdfs.mjs';

const S=2048,M='MICROSOFT*XBOX*MEDIA';
const w16=(b,o,v)=>{b[o]=v&255;b[o+1]=v>>>8};const w32=(b,o,v)=>{for(let i=0;i<4;i++)b[o+i]=(v>>>(8*i))&255};const put=(b,o,s)=>{for(let i=0;i<s.length;i++)b[o+i]=s.charCodeAt(i)};
function make(){const b=Buffer.alloc(80*S),d=32*S;put(b,d,M);put(b,d+0x7ec,M);w32(b,d+0x14,40);w32(b,d+0x18,S);const r=40*S,n='default.xex';w32(b,r+4,60);w32(b,r+8,32);b[r+12]=0x80;b[r+13]=n.length;put(b,r+14,n);put(b,60*S,'XEX2');return b;}

// A source that records every requested range. Any whole-image read is a critic failure.
const image=make();const requests=[];const source={size:image.length,async readRange(off,len){requests.push([off,len]);assert.ok(len<=S,'critic: reader attempted an oversized metadata/file probe');return image.subarray(off,off+len)}};
const v=await mountXdvdfs(source);const head=await v.readFileRange('/default.xex',0,4);assert.equal(Buffer.from(head).toString('ascii'),'XEX2');assert.ok(requests.length>=3);assert.ok(requests.reduce((a,[,n])=>a+n,0)<image.length/2,'critic: virtual mount read an excessive fraction of the image');

// Corrupt root pointer must not escape the directory table.
{const bad=make();w16(bad,40*S,0xffff);const q=await mountXdvdfs(bad);await assert.rejects(()=>q.list('/'),/pointer out of bounds/);}
// Corrupt root size must fail before an unsafe read.
{const bad=make();w32(bad,32*S+0x18,0xffffffff);await assert.rejects(()=>mountXdvdfs(bad),/size unreasonable|outside image/);}
// Missing default.xex must be exact, not guessed by file position.
{const bad=make();bad.fill(0,40*S+14,40*S+14+'default.xex'.length);const q=await mountXdvdfs(bad);await assert.rejects(()=>q.stat('/default.xex'),/path not found/);}

console.log('XDVDFS_HARSH_CRITIC=PASS');
console.log('XDVDFS_NO_WHOLE_ISO_COPY=PASS');
console.log('XDVDFS_POINTER_BOUNDS_FAIL_CLOSED=PASS');
console.log('XDVDFS_DEFAULT_XEX_DISCOVERY_PROVENANCE=PASS');
