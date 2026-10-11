// Host side of the Render360 guest JIT (src/xenia_web_bootstrap/hir_wasm_jit.cpp).
//
// The core compiles a hot guest function's finalized Xenia HIR into a small
// WebAssembly module. This module instantiates it next to the core (sharing
// its memory, calling its r360_jit_h_* helpers) and places the generated
// function in the core's indirect function table, where the HIR executor
// calls it in place of interpreting the HIR.
//
// Browsers only allow small synchronous compiles on the main thread, so a
// module that cannot be compiled synchronously is compiled asynchronously;
// the function keeps running on the executor until r360_jit_install reports
// it ready.
const HELPERS=['state','spill_alloc','spill_pop','call','call_indirect','set_return','ld8','ld16','ld32','ld64','st8','st16','st32','st64','poll','clock','memset','atomic','set_rounding','call_extern','cvt_f2i','mulhi64','fail','call_addr','exec','ld128','st128'];

// (i32, i32, i32) -> i32 import "js"."c", re-exported as "c": turns the host
// compile callback into a table-callable WebAssembly function.
const INSTALLED=new WeakMap();
const TRAMPOLINE=new Uint8Array([0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,0x01,0x08,0x01,0x60,0x03,0x7f,0x7f,0x7f,0x01,0x7f,0x02,0x08,0x01,0x02,0x6a,0x73,0x01,0x63,0x00,0x00,0x07,0x05,0x01,0x01,0x63,0x00,0x00]);

export function hasGuestJit(bootstrap){
  const e=bootstrap?.exports;
  return typeof e?.r360_jit_set_compiler==='function'&&e.__indirect_function_table instanceof WebAssembly.Table&&typeof e.asyncify_get_state==='function';
}

// mode: 0 off, 1 compile hot functions (default), 2 compile everything on
// first execution (tests). Returns a telemetry reader, or null.
export function installGuestJit(bootstrap,{mode=1,hotThreshold=2,onError=null}={}){
  if(!hasGuestJit(bootstrap))return null;
  const e=bootstrap.exports;
  if(INSTALLED.has(e))return INSTALLED.get(e);
  const table=e.__indirect_function_table;
  const h={};
  for(const name of HELPERS){
    const fn=name==='state'?e.asyncify_get_state:e[`r360_jit_h_${name}`];
    if(typeof fn!=='function')return null;
    h[name]=fn;
  }
  const imports={e:{memory:e.memory},h};
  const stats={compiled:0,asyncCompiled:0,errors:0,lastError:null};
  const place=fn=>{const index=table.grow(1);table.set(index,fn);return index;};
  const fail=(error,bytes)=>{
    stats.errors++;stats.lastError=String(error?.message||error);
    if(onError)try{onError(error,bytes);}catch{}
  };
  const compile=(ptr,len,request)=>{
    const bytes=new Uint8Array(e.memory.buffer,ptr>>>0,len>>>0).slice();
    let module=null;
    try{module=new WebAssembly.Module(bytes);}catch(error){
      if(!(error instanceof RangeError)){fail(error,bytes);return 0;}
    }
    if(module){
      try{const instance=new WebAssembly.Instance(module,imports);stats.compiled++;return place(instance.exports.f);}
      catch(error){if(!(error instanceof RangeError)){fail(error,bytes);return 0;}}
    }
    // Too large to compile synchronously here: compile in the background.
    WebAssembly.instantiate(bytes,imports).then(({instance})=>{
      stats.asyncCompiled++;
      e.r360_jit_install(request,place(instance.exports.f));
    },error=>{fail(error,bytes);e.r360_jit_install(request,0);});
    return 0;
  };
  const trampoline=new WebAssembly.Instance(new WebAssembly.Module(TRAMPOLINE),{js:{c:compile}});
  e.r360_jit_set_compiler(place(trampoline.exports.c));
  e.r360_jit_set_mode(mode>>>0,hotThreshold>>>0);
  const read=i=>e.r360_jit_stat?.(i)>>>0;
  const jit={stats,setMode:(m,t=0)=>e.r360_jit_set_mode(m>>>0,t>>>0),telemetry:()=>({functions:read(0),rejected:read(1),compileFailures:read(2),calls:read(3)*1000,lastRejectOpcode:read(4),codeKiB:read(5),pending:read(6),...stats})};
  INSTALLED.set(e,jit);
  return jit;
}
