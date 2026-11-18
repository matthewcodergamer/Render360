import {readGpuActivitySignature,readXenosShaderSignature} from './render360-runtime-inspection-cache.mjs';

const values={status:0,packets:0,swaps:0,generation:0,ringStatus:0,writePointer:0};
const shaders=[{dwords:0,hash:0},{dwords:0,hash:0}];
const bootstrap={exports:{
  r360_xenos_status:()=>values.status,
  r360_xenos_packets:()=>values.packets,
  r360_xenos_swaps:()=>values.swaps,
  r360_xenos_frame_generation:()=>values.generation,
  r360_title_gpu_status:()=>values.ringStatus,
  r360_title_gpu_write_pointer:()=>values.writePointer,
  r360_xenos_shader_dwords:type=>shaders[type].dwords,
  r360_xenos_shader_hash:type=>shaders[type].hash,
}};

const initialGpu=readGpuActivitySignature(bootstrap);
if(initialGpu!==readGpuActivitySignature(bootstrap))throw new Error('GPU activity signature is not stable');
values.writePointer=64;
if(initialGpu===readGpuActivitySignature(bootstrap))throw new Error('GPU signature missed a guest ring write');
values.swaps=1;values.generation=1;
if(initialGpu===readGpuActivitySignature(bootstrap))throw new Error('GPU signature missed a real frame swap');

const initialShaders=readXenosShaderSignature(bootstrap);
if(initialShaders!==readXenosShaderSignature(bootstrap))throw new Error('Shader signature is not stable');
shaders[0]={dwords:128,hash:0x12345678};
if(initialShaders===readXenosShaderSignature(bootstrap))throw new Error('Shader signature missed new vertex shader code');
shaders[1]={dwords:96,hash:0x87654321};
const both=readXenosShaderSignature(bootstrap);
if(both===initialShaders)throw new Error('Shader signature missed new pixel shader code');
if(readGpuActivitySignature({exports:{}})!==null)throw new Error('Missing GPU telemetry should use the safe uncached fallback');
if(readXenosShaderSignature({exports:{}})!==null)throw new Error('Missing shader telemetry should use the safe uncached fallback');

console.log('RUNTIME_INSPECTION_GPU_SIGNATURE=PASS');
console.log('RUNTIME_INSPECTION_SHADER_SIGNATURE=PASS');
console.log('RUNTIME_INSPECTION_LEGACY_FALLBACK=PASS');
