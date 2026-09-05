import fs from 'node:fs';

const overlay=fs.readFileSync('prepare-hir-stack-history-overlay.py','utf8');
const build=fs.readFileSync('build-xenia-ppc-bootstrap.sh','utf8');
const titleRuntimeOverlay=fs.readFileSync('prepare-title-runtime-memory-overlay.py','utf8');
const controller=fs.readFileSync('render360-title-controller.mjs','utf8');
const dev=fs.readFileSync('developer-console.js','utf8');

const orderedOverlays=[
  'prepare-title-runtime-memory-overlay.py',
  'prepare-hir-call-return-stack-overlay.py',
  'prepare-hir-return-metadata-v3-overlay.py',
  'prepare-hir-stack-history-overlay.py',
  'prepare-hir-tail-frame-overlay.py',
];
let previous=-1;
for(const marker of orderedOverlays){
  const index=build.indexOf(marker);
  if(index<0)throw new Error(`build overlay ordering missing ${marker}`);
  if(index<=previous)throw new Error(`build overlay order is wrong at ${marker}`);
  previous=index;
}
if(titleRuntimeOverlay.includes('subprocess.run(')){
  throw new Error('title runtime memory overlay must not recursively re-run HIR overlays');
}

for(const marker of ['r360_ppc_probe_stack_write_count','r360_ppc_probe_stack_call_count','g_r360_stack_event_sequence','RecordStackWriteHistory','RecordStackCallHistory']){
  if(!overlay.includes(marker))throw new Error(`history overlay missing ${marker}`);
}
for(const marker of ['stackTrace.writeHistory','stackTrace.callHistory','r360_ppc_probe_stack_write_sequence','r360_ppc_probe_stack_call_flags']){
  if(!controller.includes(marker))throw new Error(`title snapshot missing ${marker}`);
}
for(const marker of ['FRAME_ENTRY_MISSING_PROLOGUE','Stack / call timeline','PPC around title entry','matchingAllocation','missingAllocation']){
  if(!dev.includes(marker))throw new Error(`problem-first console missing ${marker}`);
}
console.log('BRAID_FRAME_HISTORY_CONTRACT=PASS');
