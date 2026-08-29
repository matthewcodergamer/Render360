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
  return {
    available:true,
    vertex,pixel,
    capturedShaders:Number(vertex.captured)+Number(pixel.captured),
    executedShaders:Number(vertex.executed)+Number(pixel.executed),
    bothCaptured:vertex.captured&&pixel.captured,
    bothExecuted:vertex.executed&&pixel.executed,
    textureFetchBlocker:[vertex,pixel].some(s=>s.captured&&!s.interpretable&&(s.usesTextureFetch||s.status===0xE1000003)),
  };
}
