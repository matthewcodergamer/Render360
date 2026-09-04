import fs from 'node:fs';

const dev=fs.readFileSync('developer-console.js','utf8');
const controller=fs.readFileSync('render360-title-controller.mjs','utf8');
const overlay=fs.readFileSync('prepare-hir-call-return-stack-overlay.py','utf8');
for(const marker of ["instructionKind='ds-form-memory'",'primaryOpcode===58||primaryOpcode===62','stackDiagnosticSummary(summary.memory)','r360_ppc_probe_stack_blocker_r1']){
  if(!dev.includes(marker))throw new Error(`developer diagnostic marker missing: ${marker}`);
}
for(const marker of ['stackTraceRead','r360_ppc_probe_stack_blocker_r1','stackTrace,translatedFunctionCount']){
  if(!controller.includes(marker))throw new Error(`title snapshot marker missing: ${marker}`);
}
for(const marker of ['blocker_r1','r360_ppc_probe_stack_blocker_r1','r360_ppc_probe_stack_last_write_address','trace_exports_replacement']){
  if(!overlay.includes(marker))throw new Error(`HIR trace export marker missing: ${marker}`);
}
const word=0xEB61FFD0>>>0;
const primary=word>>>26;
const rt=(word>>>21)&31;
const ra=(word>>>16)&31;
let ds=(word>>>2)&0x3FFF;if(ds&0x2000)ds-=0x4000;
const displacement=(ds<<2)|0;
if(primary!==58||rt!==27||ra!==1||displacement!==-48){
  throw new Error(`Braid blocker DS decode mismatch primary=${primary} rt=${rt} ra=${ra} disp=${displacement}`);
}
const fault=0x70081020>>>0;
const base=(fault-displacement)>>>0;
if(base!==0x70081050)throw new Error(`Braid blocker r1 inference mismatch 0x${base.toString(16)}`);
console.log('BRAID_DS_FORM_BLOCKER_DECODE=PASS');
console.log('BRAID_STACK_TRACE_EXPORTS=PASS');
console.log('BRAID_BLOCKER_R1_EXPECTED=0x70081050');
