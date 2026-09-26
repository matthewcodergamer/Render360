import fs from 'node:fs';
import {WASI} from 'node:wasi';
import crypto from 'node:crypto';
import {XBOXKRNL_EXPORTS,XAM_EXPORTS} from './render360-kernel-export-names.mjs';

// End-to-end critic for the native xboxkrnl/XAM service layer ported from
// Xenia (kernel_xboxkrnl_services.cpp). Every call goes through the same
// r360_kernel_service_call ABI the PPC import thunks use.

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`kernel services bootstrap WASM not found: ${wasmPath}`);
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{};}
}
const instance=await WebAssembly.instantiate(mod,imports);
wasi.initialize(instance);
const e=instance.exports;
const need=n=>{const fn=e[n]??e[`_${n}`];if(typeof fn!=='function')throw new Error(`missing kernel services export ${n}`);return fn;};

const byName=new Map();
for(const [ordinal,info] of XBOXKRNL_EXPORTS)byName.set(`xboxkrnl:${info.name}`,ordinal);
for(const [ordinal,info] of XAM_EXPORTS)byName.set(`xam:${info.name}`,ordinal);
const ord=(module,name)=>{const v=byName.get(`${module}:${name}`);if(v===undefined)throw new Error(`unknown export ${module}!${name}`);return v;};

const service=need('r360_kernel_service_call');
const serviceStatus=need('r360_kernel_service_status');
const setCaller=need('r360_kernel_service_set_caller');
const k=(name,...args)=>{const a=[...args,0,0,0,0,0,0,0,0].slice(0,8);return service(1,ord('xboxkrnl',name),...a)>>>0;};
const x=(name,...args)=>{const a=[...args,0,0,0,0,0,0,0,0].slice(0,8);return service(2,ord('xam',name),...a)>>>0;};
const status=()=>serviceStatus()>>>0;
const expect=(cond,message)=>{if(!cond)throw new Error(message);};
const ok=(value,name)=>{expect(status()===1,`${name} did not complete as an implemented service (status ${status()})`);return value;};

need('r360_sparse_guest_memory_reset')();
need('r360_kernel_runtime_reset')();
need('r360_kernel_service_reset')();
need('r360_kernel_services_reset')();
const alloc=need('r360_sparse_guest_memory_alloc');
const map=need('r360_sparse_guest_memory_map');
const w8=need('r360_sparse_guest_memory_write_u8');
const r8=need('r360_sparse_guest_memory_read_u8');
const mapPages=(address,pages)=>{const b=alloc(pages)>>>0;expect(b&&(map(address,pages,b,0,3)>>>0)===1,`unable to map 0x${address.toString(16)}`);};
const w32=(a,v)=>{for(let i=0;i<4;i++)expect((w8(a+i,(v>>>(24-8*i))&255)>>>0)===1,`write 0x${(a+i).toString(16)}`);};
const w16=(a,v)=>{w8(a,(v>>>8)&255);w8(a+1,v&255);};
const w64=(a,v)=>{w32(a,Number((BigInt.asUintN(64,v)>>32n)&0xFFFFFFFFn));w32(a+4,Number(BigInt.asUintN(64,v)&0xFFFFFFFFn));};
const r32=a=>((r8(a)<<24)|(r8(a+1)<<16)|(r8(a+2)<<8)|r8(a+3))>>>0;
const r16=a=>((r8(a)<<8)|r8(a+1))>>>0;
const r64=a=>(BigInt(r32(a))<<32n)|BigInt(r32(a+4));
const ascii=(a,text)=>{for(let i=0;i<text.length;i++)w8(a+i,text.charCodeAt(i));w8(a+text.length,0);};
const utf16=(a,text)=>{for(let i=0;i<text.length;i++)w16(a+i*2,text.charCodeAt(i));w16(a+text.length*2,0);};
const readAscii=(a,n)=>Array.from({length:n},(_,i)=>String.fromCharCode(r8(a+i))).join('');

// Scratch parameter pages and a fake primary thread (KPCR -> KTHREAD).
const P=0x51000000;mapPages(P,16);
const PCR=0x50000000,KTHREAD=0x50002000;mapPages(PCR,4);
w32(PCR+0x100,KTHREAD);w32(KTHREAD+0x14C,1);
setCaller(PCR,0x82000100,P+0xF000);

// Guest XEX header with the optional headers the services read.
const XEX=0x50010000;mapPages(XEX,2);
const headers=[[0x00030000,0x00000440],[0x00020200,0x00010000],[0x00020104,XEX+0x200-XEX],[0x00040006,XEX+0x240-XEX],[0x000002FF,XEX+0x280-XEX]];
ascii(XEX,'XEX2');w32(XEX+0x08,0x800);w32(XEX+0x14,headers.length);
headers.forEach(([key,value],i)=>{w32(XEX+0x18+i*8,key);w32(XEX+0x1C+i*8,value);});
// TLS info: 4 slots, raw template at XEX+0x300 (8 bytes), data size 0x10.
w32(XEX+0x200,4);w32(XEX+0x204,XEX+0x300);w32(XEX+0x208,0x10);w32(XEX+0x20C,8);
w32(XEX+0x300,0x11223344);w32(XEX+0x304,0x55667788);
// Execution info: title id at +0x0C.
w32(XEX+0x24C,0x58410A3E);
// Resource info: one "braidres" section.
w32(XEX+0x280,4+16);ascii(XEX+0x284,'braidres');w32(XEX+0x28C,0x82800000);w32(XEX+0x290,0x1234);
const HMODULE=0x50010F00;
expect((need('r360_kernel_set_executable_module')(HMODULE,XEX,0x50011000)>>>0)===1,'executable module install failed');
// Register the loader's primary thread like prepareBrowserMainThreadContext.
mapPages(0x70001000,16);
const main=need('r360_guest_thread_register_external')(0x82000000,0x70011000,0x70001000,PCR,KTHREAD,1)>>>0;
expect(main,'primary thread registration failed');
console.log('KERNEL_PRIMARY_THREAD_REGISTRATION=PASS');

// --- ExGetXConfigSetting ---------------------------------------------------------
w16(P+0x10,0xFFFF);
expect(ok(k('ExGetXConfigSetting',3,9,P,4,P+0x10),'ExGetXConfigSetting')===0&&r32(P)===1&&r16(P+0x10)===4,'XCONFIG_USER_LANGUAGE mismatch');
expect(k('ExGetXConfigSetting',3,0x0E,P,4,P+0x10)===0&&r8(P)===103&&r16(P+0x10)===1,'XCONFIG_USER_COUNTRY mismatch');
expect(k('ExGetXConfigSetting',3,9,P,2,P+0x10)===0xC0000023,'short buffer did not return STATUS_BUFFER_TOO_SMALL');
expect(k('ExGetXConfigSetting',9,1,P,4,0)===0xC00000EF,'unknown category did not return STATUS_INVALID_PARAMETER_1');
console.log('XCONFIG_SETTINGS_XENIA=PASS');

// --- Events ------------------------------------------------------------------------
const zeroTimeout=P+0x40;w64(zeroTimeout,0n);
expect(ok(k('NtCreateEvent',P+0x20,0,1,0),'NtCreateEvent')===0,'NtCreateEvent failed');
const syncEvent=r32(P+0x20);expect(((syncEvent&0xF8000000)>>>0)===0xF8000000,`unexpected event handle 0x${syncEvent.toString(16)}`);
expect(k('NtWaitForSingleObjectEx',syncEvent,1,0,zeroTimeout)===0x102,'unsignalled sync event did not time out');
expect(k('NtSetEvent',syncEvent,P+0x24)===0&&r32(P+0x24)===0,'NtSetEvent previous state mismatch');
expect(k('NtWaitForSingleObjectEx',syncEvent,1,0,zeroTimeout)===0,'signalled sync event wait failed');
expect(k('NtWaitForSingleObjectEx',syncEvent,1,0,zeroTimeout)===0x102,'synchronization event did not auto-reset');
k('NtWaitForSingleObjectEx',syncEvent,1,0,0);
expect(status()===5&&(need('r360_kernel_wait_handle')()>>>0)===syncEvent,'infinite wait on unsignalled event did not stop at would-block');
k('NtCreateEvent',P+0x28,0,0,1);const manual=r32(P+0x28);
expect(k('NtWaitForSingleObjectEx',manual,1,0,zeroTimeout)===0&&k('NtWaitForSingleObjectEx',manual,1,0,zeroTimeout)===0,'notification event did not stay signalled');
expect(k('NtClearEvent',manual)===0&&k('NtWaitForSingleObjectEx',manual,1,0,zeroTimeout)===0x102,'NtClearEvent did not reset');
// Relative timeout elapses as STATUS_TIMEOUT (no other thread can signal).
w64(P+0x48,-10000n);expect(k('NtWaitForSingleObjectEx',manual,1,0,P+0x48)===0x102&&status()===1,'bounded wait did not elapse');
// Pointer-based KEVENT.
const kevent=P+0x100;k('KeInitializeEvent',kevent,1,0);
expect(r8(kevent)===1&&r32(kevent+4)===0,'KeInitializeEvent layout mismatch');
expect(k('KeSetEvent',kevent,1,0)===0&&k('KeWaitForSingleObject',kevent,3,1,0,zeroTimeout)===0,'KeSetEvent/KeWaitForSingleObject failed');
// Wait-any returns the index of the signalled object.
w32(P+0x60,manual);w32(P+0x64,syncEvent);k('NtSetEvent',syncEvent,0);
expect(k('NtWaitForMultipleObjectsEx',2,P+0x60,1,1,0,zeroTimeout)===1,'wait-any did not return index 1');
console.log('KERNEL_EVENTS_AND_WAITS=PASS');

// --- Semaphores / mutants ---------------------------------------------------------
expect(k('NtCreateSemaphore',P+0x70,0,1,2)===0,'NtCreateSemaphore failed');const sem=r32(P+0x70);
expect(k('NtWaitForSingleObjectEx',sem,1,0,zeroTimeout)===0&&k('NtWaitForSingleObjectEx',sem,1,0,zeroTimeout)===0x102,'semaphore count mismatch');
expect(k('NtReleaseSemaphore',sem,1,P+0x74)===0&&r32(P+0x74)===0,'NtReleaseSemaphore failed');
expect(k('NtReleaseSemaphore',sem,2,P+0x74)===0xC0000047,'semaphore limit not enforced');
expect(k('NtCreateMutant',P+0x78,0,1)===0,'NtCreateMutant failed');const mutant=r32(P+0x78);
expect(k('NtWaitForSingleObjectEx',mutant,1,0,zeroTimeout)===0,'owner could not re-acquire mutant');
expect(k('NtReleaseMutant',mutant,0)===0&&k('NtReleaseMutant',mutant,0)===0,'recursive mutant release failed');
expect(k('NtReleaseMutant',mutant,0)===0xC0000046,'released mutant did not report MUTANT_NOT_OWNED');
expect(k('NtClose',mutant)===0&&k('NtClose',mutant)===0xC0000008,'NtClose handle lifetime mismatch');
console.log('KERNEL_SEMAPHORES_AND_MUTANTS=PASS');

// --- Critical sections ------------------------------------------------------------
const cs=P+0x200;k('RtlInitializeCriticalSectionAndSpinCount',cs,1000);
expect(r8(cs)===1&&r8(cs+1)===4&&r32(cs+0x10)===0xFFFFFFFF,'critical section initialization mismatch');
k('RtlEnterCriticalSection',cs);k('RtlEnterCriticalSection',cs);
expect(r32(cs+0x18)===KTHREAD&&r32(cs+0x14)===2&&r32(cs+0x10)===1,'recursive enter mismatch');
k('RtlLeaveCriticalSection',cs);k('RtlLeaveCriticalSection',cs);
expect(r32(cs+0x18)===0&&r32(cs+0x10)===0xFFFFFFFF,'critical section not released');
expect(k('RtlTryEnterCriticalSection',cs)===1,'RtlTryEnterCriticalSection failed');
w32(PCR+0x100,0x50003000);
expect(k('RtlTryEnterCriticalSection',cs)===0,'other thread acquired owned critical section');
k('RtlEnterCriticalSection',cs);expect(status()===5,'contended critical section did not stop at would-block');
w32(PCR+0x100,KTHREAD);k('RtlLeaveCriticalSection',cs);
console.log('KERNEL_CRITICAL_SECTIONS=PASS');

// --- Pool / physical memory ------------------------------------------------------
const pool=ok(k('ExAllocatePoolTypeWithTag',100,0x52333630,0),'ExAllocatePoolTypeWithTag');
expect(pool>=0x5A000000&&pool<0x5F000000,`pool block outside arena 0x${pool.toString(16)}`);
expect(k('ExQueryPoolBlockSize',pool)===0x1000,'pool block not rounded to 4 KiB like Xenia');
w32(pool,0xDEADBEEF);expect(r32(pool)===0xDEADBEEF,'pool block not writable');
k('ExFreePool',pool);const reused=k('ExAllocatePool',64);expect(reused<=pool&&reused>=pool-0x100,`freed pool space was not reused (0x${reused.toString(16)} vs 0x${pool.toString(16)})`);
const phys=ok(k('MmAllocatePhysicalMemoryEx',0,0x20000,0x20000004,0,0xFFFFFFFF,0x10000),'MmAllocatePhysicalMemoryEx');
expect(phys>=0xA0000000&&phys<0xC0000000&&(phys&0xFFFF)===0,`64 KiB physical allocation not in vA0000000 view: 0x${phys.toString(16)}`);
expect(phys===0xBFFE0000,`physical allocation not top-down: 0x${phys.toString(16)}`);
w32(phys+0x1FFFC,0x0BADF00D);expect(r32(phys+0x1FFFC)===0x0BADF00D,'physical memory not mapped');
expect(k('MmQueryAllocationSize',phys)===0x20000,'MmQueryAllocationSize mismatch');
const small=k('MmAllocatePhysicalMemoryEx',0,0x100,0x04,0,0xFFFFFFFF,0);
expect(small>=0xE0000000,`4 KiB physical allocation not in vE0000000 view: 0x${small.toString(16)}`);
expect(k('MmAllocatePhysicalMemoryEx',0,0x1000,0x01,0,0xFFFFFFFF,0)===0,'NOACCESS physical allocation should fail like Xenia');
k('MmFreePhysicalMemory',0,phys);expect(k('MmQueryAllocationSize',phys)===0,'MmFreePhysicalMemory did not release');
w32(P+0x300,104);expect(k('MmQueryStatistics',P+0x300)===0&&r32(P+0x304)===0x20000,'MmQueryStatistics mismatch');
console.log('KERNEL_POOL_AND_PHYSICAL_MEMORY=PASS');

// --- Time ---------------------------------------------------------------------------
k('KeQuerySystemTime',P+0x400);
const unixMs=Number((r64(P+0x400)-116444736000000000n)/10000n);
expect(Math.abs(unixMs-Date.now())<60000,'KeQuerySystemTime is not current FILETIME');
const known=BigInt(Date.UTC(2020,0,2,3,4,5,6))*10000n+116444736000000000n;
w64(P+0x410,known);k('RtlTimeToTimeFields',P+0x410,P+0x420);
const fields=[0,2,4,6,8,10,12,14].map(o=>r16(P+0x420+o));
expect(JSON.stringify(fields)===JSON.stringify([2020,1,2,3,4,5,6,4]),`RtlTimeToTimeFields mismatch ${fields}`);
expect(k('RtlTimeFieldsToTime',P+0x420,P+0x430)===1&&r64(P+0x430)===known,'RtlTimeFieldsToTime round trip failed');
w16(P+0x422,13);expect(k('RtlTimeFieldsToTime',P+0x420,P+0x430)===0,'invalid month accepted');
console.log('KERNEL_TIME_CONVERSION=PASS');

// --- Strings / memory ---------------------------------------------------------------
ascii(P+0x500,'game:\\braid.dat');k('RtlInitAnsiString',P+0x540,P+0x500);
expect(r16(P+0x540)===15&&r16(P+0x542)===16&&r32(P+0x544)===P+0x500,'RtlInitAnsiString mismatch');
utf16(P+0x600,'Tim');k('RtlInitUnicodeString',P+0x640,P+0x600);
expect(r16(P+0x640)===6&&r16(P+0x642)===8,'RtlInitUnicodeString mismatch');
expect(k('RtlUnicodeStringToAnsiString',P+0x650,P+0x640,1)===0&&readAscii(r32(P+0x654),3)==='Tim','RtlUnicodeStringToAnsiString mismatch');
k('RtlMultiByteToUnicodeN',P+0x700,8,P+0x710,P+0x500,3);
expect(r16(P+0x700)===0x67&&r32(P+0x710)===6,'RtlMultiByteToUnicodeN mismatch');
ascii(P+0x720,'BRAID');ascii(P+0x730,'braid!');
expect(k('RtlCompareStringN',P+0x720,5,P+0x730,5,1)===0,'case-insensitive RtlCompareStringN mismatch');
expect(k('RtlNtStatusToDosError',0xC0000034)===2&&k('RtlNtStatusToDosError',0xC000000D)===0x57&&k('RtlNtStatusToDosError',0x80070005)===5,'RtlNtStatusToDosError table mismatch');
k('RtlFillMemoryUlong',P+0x800,16,0xA5A5A5A5);expect(k('RtlCompareMemoryUlong',P+0x800,16,0xA5A5A5A5)===4,'RtlFill/CompareMemoryUlong mismatch');
// SList
w32(P+0x900,0);w32(P+0x904,0);
k('InterlockedPushEntrySList',P+0x900,P+0x910);k('InterlockedPushEntrySList',P+0x900,P+0x920);
expect(r16(P+0x904)===2&&k('InterlockedPopEntrySList',P+0x900)===P+0x920&&k('InterlockedFlushSList',P+0x900)===P+0x910,'SList semantics mismatch');
console.log('KERNEL_RTL_STRINGS_AND_SLIST=PASS');

// --- Modules --------------------------------------------------------------------
expect(k('XexCheckExecutablePrivilege',6)===1&&k('XexCheckExecutablePrivilege',10)===1&&k('XexCheckExecutablePrivilege',7)===0,'XexCheckExecutablePrivilege mismatch');
expect(k('XexGetModuleHandle',0,P+0xA00)===0&&r32(P+0xA00)===HMODULE,'XexGetModuleHandle(NULL) mismatch');
ascii(P+0xA10,'xam.xex');expect(k('XexGetModuleHandle',P+0xA10,P+0xA00)===0&&r32(P+0xA00)!==0,'XexGetModuleHandle(xam.xex) mismatch');
ascii(P+0xA20,'xbdm.xex');expect(k('XexGetModuleHandle',P+0xA20,P+0xA00)===0x490&&r32(P+0xA00)===0,'XexGetModuleHandle(xbdm.xex) should be NOT_FOUND');
ascii(P+0xA30,'braidres');expect(k('XexGetModuleSection',HMODULE,P+0xA30,P+0xA40,P+0xA44)===0&&r32(P+0xA40)===0x82800000&&r32(P+0xA44)===0x1234,'XexGetModuleSection mismatch');
console.log('KERNEL_XEX_MODULE_QUERIES=PASS');

// --- Threads -------------------------------------------------------------------
const createStatus=k('ExCreateThread',P+0xB00,0,P+0xB04,0x82001000,0x82002000,0xCAFE0000,1);
expect(createStatus===0,`ExCreateThread failed 0x${createStatus.toString(16)}`);
const threadHandle=r32(P+0xB00);expect(r32(P+0xB04)===2,'second thread id should be 2');
expect(need('r360_kernel_object_count')()>=1,'thread object missing');
const threadObject=(()=>{w32(P+0xB10,0);k('ObReferenceObjectByHandle',threadHandle,0xD01BBEEF,P+0xB10);return r32(P+0xB10);})();
expect(threadObject>=0x5A000000&&r8(threadObject)===6,'KTHREAD dispatcher header missing');
expect(r32(threadObject+0x150)===0x82002000&&r32(threadObject+0x14C)===2&&r8(threadObject+0xBC)===1,'KTHREAD fields mismatch');
const native=need('r360_guest_thread_find_by_kthread')(threadObject)>>>0;
expect(native&&(need('r360_guest_thread_arg1')(native)>>>0)===0xCAFE0000&&(need('r360_guest_thread_entry')(native)>>>0)===0x82001000,'XapiThreadStartup trampoline arguments mismatch');
const threadPcr=need('r360_guest_thread_pcr')(native)>>>0;
expect(threadPcr&&r32(threadPcr+0x100)===threadObject&&r32(threadPcr+0x30)===threadPcr,'thread KPCR mismatch');
const threadTls=r32(threadPcr);expect(r32(threadTls)===0x11223344&&r32(threadTls+4)===0x55667788,'TLS template not copied');
expect((need('r360_guest_thread_state')(native)>>>0)===3,'CREATE_SUSPENDED thread was not suspended');
expect(k('NtResumeThread',threadHandle,P+0xB20)===0&&r32(P+0xB20)===1,'NtResumeThread previous count mismatch');
expect(k('NtWaitForSingleObjectEx',threadHandle,1,0,zeroTimeout)===0x102,'running thread handle should not be signalled');
expect(k('KeSetAffinityThread',threadObject,4,P+0xB30)===0&&r32(P+0xB30)===1,'KeSetAffinityThread mismatch');
expect(k('ObReferenceObjectByHandle',threadHandle,0xD00EBEEF,P+0xB10)===0xC0000024,'object type mismatch not reported');
// Pseudo-handle -2 is the current thread.
expect(k('NtDuplicateObject',0xFFFFFFFE,P+0xB40,0)===0&&r32(P+0xB40)!==0,'NtDuplicateObject(current thread) failed');
console.log('KERNEL_THREAD_CREATION_XENIA=PASS');

// --- XAM ------------------------------------------------------------------------
expect(ok(x('XamUserGetSigninState',0),'XamUserGetSigninState')===1&&x('XamUserGetSigninState',1)===0,'sign-in state mismatch');
expect(x('XamUserGetXUID',0,1,P+0xC00)===0&&r64(P+0xC00)===0xB13EBABEBABEBABEn,'XamUserGetXUID mismatch');
expect(x('XGetAVPack')===6&&x('XGetGameRegion')===0xFFFF,'XAM info mismatch');
x('XGetVideoMode',P+0xC10);expect(r32(P+0xC10)===1280&&r32(P+0xC14)===720,'XGetVideoMode mismatch');
expect(x('XamGetExecutionId',P+0xC50)===0&&r32(P+0xC50)===XEX+0x240,'XamGetExecutionId mismatch');
expect(x('XamGetCurrentTitleId')===0x58410A3E,'XamGetCurrentTitleId mismatch');
need('r360_input_set_gamepad')(0,1,0x1000,0x80FF,(0x7FFF&0xFFFF)|((-0x8000&0xFFFF)<<16),0);
expect(x('XamInputGetState',0,1,P+0xC80)===0&&r16(P+0xC84)===0x1000&&r8(P+0xC86)===0xFF&&r8(P+0xC87)===0x80,'XamInputGetState buttons/triggers mismatch');
expect(r16(P+0xC88)===0x7FFF&&r16(P+0xC8A)===0x8000&&r32(P+0xC80)===1,'XamInputGetState thumbs/packet mismatch');
expect(x('XamInputGetState',1,1,P+0xC80)===0x48F,'disconnected pad not reported');
expect(x('XamInputGetCapabilities',0,1,P+0xCA0)===0&&r8(P+0xCA0)===1,'XamInputGetCapabilities mismatch');
console.log('XAM_USER_INPUT_INFO=PASS');

// --- Crypto (Xenia xboxkrnl_crypt.cc) against reference implementations ----------
const Q=0x51008000;
const put=(a,bytes)=>{for(let i=0;i<bytes.length;i++)w8(a+i,bytes[i]);};
const get=(a,n)=>Buffer.from(Array.from({length:n},(_,i)=>r8(a+i)));
const msg=Buffer.from(Array.from({length:150},(_,i)=>(i*37+11)&255));put(Q+0x100,msg);
k('XeCryptShaInit',Q);k('XeCryptShaUpdate',Q,Q+0x100,70);k('XeCryptShaUpdate',Q,Q+0x100+70,80);ok(k('XeCryptShaFinal',Q,Q+0x300,20),'XeCryptShaFinal');
expect(get(Q+0x300,20).equals(crypto.createHash('sha1').update(msg).digest()),'SHA-1 init/update/final mismatch');
k('XeCryptSha',Q+0x100,100,Q+0x100+100,50,0,0,Q+0x320,20);
expect(get(Q+0x320,20).equals(crypto.createHash('sha1').update(msg).digest()),'XeCryptSha one-shot mismatch');
k('XeCryptSha256Init',Q+0x400);k('XeCryptSha256Update',Q+0x400,Q+0x100,1);k('XeCryptSha256Update',Q+0x400,Q+0x100+1,149);k('XeCryptSha256Final',Q+0x400,Q+0x340,32);
expect(get(Q+0x340,32).equals(crypto.createHash('sha256').update(msg).digest()),'SHA-256 mismatch');
const hmacKey=Buffer.from(Array.from({length:16},(_,i)=>0xA0+i));put(Q+0x480,hmacKey);
w32(P+0xF054,Q+0x360);w32(P+0xF05C,20);
ok(k('XeCryptHmacSha',Q+0x480,16,Q+0x100,40,Q+0x100+40,60,Q+0x100+100,50),'XeCryptHmacSha');
expect(get(Q+0x360,20).equals(crypto.createHmac('sha1',hmacKey).update(msg).digest()),'HMAC-SHA1 mismatch');
const longKey=Buffer.from(Array.from({length:100},(_,i)=>i));put(Q+0x500,longKey);
k('XeCryptHmacSha',Q+0x500,100,Q+0x100,150,0,0,0,0);
expect(get(Q+0x360,20).equals(crypto.createHmac('sha1',longKey).update(msg).digest()),'HMAC-SHA1 long-key mismatch');
const rc4=(key,data)=>{const S=[...Array(256).keys()];let j=0;for(let i=0;i<256;i++){j=(j+S[i]+key[i%key.length])&255;[S[i],S[j]]=[S[j],S[i]];}let i=0;j=0;return Buffer.from(data.map(b=>{i=(i+1)&255;j=(j+S[i])&255;[S[i],S[j]]=[S[j],S[i]];return b^S[(S[i]+S[j])&255];}));};
put(Q+0x600,msg.subarray(0,64));k('XeCryptRc4Key',Q+0x700,Q+0x480,16);k('XeCryptRc4Ecb',Q+0x700,Q+0x600,20);k('XeCryptRc4Ecb',Q+0x700,Q+0x600+20,44);
expect(get(Q+0x600,64).equals(rc4([...hmacKey],[...msg.subarray(0,64)])),'RC4 keyed stream mismatch');
k('XeCryptRc4',Q+0x480,16,Q+0x600,64);expect(get(Q+0x600,64).equals(msg.subarray(0,64)),'XeCryptRc4 round trip mismatch');
k('XeCryptRandom',Q+0x800,9);expect(get(Q+0x800,9).every(b=>b===0xFD),'XeCryptRandom is not Xenia deterministic 0xFD');
console.log('KERNEL_CRYPTO_XENIA=PASS');

// --- Memory, stacks, modules --------------------------------------------------------
w32(P+0x100,0);w32(P+0x104,0x3000);
expect(k('NtAllocateVirtualMemory',P+0x100,P+0x104,0x3000,0x04,0)===0,'NtAllocateVirtualMemory for protect test');
const vbase=r32(P+0x100);w32(P+0x108,vbase+0x10);w32(P+0x10C,0x1000);
expect(ok(k('NtProtectVirtualMemory',P+0x108,P+0x10C,0x02,P+0x110,0),'NtProtectVirtualMemory')===0&&r32(P+0x108)===vbase&&r32(P+0x10C)===0x2000&&r32(P+0x110)===0x04,'NtProtectVirtualMemory rounding/old protect mismatch');
expect((w8(vbase+4,1)>>>0)===0,'read-only protection did not block writes');
w32(P+0x108,vbase);w32(P+0x10C,0x1000);expect(k('NtProtectVirtualMemory',P+0x108,P+0x10C,0x04,P+0x110,0)===0&&r32(P+0x110)===0x02&&(w8(vbase+4,1)>>>0)===1,'restoring old protection failed');
expect(k('NtProtectVirtualMemory',P+0x108,P+0x10C,0x40,P+0x110,0)===0xC0000022,'execute protection not refused');
const kstack=ok(k('MmCreateKernelStack',0x4000,0),'MmCreateKernelStack');
expect(kstack>=0x78004000&&kstack<0x7F000000&&(w8(kstack-4,1)>>>0)===1,'kernel stack not mapped');
expect(k('MmDeleteKernelStack',kstack,kstack-0x4000)===0&&(w8(kstack-4,1)>>>0)===0,'MmDeleteKernelStack did not release');
const PE=0x51009000;w8(PE,0x4D);w8(PE+1,0x5A);w8(PE+0x3C,0x80);put(PE+0x80,[0x50,0x45,0,0]);
expect(k('RtlImageNtHeader',PE)===PE+0x80&&k('RtlImageNtHeader',PE+1)===0,'RtlImageNtHeader mismatch');
w32(P+0x120,0x82001000);w32(P+0x124,5);expect(ok(k('ExRegisterTitleTerminateNotification',P+0x120,1),'ExRegisterTitleTerminateNotification')===0,'ExRegisterTitleTerminateNotification failed');
ok(k('KeSetCurrentStackPointers',0x70100000,KTHREAD,0x70000000,0x70100000,0x700F0000),'KeSetCurrentStackPointers');
expect(r32(KTHREAD+0x5C)===0x70100000&&r32(KTHREAD+0x60)===0x700F0000&&r32(KTHREAD+0xD0)===0x70000000&&r32(PCR+0x70)===0x70100000,'KeSetCurrentStackPointers did not update KTHREAD/KPCR');
console.log('KERNEL_MEMORY_STACKS_MODULES_XENIA=PASS');

// --- XAM profile, locale, launch data, networking ------------------------------------
w32(P+0x200,0x10040003);w32(P+0x204,0x4064000F);w32(P+0x208,0x63E83FFF);w32(P+0x20C,0);
expect(ok(x('XamUserReadProfileSettings',0,0,0,0,3,P+0x200,P+0x20C,0),'XamUserReadProfileSettings')===0x7A,'profile size query did not report insufficient buffer');
const need2=r32(P+0x20C);expect(need2===8+3*40+(0x064+0x3E8),`profile needed size ${need2}`);
const PB=0x5100A000;expect(x('XamUserReadProfileSettings',0,0,0,0,3,P+0x200,P+0x20C,PB)===0,'profile read failed');
expect(r32(PB)===3&&r32(PB+4)===PB+8&&r32(PB+8)===1&&r32(PB+8+16)===0x10040003&&r8(PB+8+24)===1&&r32(PB+8+32)===3,'vibration setting mismatch');
const pic=PB+8+40;expect(r8(pic+24)===4&&r32(pic+32)===44&&r16(r32(pic+36))==='g'.charCodeAt(0),'gamercard picture key setting mismatch');
expect(r32(PB+8+80)===0&&r8(PB+8+80+24)===0,'unset title-specific setting should report from=0');
w32(P+0x240,0);w32(P+0x244,0);w32(P+0x248,0);w32(P+0x24C,0);w32(P+0x250,0x63E83FFF);w32(P+0x254,0);w8(P+0x258,6);w32(P+0x260,4);w32(P+0x264,P+0x280);w32(P+0x280,0xDEADBEEF);
expect(x('XamUserWriteProfileSettings',0,0,1,P+0x240,0)===0,'XamUserWriteProfileSettings failed');
w32(P+0x20C,need2);expect(x('XamUserReadProfileSettings',0,0,0,0,3,P+0x200,P+0x20C,PB)===0&&r32(PB+8+80)===2&&r32(PB+8+80+32)===4&&r32(r32(PB+8+80+36))===0xDEADBEEF,'written title-specific setting not read back');
expect(x('XamGetLocale')===36&&x('XamUserGetMembershipTier',0)===6&&x('XamUserIsOnlineEnabled',0)===1,'XAM locale/membership mismatch');
expect(x('XamUserGetGamerTag',0,P+0x300,16)===0&&r16(P+0x300)===0x55&&r16(P+0x306)===0x72&&r16(P+0x308)===0,'gamertag mismatch');
put(P+0x320,[1,2,3]);x('XamLoaderSetLaunchData',P+0x320,3);expect(x('XamLoaderGetLaunchDataSize',P+0x330)===0&&r32(P+0x330)===3,'launch data size mismatch');
expect(x('NetDll_WSAStartup',0,0x0202,P+0x400)===0&&r16(P+0x400)===0x0202&&r16(P+0x586)===100,'WSAStartup mismatch');
expect(x('NetDll_XNetGetTitleXnAddr',0,P+0x600)===4&&r32(P+0x600)===0x7F000001&&r8(P+0x60A)===0xCC,'XNetGetTitleXnAddr mismatch');
expect(ok(x('NetDll_XNetStartup',0,0),'NetDll_XNetStartup')===0&&x('NetDll_XNetGetEthernetLinkStatus',0)===0,'XNet startup/link mismatch');
console.log('XAM_PROFILE_LOCALE_NET_XENIA=PASS');

// --- XMA context registers (Xenia xboxkrnl_audio_xma.cc) --------------------------
expect(k('XMACreateContext',P+0x700)===0,'XMACreateContext for register test');
const xctx=r32(P+0x700);expect(k('XMAIsInputBuffer0Valid',xctx)===0&&k('XMAIsInputBuffer1Valid',xctx)===0,'fresh XMA context should have no valid buffers');
const XI=P+0x740;[0x51001000,4,0,0,0x80,0x51002000,8,0,2,2,1].forEach((v,i)=>w32(XI+i*4,v));w32(XI+44,0x100);w32(XI+48,0x2000);w8(XI+52,3);w8(XI+53,1);w8(XI+54,2);
expect(ok(k('XMAInitializeContext',xctx,XI),'XMAInitializeContext')===0,'XMAInitializeContext failed');
expect(r32(xctx+20)===0x51001000&&r32(xctx+28)===0x51002000&&k('XMAGetInputBufferReadOffset',xctx)===0x80,'XMA init pointers/read offset mismatch');
expect(((r32(xctx)&0xFFF)===4)&&(((r32(xctx)>>>12)&0xFF)===3)&&(((r32(xctx)>>>22)&31)===8),'XMA dword0 bitfields mismatch');
expect((((r32(xctx+4)>>>20)&15)===2)&&(((r32(xctx+4)>>>27)&3)===1)&&(((r32(xctx+4)>>>29)&1)===1)&&(r32(xctx+12)&0x3FFFFFF)===0x100,'XMA dword1/loop bitfields mismatch');
k('XMASetInputBuffer1',xctx,0x51003000,6);k('XMASetInputBuffer0Valid',xctx);k('XMASetOutputBufferValid',xctx);
expect(k('XMAIsInputBuffer0Valid',xctx)===1&&k('XMAIsOutputBufferValid',xctx)===1&&r32(xctx+24)===0x51003000&&(r32(xctx+4)&0xFFF)===6,'XMA buffer set/valid mismatch');
k('XMASetOutputBufferReadOffset',xctx,7);expect(k('XMAGetOutputBufferReadOffset',xctx)===7,'XMA output read offset mismatch');
expect(k('XMAEnableContext',xctx)===0&&k('XMADisableContext',xctx,0)===0,'XMA enable/disable failed');
k('XMABlockWhileInUse',xctx);expect(status()===5&&(need('r360_kernel_wait_reason')()>>>0)===5,'XMABlockWhileInUse with valid buffers should be a named decoder wait');
console.log('KERNEL_XMA_CONTEXT_XENIA=PASS');

// --- Notification listeners (Xenia XNotifyListener startup queue) -------------------
const liveOnly=x('XamNotifyCreateListener',0x2,10);expect(liveOnly>=0xF8000000,'listener handle is not a kernel object handle');
const sys=x('XamNotifyCreateListener',0x1,10);
w64(P+0x8F0,0n);expect(k('NtWaitForSingleObjectEx',sys,1,0,P+0x8F0)===0,'listener with queued notifications should be signalled');
expect(k('NtWaitForSingleObjectEx',liveOnly,1,0,P+0x8F0)===0x102,'listener without notifications should time out');
expect(x('XNotifyGetNext',sys,0x0A,P+0x900,P+0x904)===1&&r32(P+0x900)===0x0A&&r32(P+0x904)===1,'match-id dequeue of XN_SYS_SIGNINCHANGED failed');
const seen=[];while(x('XNotifyGetNext',sys,0,P+0x900,P+0x904)===1)seen.push(`${r32(P+0x900).toString(16)}:${r32(P+0x904)}`);
expect(JSON.stringify(seen)===JSON.stringify(['9:1','9:0','a:1','12:0','12:0','13:0','13:0']),`startup notification order ${seen}`);
expect(k('NtWaitForSingleObjectEx',sys,1,0,P+0x8F0)===0x102,'drained listener should reset its event');
const second=x('XamNotifyCreateListener',0x1,10);expect(x('XNotifyGetNext',second,0,P+0x900,P+0x904)===0&&r32(P+0x900)===0,'startup notifications must only go to the first system listener');
console.log('XAM_NOTIFY_LISTENER_XENIA=PASS');

// --- Diagnostics / boundaries ------------------------------------------------------
ascii(P+0xD00,'Braid: hello from DbgPrint');k('DbgPrint',P+0xD00);
const logOut=need('r360_kernel_pool_alloc')(64,16)>>>0;
expect((need('r360_kernel_debug_log_count')()>>>0)>=1,'DbgPrint was not captured');
k('HalReturnToFirmware',1);
expect(status()===4&&(need('r360_kernel_terminal_kind')()>>>0)===1&&(need('r360_kernel_terminal_code')()>>>0)===1,'HalReturnToFirmware did not stop at a terminal boundary');
expect((need('r360_kernel_terminal_lr')()>>>0)===0x82000100,'terminal boundary did not record caller LR');
w32(P+0xE00,0x82400000);w32(P+0xE04,0xCAFE);expect(k('XAudioRegisterRenderDriverClient',P+0xE00,P+0xE10)===0&&r32(P+0xE10)===0x41550000,'XAudioRegisterRenderDriverClient mismatch');
expect((need('r360_audio_client_callback')(0)>>>0)===0x82400000&&(need('r360_audio_client_callback_arg')(0)>>>0)===0xCAFE,'audio client callback not recorded');
expect(k('XAudioSubmitRenderDriverFrame',0x41550000,P+0xE20)===0&&(need('r360_audio_client_frames')(0)>>>0)===1,'audio frame submission not counted');
expect(k('XMACreateContext',P+0xE30)===0&&r32(P+0xE30)>=0xA0000000,'XMACreateContext mismatch');
k('XeCryptAesKey',P+0xE40,P+0xE80);expect(status()===2,'unimplemented XeCryptAesKey did not fail closed');
expect(logOut>=0x5A000000,'pool alloc export mismatch');
console.log('KERNEL_TERMINAL_AND_FAIL_CLOSED=PASS');
console.log('KERNEL_XBOXKRNL_SERVICES_CRITIC=PASS');
