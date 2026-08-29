import {mountXdvdfs} from './render360-xdvdfs.mjs';
import {handoffDefaultXex} from './render360-title-controller.mjs';

export async function handoffXboxIso({core,bootstrap,isoSource,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8,implementedKernelExports={},initialGprs={},maxDefaultXexBytes=256*1024*1024}){
  const volume=await mountXdvdfs(isoSource);
  const defaultNode=await volume.stat('/default.xex');
  if(defaultNode.isDirectory)throw new Error('XDVDFS default.xex is a directory');
  if(defaultNode.size<0x18)throw new Error('XDVDFS default.xex is too small');
  if(defaultNode.size>maxDefaultXexBytes)throw new Error(`default.xex exceeds bounded title staging limit ${defaultNode.size}/${maxDefaultXexBytes}`);
  const defaultXex=await volume.readDefaultXex({maxBytes:maxDefaultXexBytes});
  const handoff=await handoffDefaultXex({core,bootstrap,defaultXex,encryptedSecurityKey,useDevkitKey,entryBytes,implementedKernelExports,initialGprs});
  return {...handoff,inputKind:'xdvdfs',discLayout:volume.layout,discPartitionOffset:volume.partitionOffset,defaultXexBytes:defaultNode.size,xdvdfsReads:volume.telemetry.reads,xdvdfsBytesRead:volume.telemetry.bytes,xdvdfsMaxRead:volume.telemetry.maxRead};
}
