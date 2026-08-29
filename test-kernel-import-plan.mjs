import { decodeKernelImportRecords, buildKernelImportPlan } from './render360-kernel-imports.mjs';

const p16be=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};
const p32be=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const p16le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255};
const p32le=(a,o,v)=>{a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255};
const ascii=(a,o,s)=>a.set(Buffer.from(s,'ascii'),o);
const base=0x72000000;

function preparedPe(){
  const a=Buffer.alloc(0x600),nt=0x80,opt=nt+24,sh=opt+224;
  ascii(a,0,'MZ');p32le(a,0x3c,nt);p32le(a,nt,0x00004550);p16le(a,nt+4,0x01F2);p16le(a,nt+6,1);p16le(a,nt+20,224);p16le(a,nt+22,0x0102);p16le(a,opt,0x10B);p32le(a,opt+16,0x1000);p32le(a,opt+28,base);p32le(a,opt+32,0x1000);p32le(a,opt+36,0x200);p32le(a,opt+56,0x3000);p32le(a,opt+60,0x200);p16le(a,opt+68,14);
  ascii(a,sh,'.text\0\0\0');p32le(a,sh+8,0x400);p32le(a,sh+12,0x1000);p32le(a,sh+16,0x400);p32le(a,sh+20,0x200);p32le(a,sh+36,0xE0000020);
  // Guest RVA 0x1100/0x1104/0x1200 map to raw 0x300/0x304/0x400.
  p32be(a,0x300,0x00000123);p32be(a,0x304,0x01000123);p32be(a,0x400,0x00000456);
  return a;
}

function fixture(){
  const x=Buffer.alloc(0x180);ascii(x,0,'XEX2');p32be(x,8,0x180);p32be(x,0x14,2);
  p32be(x,0x18,0x00010201);p32be(x,0x1c,base);
  p32be(x,0x20,0x000103ff);p32be(x,0x24,0x60);
  const o=0x60,stringBytes=24,total=0x80;p32be(x,o,total);p32be(x,o+4,stringBytes);p32be(x,o+8,2);
  ascii(x,o+12,'xboxkrnl.exe\0');ascii(x,o+28,'xam.xex\0');
  let p=o+12+stringBytes;
  p32be(x,p,0x30);p32be(x,p+0x18,1);p32be(x,p+0x1c,0x10000);p32be(x,p+0x20,0x10000);p16be(x,p+0x24,0);p16be(x,p+0x26,2);p32be(x,p+0x28,base+0x1100);p32be(x,p+0x2c,base+0x1104);p+=0x30;
  p32be(x,p,0x2c);p32be(x,p+0x18,2);p32be(x,p+0x1c,0x20000);p32be(x,p+0x20,0x20000);p16be(x,p+0x24,1);p16be(x,p+0x26,1);p32be(x,p+0x28,base+0x1200);
  return {x,prepared:preparedPe()};
}

const {x,prepared}=fixture();
const decoded=decodeKernelImportRecords(x,prepared);
if(decoded.imageBase!==base||decoded.libraries.length!==2)throw new Error('kernel import decode metadata mismatch');
const k=decoded.libraries[0].imports[0],v=decoded.libraries[1].imports[0];
if(k.kind!=='function'||k.ordinal!==0x123||k.valueAddress!==base+0x1100||k.thunkAddress!==base+0x1104||k.descriptorRawOffset!==0x300||k.thunkRawOffset!==0x304)throw new Error(`function pair mismatch ${JSON.stringify(k)}`);
if(v.kind!=='variable'||v.ordinal!==0x456||v.valueAddress!==base+0x1200||v.thunkAddress!==0||v.descriptorRawOffset!==0x400)throw new Error(`variable import mismatch ${JSON.stringify(v)}`);
console.log('KERNEL_IMPORT_DESCRIPTOR_DECODE=PASS');
console.log('KERNEL_IMPORT_PE_RVA_TO_RAW=PASS');
console.log('KERNEL_IMPORT_FUNCTION_THUNK_PAIR=PASS');
console.log('KERNEL_IMPORT_VARIABLE_DECODE=PASS');

let plan=buildKernelImportPlan(x,prepared);
if(!plan.firstKernelBlocker||plan.firstKernelBlocker.module!=='xboxkrnl.exe'||plan.firstKernelBlocker.ordinal!==0x123)throw new Error(`first kernel blocker mismatch ${JSON.stringify(plan.firstKernelBlocker)}`);
console.log('FIRST_KERNEL_BLOCKER_IDENTIFICATION=PASS');
plan=buildKernelImportPlan(x,prepared,{implementedExports:{'xboxkrnl.exe:291':()=>1}});
if(!plan.firstKernelBlocker||plan.firstKernelBlocker.module!=='xam.xex'||plan.firstKernelBlocker.ordinal!==0x456)throw new Error('implemented export did not advance blocker');
console.log('KERNEL_IMPORT_IMPLEMENTATION_ADVANCES_BLOCKER=PASS');

const bad=fixture();p32be(bad.prepared,0x304,0x01000999);let failed=false;try{decodeKernelImportRecords(bad.x,bad.prepared)}catch{failed=true}if(!failed)throw new Error('mismatched thunk ordinal did not fail closed');
console.log('KERNEL_IMPORT_MALFORMED_FAIL_CLOSED=PASS');

const zeroFill=fixture();p32be(zeroFill.x,0x60+12+24+0x28,base+0x1500);failed=false;try{decodeKernelImportRecords(zeroFill.x,zeroFill.prepared)}catch{failed=true}if(!failed)throw new Error('unbacked virtual import descriptor did not fail closed');
console.log('KERNEL_IMPORT_UNBACKED_VIRTUAL_FAIL_CLOSED=PASS');
