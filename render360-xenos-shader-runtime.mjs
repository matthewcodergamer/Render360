const pick=(e,n)=>e[n]??e[`_${n}`];
const maybe=(e,n)=>typeof pick(e,n)==='function'?pick(e,n):null;

function snapshot(e,type){
  const get=n=>maybe(e,n)?.()>>>0;
  const exportComponent=maybe(e,'r360_xenos_shader_interpreter_last_export_component_bits');
  return {
    type,
    status:get('r360_xenos_shader_interpreter_status'),
    ucodeDwords:get('r360_xenos_shader_interpreter_ucode_dwords'),
    cfPairBound:get('r360_xenos_shader_interpreter_cf_pair_bound'),
    registerBound:get('r360_xenos_shader_interpreter_register_bound'),
    vertexBindings:get('r360_xenos_shader_interpreter_vertex_bindings'),
    textureBindings:get('r360_xenos_shader_interpreter_texture_bindings'),
    usesTextureFetch:get('r360_xenos_shader_interpreter_uses_texture_fetch')===1,
    writesInterpolators:get('r360_xenos_shader_interpreter_writes_interpolators'),
    writesColorTargets:get('r360_xenos_shader_interpreter_writes_color_targets'),
    executionCount:get('r360_xenos_shader_interpreter_execution_count'),
    allocExports:get('r360_xenos_shader_interpreter_alloc_exports'),
    valueExports:get('r360_xenos_shader_interpreter_value_exports'),
    lastExportRegister:get('r360_xenos_shader_interpreter_last_export_register'),
    lastExportMask:get('r360_xenos_shader_interpreter_last_export_mask'),
    lastExportComponents:Array.from({length:4},(_,i)=>exportComponent?exportComponent(i)>>>0:0),
  };
}

export function hasXenosShaderInterpreter(bootstrap){
  const e=bootstrap?.exports;
  return !!e&&['r360_xenos_shader_dwords','r360_xenos_shader_interpreter_reset','r360_xenos_shader_interpreter_analyze','r360_xenos_shader_interpreter_execute','r360_xenos_shader_interpreter_status'].every(n=>typeof pick(e,n)==='function');
}

export function hasXenosSpirvTranslator(bootstrap){
  const e=bootstrap?.exports;
  return !!e&&['r360_xenos_shader_dwords','r360_xenos_spirv_reset','r360_xenos_spirv_translate','r360_xenos_spirv_status','r360_xenos_spirv_buffer','r360_xenos_spirv_size','r360_xenos_spirv_word'].every(n=>typeof pick(e,n)==='function');
}

export function translateCapturedXenosShaderToSpirv({bootstrap,type}={}){
  if(type!==0&&type!==1)throw new RangeError('Xenos shader type must be 0 (vertex) or 1 (pixel)');
  if(!hasXenosSpirvTranslator(bootstrap))return {available:false,type,translated:false,reason:'xenia-spirv-translator-not-exported',bytes:null};
  const e=bootstrap.exports;
  const dwords=pick(e,'r360_xenos_shader_dwords')(type)>>>0;
  if(!dwords)return {available:true,type,captured:false,translated:false,dwordCount:0,status:0,reason:'shader-not-captured',bytes:null};
  pick(e,'r360_xenos_spirv_reset')();
  const translated=(pick(e,'r360_xenos_spirv_translate')(type)>>>0)===1;
  const status=pick(e,'r360_xenos_spirv_status')()>>>0;
  const errorCount=maybe(e,'r360_xenos_spirv_error_count')?.()>>>0||0;
  const size=pick(e,'r360_xenos_spirv_size')()>>>0;
  const ptr=pick(e,'r360_xenos_spirv_buffer')()>>>0;
  if(!translated)return {available:true,type,captured:true,translated:false,dwordCount:dwords,status,errorCount,size,reason:`xenia-spirv-status-0x${status.toString(16)}`,bytes:null};
  if(!ptr||size<20||(size&3)!==0)return {available:true,type,captured:true,translated:false,dwordCount:dwords,status:0xE2000005,errorCount,size,reason:'invalid-spirv-buffer',bytes:null};
  const source=new Uint8Array(e.memory.buffer,ptr,size);
  const bytes=source.slice();
  const words=new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength>>>2);
  if(words[0]!==0x07230203)return {available:true,type,captured:true,translated:false,dwordCount:dwords,status:0xE2000005,errorCount,size,reason:'invalid-spirv-magic',bytes:null};
  return {available:true,type,captured:true,translated:true,dwordCount:dwords,status,errorCount,size,wordCount:words.length,magic:words[0]>>>0,bytes};
}

export function inspectCapturedXenosSpirv({bootstrap}={}){
  if(!hasXenosSpirvTranslator(bootstrap))return {available:false,reason:'xenia-spirv-translator-not-exported',vertex:null,pixel:null};
  const vertex=translateCapturedXenosShaderToSpirv({bootstrap,type:0});
  const pixel=translateCapturedXenosShaderToSpirv({bootstrap,type:1});
  return {available:true,vertex,pixel,bothCaptured:!!vertex.captured&&!!pixel.captured,bothTranslated:!!vertex.translated&&!!pixel.translated,translatedShaders:Number(!!vertex.translated)+Number(!!pixel.translated)};
}

export async function translateCapturedXenosShaderToWgsl({bootstrap,type,converter}={}){
  const spirv=translateCapturedXenosShaderToSpirv({bootstrap,type});
  if(!spirv.translated)return {...spirv,wgsl:null,wgslTranslated:false};
  const convert=converter||globalThis.render360SpirvToWgsl||globalThis.nagaSpirvToWgsl;
  if(typeof convert!=='function')return {...spirv,wgsl:null,wgslTranslated:false,reason:'spirv-to-wgsl-converter-not-loaded'};
  const output=await convert(spirv.bytes.slice());
  const wgsl=typeof output==='string'?output:output?.wgsl;
  if(typeof wgsl!=='string'||!wgsl.trim())return {...spirv,wgsl:null,wgslTranslated:false,reason:'spirv-to-wgsl-converter-returned-empty-output'};
  // WebGPU itself remains the final validator when createShaderModule is used.
  return {...spirv,wgsl,wgslTranslated:true,reason:'wgsl-ready'};
}

export function inspectCapturedXenosShaders({bootstrap,execute=true}={}){
  if(!hasXenosShaderInterpreter(bootstrap))return {available:false,reason:'shader-interpreter-not-exported',vertex:null,pixel:null};
  const e=bootstrap.exports;
  const dwords=pick(e,'r360_xenos_shader_dwords'),reset=pick(e,'r360_xenos_shader_interpreter_reset'),analyze=pick(e,'r360_xenos_shader_interpreter_analyze'),run=pick(e,'r360_xenos_shader_interpreter_execute');
  const inspect=type=>{
    const captured=dwords(type)>>>0;
    if(!captured)return {type,captured:false,dwordCount:0,analyzed:false,interpretable:false,executed:false,status:0};
    reset();
    const analyzed=(analyze(type)>>>0)===1;
    let state=snapshot(e,type);
    const interpretable=analyzed&&state.status===2;
    let executed=false;
    if(execute&&interpretable){executed=(run(type)>>>0)===1;state=snapshot(e,type);}
    const reason=!analyzed?(state.usesTextureFetch||state.status===0xE1000003?'texture-fetch-not-supported-by-upstream-interpreter':`shader-analysis-status-0x${state.status.toString(16)}`):execute&&!executed?`shader-execution-status-0x${state.status.toString(16)}`:executed?'executed':'interpretable';
    return {...state,captured:true,dwordCount:captured,analyzed,interpretable,executed,reason};
  };
  const vertex=inspect(0),pixel=inspect(1);
  const spirv=hasXenosSpirvTranslator(bootstrap)?inspectCapturedXenosSpirv({bootstrap}):{available:false,reason:'xenia-spirv-translator-not-exported'};
  return {
    available:true,
    vertex,pixel,spirv,
    capturedShaders:Number(vertex.captured)+Number(pixel.captured),
    executedShaders:Number(vertex.executed)+Number(pixel.executed),
    translatedSpirvShaders:spirv.translatedShaders||0,
    bothCaptured:vertex.captured&&pixel.captured,
    bothExecuted:vertex.executed&&pixel.executed,
    bothSpirvTranslated:spirv.bothTranslated===true,
    textureFetchBlocker:[vertex,pixel].some(s=>s.captured&&!s.interpretable&&(s.usesTextureFetch||s.status===0xE1000003)),
  };
}
