import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`NtAllocateVirtualMemory bootstrap WASM not found: ${wasmPath}`);
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod)){
  if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){
    imports.env||={};
    imports.env.emscripten_notify_memory_growth=()=>{};
  }
}
const instance=await WebAssembly.instantiate(mod,imports);
wasi.initialize(instance);
const e=instance.exports;
const p=n=>e[n]??e[`_${n}`];
const need=n=>{const fn=p(n);if(typeof fn!=='function')throw new Error(`missing NtAllocateVirtualMemory fixture export ${n}`);return fn;};

const resetSparse=need('r360_sparse_guest_memory_reset');
const allocBacking=need('r360_sparse_guest_memory_alloc');
const map=need('r360_sparse_guest_memory_map');
const write32=need('r360_sparse_guest_memory_write_u32_be');
const read8=need('r360_sparse_guest_memory_read_u8');
const write8=need('r360_sparse_guest_memory_write_u8');
const mappedPages=need('r360_sparse_guest_memory_mapped_pages');
const runtimeReset=need('r360_kernel_runtime_reset');
const serviceReset=need('r360_kernel_service_reset');
const service=need('r360_kernel_service_call');
const serviceStatus=need('r360_kernel_service_status');

resetSparse();
runtimeReset();
serviceReset();

// One writable parameter page for the in/out BaseAddress and RegionSize cells.
const params=0x51000000;
const paramBacking=allocBacking(1)>>>0;
if(!paramBacking||(map(params,1,paramBacking,0,3)>>>0)!==1)throw new Error('unable to map NtAllocateVirtualMemory parameter page');
const basePtr=params+0x20;
const sizePtr=params+0x24;
if((write32(basePtr,0)>>>0)!==1||(write32(sizePtr,0x1234)>>>0)!==1)throw new Error('unable to initialize NtAllocateVirtualMemory arguments');

const readBe32=address=>((read8(address)<<<24)|(read8(address+1)<<<16)|(read8(address+2)<<<8)|read8(address+3))>>>0;

// X_MEM_RESERVE | X_MEM_COMMIT, X_PAGE_READWRITE, DebugMemory=FALSE.
const status=service(1,0x00CC,basePtr,sizePtr,0x3000,0x04,0,0,0,0)>>>0;
if(status!==0)throw new Error(`NtAllocateVirtualMemory returned NTSTATUS 0x${status.toString(16)}`);
if((serviceStatus()>>>0)!==1)throw new Error(`NtAllocateVirtualMemory service status ${serviceStatus()>>>0}`);

const base=readBe32(basePtr);
const size=readBe32(sizePtr);
if(base!==0x10000000)throw new Error(`unexpected first browser virtual allocation 0x${base.toString(16)}`);
if(size!==0x2000)throw new Error(`allocation size was not page-rounded: 0x${size.toString(16)}`);
if((mappedPages()>>>0)!==3)throw new Error(`expected parameter page + 2 allocated pages, got ${mappedPages()>>>0}`);
if((read8(base)>>>0)!==0)throw new Error('newly committed virtual memory was not zero initialized');
if((write8(base+0x1fff,0xA5)>>>0)!==1||(read8(base+0x1fff)>>>0)!==0xA5)throw new Error('allocated virtual memory is not read/write');

// A second automatic allocation must not alias the first one.
if((write32(basePtr,0)>>>0)!==1||(write32(sizePtr,0x1000)>>>0)!==1)throw new Error('unable to initialize second allocation arguments');
const status2=service(1,0x00CC,basePtr,sizePtr,0x3000,0x04,0,0,0,0)>>>0;
const base2=readBe32(basePtr);
if(status2!==0||base2!==0x10002000)throw new Error(`second allocation mismatch status=0x${status2.toString(16)} base=0x${base2.toString(16)}`);

// Guest API failures are NTSTATUS results, not an unsupported-service blocker.
if((write32(basePtr,0)>>>0)!==1||(write32(sizePtr,0)>>>0)!==1)throw new Error('unable to initialize invalid allocation arguments');
const invalid=service(1,0x00CC,basePtr,sizePtr,0x3000,0x04,0,0,0,0)>>>0;
if(invalid!==0xC000000D)throw new Error(`zero-size allocation should return STATUS_INVALID_PARAMETER, got 0x${invalid.toString(16)}`);
if((serviceStatus()>>>0)!==1)throw new Error('implemented NtAllocateVirtualMemory guest failure became an emulator blocker');

console.log('XBOXKRNL_ORDINAL_CC_NT_ALLOCATE_VIRTUAL_MEMORY=PASS');
console.log('NT_ALLOCATE_VIRTUAL_MEMORY_PAGE_ROUNDING=PASS');
console.log('NT_ALLOCATE_VIRTUAL_MEMORY_ZEROED_RW=PASS');
console.log('NT_ALLOCATE_VIRTUAL_MEMORY_NO_ALIAS=PASS');
console.log('NT_ALLOCATE_VIRTUAL_MEMORY_NTSTATUS_FAIL_CLOSED=PASS');
