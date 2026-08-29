import { decodeXexImportLibraries } from './render360-xex-imports.mjs';

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const le16=(b,o)=>(b[o]|(b[o+1]<<8))>>>0;
const le32=(b,o)=>(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;
const KEY_IMAGE_BASE=0x00010201;
const KERNEL_MODULES=new Set(['xboxkrnl.exe','xam.xex']);

function imageBaseFromXex(xexBytes){
  const x=Buffer.from(xexBytes);
  if(x.length<0x18||x.toString('ascii',0,4)!=='XEX2')throw new Error('kernel import decode requires XEX2');
  const headerSize=be32(x,8),headerCount=be32(x,0x14);
  if(headerSize<0x18||headerSize>x.length||headerCount>((headerSize-0x18)>>>3))throw new Error('XEX optional header table out of bounds');
  for(let i=0;i<headerCount;i++){
    const p=0x18+i*8;
    if(be32(x,p)===KEY_IMAGE_BASE)return be32(x,p+4);
  }
  throw new Error('XEX image base optional header missing');
}

function parsePreparedPe(preparedImage){
  const p=Buffer.from(preparedImage);
  if(p.length<0x40||p[0]!==0x4d||p[1]!==0x5a)throw new Error('kernel import prepared image is not PE');
  const nt=le32(p,0x3c);
  if(nt>p.length-24||le32(p,nt)!==0x00004550)throw new Error('kernel import PE NT header invalid');
  const sectionCount=le16(p,nt+6),optionalSize=le16(p,nt+20),optional=nt+24;
  if(optional>p.length||optionalSize>p.length-optional)throw new Error('kernel import PE optional header out of bounds');
  if(optionalSize<64)throw new Error('kernel import PE optional header too small');
  const sizeOfImage=le32(p,optional+56),sizeOfHeaders=le32(p,optional+60);
  if(!sizeOfImage||sizeOfHeaders>p.length)throw new Error('kernel import PE image/header size invalid');
  const sectionTable=optional+optionalSize;
  if(sectionCount>((p.length-sectionTable)/40|0))throw new Error('kernel import PE section table out of bounds');
  const sections=[];
  for(let i=0;i<sectionCount;i++){
    const s=sectionTable+i*40;
    const virtualSize=le32(p,s+8),virtualAddress=le32(p,s+12),rawSize=le32(p,s+16),rawPointer=le32(p,s+20);
    const virtualSpan=Math.max(virtualSize,rawSize);
    const virtualEnd=BigInt(virtualAddress)+BigInt(virtualSpan);
    if(virtualEnd>0x100000000n||virtualEnd>BigInt(sizeOfImage))throw new Error('kernel import PE section RVA wraps/exceeds image');
    sections.push({virtualSize,virtualAddress,rawSize,rawPointer,virtualSpan});
  }
  return {bytes:p,sizeOfImage,sizeOfHeaders,sections};
}

function rvaInsideMappedPe(pe,rva,size){
  if(rva<pe.sizeOfHeaders)return rva<=pe.sizeOfHeaders-size&&rva<=pe.bytes.length-size;
  for(const section of pe.sections){
    if(rva<section.virtualAddress)continue;
    const delta=rva-section.virtualAddress;
    if(delta>=section.virtualSpan)continue;
    return rva<=pe.bytes.length-size&&delta<=section.virtualSpan-size;
  }
  return false;
}

function rawOffsetForRva(pe,rva,size){
  if(rva<pe.sizeOfHeaders)return rva<=pe.sizeOfHeaders-size&&rva<=pe.bytes.length-size?rva:null;
  for(const section of pe.sections){
    if(rva<section.virtualAddress)continue;
    const delta=rva-section.virtualAddress;
    if(delta>=section.virtualSpan)continue;
    // Disk-layout PE fallback only has initialized bytes through SizeOfRawData.
    if(delta>section.rawSize-size)return null;
    const raw=section.rawPointer+delta;
    if(raw>pe.bytes.length-size)return null;
    return raw;
  }
  return null;
}

function resolveImportDescriptor(pe,rva){
  if(!Number.isInteger(rva)||rva<0||rva>0xffffffff)throw new Error('kernel import PE RVA invalid');
  const candidates=[];
  if(rvaInsideMappedPe(pe,rva,4))candidates.push({layout:'mapped-image',offset:rva});
  const rawOffset=rawOffsetForRva(pe,rva,4);
  if(rawOffset!==null&&!candidates.some(x=>x.offset===rawOffset))candidates.push({layout:'raw-pe',offset:rawOffset});
  if(!candidates.length)throw new Error('XEX import descriptor RVA is outside PE mappings');

  for(const candidate of candidates){
    candidate.descriptor=be32(pe.bytes,candidate.offset);
    candidate.type=(candidate.descriptor>>>24)&0xff;
    candidate.ordinal=candidate.descriptor&0xffff;
  }
  const valid=candidates.filter(x=>x.type===0||x.type===1);
  if(valid.length===1)return valid[0];
  if(valid.length>1){
    // A decompressed XEX is a loaded-memory image, while older synthetic tests
    // may still provide a compact disk-layout PE. Prefer mapped RVA semantics
    // when the prepared buffer spans SizeOfImage. Otherwise retain the raw PE
    // interpretation if both locations happen to resemble valid descriptors.
    const preferred=pe.bytes.length>=pe.sizeOfImage
      ?valid.find(x=>x.layout==='mapped-image')
      :valid.find(x=>x.layout==='raw-pe');
    return preferred??valid[0];
  }

  const first=candidates[0];
  const detail=candidates.map(x=>`${x.layout}@0x${x.offset.toString(16)}=type${x.type}`).join(', ');
  throw new Error(`unsupported XEX import descriptor type ${first.type} (${detail})`);
}

export function decodeKernelImportRecords(xexBytes,preparedImage){
  const libraries=decodeXexImportLibraries(xexBytes);
  const pe=parsePreparedPe(preparedImage);
  const imageBase=imageBaseFromXex(xexBytes);
  const decoded=[];
  for(const library of libraries){
    const module=library.name.toLowerCase();
    const records=[];
    for(const recordAddress of library.imports){
      const va=BigInt(recordAddress>>>0),base=BigInt(imageBase>>>0);
      if(va<base)throw new Error(`XEX import descriptor below image base: ${library.name}@0x${(recordAddress>>>0).toString(16)}`);
      const rvaBig=va-base;
      if(rvaBig>0xffffffffn)throw new Error('XEX import descriptor RVA overflow');
      const rva=Number(rvaBig);
      const resolved=resolveImportDescriptor(pe,rva);
      records.push({
        recordAddress:recordAddress>>>0,
        rva,
        rawOffset:resolved.offset,
        descriptorOffset:resolved.offset,
        descriptorLayout:resolved.layout,
        descriptor:resolved.descriptor,
        type:resolved.type,
        ordinal:resolved.ordinal
      });
    }
    const imports=[];
    for(const record of records){
      if(record.type===0){
        imports.push({module:library.name,ordinal:record.ordinal,kind:'variable',valueAddress:record.recordAddress,thunkAddress:0,descriptorAddress:record.recordAddress,descriptorRva:record.rva,descriptorRawOffset:record.rawOffset,descriptorOffset:record.descriptorOffset,descriptorLayout:record.descriptorLayout});
        continue;
      }
      const previous=imports[imports.length-1];
      if(!previous||previous.ordinal!==record.ordinal||previous.thunkAddress)throw new Error(`XEX import thunk has no matching descriptor: ${library.name} ordinal 0x${record.ordinal.toString(16)}`);
      previous.kind='function';
      previous.thunkAddress=record.recordAddress;
      previous.thunkRva=record.rva;
      previous.thunkRawOffset=record.rawOffset;
      previous.thunkOffset=record.descriptorOffset;
      previous.thunkLayout=record.descriptorLayout;
    }
    decoded.push({name:library.name,id:library.id,version:library.version,versionMin:library.versionMin,isKernelModule:KERNEL_MODULES.has(module),imports});
  }
  return {imageBase,libraries:decoded};
}

export function buildKernelImportPlan(xexBytes,preparedImage,{implementedExports={}}={}){
  const decoded=decodeKernelImportRecords(xexBytes,preparedImage);
  const plan=[];
  for(const library of decoded.libraries){
    for(const entry of library.imports){
      const key=`${library.name.toLowerCase()}:${entry.ordinal}`;
      const implementation=implementedExports[key]??null;
      plan.push({...entry,isKernelModule:library.isKernelModule,resolution:implementation?'implemented':(library.isKernelModule?'kernel-unimplemented':'user-module-unresolved'),implementation});
    }
  }
  const firstKernelBlocker=plan.find(x=>x.isKernelModule&&x.resolution!=='implemented')??null;
  return {...decoded,plan,firstKernelBlocker};
}
