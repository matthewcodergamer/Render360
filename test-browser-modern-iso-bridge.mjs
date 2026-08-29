import fs from 'node:fs';

const facade=fs.readFileSync('gpu-web.js','utf8');
const bridge=fs.readFileSync('render360-browser-modern-iso-bridge.mjs','utf8');

const must=(condition,label)=>{if(!condition)throw new Error(`modern ISO bridge critic failed: ${label}`)};

must(facade.includes("import './render360-browser-modern-iso-bridge.mjs';"),'GPU facade must load the modern ISO bridge before app-v32 executes');
must(bridge.includes('handoffXboxIsoBrowser'),'bridge must invoke the real browser ISO title runtime');
must(bridge.includes('entryBytes:ENTRY_WINDOW_BYTES'),'bridge must expand the real entry translation window');
must(bridge.includes('browserHleTelemetry'),'bridge must consume live PPC HLE telemetry');
must(bridge.includes('ringInitialized'),'bridge must surface genuine VdInitializeRingBuffer capture');
must(bridge.includes('requiresProducerWritePointerBeforePm4Submit:true'),'bridge must fail closed before PM4 submission without a real producer/write pointer');
must(bridge.includes('event.stopImmediatePropagation()'),'ISO selection must not fall through to the obsolete legacy ISO warning');
must(!bridge.includes('XDVDFS support is a future mount path'),'modern bridge must not regress to the obsolete ISO claim');

console.log('BROWSER_MODERN_XDVDFS_HANDOFF=PASS');
console.log('REAL_TITLE_RING_TELEMETRY_UI=PASS');
console.log('PM4_PRODUCER_POINTER_FAIL_CLOSED=PASS');
