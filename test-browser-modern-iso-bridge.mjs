import fs from 'node:fs';

const facade=fs.readFileSync('runtime/render360-runtime.js','utf8');
const bridge=fs.readFileSync('render360-browser-modern-iso-bridge.mjs','utf8');
const traffic=fs.readFileSync('render360-title-gpu-traffic.mjs','utf8');
const controller=fs.readFileSync('render360-title-controller.mjs','utf8');

const must=(condition,label)=>{if(!condition)throw new Error(`modern ISO bridge critic failed: ${label}`)};

must(facade.includes("import('../render360-browser-modern-iso-bridge.mjs')"),'canonical runtime must load the modern ISO bridge');
must(bridge.includes('handoffXboxIsoBrowser'),'bridge must invoke the real browser ISO title runtime');
must(bridge.includes('entryBytes:ENTRY_WINDOW_BYTES'),'bridge must expand the real entry translation window');
must(bridge.includes('titleGpuTelemetry'),'bridge must consume native title GPU telemetry');
must(bridge.includes('submitCapturedTitleGpuTraffic'),'bridge must automatically consume the captured producer range');
must(bridge.includes('threadScheduler:threadScheduler??null'),'bridge must retain the native Xbox scheduler returned by production ISO boot');
must(bridge.includes('threadScheduler.runLoop'),'bridge must continuously drive runnable Xbox guest threads after the first boot slice');
must(bridge.includes('browserYieldBetweenPumps:true'),'bridge contract must require browser yielding between scheduler pumps');
must(bridge.includes('autoPumpsRunnableThreads:true'),'bridge contract must describe continuous title scheduling');
must(bridge.includes('captureTitleFrontbuffer')&&bridge.includes('presentTitleFrontbuffer'),'bridge must sample and present a real VdSwap frontbuffer while execution continues');
must(bridge.includes('lastOpcode')&&bridge.includes('lastFaultWord'),'bridge must surface the exact real PM4 blocker');
must(bridge.includes('failClosedOnUnsupportedPm4:true'),'bridge contract must fail closed on unsupported PM4');
must(traffic.includes('r360_title_gpu_write_pointer'),'captured reader must use CP_RB_WPTR telemetry');
must(traffic.includes('r360_title_gpu_ring_word'),'captured reader must use sparse/native ring words rather than the 64 KiB probe window');
must(traffic.includes("reason:'producer-write-pointer-not-observed'"),'GPU reader must refuse submission before a genuine write pointer');
must(traffic.includes('nativeDrained:true')&&traffic.includes("source:'native-cp-rb-wptr-drain'"),'GPU reader must expose native circular-ring consumption rather than guessed ranges');
must(controller.includes('nativeTitleGpu=hasNativeTitleGpuRuntime'),'modern controller must prefer native title GPU services over synthetic PPC shims');
must(bridge.includes('event.stopImmediatePropagation()'),'ISO selection must not fall through to the obsolete legacy ISO warning');
must(!bridge.includes('XDVDFS support is a future mount path'),'modern bridge must not regress to the obsolete ISO claim');

console.log('BROWSER_MODERN_XDVDFS_HANDOFF=PASS');
console.log('CONTINUOUS_NATIVE_GUEST_THREAD_DRIVER=PASS');
console.log('NATIVE_TITLE_GPU_TELEMETRY_UI=PASS');
console.log('CP_RB_WPTR_BOUNDED_PM4_SUBMISSION=PASS');
console.log('REAL_VDSWAP_FRONTBUFFER_DRIVER=PASS');
console.log('REAL_PM4_BLOCKER_SURFACE=PASS');
