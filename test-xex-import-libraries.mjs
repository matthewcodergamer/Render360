import { decodeXexImportLibraries } from './render360-xex-imports.mjs';

const p16=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};
const p32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const ascii=(a,o,s)=>a.set(Buffer.from(s,'ascii'),o);

function fixture(){
  const x=Buffer.alloc(0x100);ascii(x,0,'XEX2');p32(x,8,0x100);p32(x,0x14,1);p32(x,0x18,0x000103ff);p32(x,0x1c,0x40);
  const o=0x40,stringBytes=24,total=0x80;p32(x,o,total);p32(x,o+4,stringBytes);p32(x,o+8,2);
  ascii(x,o+12,'xboxkrnl.exe\0');ascii(x,o+28,'xam.xex\0');
  let p=o+12+stringBytes;
  p32(x,p,0x30);p32(x,p+0x18,0x11111111);p32(x,p+0x1c,0x00010002);p32(x,p+0x20,0x00010000);p16(x,p+0x24,0);p16(x,p+0x26,2);p32(x,p+0x28,0x82001000);p32(x,p+0x2c,0x82001004);p+=0x30;
  p32(x,p,0x2c);p32(x,p+0x18,0x22222222);p32(x,p+0x1c,0x00020003);p32(x,p+0x20,0x00020000);p16(x,p+0x24,1);p16(x,p+0x26,1);p32(x,p+0x28,0x82002000);
  return x;
}
const libs=decodeXexImportLibraries(fixture());
if(libs.length!==2||libs[0].name!=='xboxkrnl.exe'||libs[1].name!=='xam.xex')throw new Error(`library names mismatch ${JSON.stringify(libs)}`);
if(libs[0].imports.length!==2||libs[0].imports[0]!==0x82001000||libs[0].imports[1]!==0x82001004||libs[1].imports[0]!==0x82002000)throw new Error(`import table mismatch ${JSON.stringify(libs)}`);
console.log('XEX_IMPORT_STRING_TABLE=PASS');
console.log('XEX_IMPORT_LIBRARY_RECORDS=PASS');
console.log('XEX_IMPORT_XBOXKRNL_XAM_IDENTIFICATION=PASS');

const bad=fixture();p16(bad,0x40+12+24+0x24,9);let failed=false;try{decodeXexImportLibraries(bad)}catch{failed=true}if(!failed)throw new Error('bad import name index did not fail closed');
console.log('XEX_IMPORT_MALFORMED_FAIL_CLOSED=PASS');
