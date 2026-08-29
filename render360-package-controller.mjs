import { handoffDefaultXex } from './render360-title-controller.mjs';

const u64=(lo,hi)=>(hi>>>0)*0x100000000+(lo>>>0);

function requireCore(core,names){for(const n of names)if(typeof core.exports[n]!=='function')throw new Error(`missing package-controller export ${n}`);}

export async function handoffStfsPackage({core,bootstrap,packageBytes,encryptedSecurityKey=null,useDevkitKey=false,entryBytes=8,maxRequests=4096,implementedKernelExports={}}){
  const pkg=Buffer.from(packageBytes);
  if(!pkg.length||pkg.length>0xffffffff)throw new Error('STFS package size unsupported by current controller');
  const e=core.exports;
  requireCore(core,['r360_io_ptr','r360_io_capacity','r360_stfs_mount_begin','r360_stfs_submit_read','r360_stfs_request_pending','r360_stfs_request_offset_lo','r360_stfs_request_offset_hi','r360_stfs_request_size','r360_stfs_mount_status','r360_stfs_default_xex_index','r360_stfs_extract_default_xex','r360_stfs_extract_status','r360_stfs_extract_bytes_total','r360_stfs_extract_bytes_done']);
  const io=e.r360_io_ptr()>>>0,cap=e.r360_io_capacity()>>>0;
  const heap=()=>new Uint8Array(e.memory.buffer);
  const service=(capture=null)=>{
    const off=u64(e.r360_stfs_request_offset_lo(),e.r360_stfs_request_offset_hi());
    const size=e.r360_stfs_request_size()>>>0;
    if(!size||size>cap||off>pkg.length||size>pkg.length-off)throw new Error(`STFS request out of package bounds off=${off} size=${size}`);
    const chunk=pkg.subarray(off,off+size);
    if(capture){const logical=e.r360_stfs_extract_bytes_done()>>>0;if(logical<capture.length)capture.set(chunk.subarray(0,Math.min(size,capture.length-logical)),logical);}
    heap().set(chunk,io);
    return e.r360_stfs_submit_read(size)>>>0;
  };
  let status=e.r360_stfs_mount_begin(pkg.length>>>0,0)>>>0,requests=0;
  while((e.r360_stfs_request_pending()>>>0)!==0){if(++requests>maxRequests)throw new Error('STFS mount request guard exceeded');status=service();}
  if(status!==2||(e.r360_stfs_mount_status()>>>0)!==2)throw new Error(`STFS mount failed ${status}`);
  if((e.r360_stfs_default_xex_index()>>>0)===0xffffffff)throw new Error('default.xex not found in package');
  status=e.r360_stfs_extract_default_xex()>>>0;
  if(status!==1)throw new Error(`default.xex extraction did not start ${status}`);
  const total=e.r360_stfs_extract_bytes_total()>>>0;if(!total)throw new Error('default.xex declared zero bytes');
  const xex=Buffer.alloc(total);
  while((e.r360_stfs_request_pending()>>>0)!==0){if(++requests>maxRequests)throw new Error('STFS extraction request guard exceeded');status=service(xex);}
  if(status!==2||(e.r360_stfs_extract_status()>>>0)!==2||(e.r360_stfs_extract_bytes_done()>>>0)!==total)throw new Error(`default.xex extraction failed status=${status} bytes=${e.r360_stfs_extract_bytes_done()>>>0}/${total}`);
  const handoff=await handoffDefaultXex({core,bootstrap,defaultXex:xex,encryptedSecurityKey,useDevkitKey,entryBytes,implementedKernelExports});
  return {...handoff,packageBytes:pkg.length,defaultXexBytes:total,stfsRequests:requests};
}
