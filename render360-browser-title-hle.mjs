const pick=(e,n)=>e[n]??e[`_${n}`];

const WINDOW_BYTES=64*1024;
const SHIM_BASE_OFFSET=0xF000;
const TELEMETRY_OFFSET=0xFF00;
const BLR=0x4E800020;

const OPCODE_ADDI=14;
const OPCODE_ADDIS=15;
const OPCODE_ORI=24;
const OPCODE_ORIS=25;
const OPCODE_STW=36;
const dform=(opcode,rt,ra,imm)=>((opcode<<26)|(rt<<21)|(ra<<16)|(imm&0xffff))>>>0;
const lis=(rt,imm)=>dform(OPCODE_ADDIS,rt,0,imm);
const li=(rt,imm)=>dform(OPCODE_ADDI,rt,0,imm);
const ori=(ra,rs,imm)=>dform(OPCODE_ORI,rs,ra,imm);
const oris=(ra,rs,imm)=>dform(OPCODE_ORIS,rs,ra,imm);
const stw=(rs,ra,d)=>dform(OPCODE_STW,rs,ra,d);

function requireExport(e,n){const f=pick(e,n);if(typeof f!=='function')throw new Error(`missing browser title HLE export ${n}`);return f;}
function add32(a,b){const v=BigInt(a>>>0)+BigInt(b>>>0);if(v>0xffffffffn)throw new RangeError('browser title HLE address wraps uint32');return Number(v)>>>0;}
function addressWords(reg,address){
  // Xbox 360 guest pointers are 32-bit values carried in 64-bit PPC GPRs.
  // `lis reg, 0x8xxx..0xffff` sign-extends on PPC64, producing
  // 0xffffffffXXXXXXXX and making otherwise valid high guest addresses fail
  // the sparse-memory uint32 boundary. Build the address from zero with
  // OR-immediate-shifted instead, which preserves the required zero extension.
  return [li(reg,0),oris(reg,reg,(address>>>16)&0xffff),ori(reg,reg,address&0xffff)];
}
function constantReturn(value){value>>>=0;return [...addressWords(3,value),BLR];}
function capturePair(destination){return [...addressWords(11,destination),stw(3,11,0),stw(4,11,4),BLR];}

function writeWords(e,address,words){
  const write=requireExport(e,'r360_ppc_probe_write_guest_u32_be');
  for(let i=0;i<words.length;i++)if((write(add32(address,i*4),words[i]>>>0)>>>0)!==1)throw new Error(`failed to install browser title HLE word @ 0x${add32(address,i*4).toString(16)}`);
}

function primeTitleWindow(e,entry){
  const input=requireExport(e,'r360_ppc_probe_input_buffer')()>>>0;
  const cap=requireExport(e,'r360_ppc_probe_input_capacity')()>>>0;
  const loadAt=requireExport(e,'r360_ppc_probe_load_at');
  if(!input||cap<4)throw new Error('browser title HLE staging buffer unavailable');
  new Uint8Array(e.memory.buffer,input,4).set([0x4e,0x80,0x00,0x20]);
  if((loadAt(entry>>>0,input,4)>>>0)!==4)throw new Error('failed to prime relocated title PPC window for HLE shims');
}

export function installBrowserTitleHle({bootstrap,entry}){
  if(!bootstrap?.exports)throw new TypeError('bootstrap instance required');
  if(!Number.isInteger(entry)||entry<0||entry>0xffffffff)throw new RangeError('title entry must be uint32');
  const e=bootstrap.exports;primeTitleWindow(e,entry>>>0);
  const windowEnd=BigInt(entry>>>0)+BigInt(WINDOW_BYTES);if(windowEnd>0x100000000n)throw new RangeError('title entry leaves no complete browser HLE window');

  const telemetry=add32(entry,TELEMETRY_OFFSET);
  const addresses={
    mmGetPhysicalAddress:add32(entry,SHIM_BASE_OFFSET+0x000),
    queryPerformanceFrequency:add32(entry,SHIM_BASE_OFFSET+0x020),
    xGetLanguage:add32(entry,SHIM_BASE_OFFSET+0x040),
    vdInitializeRingBuffer:add32(entry,SHIM_BASE_OFFSET+0x080),
    vdEnableRingBufferRPtrWriteBack:add32(entry,SHIM_BASE_OFFSET+0x0C0),
    vdInitializeEngines:add32(entry,SHIM_BASE_OFFSET+0x100),
    vdGetGraphicsAsicID:add32(entry,SHIM_BASE_OFFSET+0x120),
    vdEnableDisableClockGating:add32(entry,SHIM_BASE_OFFSET+0x140),
    vdIsHSIOTrainingSucceeded:add32(entry,SHIM_BASE_OFFSET+0x160),
    vdQueryVideoFlags:add32(entry,SHIM_BASE_OFFSET+0x180),
    vdSetDisplayMode:add32(entry,SHIM_BASE_OFFSET+0x1A0),
    vdSetDisplayModeOverride:add32(entry,SHIM_BASE_OFFSET+0x1C0),
  };
  const telemetryAddresses={ringBase:telemetry,ringSizeLog2:add32(telemetry,4),rptrWriteback:add32(telemetry,8),rptrBlockSizeLog2:add32(telemetry,12)};
  for(const address of Object.values(telemetryAddresses))writeWords(e,address,[0]);

  // MmGetPhysicalAddress: this bounded browser stage uses the guest-visible
  // address directly, so preserving r3 is the correct identity mapping.
  writeWords(e,addresses.mmGetPhysicalAddress,[BLR]);
  writeWords(e,addresses.queryPerformanceFrequency,constantReturn(50000000));
  writeWords(e,addresses.xGetLanguage,[li(3,1),BLR]);
  writeWords(e,addresses.vdInitializeRingBuffer,capturePair(telemetryAddresses.ringBase));
  writeWords(e,addresses.vdEnableRingBufferRPtrWriteBack,capturePair(telemetryAddresses.rptrWriteback));
  writeWords(e,addresses.vdInitializeEngines,[li(3,1),BLR]);
  writeWords(e,addresses.vdGetGraphicsAsicID,[li(3,0x11),BLR]);
  writeWords(e,addresses.vdEnableDisableClockGating,[li(3,0),BLR]);
  writeWords(e,addresses.vdIsHSIOTrainingSucceeded,[li(3,1),BLR]);
  writeWords(e,addresses.vdQueryVideoFlags,[li(3,3),BLR]);
  writeWords(e,addresses.vdSetDisplayMode,[li(3,0),BLR]);
  writeWords(e,addresses.vdSetDisplayModeOverride,[li(3,0),BLR]);

  const implementedKernelExports={
    // xboxkrnl ordinals match upstream Xenia's xboxkrnl_table.inc.
    'xboxkrnl.exe:131':{r3:addresses.queryPerformanceFrequency},       // KeQueryPerformanceFrequency 0x83
    'xboxkrnl.exe:190':{r3:addresses.mmGetPhysicalAddress},            // MmGetPhysicalAddress 0xBE
    'xboxkrnl.exe:436':{r3:addresses.vdEnableDisableClockGating},      // VdEnableDisableClockGating 0x1B4
    'xboxkrnl.exe:438':{r3:addresses.vdEnableRingBufferRPtrWriteBack}, // VdEnableRingBufferRPtrWriteBack 0x1B6
    'xboxkrnl.exe:444':{r3:addresses.vdGetGraphicsAsicID},             // VdGetGraphicsAsicID 0x1BC
    'xboxkrnl.exe:450':{r3:addresses.vdInitializeEngines},             // VdInitializeEngines 0x1C2
    'xboxkrnl.exe:451':{r3:addresses.vdInitializeRingBuffer},          // VdInitializeRingBuffer 0x1C3
    'xboxkrnl.exe:454':{r3:addresses.vdIsHSIOTrainingSucceeded},       // VdIsHSIOTrainingSucceeded 0x1C6
    'xboxkrnl.exe:457':{r3:addresses.vdQueryVideoFlags},               // VdQueryVideoFlags 0x1C9
    'xboxkrnl.exe:467':{r3:addresses.vdSetDisplayMode},                // VdSetDisplayMode 0x1D3
    'xboxkrnl.exe:468':{r3:addresses.vdSetDisplayModeOverride},        // VdSetDisplayModeOverride 0x1D4
    'xam.xex:973':{r3:addresses.xGetLanguage},                         // XGetLanguage 0x3CD
  };
  return {windowBase:entry>>>0,windowBytes:WINDOW_BYTES,addresses,telemetryAddresses,implementedKernelExports};
}

export function readBrowserTitleHleTelemetry({bootstrap,hle}){
  if(!bootstrap?.exports||!hle?.telemetryAddresses)throw new TypeError('installed browser title HLE required');
  const read=requireExport(bootstrap.exports,'r360_ppc_probe_read_guest_u32_be');
  const get=name=>read(hle.telemetryAddresses[name]>>>0)>>>0;
  const ringBase=get('ringBase'),ringSizeLog2=get('ringSizeLog2'),rptrWriteback=get('rptrWriteback'),rptrBlockSizeLog2=get('rptrBlockSizeLog2');
  let ringBytes=0,ringWordCapacity=0;
  if(ringSizeLog2<29){ringBytes=2**(ringSizeLog2+3);ringWordCapacity=ringBytes/4;}
  const ringInActiveWindow=!!ringBase&&ringBase>=hle.windowBase&&BigInt(ringBase)+BigInt(Math.max(4,ringBytes||4))<=BigInt(hle.windowBase)+BigInt(hle.windowBytes);
  return {ringInitialized:!!ringBase,ringBase,ringSizeLog2,ringBytes,ringWordCapacity,ringInActiveWindow,rptrWriteback,rptrBlockSizeLog2};
}

export function browserTitleHleContract(){return {kind:'relocated-ppc-abi-shims',windowBytes:WINDOW_BYTES,captures:['VdInitializeRingBuffer','VdEnableRingBufferRPtrWriteBack'],identity:['MmGetPhysicalAddress'],graphicsBootstrap:true};}
