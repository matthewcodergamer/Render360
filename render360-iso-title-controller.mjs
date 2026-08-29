import {mountXdvdfs} from './render360-xdvdfs.mjs?v=44.1';
import {handoffDefaultXex} from './render360-title-controller.mjs?v=44.1';

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const pick=(bootstrap,name)=>bootstrap?.exports?.[name]??bootstrap?.exports?.[`_${name}`];
export function extractXex2EncryptedImageKey(xex){
  if(xex.length<0x18||String.fromCharCode(...xex.subarray(0,4))!=='XEX2')throw new Error('disc default.xex is not XEX2');
  const headerSize=be32(xex,8),securityOffset=be32(xex,0x10);
  if(headerSize<0x18||headerSize>xex.length)throw new Error('disc XEX header size out of bounds');
  if(!securityOffset||securityOffset>headerSize-0x160)throw new Error('disc XEX2 security info is too small for AES key');
  return xex.slice(securityOffset+0x150,securityOffset+0x160);
}

export async function handoffXboxIso({core,bootstrap,isoSource,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8,scanEntryFunction=false,implementedKernelExports={},initialGprs={},maxDefaultXexBytes=256*1024*1024,executeDuringTranslation=true,executeHirCompatibilityFallback=true}){
  const volume=await mountXdvdfs(isoSource);
  const defaultNode=await volume.stat('/default.xex');
  if(defaultNode.isDirectory)throw new Error('XDVDFS default.xex is a directory');
  if(defaultNode.size<0x18)throw new Error('XDVDFS default.xex is too small');
  if(defaultNode.size>maxDefaultXexBytes)throw new Error(`default.xex exceeds bounded title staging limit ${defaultNode.size}/${maxDefaultXexBytes}`);
  const defaultXex=await volume.readDefaultXex({maxBytes:maxDefaultXexBytes});
  const securityKey=encryptedSecurityKey??extractXex2EncryptedImageKey(defaultXex);

  const setExecute=pick(bootstrap,'r360_ppc_probe_set_execute_on_translate');
  const getExecute=pick(bootstrap,'r360_ppc_probe_execute_on_translate');
  const callableCountFn=pick(bootstrap,'r360_wasm_backend_call_function_count');
  let previousExecute=1;
  let translationOnly=false;
  if(!executeDuringTranslation){
    if(typeof setExecute!=='function'||typeof getExecute!=='function')throw new Error('browser bootstrap does not support side-effect-free PPC translation mode');
    previousExecute=getExecute()>>>0;
    if((setExecute(0)>>>0)!==0)throw new Error('could not enter side-effect-free PPC translation mode');
    translationOnly=true;
  }

  const handoffArgs={core,bootstrap,defaultXex,encryptedSecurityKey:securityKey,useDevkitKey,entryBytes,scanEntryFunction,implementedKernelExports,initialGprs};
  let handoff;
  try{
    handoff=await handoffDefaultXex(handoffArgs);
  }finally{
    if(translationOnly)setExecute(previousExecute?1:0);
  }

  let compatibilityExecution=null;
  if(translationOnly){
    if((handoff.executionStatus>>>0)!==4)throw new Error(`title translation unexpectedly executed guest PPC (status ${handoff.executionStatus>>>0})`);
    const callableFunctionCount=typeof callableCountFn==='function'?(callableCountFn()>>>0):(handoff.translatedFunctionCount>>>0);
    console.info(`[Render360] PPC translation-only entry 0x${(handoff.entry>>>0).toString(16)} produced ${callableFunctionCount} callable WASM functions`);
    if(!callableFunctionCount&&executeHirCompatibilityFallback){
      if(typeof setExecute!=='function'||typeof getExecute!=='function')throw new Error('browser bootstrap cannot enable HIR compatibility execution');
      const beforeFallback=getExecute()>>>0;
      if((setExecute(1)>>>0)!==1)throw new Error('could not enable HIR compatibility execution');
      const translatedOnly={
        entry:handoff.entry>>>0,
        hir:handoff.hir>>>0,
        handoffBytes:handoff.handoffBytes>>>0,
        executionStatus:handoff.executionStatus>>>0,
        executionInstructions:handoff.executionInstructions>>>0,
        translatedFunctionCount:handoff.translatedFunctionCount>>>0,
      };
      console.info(`[Render360] Generated WASM entry unavailable; executing native HIR compatibility path for 0x${(handoff.entry>>>0).toString(16)}`);
      try{
        handoff=await handoffDefaultXex(handoffArgs);
      }finally{
        setExecute(beforeFallback?1:0);
      }
      compatibilityExecution={
        used:true,
        reason:'generated-wasm-entry-unavailable',
        entry:handoff.entry>>>0,
        translatedOnly,
        executionStatus:handoff.executionStatus>>>0,
        executionInstructions:handoff.executionInstructions>>>0,
        runtimeBoundary:handoff.runtimeBoundary,
        reachedKernelBlocker:handoff.reachedKernelBlocker??null,
      };
      console.info(`[Render360] Native HIR compatibility result status=${compatibilityExecution.executionStatus} instructions=${compatibilityExecution.executionInstructions} boundary=${compatibilityExecution.runtimeBoundary}`);
      handoff={...handoff,entryExecutedDuringTranslation:true,compatibilityExecution};
    }else{
      handoff={...handoff,runtimeBoundary:'translation-only',entryExecutedDuringTranslation:false,compatibilityExecution:null};
    }
  }else{
    handoff={...handoff,entryExecutedDuringTranslation:true,compatibilityExecution:null};
  }
  return {...handoff,inputKind:'xdvdfs',discLayout:volume.layout,discPartitionOffset:volume.partitionOffset,defaultXexBytes:defaultNode.size,securityKeySource:encryptedSecurityKey?'caller':'xex2-security-info',xdvdfsReads:volume.telemetry.reads,xdvdfsBytesRead:volume.telemetry.bytes,xdvdfsMaxRead:volume.telemetry.maxRead};
}