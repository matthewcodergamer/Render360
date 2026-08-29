let converterPromise=null;

async function loadGeneratedModule(){
  // The verified publish workflow places wasm-bindgen's generated JS/WASM at
  // the repository root beside the Xenia bootstrap. Keep a build-tree fallback
  // for local/CI runs before publication.
  let module;
  try{module=await import('./render360_spirv_wgsl.js');}
  catch{module=await import('./build/spirv-wgsl/render360_spirv_wgsl.js');}
  const init=module.default;
  if(typeof init!=='function'||typeof module.spirv_to_wgsl!=='function')throw new Error('Render360 Naga converter module is incomplete');
  let wasmUrl;
  try{wasmUrl=new URL('./render360_spirv_wgsl_bg.wasm',import.meta.url);await init(wasmUrl);}
  catch{
    wasmUrl=new URL('./build/spirv-wgsl/render360_spirv_wgsl_bg.wasm',import.meta.url);
    await init(wasmUrl);
  }
  return {convert:module.spirv_to_wgsl,version:typeof module.converter_version==='function'?module.converter_version():''};
}

export async function loadSpirvToWgslConverter(){
  if(!converterPromise)converterPromise=loadGeneratedModule().catch(error=>{converterPromise=null;throw error});
  return converterPromise;
}

export async function spirvToWgsl(spirvBytes){
  if(!(spirvBytes instanceof Uint8Array))throw new TypeError('SPIR-V Uint8Array required');
  const {convert}=await loadSpirvToWgslConverter();
  const wgsl=convert(spirvBytes);
  if(typeof wgsl!=='string'||!wgsl.trim())throw new Error('Naga returned empty WGSL');
  return wgsl;
}

export async function installRender360SpirvToWgslGlobal(){
  const loaded=await loadSpirvToWgslConverter();
  globalThis.render360SpirvToWgsl=async bytes=>loaded.convert(bytes);
  return loaded;
}

export function spirvWgslContract(){return {frontend:'Naga SPIR-V',backend:'Naga WGSL',browserTarget:'WebAssembly',failClosed:true};}
