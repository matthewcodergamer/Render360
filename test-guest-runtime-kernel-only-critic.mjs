import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/kernel-runtime/kernel_runtime.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);
const e=instance.exports;const pick=n=>e[n]??e[`_${n}`];

const required=[
  'r360_kernel_runtime_reset','r360_guest_thread_create','r360_guest_thread_current',
  'r360_guest_thread_set_current','r360_guest_thread_suspend','r360_guest_thread_resume',
  'r360_guest_thread_terminate','r360_guest_thread_next_runnable','r360_guest_thread_state',
  'r360_guest_thread_exit_code','r360_guest_thread_entry','r360_guest_thread_context',
  'r360_guest_thread_flags','r360_guest_thread_stack_size','r360_guest_thread_stack_base',
  'r360_guest_thread_stack_top','r360_guest_thread_stack_mapped','r360_guest_runtime_status',
  'r360_guest_tls_alloc','r360_guest_tls_free','r360_guest_tls_set','r360_guest_tls_get',
  'r360_sparse_guest_memory_read_u8','r360_sparse_guest_memory_write_u8',
  'r360_sparse_guest_memory_last_fault_code'
];
for(const n of required)if(typeof pick(n)!=='function')throw new Error(`missing kernel-only runtime critic export ${n}`);

pick('r360_kernel_runtime_reset')();
const a=pick('r360_guest_thread_create')(0x82001000,0x1111,1,0xA5)>>>0;
const b=pick('r360_guest_thread_create')(0x82002000,0x2222,0x5000,0x5A)>>>0;
const d=pick('r360_guest_thread_create')(0x82002500,0,0,0)>>>0;
if(!a||!b||!d||a===b)throw new Error('thread creation/identity failed');
if((pick('r360_guest_thread_stack_size')(a)>>>0)!==0x4000)throw new Error('minimum stack alignment failed');
if((pick('r360_guest_thread_stack_size')(b)>>>0)!==0x8000)throw new Error('requested stack alignment failed');
if((pick('r360_guest_thread_stack_size')(d)>>>0)!==0x40000)throw new Error('default guest stack is not 256 KiB');

const stackBase=pick('r360_guest_thread_stack_base')(a)>>>0;
const stackSize=pick('r360_guest_thread_stack_size')(a)>>>0;
const stackTop=pick('r360_guest_thread_stack_top')(a)>>>0;
if(!stackBase||!stackTop||(stackTop&15)||stackTop<=stackBase||stackTop>=stackBase+stackSize)throw new Error('invalid PPC r1 stack seed');
if((pick('r360_guest_thread_stack_mapped')(a)>>>0)!==1)throw new Error('stack mapping telemetry failed');
if((pick('r360_sparse_guest_memory_write_u8')(stackBase,0x7B)>>>0)!==1||(pick('r360_sparse_guest_memory_read_u8')(stackBase)>>>0)!==0x7B)throw new Error('usable stack memory is inaccessible');
if((pick('r360_sparse_guest_memory_write_u8')((stackBase-1)>>>0,0x55)>>>0)!==0||(pick('r360_sparse_guest_memory_last_fault_code')()>>>0)!==1)throw new Error('lower guard page is not unmapped');
if((pick('r360_sparse_guest_memory_write_u8')((stackBase+stackSize)>>>0,0x56)>>>0)!==0||(pick('r360_sparse_guest_memory_last_fault_code')()>>>0)!==1)throw new Error('upper guard page is not unmapped');
console.log('KERNEL_ONLY_GUEST_STACK_DEFAULT_256K=PASS');
console.log('KERNEL_ONLY_GUEST_STACK_GUARDS=PASS');

const slot=pick('r360_guest_tls_alloc')()>>>0;if(slot===0xFFFFFFFF)throw new Error('TLS alloc failed');
if(!(pick('r360_guest_tls_set')(a,slot,0x11112222)>>>0)||!(pick('r360_guest_tls_set')(b,slot,0x33334444)>>>0))throw new Error('TLS set failed');
if((pick('r360_guest_tls_get')(a,slot)>>>0)!==0x11112222||(pick('r360_guest_tls_get')(b,slot)>>>0)!==0x33334444)throw new Error('TLS isolation failed');
if((pick('r360_guest_thread_suspend')(b)>>>0)!==0||(pick('r360_guest_thread_state')(b)>>>0)!==3)throw new Error('suspend failed');
if((pick('r360_guest_thread_resume')(b)>>>0)!==1||(pick('r360_guest_thread_state')(b)>>>0)!==1)throw new Error('resume failed');
if(!(pick('r360_guest_thread_terminate')(a,0xDEAD)>>>0))throw new Error('terminate failed');
if((pick('r360_guest_thread_stack_mapped')(a)>>>0)!==0)throw new Error('terminated thread retained stack mapping');
if((pick('r360_sparse_guest_memory_write_u8')(stackBase,1)>>>0)!==0||(pick('r360_sparse_guest_memory_last_fault_code')()>>>0)!==1)throw new Error('terminated stack remained accessible');
console.log('KERNEL_ONLY_GUEST_TLS_AND_LIFECYCLE=PASS');

pick('r360_kernel_runtime_reset')();
for(let i=0;i<17;i++){
  const h=pick('r360_guest_thread_create')(0x82100000+i*4,0,0x4000,0)>>>0;
  if(!h)throw new Error(`reserved-slot setup failed at thread ${i}`);
  const base=pick('r360_guest_thread_stack_base')(h)>>>0;
  if(base>=0x70000000&&base<0x71000000)throw new Error(`child thread collided with browser main-thread slot: 0x${base.toString(16)}`);
}
console.log('KERNEL_ONLY_BROWSER_MAIN_STACK_SLOT_RESERVED=PASS');
console.log('KERNEL_ONLY_GUEST_RUNTIME_HARSH_CRITIC=PASS');
