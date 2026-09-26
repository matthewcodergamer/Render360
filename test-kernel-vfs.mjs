import fs from 'node:fs';
import {createRender360BrowserImports,attachRender360BrowserInstance,validateRender360BrowserImports} from './render360-browser-wasi.mjs';
import {XBOXKRNL_EXPORTS,XAM_EXPORTS} from './render360-kernel-export-names.mjs';

// Critic for the Xenia-style virtual file system: game:/d: symlinks to
// \Device\Cdrom0, NtCreateFile/NtOpenFile/NtReadFile/NtQuery*File and
// NtQueryDirectoryFile over files supplied either in wasm memory or through
// the browser WASI fd_pread host-file hook.

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const module=await WebAssembly.compile(fs.readFileSync(wasmPath));
validateRender360BrowserImports(module);
const host=createRender360BrowserImports({onStdout:()=>{},onStderr:()=>{}});
const instance=attachRender360BrowserInstance(host,await WebAssembly.instantiate(module,host.imports));
const e=instance.exports;
const need=n=>{const fn=e[n]??e[`_${n}`];if(typeof fn!=='function')throw new Error(`missing VFS export ${n}`);return fn;};
const ord=name=>{for(const [o,info] of XBOXKRNL_EXPORTS)if(info.name===name)return o;throw new Error(name);};
const service=need('r360_kernel_service_call'),serviceStatus=need('r360_kernel_service_status');
const k=(name,...args)=>{const a=[...args,0,0,0,0,0,0,0,0].slice(0,8);return service(1,ord(name),...a)>>>0;};
const status=()=>serviceStatus()>>>0;
const expect=(cond,message)=>{if(!cond)throw new Error(message);};

need('r360_sparse_guest_memory_reset')();need('r360_kernel_runtime_reset')();need('r360_kernel_services_reset')();need('r360_vfs_reset')();
const alloc=need('r360_sparse_guest_memory_alloc'),map=need('r360_sparse_guest_memory_map');
const w8=need('r360_sparse_guest_memory_write_u8'),r8=need('r360_sparse_guest_memory_read_u8');
const w32=(a,v)=>{for(let i=0;i<4;i++)w8(a+i,(v>>>(24-8*i))&255);};
const w16=(a,v)=>{w8(a,(v>>>8)&255);w8(a+1,v&255);};
const w64=(a,v)=>{w32(a,Number((BigInt.asUintN(64,v)>>32n)&0xFFFFFFFFn));w32(a+4,Number(BigInt.asUintN(64,v)&0xFFFFFFFFn));};
const r32=a=>((r8(a)<<24)|(r8(a+1)<<16)|(r8(a+2)<<8)|r8(a+3))>>>0;
const r64=a=>(BigInt(r32(a))<<32n)|BigInt(r32(a+4));
const ascii=(a,t)=>{for(let i=0;i<t.length;i++)w8(a+i,t.charCodeAt(i));w8(a+t.length,0);};
const readAscii=(a,n)=>Array.from({length:n},(_,i)=>String.fromCharCode(r8(a+i))).join('');
const readU16=(a,n)=>Array.from({length:n},(_,i)=>String.fromCharCode((r8(a+i*2)<<8)|r8(a+i*2+1))).join('');
const P=0x51000000;{const b=alloc(32)>>>0;expect(b&&(map(P,32,b,0,3)>>>0)===1,'map params');}

// Registration helpers (what the browser loader / title runner call).
const pathBuffer=need('r360_vfs_path_buffer')()>>>0;
const register=(path,size,{attributes=0,hostFd=0,hostOffset=0}={})=>{
  const bytes=Buffer.from(path,'utf8');new Uint8Array(e.memory.buffer,pathBuffer,bytes.length).set(bytes);
  const id=need('r360_vfs_register')(bytes.length,size>>>0,Math.floor(size/2**32),attributes,hostFd,hostOffset>>>0,Math.floor(hostOffset/2**32))>>>0;
  expect(id,`register ${path}`);return id;
};
const attach=(id,data)=>{const ptr=need('r360_vfs_data_buffer')(id)>>>0;expect(ptr,'data buffer');new Uint8Array(e.memory.buffer,ptr,data.length).set(data);};

const xexBytes=Buffer.from('XEX2 fake executable for VFS critic');
attach(register('default.xex',xexBytes.length),xexBytes);
// A host-backed "disc image": level1.dat lives at offset 0x800 inside it.
const disc=Buffer.alloc(0x4000);for(let i=0;i<disc.length;i++)disc[i]=(i*7+3)&255;
let hostReads=0;
const discFd=host.registerHostFile({readSync(offset,length){hostReads++;return disc.subarray(offset,offset+length);}});
register('Data\\Level1.dat',0x1000,{hostFd:discFd,hostOffset:0x800});
register('data\\sub\\x.bin',4,{hostFd:discFd,hostOffset:0});
const lazyFd=host.registerHostFile({readSync(){return null;}});  // Needs async fetch.
register('data\\music.xma',0x200000,{hostFd:lazyFd,hostOffset:0});
expect((need('r360_vfs_entry_count')()>>>0)===6,'expected default.xex, data, level1, sub, x.bin, music');
console.log('VFS_REGISTRATION=PASS');

// X_OBJECT_ATTRIBUTES { root=ObDosDevices, name=&ANSI_STRING }.
const attrs=(address,path)=>{ascii(address+0x40,path);w16(address+0x10,path.length);w16(address+0x12,path.length+1);w32(address+0x14,address+0x40);w32(address,0xFFFFFFFD);w32(address+4,address+0x10);w32(address+8,0);return address;};
const OPEN=1,FILE_NON_DIRECTORY_FILE=0x40;
expect(k('NtOpenFile',P+0x800,0x80100000,attrs(P,'game:\\data\\level1.dat'),P+0x810,1,FILE_NON_DIRECTORY_FILE)===0,'NtOpenFile game:\\data\\level1.dat failed');
const file=r32(P+0x800);expect(r32(P+0x810)===0&&r32(P+0x814)===1,'IO_STATUS_BLOCK for open mismatch');
expect(k('NtReadFile',file,0,0,0,P+0x820,P+0x1000,16,0)===0,'NtReadFile failed');
expect(r32(P+0x824)===16&&r8(P+0x1000)===disc[0x800]&&r8(P+0x100F)===disc[0x80F],'NtReadFile bytes mismatch');
expect(k('NtReadFile',file,0,0,0,P+0x820,P+0x1000,16,0)===0&&r8(P+0x1000)===disc[0x810],'sequential read did not advance the file position');
w64(P+0x830,0xFF0n);expect(k('NtReadFile',file,0,0,0,P+0x820,P+0x1000,0x100,P+0x830)===0&&r32(P+0x824)===0x10,'read at explicit offset near EOF not truncated');
w64(P+0x830,0x2000n);expect(k('NtReadFile',file,0,0,0,P+0x820,P+0x1000,16,P+0x830)===0xC0000011,'read past EOF did not return STATUS_END_OF_FILE');
expect(k('NtQueryInformationFile',file,P+0x840,P+0x850,8,14)===0&&r64(P+0x850)===0x1000n,'position after EOF-adjacent read mismatch');
w64(P+0x860,4n);expect(k('NtSetInformationFile',file,P+0x840,P+0x860,8,14)===0,'NtSetInformationFile position failed');
expect(k('NtReadFile',file,0,0,0,P+0x820,P+0x1000,1,0)===0&&r8(P+0x1000)===disc[0x804],'position set was not honoured');
expect(k('NtQueryInformationFile',file,P+0x840,P+0x870,56,34)===0&&r64(P+0x870+40)===0x1000n,'network open info size mismatch');
// Synchronous file handles are always signalled.
w64(P+0x8F0,0n);expect(k('NtWaitForSingleObjectEx',file,1,0,P+0x8F0)===0,'file handle wait not signalled');
expect(k('NtClose',file)===0,'NtClose(file) failed');
expect(hostReads>=4,'host fd_pread path was not exercised');
console.log('VFS_OPEN_READ_SEEK=PASS');

// In-memory data via d: symlink and \\Device path forms.
expect(k('NtOpenFile',P+0x800,0x80100000,attrs(P,'d:\\default.xex'),P+0x810,1,0)===0,'d:\\default.xex open failed');
const xex=r32(P+0x800);expect(k('NtReadFile',xex,0,0,0,P+0x820,P+0x1100,4,0)===0&&readAscii(P+0x1100,4)==='XEX2','in-memory read mismatch');
expect(k('NtOpenFile',P+0x800,0x80100000,attrs(P,'\\Device\\Cdrom0\\DATA\\SUB\\X.BIN'),P+0x810,1,0)===0,'case-insensitive device path open failed');
expect(k('NtOpenFile',P+0x800,0x80100000,attrs(P,'game:\\missing.bin'),P+0x810,1,0)===0xC000000F,'missing file not STATUS_NO_SUCH_FILE');
expect(k('NtCreateFile',P+0x800,0x40000000,attrs(P,'game:\\save.dat'),P+0x810,0,0x80,0,2)===0xC0000022,'creating a file on read-only disc should be denied');
console.log('VFS_PATHS_AND_SYMLINKS=PASS');

// Attributes and directory enumeration.
expect(k('NtQueryFullAttributesFile',attrs(P,'game:\\data\\level1.dat'),P+0x900)===0&&r64(P+0x900+40)===0x1000n,'NtQueryFullAttributesFile size mismatch');
expect(k('NtQueryFullAttributesFile',attrs(P,'game:\\data'),P+0x900)===0&&(r32(P+0x900+48)&0x10)===0x10,'directory attributes mismatch');
expect(k('NtOpenFile',P+0x800,0x80100000,attrs(P,'game:\\data'),P+0x810,1,1)===0,'open directory failed');
const dir=r32(P+0x800);const names=[];
for(let i=0;i<8;i++){const st=k('NtQueryDirectoryFile',dir,0,0,0,P+0x840,P+0xA00,0x100,0);if(st!==0){expect(st===0x80000006,`enumeration ended with 0x${st.toString(16)}`);break;}names.push(readAscii(P+0xA00+64,r32(P+0xA00+60)));}
expect(JSON.stringify(names.sort())===JSON.stringify(['Level1.dat','music.xma','sub']),`directory listing mismatch ${names}`);
ascii(P+0xB40,'*.xma');w16(P+0xB30,5);w16(P+0xB32,6);w32(P+0xB34,P+0xB40);
expect(k('NtQueryDirectoryFile',dir,0,0,0,P+0x840,P+0xA00,0x100,P+0xB30)===0&&readAscii(P+0xA00+64,9)==='music.xma','wildcard directory query mismatch');
expect(k('NtQueryVolumeInformationFile',dir,P+0x840,P+0xC00,32,5)===0&&readAscii(P+0xC00+12,4)==='GDFX','volume attribute name mismatch');
console.log('VFS_DIRECTORY_AND_VOLUME=PASS');

// A read the host cannot satisfy synchronously stops at an exact host-I/O boundary.
expect(k('NtOpenFile',P+0x800,0x80100000,attrs(P,'game:\\data\\music.xma'),P+0x810,1,0)===0,'music open failed');
k('NtReadFile',r32(P+0x800),0,0,0,P+0x820,P+0x1000,0x800,0);
expect(status()===5&&(need('r360_kernel_wait_reason')()>>>0)===4,'unavailable host bytes did not stop at a host-I/O would-block boundary');
const pending=need('r360_vfs_host_io_entry')()>>>0;const len=need('r360_vfs_entry_path')(pending)>>>0;
expect(Buffer.from(e.memory.buffer,pathBuffer,len).toString()==='data\\music.xma'&&(need('r360_vfs_host_io_length')()>>>0)===0x800,'host-I/O boundary did not name the file and length');
console.log('VFS_HOST_IO_BOUNDARY=PASS');

// --- Save data: XamContent packages as writable devices (Xenia ContentManager) ------
const xord=name=>{for(const [o,info] of XAM_EXPORTS)if(info.name===name)return o;throw new Error(name);};
const x=(name,...args)=>{const a=[...args,0,0,0,0,0,0,0,0].slice(0,8);return service(2,xord(name),...a)>>>0;};
const S=P+0x2000;
need('r360_kernel_service_set_caller')(0,0x82000100,P+0xF000);  // stack args live at r1+0x54
expect(x('XamContentGetDeviceData',1,S)===0&&r32(S)===1&&r32(S+4)===1&&readU16(S+24,9)==='Dummy HDD','XamContentGetDeviceData mismatch');
const listener=x('XamNotifyCreateListener',1,10);while(x('XNotifyGetNext',listener,0,S+0x60,S+0x64)===1){}
expect(x('XamShowDeviceSelectorUI',0,1,0,0,S+0x50,0)===0&&r32(S+0x50)===1,'device selector did not pick the HDD');
expect(x('XNotifyGetNext',listener,0,S+0x60,S+0x64)===1&&r32(S+0x60)===9&&r32(S+0x64)===1&&x('XNotifyGetNext',listener,0,S+0x60,S+0x64)===1&&r32(S+0x64)===0,'device selector did not bracket XN_SYS_UI on/off');
// XCONTENT_DATA {device 1, type 1 saved game, display "Braid Save", file "braidsave"}
const CD=S+0x100;for(let i=0;i<0x134;i++)w8(CD+i,0);w32(CD,1);w32(CD+4,1);
'Braid Save'.split('').forEach((c,i)=>w16(CD+8+i*2,c.charCodeAt(0)));ascii(CD+0x108,'braidsave');
ascii(S+0x240,'save');
expect(x('XamContentCreate',0,S+0x240,CD,3,S+0x250,S+0x254,0)===3,'OPEN_EXISTING on a missing package should be PATH_NOT_FOUND');
expect(x('XamContentCreate',0,S+0x240,CD,4,S+0x250,S+0x254,0)===0&&r32(S+0x250)===1,'OPEN_ALWAYS did not create the package');
const OVERWRITE_IF=5,CREATE=2;
const create=(path,disposition,options=0)=>k('NtCreateFile',P+0x800,0xC0100000,attrs(P,path),P+0x810,0,0x80,0,disposition)||0;
w32(P+0xF054,0x40);  // CreateOptions stack arg: FILE_NON_DIRECTORY_FILE
expect(create('save:\\Progress.dat',OVERWRITE_IF)===0&&r32(P+0x814)===2,'save file was not created');
const saveFile=r32(P+0x800);const payload=Buffer.from(Array.from({length:100},(_,i)=>(i*13+5)&255));
payload.forEach((b,i)=>w8(P+0x1000+i,b));
expect(k('NtWriteFile',saveFile,0,0,0,P+0x820,P+0x1000,100,0)===0&&r32(P+0x824)===100,'NtWriteFile to save failed');
expect(k('NtClose',saveFile)===0,'close save file');
expect(k('NtQueryFullAttributesFile',attrs(P,'save:\\progress.dat'),P+0x900)===0&&r64(P+0x900+40)===100n,'saved file size mismatch');
w32(P+0xF054,1);  // FILE_DIRECTORY_FILE
expect(create('save:\\slot1',CREATE)===0&&r32(P+0x814)===2,'save directory not created');k('NtClose',r32(P+0x800));
expect(k('NtQueryFullAttributesFile',attrs(P,'save:\\slot1'),P+0x900)===0&&(r32(P+0x900+48)&0x10)===0x10,'FILE_DIRECTORY_FILE did not create a directory');
w32(P+0xF054,0x40);expect(create('save:\\slot1\\inner.bin',CREATE)===0&&r32(P+0x814)===2,'file inside new directory not created');k('NtClose',r32(P+0x800));
w32(P+0xF054,0x40);
expect(create('save:\\missing\\x.dat',CREATE)===0xC000003A,'missing parent should be OBJECT_PATH_NOT_FOUND');
expect(k('NtOpenFile',P+0x800,0x80100000,attrs(P,'save:\\'),P+0x810,1,1)===0,'open save root');
w32(P+0xF054,0);  // 9th argument is RestartScan for NtQueryDirectoryFile
const root=r32(P+0x800);const saveNames=[];
for(let i=0;i<8;i++){const st=k('NtQueryDirectoryFile',root,0,0,0,P+0x840,P+0xA00,0x100,0);if(st)break;saveNames.push(readAscii(P+0xA00+64,r32(P+0xA00+60)));}
expect(JSON.stringify(saveNames.sort())===JSON.stringify(['Progress.dat','slot1']),`save root listing ${saveNames}`);
expect(!saveNames.includes('Level1.dat'),'save device leaked disc entries');
k('NtClose',root);
expect(x('XamContentDelete',0,CD,0)===5,'deleting an open package should be ACCESS_DENIED');
expect(x('XamContentClose',S+0x240,0)===0,'XamContentClose failed');
expect(k('NtOpenFile',P+0x800,0x80100000,attrs(P,'save:\\progress.dat'),P+0x810,1,0)===0xC000000F,'closed root still resolves');
expect(x('XamContentCreate',0,S+0x240,CD,1,S+0x250,S+0x254,0)===0xB7,'CREATE_NEW on an existing package should be ALREADY_EXISTS');
expect(x('XamContentCreate',0,S+0x240,CD,3,S+0x250,S+0x254,0)===0&&r32(S+0x250)===2,'OPEN_EXISTING did not reopen');
expect(k('NtOpenFile',P+0x800,0x80100000,attrs(P,'save:\\progress.dat'),P+0x810,1,0)===0,'reopened save file missing');
expect(k('NtReadFile',r32(P+0x800),0,0,0,P+0x820,P+0x1100,100,0)===0&&payload.every((b,i)=>r8(P+0x1100+i)===b),'save data did not persist across close/open');
k('NtClose',r32(P+0x800));
expect(x('XamContentCreateEnumerator',0,1,1,0,4,S+0x300,S+0x304)===0&&r32(S+0x300)===4*0x134,'content enumerator creation failed');
expect(x('XamEnumerate',r32(S+0x304),0,S+0x400,4*0x134,S+0x308,0)===0&&r32(S+0x308)===1&&readAscii(S+0x400+0x108,9)==='braidsave'&&r32(S+0x400)===1,'content enumeration mismatch');
expect(x('XamEnumerate',r32(S+0x304),0,S+0x400,4*0x134,S+0x308,0)===0x12,'exhausted enumerator should report NO_MORE_FILES');
expect(x('XamContentClose',S+0x240,0)===0&&x('XamContentDelete',0,CD,0)===0,'delete after close failed');
x('XamContentCreateEnumerator',0,1,1,0,4,S+0x300,S+0x304);expect(x('XamEnumerate',r32(S+0x304),0,S+0x400,4*0x134,S+0x308,0)===0x12,'deleted package still enumerated');
expect(x('XamContentGetLicenseMask',S+0x310,0)===0&&r32(S+0x310)===0,'default license mask should match Xenia (0)');
need('r360_xam_set_license_mask')(1);expect(x('XamContentGetLicenseMask',S+0x310,0)===0&&r32(S+0x310)===1,'license mask setter ignored');need('r360_xam_set_license_mask')(0);
console.log('XAM_CONTENT_SAVE_DATA=PASS');
console.log('KERNEL_VFS_CRITIC=PASS');
