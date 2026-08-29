const be16=(b,o)=>((b[o]<<8)|b[o+1])>>>0;
const be32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const KEY_IMPORT_LIBRARIES=0x000103ff;

export function decodeXexImportLibraries(xexBytes){
  const x=Buffer.from(xexBytes);
  if(x.length<0x18||x.toString('ascii',0,4)!=='XEX2')throw new Error('XEX import decode requires XEX2');
  const headerSize=be32(x,8),headerCount=be32(x,0x14);
  if(headerSize<0x18||headerSize>x.length||headerCount>((headerSize-0x18)>>>3))throw new Error('XEX optional header table out of bounds');
  let offset=0;
  for(let i=0;i<headerCount;i++){const p=0x18+i*8,key=be32(x,p),value=be32(x,p+4);if(key===KEY_IMPORT_LIBRARIES){offset=value;break;}}
  if(!offset)return [];
  if(offset>headerSize-12)throw new Error('XEX import header out of bounds');
  const totalSize=be32(x,offset),stringBytes=be32(x,offset+4),stringCount=be32(x,offset+8);
  if(totalSize<12||offset+totalSize>headerSize||12+stringBytes>totalSize||stringCount>256)throw new Error('XEX import header size invalid');
  const strings=[];let s=0;
  while(s<stringBytes&&strings.length<stringCount){const start=offset+12+s,endLimit=offset+12+stringBytes;let end=start;while(end<endLimit&&x[end]!==0)end++;if(end===endLimit)throw new Error('unterminated XEX import string');strings.push(x.toString('utf8',start,end));s+=(end-start)+1;if(s&3)s+=4-(s&3);}
  if(strings.length!==stringCount)throw new Error('XEX import string count mismatch');
  const libraries=[];let p=offset+12+stringBytes,end=offset+totalSize;
  while(p<end){if(end-p<0x28)throw new Error('truncated XEX import library');const size=be32(x,p);if(size===0)break;if(size<0x28||size>end-p)throw new Error('XEX import library size invalid');const nameIndex=be16(x,p+0x24)&0xff,count=be16(x,p+0x26);if(nameIndex>=strings.length)throw new Error('XEX import library name index invalid');if(0x28+count*4>size)throw new Error('XEX import table exceeds library record');const imports=[];for(let i=0;i<count;i++)imports.push(be32(x,p+0x28+i*4));libraries.push({name:strings[nameIndex],id:be32(x,p+0x18),version:be32(x,p+0x1c),versionMin:be32(x,p+0x20),imports});p+=size;}
  if(p>end)throw new Error('XEX import traversal overflow');
  return libraries;
}
