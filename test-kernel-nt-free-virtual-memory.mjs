import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
if(!fs.existsSync(wasmPath))throw new Error(`NtFreeVirtualMemory bootstrap WASM not found: ${wasmPath}`);
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
const need=n=>{const fn=p(n);if(typeof fn!=='function')throw new Error(`missing NtFreeVirtualMemory fixture export ${n}`);return fn;};

const resetSparse=need('r360_sparse_guest_memory_reset');
const allocBacking=need('r360_sparse_guest_memory_alloc');
const map=need('r360_sparse_guest_memory_map');
const write32=need('r360_sparse_guest_memory_write_u32_be');
const read8=need('r360_sparse_guest_memory_read_u8');
const mappedPages=need('r360_sparse_guest_memory_mapped_pages');
const runtimeReset=need('r360_kernel_runtime_reset');
const serviceReset=need('r360_kernel_service_reset');
const service=need('r360_kernel_service_call');
const serviceStatus=need('r360_kernel_service_status');

resetSparse();
runtimeReset();
serviceReset();

const params=0x51000000;
const paramBacking=allocBacking(1)>>>0;
if(!paramBacking||(map(params,1,paramBacking,0,3)>>>0)!==1)throw new Error('unable to map NtFreeVirtualMemory parameter page');
const basePtr=params+0x20;
const sizePtr=params+0x24;
const readBe32=address=>((read8(address)<<24)|(read8(address+1)<<16)|(read8(address+2)<<8)|read8(address+3))>>>0;
const put32=(address,value)=>{if((write32(address,value>>>0)>>>0)!==1)throw new Error(`guest dword write failed @ 0x${address.toString(16)}`);};

function allocate(base,size,allocType=0x3000,protect=0x04){
  put32(basePtr,base>>>0);
  put32(sizePtr,size>>>0);
  const status=service(1,0x00CC,basePtr,sizePtr,allocType,protect,0,0,0,0)>>>0;
  if((serviceStatus()>>>0)!==1)throw new Error(`NtAllocateVirtualMemory service status ${serviceStatus()>>>0}`);
  return {status,base:readBe32(basePtr),size:readBe32(sizePtr)};
}
function free(base,size,freeType){
  put32(basePtr,base>>>0);
  put32(sizePtr,size>>>0);
  const status=service(1,0x00DC,basePtr,sizePtr,freeType,0,0,0,0,0)>>>0;
  if((serviceStatus()>>>0)!==1)throw new Error(`NtFreeVirtualMemory service status ${serviceStatus()>>>0}`);
  return {status,base:readBe32(basePtr),size:readBe32(sizePtr)};
}

const first=allocate(0,0x2345);
if(first.status!==0||first.base!==0x10000000||first.size!==0x3000)throw new Error(`initial allocation mismatch ${JSON.stringify(first)}`);
if((mappedPages()>>>0)!==4)throw new Error(`expected parameter page + 3 allocation pages, got ${mappedPages()>>>0}`);

// X_MEM_RELEASE: Xenia requires the region base, releases the whole reservation,
// writes the released region size back and leaves guest failures as NTSTATUS.
const released=free(first.base,0,0x8000);
if(released.status!==0||released.base!==first.base||released.size!==0x3000)throw new Error(`release mismatch ${JSON.stringify(released)}`);
if((mappedPages()>>>0)!==1)throw new Error(`release did not unmap committed pages: ${mappedPages()>>>0}`);

// The released virtual range must be reusable at the same fixed guest address.
const fixed=allocate(first.base,0x3000);
if(fixed.status!==0||fixed.base!==first.base||fixed.size!==0x3000)throw new Error(`fixed reallocation mismatch ${JSON.stringify(fixed)}`);
if((mappedPages()>>>0)!==4)throw new Error('fixed reallocation did not restore sparse mappings');

// X_MEM_DECOMMIT preserves the reservation while dropping its committed backing.
const decommitted=free(fixed.base,fixed.size,0x4000);
if(decommitted.status!==0||decommitted.base!==fixed.base||decommitted.size!==fixed.size)throw new Error(`decommit mismatch ${JSON.stringify(decommitted)}`);
if((mappedPages()>>>0)!==1)throw new Error(`decommit did not remove sparse backing: ${mappedPages()>>>0}`);
const recommitted=allocate(fixed.base,fixed.size,0x1000,0x04);
if(recommitted.status!==0||recommitted.base!==fixed.base||recommitted.size!==fixed.size)throw new Error(`recommit mismatch ${JSON.stringify(recommitted)}`);
if((mappedPages()>>>0)!==4)throw new Error('recommit did not remap the reserved range');
const releasedAgain=free(recommitted.base,0,0x8000);
if(releasedAgain.status!==0||(mappedPages()>>>0)!==1)throw new Error('second release failed');

const nullFree=free(0,0,0x8000);
if(nullFree.status!==0xC00000A0)throw new Error(`null free should return STATUS_MEMORY_NOT_ALLOCATED, got 0x${nullFree.status.toString(16)}`);
const unknownFree=free(0x12000000,0,0x8000);
if(unknownFree.status!==0xC0000001)throw new Error(`unknown reservation should return STATUS_UNSUCCESSFUL, got 0x${unknownFree.status.toString(16)}`);

console.log('XBOXKRNL_ORDINAL_DC_NT_FREE_VIRTUAL_MEMORY=PASS');
console.log('NT_FREE_VIRTUAL_MEMORY_RELEASE=PASS');
console.log('NT_FREE_VIRTUAL_MEMORY_RELEASE_SIZE_WRITEBACK=PASS');
console.log('NT_FREE_VIRTUAL_MEMORY_REUSE=PASS');
console.log('NT_FREE_VIRTUAL_MEMORY_DECOMMIT_RECOMMIT=PASS');
console.log('NT_FREE_VIRTUAL_MEMORY_NTSTATUS_FAIL_CLOSED=PASS');
