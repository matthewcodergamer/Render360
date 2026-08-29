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
  const sizeOfHeaders=le32(p,optional+60);
  if(sizeOfHeaders>p.length)throw new Error('kernel import PE headers exceed prepared image');
  const sectionTable=optional+optionalSize;
  if(sectionCount>((p.length-sectionTable)/40|0))throw new Error('kernel import PE section table out of bounds');
  const sections=[];
  for(let i=0;i<sectionCount;i++){
    const s=sectionTable+i*40;
    const virtualSize=le32(p,s+8),virtualAddress=le32(p,s+12),rawSize=le32(p,s+16),rawPointer=le32(p,s+20);
    if(rawSize&&(rawPointer>p.length||rawSize>p.length-rawPointer))throw new Error('kernel import PE section raw range out of bounds');
    const virtualSpan=Math.max(virtualSize,rawSize);
    const virtualEnd=BigInt(virtualAddress)+BigInt(virtualSpan);
    if(virtualEnd>0x100000000n)throw new Error('kernel import PE section RVA wraps');
    sections.push({virtualSize,virtualAddress,rawSize,rawPointer,virtualSpan});
  }
  return {bytes:p,sizeOfHeaders,sections};
}

function peRawOffsetForRva(pe,rva,size=4){
  if(!Number.isInteger(rva)||rva<0||rva>0xffffffff||!Number.isInteger(size)||size<=0)throw new Error('kernel import PE RVA invalid');
  if(rva<pe.sizeOfHeaders){
    if(rva>pe.sizeOfHeaders-size||rva>pe.bytes.length-size)throw new Error('kernel import descriptor crosses PE headers');
    return rva;
  }
  for(const section of pe.sections){
    if(rva<section.virtualAddress)continue;
    const delta=rva-section.virtualAddress;
    if(delta>=section.virtualSpan)continue;
    // An RVA in virtual zero-fill is a valid mapped address but has no file
    // bytes containing an import descriptor, so fail closed rather than read
    // unrelated bytes.
    if(delta>section.rawSize-size)throw new Error('XEX import descriptor lies in unbacked PE virtual range');
    const raw=section.rawPointer+delta;
    if(raw>pe.bytes.length-size)throw new Error('XEX import descriptor raw offset out of bounds');
    return raw;
  }
  throw new Error('XEX import descriptor RVA is outside PE mappings');
}

export function decodeKernelImportRecords(xexBytes,preparedImage){
  const libraries=decodeXexImportLibraries(xexBytes);
  const prepared=Buffer.from(preparedImage);
  const pe=parsePreparedPe(prepared);
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
      const rawOffset=peRawOffsetForRva(pe,rva,4);
      const descriptor=be32(prepared,rawOffset);
      const type=(descriptor>>>24)&0xff;
      const ordinal=descriptor&0xffff;
      if(type!==0&&type!==1)throw new Error(`unsupported XEX import descriptor type ${type}`);
      records.push({recordAddress:recordAddress>>>0,rva,rawOffset,descriptor,type,ordinal});
    }
    const imports=[];
    for(const record of records){
      if(record.type===0){
        imports.push({module:library.name,ordinal:record.ordinal,kind:'variable',valueAddress:record.recordAddress,thunkAddress:0,descriptorAddress:record.recordAddress,descriptorRva:record.rva,descriptorRawOffset:record.rawOffset});
        continue;
      }
      const previous=imports[imports.length-1];
      if(!previous||previous.ordinal!==record.ordinal||previous.thunkAddress)throw new Error(`XEX import thunk has no matching descriptor: ${library.name} ordinal 0x${record.ordinal.toString(16)}`);
      previous.kind='function';
      previous.thunkAddress=record.recordAddress;
      previous.thunkRva=record.rva;
      previous.thunkRawOffset=record.rawOffset;
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
