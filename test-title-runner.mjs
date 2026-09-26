import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

// End-to-end critic for tools/run-title.mjs: a synthetic encrypted retail-style
// XEX whose entry calls xboxkrnl!KeQueryPerformanceFrequency and then
// xboxkrnl!HalReturnToFirmware(1). The runner must boot it through the real
// pipeline, register the folder as the guest disc, and report a named
// title-requested-exit boundary with the named kernel call trace.

const wasm=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const p16le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};
const p32le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};
const p16be=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};
const p32be=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const retail=Buffer.from([0x20,0xB1,0x85,0xA5,0x9D,0x28,0xFD,0xC3,0x40,0x58,0x3F,0xBB,0x08,0x96,0xBF,0x91]);
const aes=(k,d)=>{const c=crypto.createCipheriv('aes-128-cbc',k,Buffer.alloc(16));c.setAutoPadding(false);return Buffer.concat([c.update(d),c.final()]);};

function pe(base){
  const a=Buffer.alloc(0x400),nt=0x80,opt=nt+24,sh=opt+224;
  a.write('MZ',0,'ascii');p32le(a,0x3c,nt);p32le(a,nt,0x00004550);p16le(a,nt+4,0x01F2);p16le(a,nt+6,1);p16le(a,nt+20,224);p16le(a,nt+22,0x0102);
  p16le(a,opt,0x10B);p32le(a,opt+16,0x1000);p32le(a,opt+28,base);p32le(a,opt+32,0x1000);p32le(a,opt+36,0x200);p32le(a,opt+56,0x2000);p32le(a,opt+60,0x200);p16le(a,opt+68,14);
  a.write('.text\0\0\0',sh,'ascii');p32le(a,sh+8,0x200);p32le(a,sh+12,0x1000);p32le(a,sh+16,0x200);p32le(a,sh+20,0x200);p32le(a,sh+36,0x60000020);
  const call=thunk=>[0x3D600000|((thunk>>>16)&0xffff),0x616B0000|(thunk&0xffff),0x7D6903A6,0x4E800421];
  const words=[...call(base+0x1104),0x38600001,...call(base+0x110C),0x4E800020];
  words.forEach((w,i)=>p32be(a,0x200+i*4,w>>>0));
  // xboxkrnl import records: descriptor (type 0) + thunk (type 1) per function.
  p32be(a,0x300,0x00000083);p32be(a,0x304,0x01000083);  // KeQueryPerformanceFrequency
  p32be(a,0x308,0x00000028);p32be(a,0x30C,0x01000028);  // HalReturnToFirmware
  return a;
}

function xex(base,body){
  const h=Buffer.alloc(0x400),s=0x120,ffi=0x60,exec=0x90,imp=0xB0;
  h.write('XEX2',0,'ascii');p32be(h,4,1);p32be(h,8,0x400);p32be(h,0x10,s);p32be(h,0x14,5);
  let p=0x18;for(const[k,v]of[[0x3ff,ffi],[0x10100,base+0x1000],[0x10201,base],[0x103ff,imp],[0x40006,exec]]){p32be(h,p,k);p32be(h,p+4,v);p+=8;}
  p32be(h,ffi,8);p16be(h,ffi+4,1);p16be(h,ffi+6,0);
  p32be(h,exec,0xAABBCCDD);p32be(h,exec+0x0c,0x584108CE);
  p32be(h,imp,0x54);p32be(h,imp+4,16);p32be(h,imp+8,1);h.write('xboxkrnl.exe\0',imp+12,'ascii');
  const lib=imp+28;p32be(h,lib,0x38);p32be(h,lib+0x18,1);p32be(h,lib+0x1c,0x10000);p32be(h,lib+0x20,0x10000);p16be(h,lib+0x24,0);p16be(h,lib+0x26,4);
  [0x1100,0x1104,0x1108,0x110C].forEach((o,i)=>p32be(h,lib+0x28+i*4,base+o));
  p32be(h,s,0x19c);p32be(h,s+4,0x2000);p32be(h,s+0x110,base);p32be(h,s+0x178,0xffffffff);p32be(h,s+0x17c,0x08000000);p32be(h,s+0x180,1);p32be(h,s+0x184,0x11);
  return Buffer.concat([h,body]);
}

const base=0x82000000;
const session=Buffer.from(Array.from({length:16},(_,i)=>(0x5D+i*13)&255));
const plain=pe(base);
const defaultXex=xex(base,aes(session,plain));
// The retail loader reads the encrypted session key from security info +0x150.
aes(retail,session).copy(defaultXex,0x120+0x150);

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r360-runner-'));
fs.writeFileSync(path.join(dir,'default.xex'),defaultXex);
fs.mkdirSync(path.join(dir,'data'));fs.writeFileSync(path.join(dir,'data','level.bin'),Buffer.alloc(64,7));
const reportPath=path.join(dir,'report.json');
let stdout='';
try{stdout=execFileSync(process.execPath,['tools/run-title.mjs',dir,'--bootstrap',wasm,'--json',reportPath],{encoding:'utf8',stdio:['ignore','pipe','pipe']});}
catch(error){throw new Error(`title runner failed: ${error.stdout}\n${error.stderr}`);}
const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
const expect=(cond,message)=>{if(!cond)throw new Error(`${message}\n${stdout}`);};
expect(report.kind==='folder'&&report.vfs.files===2&&report.vfs.directories===1,'runner did not register the title folder as the guest disc');
expect(report.runtimeBoundary==='title-requested-exit','runner did not stop at the title-requested exit');
expect(report.kernelBoundary?.export==='HalReturnToFirmware'&&report.kernelBoundary?.code===1,'terminal boundary did not name HalReturnToFirmware(1)');
const names=report.kernelTrace.map(call=>call.name);
expect(JSON.stringify(names)===JSON.stringify(['KeQueryPerformanceFrequency','HalReturnToFirmware']),`kernel trace mismatch ${names}`);
expect(report.kernelTrace[0].result===50000000&&report.kernelTrace[1].status===4,'kernel trace results mismatch');
expect(/stopped at: title-requested-exit/.test(stdout)&&/HalReturnToFirmware/.test(stdout),'human-readable report missing');
fs.rmSync(dir,{recursive:true,force:true});
console.log('TITLE_RUNNER_FOLDER_VFS=PASS');
console.log('TITLE_RUNNER_NAMED_KERNEL_TRACE=PASS');
console.log('TITLE_RUNNER_TERMINAL_BOUNDARY=PASS');
