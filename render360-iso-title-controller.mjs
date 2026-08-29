import {mountXdvdfs} from './render360-xdvdfs.mjs';
import {handoffDefaultXex} from './render360-title-controller.mjs';

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
export function extractXex2EncryptedImageKey(xex){
  if(xex.length<0x18||String.fromCharCode(...xex.subarray(0,4))!=='XEX2')throw new Error('disc default.xex is not XEX2');
  const headerSize=be32(xex,8),securityOffset=be32(xex,0x10);
  if(headerSize<0x18||headerSize>xex.length)throw new Error('disc XEX header size out of bounds');
  if(!securityOffset||securityOffset>headerSize-0x160)throw new Error('disc XEX2 security info is too small for AES key');
  return xex.slice(securityOffset+0x150,securityOffset+0x160);
}

export async function handoffXboxIso({core,bootstrap,isoSource,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8,scanEntryFunction=false,implementedKernelExports={},initialGprs={},maxDefaultXexBytes=256*1024*1024}){
  const volume=await mountXdvdfs(isoSource);
  const defaultNode=await volume.stat('/default.xex');
  if(defaultNode.isDirectory)throw new Error('XDVDFS default.xex is a directory');
  if(defaultNode.size<0x18)throw new Error('XDVDFS default.xex is too small');
  if(defaultNode.size>maxDefaultXexBytes)throw new Error(`default.xex exceeds bounded title staging limit ${defaultNode.size}/${maxDefaultXexBytes}`);
  const defaultXex=await volume.readDefaultXex({maxBytes:maxDefaultXexBytes});
  const securityKey=encryptedSecurityKey??extractXex2EncryptedImageKey(defaultXex);
  const handoff=await handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey:securityKey,useDevkitKey,entryBytes,scanEntryFunction,implementedKernelExports,initialGprs});
  return {...handoff,inputKind:'xdvdfs',discLayout:volume.layout,discPartitionOffset:volume.partitionOffset,defaultXexBytes:defaultNode.size,securityKeySource:encryptedSecurityKey?'caller':'xex2-security-info',xdvdfsReads:volume.telemetry.reads,xdvdfsBytesRead:volume.telemetry.bytes,xdvdfsMaxRead:volume.telemetry.maxRead};
}
