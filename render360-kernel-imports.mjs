import { decodeXexImportLibraries } from './render360-xex-imports.mjs';

const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
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

export function decodeKernelImportRecords(xexBytes,preparedImage){
  const libraries=decodeXexImportLibraries(xexBytes);
  const prepared=Buffer.from(preparedImage);
  const imageBase=imageBaseFromXex(xexBytes);
  const decoded=[];
  for(const library of libraries){
    const module=library.name.toLowerCase();
    const records=[];
    for(const recordAddress of library.imports){
      const relative=Number(BigInt(recordAddress>>>0)-BigInt(imageBase>>>0));
      if(relative<0||relative+4>prepared.length)throw new Error(`XEX import descriptor outside prepared image: ${library.name}@0x${(recordAddress>>>0).toString(16)}`);
      const descriptor=be32(prepared,relative);
      const type=(descriptor>>>24)&0xff;
      const ordinal=descriptor&0xffff;
      if(type!==0&&type!==1)throw new Error(`unsupported XEX import descriptor type ${type}`);
      records.push({recordAddress:recordAddress>>>0,descriptor,type,ordinal});
    }
    const imports=[];
    for(const record of records){
      if(record.type===0){
        imports.push({module:library.name,ordinal:record.ordinal,kind:'variable',valueAddress:record.recordAddress,thunkAddress:0,descriptorAddress:record.recordAddress});
        continue;
      }
      const previous=imports[imports.length-1];
      if(!previous||previous.ordinal!==record.ordinal||previous.thunkAddress)throw new Error(`XEX import thunk has no matching descriptor: ${library.name} ordinal 0x${record.ordinal.toString(16)}`);
      previous.kind='function';
      previous.thunkAddress=record.recordAddress;
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
