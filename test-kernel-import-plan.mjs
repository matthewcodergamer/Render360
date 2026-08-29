import { decodeKernelImportRecords, buildKernelImportPlan } from './render360-kernel-imports.mjs';

const p16=(a,o,v)=>{a[o]=(v>>>8)&255;a[o+1]=v&255};
const p32=(a,o,v)=>{a[o]=(v>>>24)&255;a[o+1]=(v>>>16)&255;a[o+2]=(v>>>8)&255;a[o+3]=v&255};
const ascii=(a,o,s)=>a.set(Buffer.from(s,'ascii'),o);
const base=0x82000000;

function fixture(){
  const x=Buffer.alloc(0x180);ascii(x,0,'XEX2');p32(x,8,0x180);p32(x,0x14,2);
  p32(x,0x18,0x00010201);p32(x,0x1c,base);
  p32(x,0x20,0x000103ff);p32(x,0x24,0x60);
  const o=0x60,stringBytes=24,total=0x80;p32(x,o,total);p32(x,o+4,stringBytes);p32(x,o+8,2);
  ascii(x,o+12,'xboxkrnl.exe\0');ascii(x,o+28,'xam.xex\0');
  let p=o+12+stringBytes;
  p32(x,p,0x30);p32(x,p+0x18,1);p32(x,p+0x1c,0x10000);p32(x,p+0x20,0x10000);p16(x,p+0x24,0);p16(x,p+0x26,2);p32(x,p+0x28,base+0x100);p32(x,p+0x2c,base+0x104);p+=0x30;
  p32(x,p,0x2c);p32(x,p+0x18,2);p32(x,p+0x1c,0x20000);p32(x,p+0x20,0x20000);p16(x,p+0x24,1);p16(x,p+0x26,1);p32(x,p+0x28,base+0x200);
  const prepared=Buffer.alloc(0x400);
  p32(prepared,0x100,0x00000123);p32(prepared,0x104,0x01000123);p32(prepared,0x200,0x00000456);
  return {x,prepared};
}

const {x,prepared}=fixture();
const decoded=decodeKernelImportRecords(x,prepared);
if(decoded.imageBase!==base||decoded.libraries.length!==2)throw new Error('kernel import decode metadata mismatch');
const k=decoded.libraries[0].imports[0],v=decoded.libraries[1].imports[0];
if(k.kind!=='function'||k.ordinal!==0x123||k.valueAddress!==base+0x100||k.thunkAddress!==base+0x104)throw new Error(`function pair mismatch ${JSON.stringify(k)}`);
if(v.kind!=='variable'||v.ordinal!==0x456||v.valueAddress!==base+0x200||v.thunkAddress!==0)throw new Error(`variable import mismatch ${JSON.stringify(v)}`);
console.log('KERNEL_IMPORT_DESCRIPTOR_DECODE=PASS');
console.log('KERNEL_IMPORT_FUNCTION_THUNK_PAIR=PASS');
console.log('KERNEL_IMPORT_VARIABLE_DECODE=PASS');

let plan=buildKernelImportPlan(x,prepared);
if(!plan.firstKernelBlocker||plan.firstKernelBlocker.module!=='xboxkrnl.exe'||plan.firstKernelBlocker.ordinal!==0x123)throw new Error(`first kernel blocker mismatch ${JSON.stringify(plan.firstKernelBlocker)}`);
console.log('FIRST_KERNEL_BLOCKER_IDENTIFICATION=PASS');

plan=buildKernelImportPlan(x,prepared,{implementedExports:{'xboxkrnl.exe:291':()=>1}});
if(!plan.firstKernelBlocker||plan.firstKernelBlocker.module!=='xam.xex'||plan.firstKernelBlocker.ordinal!==0x456)throw new Error('implemented export did not advance blocker');
console.log('KERNEL_IMPORT_IMPLEMENTATION_ADVANCES_BLOCKER=PASS');

const bad=fixture();p32(bad.prepared,0x104,0x01000999);let failed=false;try{decodeKernelImportRecords(bad.x,bad.prepared)}catch{failed=true}if(!failed)throw new Error('mismatched thunk ordinal did not fail closed');
console.log('KERNEL_IMPORT_MALFORMED_FAIL_CLOSED=PASS');
