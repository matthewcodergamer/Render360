import {Render360Core} from './wasm-core-v32.js';
import {mountXboxIsoBrowser,loadRender360Bootstrap,handoffXboxIsoBrowser} from './render360-browser-title-runtime.mjs';

const $=id=>document.getElementById(id);
const fmt=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(2)} GB`;
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
    const blockerText=blocker?`${blocker.module} ordinal 0x${Number(blocker.ordinal).toString(16)}${blocker.thunkAddress?` @ 0x${Number(blocker.thunkAddress).toString(16)}`:''}`:result.runtimeBoundary;
    boundary('Real ISO title reached the execution pipeline',`XDVDFS ${result.discLayout} · default.xex ${fmt(result.defaultXexBytes)} · entry 0x${result.entry.toString(16)} · HIR ${result.hir} · boundary: ${blockerText}. This is a real-title bring-up trace, not a playable/frame claim.`);
    setText('frameGateState','REAL TITLE: NEXT BLOCKER');
  }catch(error){boundary('Real ISO title bring-up stopped',error?.message??String(error));setText('frameGateState','BLOCKED · SEE MESSAGE');}
  finally{busy=false;}
}

const input=$('gameInput');
if(input)input.addEventListener('change',event=>{const file=event.target.files?.[0];if(file&&/\.iso$/i.test(file.name||''))runIso(file);});
