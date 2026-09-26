import fs from 'node:fs';
import {createRender360BrowserImports,attachRender360BrowserInstance,validateRender360BrowserImports} from './render360-browser-wasi.mjs';
import {XBOXKRNL_EXPORTS} from './render360-kernel-export-names.mjs';

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
console.log('KERNEL_VFS_CRITIC=PASS');
