import {Render360Core} from './wasm-core-v32.js';
import {mountXboxIsoBrowser,loadRender360Bootstrap,handoffXboxIsoBrowser} from './render360-browser-title-runtime.mjs';

const $=id=>document.getElementById(id);
const fmt=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(2)} GB`;
const hex=n=>`0x${(Number(n)>>>0).toString(16).padStart(8,'0')}`;
let modernCore=null,modernBootstrap=null,busy=false;
function setText(id,text){const e=$(id);if(e)e.textContent=text;}
function boundary(title,text){setText('boundaryTitle',title);setText('boundaryText',text);}
async function core(){if(!modernCore){modernCore=new Render360Core();await modernCore.init();}return modernCore;}
async function bootstrap(){if(!modernBootstrap)modernBootstrap=await loadRender360Bootstrap();return modernBootstrap;}

async function runIso(file){
  if(busy)return;busy=true;
  try{
    boundary('Mounting Xbox disc image…','Reading XDVDFS metadata in bounded File/Blob ranges. The full ISO is not copied into memory.');
    const mounted=await mountXboxIsoBrowser(file);
    setText('gameType',`Xbox ISO · ${mounted.layout}`);setText('gameSize',fmt(file.size));
    boundary(`${mounted.layout} mounted · default.xex ${fmt(mounted.defaultXex.size)}`,'Loading the verified Xenia PPC/kernel/Xenos browser bootstrap and handing the real disc title into the XEX pipeline…');
    const [c,b]=await Promise.all([core(),bootstrap()]);
    const {result}=await handoffXboxIsoBrowser({core:c,file,bootstrap:b,entryBytes:256});
    const blocker=result.reachedKernelBlocker??result.firstKernelBlocker;
    const blockerText=blocker?`${blocker.module} ordinal 0x${Number(blocker.ordinal).toString(16)}${blocker.thunkAddress?` @ ${hex(blocker.thunkAddress)}`:''}`:result.runtimeBoundary;
    const gpu=result.browserHleTelemetry;
    if(gpu?.ringInitialized){
      const ringSize=gpu.ringBytes?fmt(gpu.ringBytes):`size_log2 ${gpu.ringSizeLog2}`;
      const locality=gpu.ringInActiveWindow?'ring is inside the active PPC window':'ring is outside the current 64 KiB PPC execution window';
      boundary('Real title initialized its Xenos ring',`XDVDFS ${result.discLayout} · entry ${hex(result.entry)} · real ring ${hex(gpu.ringBase)} · ${ringSize} · ${locality} · next execution boundary: ${blockerText}. The ring address came from the title's live VdInitializeRingBuffer ABI call; it is not guessed or synthetic.`);
      setText('frameGateState',gpu.ringInActiveWindow?'REAL RING CAPTURED':'REAL RING CAPTURED · MEMORY WINDOW NEXT');
    }else{
      boundary('Real ISO title reached the execution pipeline',`XDVDFS ${result.discLayout} · default.xex ${fmt(result.defaultXexBytes)} · entry ${hex(result.entry)} · HIR ${result.hir} · boundary: ${blockerText}. No title ring initialization has been observed yet; this remains a real-title bring-up trace, not a playable/frame claim.`);
      setText('frameGateState','REAL TITLE: NEXT BLOCKER');
    }
  }catch(error){boundary('Real ISO title bring-up stopped',error?.message??String(error));setText('frameGateState','BLOCKED · SEE MESSAGE');}
  finally{busy=false;}
}

const input=$('gameInput');
if(input)input.addEventListener('change',event=>{const file=event.target.files?.[0];if(file&&/\.iso$/i.test(file.name||''))runIso(file);});
