import fs from 'node:fs';
import {WASI} from 'node:wasi';

const wasmPath=process.argv[2]||'build/xenia-ppc-bootstrap/xenia_ppc_bootstrap.wasm';
const mod=await WebAssembly.compile(fs.readFileSync(wasmPath));
const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject(mod);
for(const im of WebAssembly.Module.imports(mod))if(im.module==='env'&&im.name==='emscripten_notify_memory_growth'){imports.env||={};imports.env.emscripten_notify_memory_growth=()=>{}};
const instance=await WebAssembly.instantiate(mod,imports);wasi.initialize(instance);
const e=instance.exports,f=n=>e[n]??e[`_${n}`];
const required=['r360_xenos_reset','r360_xenos_ring_buffer','r360_xenos_ring_capacity','r360_xenos_submit','r360_xenos_swaps','r360_sparse_guest_memory_reset','r360_sparse_guest_memory_alloc','r360_sparse_guest_memory_map','r360_sparse_guest_memory_unmap','r360_sparse_guest_memory_write_u8','r360_xenos_frontbuffer_snapshot_capture','r360_xenos_frontbuffer_snapshot_status','r360_xenos_frontbuffer_snapshot_buffer','r360_xenos_frontbuffer_snapshot_size','r360_xenos_frontbuffer_snapshot_width','r360_xenos_frontbuffer_snapshot_height','r360_xenos_frontbuffer_snapshot_hash','r360_xenos_frontbuffer_snapshot_generation','r360_xenos_frontbuffer_snapshot_format','r360_xenos_frontbuffer_snapshot_tiled','r360_xenos_frontbuffer_snapshot_pitch','r360_xenos_frontbuffer_snapshot_source_address','r360_xenos_frontbuffer_snapshot_source_bytes'];
for(const n of required)if(typeof f(n)!=='function')throw new Error(`missing real frontbuffer snapshot export ${n}`);

const packet3=(opcode,count)=>((3<<30)|(((count-1)&0x3fff)<<16)|((opcode&0x7f)<<8))>>>0;
const packet0=(reg,count)=>((((count-1)&0x3fff)<<16)|(reg&0x7fff))>>>0;
const rgbaSwizzle=(0|(1<<3)|(2<<6)|(3<<9))>>>0;
const fetchWords=({base,width,height,pitch=32,tiled=false,format=6,endian=0})=>[
  ((tiled?0x80000000:0)|(((pitch>>>5)&0x1ff)<<22)|2)>>>0,
  (base|format|((endian&3)<<6))>>>0,
  (((width-1)&0x1fff)|(((height-1)&0x1fff)<<13))>>>0,
  (rgbaSwizzle<<1)>>>0,
  0,
  (1<<9)>>>0,
];
const submitSwap=({fetch,base,width,height})=>{
  f('r360_xenos_reset')();
  const words=[packet0(0x4800,6),...fetch,packet3(0x64,4),0x50415753,base>>>0,width>>>0,height>>>0];
  const ptr=f('r360_xenos_ring_buffer')()>>>0,cap=f('r360_xenos_ring_capacity')()>>>0;
  if(!ptr||words.length>cap)throw new Error('Xenos ring unavailable for real frontbuffer test');
  const ring=new Uint32Array(e.memory.buffer,ptr,cap);ring.fill(0);ring.set(words);
  if((f('r360_xenos_submit')(words.length)>>>0)!==1)throw new Error('Xenos VdSwap-style stream rejected');
  if((f('r360_xenos_swaps')()>>>0)!==1)throw new Error('XE_SWAP was not observed');
};
const mapPage=base=>{const backing=f('r360_sparse_guest_memory_alloc')(1)>>>0;if(!backing||(f('r360_sparse_guest_memory_map')(base,1,backing,0,3)>>>0)!==1)throw new Error(`sparse frontbuffer map failed @ 0x${base.toString(16)}`);return backing;};
const writeByte=(address,value)=>{if((f('r360_sparse_guest_memory_write_u8')(address>>>0,value&255)>>>0)!==1)throw new Error(`frontbuffer byte write failed @ 0x${(address>>>0).toString(16)}`);};
const fnv=bytes=>{let h=2166136261>>>0;for(const b of bytes){h^=b;h=Math.imul(h,16777619)>>>0;}return h>>>0;};
const snapshot=()=>{if((f('r360_xenos_frontbuffer_snapshot_capture')()>>>0)!==1)throw new Error(`frontbuffer snapshot failed status=0x${(f('r360_xenos_frontbuffer_snapshot_status')()>>>0).toString(16)}`);const ptr=f('r360_xenos_frontbuffer_snapshot_buffer')()>>>0,size=f('r360_xenos_frontbuffer_snapshot_size')()>>>0;return {ptr,size,width:f('r360_xenos_frontbuffer_snapshot_width')()>>>0,height:f('r360_xenos_frontbuffer_snapshot_height')()>>>0,hash:f('r360_xenos_frontbuffer_snapshot_hash')()>>>0,generation:f('r360_xenos_frontbuffer_snapshot_generation')()>>>0,format:f('r360_xenos_frontbuffer_snapshot_format')()>>>0,tiled:f('r360_xenos_frontbuffer_snapshot_tiled')()>>>0,pitch:f('r360_xenos_frontbuffer_snapshot_pitch')()>>>0,source:f('r360_xenos_frontbuffer_snapshot_source_address')()>>>0,sourceBytes:f('r360_xenos_frontbuffer_snapshot_source_bytes')()>>>0,rgba:Array.from(new Uint8Array(e.memory.buffer,ptr,size))};};

// Linear 8:8:8:8. This is the simplest real VdSwap frontbuffer tier and proves
// the snapshot is sourced from mapped Xbox guest pages rather than g_edram or a
// synthetic browser frame.
f('r360_sparse_guest_memory_reset')();
const linearBase=0x15000000,width=4,height=2,pitch=32;mapPage(linearBase);
const expected=[];
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const pixel=[10+x*20,20+y*40,30+x+y,255];expected.push(...pixel);
  const offset=(y*pitch+x)*4;for(let c=0;c<4;c++)writeByte(linearBase+offset+c,pixel[c]);
}
const linearFetch=fetchWords({base:linearBase,width,height,pitch,tiled:false,format:6,endian:0});
submitSwap({fetch:linearFetch,base:linearBase,width,height});
const linear=snapshot();
if(linear.width!==width||linear.height!==height||linear.size!==width*height*4||linear.format!==6||linear.tiled!==0||linear.pitch!==pitch||linear.source!==linearBase||linear.sourceBytes!==pitch*height*4)throw new Error(`linear snapshot metadata mismatch ${JSON.stringify({...linear,rgba:undefined})}`);
if(linear.rgba.length!==expected.length||linear.rgba.some((v,i)=>v!==expected[i]))throw new Error(`linear real frontbuffer pixels mismatch got=${linear.rgba} expected=${expected}`);
if(linear.hash!==fnv(expected))throw new Error('linear real frontbuffer hash mismatch');
console.log('XENOS_REAL_FRONTBUFFER_LINEAR_RGBA8=PASS');

// Fail-closed provenance: remove the source mapping while preserving Xenos swap
// and fetch state. Capture must stop rather than reusing stale/synthetic pixels.
if((f('r360_sparse_guest_memory_unmap')(linearBase,1)>>>0)!==1)throw new Error('linear frontbuffer unmap failed');
if((f('r360_xenos_frontbuffer_snapshot_capture')()>>>0)!==0)throw new Error('frontbuffer snapshot falsely succeeded without mapped source');
if((f('r360_xenos_frontbuffer_snapshot_status')()>>>0)!==0xE3000004)throw new Error(`unmapped frontbuffer surfaced wrong blocker 0x${(f('r360_xenos_frontbuffer_snapshot_status')()>>>0).toString(16)}`);
console.log('XENOS_REAL_FRONTBUFFER_UNMAPPED_FAIL_CLOSED=PASS');

// Xenos-tiled 2:10:10:10-as-16:16:16:16. This is the second VdSwap format
// accepted by upstream Xenia. Seed pixels at their true XGAddress2D-like tiled
// offsets and require exact detiled normalized RGBA bytes.
const tiledOffset2D=(x,y,pitchPixels,log2Bytes=2)=>{const aligned=(pitchPixels+31)&~31;const macro=((x>>>5)+(y>>>5)*(aligned>>>5))<<(log2Bytes+7);const micro=((x&7)+((y&0xe)<<2))<<log2Bytes;const offset=macro+((micro&~0xf)<<1)+(micro&0xf)+((y&1)<<4);return ((((offset&~0x1ff)<<3)+((y&16)<<7)+((offset&0x1c0)<<2)+(((((y&8)>>>2)+(x>>>3))&3)<<6)+(offset&0x3f))>>>log2Bytes)>>>0;};
const scale10=v=>Math.floor((v*255+511)/1023);
f('r360_sparse_guest_memory_reset')();
const tiledBase=0x16000000,tw=4,th=4,tp=32;mapPage(tiledBase);const tiledExpected=[];
for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
  const r=(x*257)&1023,g=(y*257)&1023,b=((x+y)*127)&1023,a=(x+y)&3;
  const packed=(r|(g<<10)|(b<<20)|(a<<30))>>>0;
  tiledExpected.push(scale10(r),scale10(g),scale10(b),a*85);
  const offset=tiledOffset2D(x,y,tp)*4;for(let c=0;c<4;c++)writeByte(tiledBase+offset+c,(packed>>>(c*8))&255);
}
const tiledFetch=fetchWords({base:tiledBase,width:tw,height:th,pitch:tp,tiled:true,format:54,endian:0});
submitSwap({fetch:tiledFetch,base:tiledBase,width:tw,height:th});
const tiled=snapshot();
if(tiled.format!==54||tiled.tiled!==1||tiled.pitch!==tp||tiled.sourceBytes!==4096)throw new Error(`tiled snapshot metadata mismatch ${JSON.stringify({...tiled,rgba:undefined})}`);
if(tiled.rgba.length!==tiledExpected.length||tiled.rgba.some((v,i)=>v!==tiledExpected[i]))throw new Error(`tiled 2:10:10:10 frontbuffer mismatch`);
if(tiled.hash!==fnv(tiledExpected))throw new Error('tiled real frontbuffer hash mismatch');
console.log('XENOS_REAL_FRONTBUFFER_TILED_2101010=PASS');
console.log('XENOS_REAL_VDSWAP_FRONTBUFFER_SNAPSHOT=PASS');
