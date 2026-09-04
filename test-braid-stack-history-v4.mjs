import fs from 'node:fs';

const overlay=fs.readFileSync('prepare-hir-stack-history-v4-overlay.py','utf8');
const controller=fs.readFileSync('render360-title-controller.mjs','utf8');
const dev=fs.readFileSync('developer-console.js','utf8');

for(const marker of [
  'kR360StackHistoryCapacity = 24',
  'PushStackHistory(kR360StackHistoryWrite',
  'PushStackHistory(kR360StackHistoryCall',
  'r360_ppc_probe_stack_history_count',
  'r360_ppc_probe_stack_history_instruction',
]){
  if(!overlay.includes(marker))throw new Error(`stack history overlay marker missing: ${marker}`);
}

for(const marker of [
  'r360_ppc_probe_stack_history_count',
  'stackHistory',
  'sourceInstruction',
]){
  if(!controller.includes(marker))throw new Error(`title-controller history marker missing: ${marker}`);
}

for(const marker of [
  'knownPpcHelper',
  '__restgprlr_',
  'stackHistory',
]){
  if(!dev.includes(marker))throw new Error(`developer-console history marker missing: ${marker}`);
}

// Real-device blocker: 0xEB61FFD0 = ld r27,-48(r1), the first instruction of
// Xenia's known __restgprlr_27 helper sequence. Keep this decode grounded so a
// future refactor cannot turn the helper label into another guessed diagnosis.
const word=0xEB61FFD0>>>0;
const primary=word>>>26;
const rt=(word>>>21)&31;
const ra=(word>>>16)&31;
let ds=(word>>>2)&0x3FFF;if(ds&0x2000)ds-=0x4000;
const displacement=(ds<<2)|0;
const expectedRestDisp=-8*(33-rt);
if(primary!==58||rt!==27||ra!==1||displacement!==-48||displacement!==expectedRestDisp){
  throw new Error(`restgpr helper decode mismatch primary=${primary} rt=${rt} ra=${ra} disp=${displacement}`);
}

console.log('BRAID_STACK_HISTORY_V4=PASS');
console.log('BRAID_BLOCKER_HELPER=__restgprlr_27');
