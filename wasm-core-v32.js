import {CORE_WASM_GZIP_BASE64} from './render360_xenia_core_embedded.js?v=43';
import {extractStfsEntryBrowser,browserStfsExtractorContract} from './render360-stfs-browser-extractor.mjs?v=43';
const U32 = 0x100000000;
const STFS_STATUS = {
  0:'Idle', 1:'Working', 2:'Mounted', 3:'Mounted (partial)',
  100:'Too small',101:'Invalid package magic',102:'Invalid STFS header',
  103:'Unsupported volume (SVOD)',104:'Read outside package',105:'Short browser read',
  106:'Directory entry limit reached',107:'Invalid directory entry',108:'Broken STFS hash chain',
};
const STFS_EXTRACT_STATUS={0:'Idle',1:'Working',2:'Complete',100:'Bad entry index',101:'Entry is a directory',102:'Broken file block chain',103:'Short extraction read'};
const BASE_EXPORTS=['memory','r360_build_version','r360_abi_version','r360_feature_bits','r360_io_capacity','r360_io_ptr','r360_probe_container','r360_stfs_mount_begin','r360_stfs_submit_read','r360_stfs_request_pending','r360_stfs_request_offset_lo','r360_stfs_request_offset_hi','r360_stfs_request_size','r360_stfs_mount_status','r360_stfs_entry_count','r360_stfs_default_xex_index'];
function decodeBase64(s){const bin=globalThis.atob(s),out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out}
async function gunzip(bytes){
  if(typeof DecompressionStream!=='function')throw new Error('Browser DecompressionStream is unavailable');
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function validateInstance(instance,label){
  const e=instance?.exports||{};
  const missing=BASE_EXPORTS.filter(name=>name==='memory'?!e.memory:typeof e[name]!=='function');
  if(missing.length)throw new Error(`${label} core is missing required ABI exports: ${missing.join(', ')}`);
  return instance;
}

export class Render360Core {
  constructor(url='./render360_xenia_core.wasm?v=43') { this.url=url; this.instance=null; this.exports=null; this.source='none'; this.networkError=null; }

  async init() {
    // Network first. The old loader preferred the embedded fallback, allowing a
    // stale V30 binary to shadow a newer checked-in core forever on Safari.
    // The embedded core is now strictly an offline/fetch-failure fallback.
    let result=null,networkError=null,embeddedError=null;
    try{
      const response=await fetch(this.url,{cache:'no-store'});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      try{result=await WebAssembly.instantiateStreaming(response.clone(),{});}
      catch{result=await WebAssembly.instantiate(await response.arrayBuffer(),{});}
      validateInstance(result.instance,'Network');
      this.source='network';
    }catch(error){networkError=error;result=null;}
    if(!result&&CORE_WASM_GZIP_BASE64){
      try{
        result=await WebAssembly.instantiate(await gunzip(decodeBase64(CORE_WASM_GZIP_BASE64)),{});
        validateInstance(result.instance,'Embedded');
        this.source='embedded';
      }catch(error){embeddedError=error;result=null;}
    }
    if(!result)throw new Error(`Render360 core could not start${networkError?` · network: ${networkError.message}`:''}${embeddedError?` · embedded: ${embeddedError.message}`:''}`);
    this.networkError=networkError;this.instance=result.instance;this.exports=this.instance.exports;
    return this;
  }

  get buildVersion(){return this.exports.r360_build_version()>>>0}
  get abiVersion(){return this.exports.r360_abi_version()>>>0}
  get featureBits(){return this.exports.r360_feature_bits()>>>0}
  get nativeStfsExtraction(){return typeof this.exports?.r360_stfs_extract_begin==='function'}
  get stfsExtractionMode(){return this.nativeStfsExtraction?'native-v32':'browser-v32-fallback'}
  get extractionContract(){return this.nativeStfsExtraction?{native:true,version:this.buildVersion}:{native:false,...browserStfsExtractorContract()}}
  ioCapacity(){return this.exports.r360_io_capacity()>>>0}
  ioPtr(){return this.exports.r360_io_ptr()>>>0}

  stageBytes(bytes){
    const src=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),cap=this.ioCapacity();
    if(src.byteLength>cap)throw new Error(`WASM staging overflow: ${src.byteLength} > ${cap}`);
    new Uint8Array(this.exports.memory.buffer,this.ioPtr(),src.byteLength).set(src);
    return {ptr:this.ioPtr(),cap,bytesRead:src.byteLength};
  }

  async stageSlice(file,offset=0,length=this.ioCapacity()){
    const safeOffset=Math.max(0,Number(offset));
    if(!Number.isSafeInteger(safeOffset))throw new Error('File offset exceeds JavaScript safe integer range');
    const available=Math.max(0,file.size-safeOffset);
    const take=Math.min(this.ioCapacity(),Math.max(0,Number(length)),available);
    const bytes=new Uint8Array(await file.slice(safeOffset,safeOffset+take).arrayBuffer());
    this.stageBytes(bytes);return {ptr:this.ioPtr(),cap:this.ioCapacity(),bytesRead:bytes.length,offset:safeOffset,bytes};
  }
  async stageFilePrefix(file){return this.stageSlice(file,0,this.ioCapacity())}

  readAscii(ptr,length){
    if(!ptr||!length)return '';
    const bytes=new Uint8Array(this.exports.memory.buffer,ptr>>>0,length>>>0);
    let out='';for(const b of bytes)out+=String.fromCharCode(b);return out;
  }
  combineU64(lo,hi){
    const value=(hi>>>0)*U32+(lo>>>0);
    if(!Number.isSafeInteger(value))throw new Error('64-bit file value exceeds JavaScript safe integer range');
    return value;
  }
  splitU64(value){
    if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid file size');
    return {lo:(value%U32)>>>0,hi:Math.floor(value/U32)>>>0};
  }

  readXexInspection(inspectStatus=this.exports.r360_xex_status()>>>0){
    return {inspectStatus,
      moduleFlags:this.exports.r360_xex_module_flags()>>>0,headerSize:this.exports.r360_xex_header_size()>>>0,
      securityOffset:this.exports.r360_xex_security_offset()>>>0,headerCount:this.exports.r360_xex_header_count()>>>0,
      entryPoint:this.exports.r360_xex_entry_point()>>>0,imageBase:this.exports.r360_xex_image_base()>>>0,
      systemFlags:this.exports.r360_xex_system_flags()>>>0,titleId:this.exports.r360_xex_title_id()>>>0,
      mediaId:this.exports.r360_xex_media_id()>>>0,imageSize:this.exports.r360_xex_image_size()>>>0,
      loadAddress:this.exports.r360_xex_load_address()>>>0,region:this.exports.r360_xex_region()>>>0,
      allowedMediaTypes:this.exports.r360_xex_allowed_media_types()>>>0,pageDescriptorCount:this.exports.r360_xex_page_descriptor_count()>>>0,
      encryptionType:this.exports.r360_xex_encryption_type()>>>0,compressionType:this.exports.r360_xex_compression_type()>>>0,
      importsOffset:this.exports.r360_xex_import_libraries_offset()>>>0,executionInfoOffset:this.exports.r360_xex_execution_info_offset()>>>0,
      fileFormatInfoOffset:this.exports.r360_xex_file_format_info_offset()>>>0};
  }

  async probeFile(file){
    const magic=await this.stageSlice(file,0,Math.min(file.size,64));
    const kind=this.exports.r360_probe_container(magic.bytesRead)>>>0;
    const result={kind,...magic,xex:null,stfs:null};
    if(kind===1||kind===2){
      const staged=await this.stageFilePrefix(file);result.bytesRead=staged.bytesRead;
      const inspectStatus=this.exports.r360_inspect_xex(staged.bytesRead)>>>0;
      result.xex=this.readXexInspection(inspectStatus);
    }
    return result;
  }

  inspectXexBytes(bytes){
    const src=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
    const take=Math.min(src.byteLength,this.ioCapacity());
    this.stageBytes(src.subarray(0,take));
    const inspectStatus=this.exports.r360_inspect_xex(take)>>>0;
    return this.readXexInspection(inspectStatus);
  }

  readStfsSnapshot(){
    const e=this.exports,status=e.r360_stfs_mount_status()>>>0;
    const namePtr=e.r360_stfs_display_name_ptr()>>>0,nameLen=e.r360_stfs_display_name_length()>>>0;
    return {status,statusName:STFS_STATUS[status]||`Status ${status}`,
      packageKind:e.r360_stfs_package_kind()>>>0,headerSize:e.r360_stfs_header_size()>>>0,
      contentType:e.r360_stfs_content_type()>>>0,metadataVersion:e.r360_stfs_metadata_version()>>>0,
      contentSize:this.combineU64(e.r360_stfs_content_size_lo(),e.r360_stfs_content_size_hi()),
      titleId:e.r360_stfs_title_id()>>>0,mediaId:e.r360_stfs_media_id()>>>0,
      volumeType:e.r360_stfs_volume_type()>>>0,descriptorLength:e.r360_stfs_descriptor_length()>>>0,
      descriptorVersion:e.r360_stfs_descriptor_version()>>>0,descriptorFlags:e.r360_stfs_descriptor_flags()>>>0,
      readOnly:!!((e.r360_stfs_descriptor_flags()>>>0)&1),dataFileCount:e.r360_stfs_data_file_count()>>>0,
      fileTableBlockCount:e.r360_stfs_file_table_block_count()>>>0,fileTableBlockNumber:e.r360_stfs_file_table_block_number()>>>0,
      totalBlockCount:e.r360_stfs_total_block_count()>>>0,freeBlockCount:e.r360_stfs_free_block_count()>>>0,
      directoryBlocksRead:e.r360_stfs_directory_blocks_read()>>>0,entryCount:e.r360_stfs_entry_count()>>>0,
      defaultXexIndex:e.r360_stfs_default_xex_index()>>>0,defaultXexKind:e.r360_stfs_default_xex_kind()>>>0,
      warnings:e.r360_stfs_warnings()>>>0,displayName:this.readAscii(namePtr,nameLen)};
  }

  readStfsEntries(){
    const e=this.exports,count=e.r360_stfs_entry_count()>>>0,entries=[];
    for(let i=0;i<count;i++){
      const ptr=e.r360_stfs_entry_name_ptr(i)>>>0,len=e.r360_stfs_entry_name_length(i)>>>0,flags=e.r360_stfs_entry_flags(i)>>>0;
      entries.push({index:i,name:this.readAscii(ptr,len),flags,
        contiguous:!!(e.r360_stfs_entry_is_contiguous(i)>>>0),directory:!!(e.r360_stfs_entry_is_directory(i)>>>0),
        validBlocks:e.r360_stfs_entry_valid_blocks(i)>>>0,allocatedBlocks:e.r360_stfs_entry_allocated_blocks(i)>>>0,
        startBlock:e.r360_stfs_entry_start_block(i)>>>0,parentIndex:e.r360_stfs_entry_parent_index(i)>>>0,length:e.r360_stfs_entry_length(i)>>>0});
    }
    return entries;
  }

  readStfsExtractSnapshot(){
    const e=this.exports;if(typeof e.r360_stfs_extract_status!=='function')return null;
    const status=e.r360_stfs_extract_status()>>>0;
    return {status,statusName:STFS_EXTRACT_STATUS[status]||`Status ${status}`,entryIndex:e.r360_stfs_extract_entry_index()>>>0,
      currentBlock:e.r360_stfs_extract_current_block()>>>0,logicalOffset:e.r360_stfs_extract_logical_offset()>>>0,
      bytesTotal:e.r360_stfs_extract_bytes_total()>>>0,bytesDone:e.r360_stfs_extract_bytes_done()>>>0,
      blocksDone:e.r360_stfs_extract_blocks_done()>>>0,contiguous:!!(e.r360_stfs_extract_is_contiguous()>>>0)};
  }

  async extractStfsEntry(file,entryIndex,{maxRequests=65536,captureLimit=32*1024*1024,onProgress=null}={}){
    const e=this.exports;
    if(typeof e.r360_stfs_extract_begin!=='function'){
      const entries=this.readStfsEntries(),entry=entries[entryIndex>>>0];
      if(!entry)throw new Error(`STFS entry ${entryIndex>>>0} is unavailable after mount`);
      return extractStfsEntryBrowser(file,{entry,stfs:this.readStfsSnapshot(),captureLimit,maxRequests,onProgress});
    }
    e.r360_stfs_extract_begin(entryIndex>>>0);
    let snap=this.readStfsExtractSnapshot(),requestCount=0,totalBytesRead=0;
    const captureBytes=Math.min(snap.bytesTotal,Math.max(0,Number(captureLimit)||0));
    const captured=new Uint8Array(captureBytes);
    while((e.r360_stfs_request_pending()>>>0)!==0){
      if(++requestCount>maxRequests){e.r360_stfs_extract_reset?.();throw new Error(`STFS extraction exceeded ${maxRequests} native read requests`);}
      const offset=this.combineU64(e.r360_stfs_request_offset_lo(),e.r360_stfs_request_offset_hi());
      const size=e.r360_stfs_request_size()>>>0,dest=e.r360_stfs_extract_bytes_done()>>>0;
      if(size===0||size>this.ioCapacity())throw new Error(`Invalid native STFS extraction read size ${size}`);
      const staged=await this.stageSlice(file,offset,size);totalBytesRead+=staged.bytesRead;
      if(staged.bytesRead!==size)throw new Error(`Short STFS extraction browser read at 0x${offset.toString(16)} (${staged.bytesRead}/${size})`);
      if(dest<captured.length){const take=Math.min(staged.bytes.length,captured.length-dest);captured.set(staged.bytes.subarray(0,take),dest);}
      e.r360_stfs_submit_read(staged.bytesRead);snap=this.readStfsExtractSnapshot();onProgress?.(snap);
    }
    snap=this.readStfsExtractSnapshot();
    return {...snap,complete:snap.status===2,requestCount,totalBytesRead,captured,fullyCaptured:captured.length===snap.bytesTotal,fallback:null};
  }

  async mountStfs(file,{maxRequests=4096,extractDefaultXex=true,onExtractProgress=null}={}){
    const e=this.exports,{lo,hi}=this.splitU64(file.size);
    e.r360_stfs_mount_begin(lo,hi);
    let requestCount=0,totalBytesRead=0;
    while((e.r360_stfs_request_pending()>>>0)!==0){
      if(++requestCount>maxRequests){e.r360_stfs_mount_reset();throw new Error(`STFS mount exceeded ${maxRequests} native read requests`);}
      const offset=this.combineU64(e.r360_stfs_request_offset_lo(),e.r360_stfs_request_offset_hi());
      const size=e.r360_stfs_request_size()>>>0;
      const kind=e.r360_stfs_request_kind()>>>0;
      if(size===0||size>this.ioCapacity())throw new Error(`Invalid native STFS read size ${size}`);
      const staged=await this.stageSlice(file,offset,size);totalBytesRead+=staged.bytesRead;
      if(staged.bytesRead!==size)throw new Error(`Short STFS browser read at 0x${offset.toString(16)} (${staged.bytesRead}/${size}, request kind ${kind})`);
      e.r360_stfs_submit_read(staged.bytesRead);
    }
    const stfs=this.readStfsSnapshot(),entries=this.readStfsEntries();
    const mounted=stfs.status===2||stfs.status===3;
    let defaultXex=null;
    if(stfs.defaultXexIndex!==0xFFFFFFFF&&stfs.defaultXexIndex<entries.length)defaultXex=entries[stfs.defaultXexIndex];
    const result={mounted,partial:stfs.status===3,stfs,entries,defaultXex,defaultXexKind:stfs.defaultXexKind,
      requestCount,totalBytesRead,chainComplete:stfs.status===2,defaultXexExtract:null,defaultXexInspection:null,extractionMode:this.stfsExtractionMode};
    if(mounted&&extractDefaultXex&&defaultXex){
      result.defaultXexExtract=await this.extractStfsEntry(file,defaultXex.index,{onProgress:onExtractProgress});
      if(result.defaultXexExtract.captured?.byteLength>=24){
        try{result.defaultXexInspection=this.inspectXexBytes(result.defaultXexExtract.captured)}catch{}
      }
      result.stfs=this.readStfsSnapshot();
    }
    return result;
  }

  xamScalar(ordinal){return this.exports.r360_xam_scalar_value(ordinal>>>0)>>>0}
}

export function containerName(kind){return ({1:'XEX1',2:'XEX2',10:'STFS LIVE',11:'STFS PIRS',12:'STFS CON',20:'PowerPC ELF'})[kind]||'Unknown'}
export function compressionName(v){return ({0:'None',1:'Basic',2:'Normal / LZX',3:'Delta'})[v]??'Unknown'}
export function encryptionName(v){return ({0:'None',1:'Normal'})[v]??'Unknown'}
export function stfsStatusName(v){return STFS_STATUS[v]||`Status ${v}`}
