// Cheap, stable signatures for deciding when expensive Xenos diagnostics need
// to run. The guest scheduler may pump thousands of times during title boot;
// shader interpretation/SPIR-V translation and full GPU-state snapshots must
// not be repeated when the guest has not changed those resources.
const pick=(exports,name)=>exports?.[name]??exports?.[`_${name}`];

function read(exports,name,...args){
  const fn=pick(exports,name);
  return typeof fn==='function'?(fn(...args)>>>0):null;
}

export function readGpuActivitySignature(bootstrap){
  const e=bootstrap?.exports;
  if(!e)return null;
  const values=[
    read(e,'r360_xenos_status'),
    read(e,'r360_xenos_swaps'),
    read(e,'r360_xenos_frame_generation'),
    read(e,'r360_title_gpu_status'),
    read(e,'r360_title_gpu_write_pointer'),
  ];
  return values.every(value=>value===null)?null:values.join(':');
}

export function readXenosShaderSignature(bootstrap){
  const e=bootstrap?.exports;
  if(!e)return null;
  const dwords=pick(e,'r360_xenos_shader_dwords');
  const hash=pick(e,'r360_xenos_shader_hash');
  if(typeof dwords!=='function'||typeof hash!=='function')return null;
  return [0,1].map(type=>`${dwords(type)>>>0}:${hash(type)>>>0}`).join('|');
}
