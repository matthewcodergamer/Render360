import {Render360Core, containerName, compressionName, encryptionName} from './wasm-core.js';
import {WebGraphicsHost} from './gpu-web.js';

const $ = id => document.getElementById(id);
const logs = [];
const core = new Render360Core();
const gpu = new WebGraphicsHost($('gpuCanvas'), log);

function log(level, ...parts) {
  const stamp = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  const text = `${stamp}  ${level.toUpperCase()}  ${parts.join(' ')}`;
  logs.push({level,text});
  if (logs.length > 700) logs.shift();
  renderLogs();
}

function renderLogs(){
  $('logCount').textContent = String(logs.length);
  $('consoleBody').innerHTML = logs.map(x=>`<div class="log ${x.level}">${escapeHtml(x.text)}</div>`).join('');
  $('consoleBody').scrollTop = $('consoleBody').scrollHeight;
}

function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function formatBytes(n){if(n<1024)return `${n} B`;if(n<1048576)return `${(n/1024).toFixed(1)} KB`;if(n<1073741824)return `${(n/1048576).toFixed(1)} MB`;return `${(n/1073741824).toFixed(2)} GB`}
function hex(n, width=8){return `0x${(n>>>0).toString(16).toUpperCase().padStart(width,'0')}`}
function openSheet(id){$('scrim').classList.remove('hidden');$(id).classList.remove('hidden')}
function closeSheets(){$('scrim').classList.add('hidden');$('consoleSheet').classList.add('hidden');$('statusSheet').classList.add('hidden')}

function setDetail(id, value){ $(id).textContent = value; }
function resetXexDetails(){
  $('xexDetails').classList.add('hidden');
  for (const id of ['xexTitleId','xexEntry','xexImageBase','xexHeaderSize','xexSecurity','xexOptCount','xexCompression','xexEncryption','xexImageSize','xexLoadAddress']) setDetail(id,'—');
}

function showXexDetails(x) {
  $('xexDetails').classList.remove('hidden');
  setDetail('xexTitleId', x.titleId ? hex(x.titleId) : 'Not found');
  setDetail('xexEntry', x.entryPoint ? hex(x.entryPoint) : 'Not found');
  setDetail('xexImageBase', x.imageBase ? hex(x.imageBase) : 'Not found');
  setDetail('xexHeaderSize', x.headerSize ? formatBytes(x.headerSize) : '—');
  setDetail('xexSecurity', x.securityOffset ? hex(x.securityOffset) : '—');
  setDetail('xexOptCount', String(x.headerCount ?? 0));
  setDetail('xexCompression', x.compressionType === 0xFFFFFFFF ? 'Not found' : compressionName(x.compressionType));
  setDetail('xexEncryption', x.encryptionType === 0xFFFFFFFF ? 'Not found' : encryptionName(x.encryptionType));
  setDetail('xexImageSize', x.imageSize ? formatBytes(x.imageSize) : 'Not parsed');
  setDetail('xexLoadAddress', x.loadAddress ? hex(x.loadAddress) : 'Not parsed');
}

async function boot(){
  log('ok','Render360 Xenia-Web V28 starting');
  try{
    await core.init();
    $('wasmStatus').textContent='ONLINE';
    $('buildStatus').textContent=`V${core.buildVersion}`;
    $('abiStatus').textContent=`${core.abiVersion>>>16}.${core.abiVersion&0xFFFF}`;
    log('ok',`WASM build V${core.buildVersion} · ABI 0x${core.abiVersion.toString(16).padStart(8,'0')} · features 0x${core.featureBits.toString(16)}`);
  } catch(e){
    $('wasmStatus').textContent='FAILED'; $('abiStatus').textContent='—'; $('buildStatus').textContent='V28';
    log('error',e.message);
  }
  try{
    const backend=await gpu.init(); $('gpuStatus').textContent=backend.toUpperCase();
  } catch(e){ $('gpuStatus').textContent='FAILED'; log('error',e.message); }
}

$('gameInput').addEventListener('change', async e=>{
  const file=e.target.files?.[0]; if(!file)return;
  resetXexDetails();
  if(!core.exports){log('error','Cannot inspect file: WASM core is offline');return}
  try{
    const probe=await core.probeFile(file), name=containerName(probe.kind);
    $('gameName').textContent=file.name||'Xbox 360 content';
    $('gameType').textContent=name;
    $('gameSize').textContent=formatBytes(file.size);
    $('gameCore').textContent=`WASM V${core.buildVersion}`;
    $('emptyState').classList.add('hidden'); $('gameState').classList.remove('hidden');

    if(probe.kind===1||probe.kind===2){
      const x=probe.xex;
      showXexDetails(x);
      if(x.inspectStatus===1){
        $('boundaryTitle').textContent=`${name} header validated in WASM`;
        $('boundaryText').textContent='V28 now reads Xenia-aligned XEX header, execution-info, file-format and XEX2 security metadata. Decryption/decompression, PE mapping, imports and execution remain the next native milestones.';
        log('ok',`${name} validated · flags ${hex(x.moduleFlags)} · header ${hex(x.headerSize)} · security ${hex(x.securityOffset)} · optional ${x.headerCount}`);
        if(x.titleId) log('ok',`XEX execution info · title ${hex(x.titleId)} · media ${hex(x.mediaId)} · entry ${hex(x.entryPoint)} · image base ${hex(x.imageBase)}`);
        if(x.compressionType!==0xFFFFFFFF) log('info',`XEX file format · compression ${compressionName(x.compressionType)} (${x.compressionType}) · encryption ${encryptionName(x.encryptionType)} (${x.encryptionType})`);
      } else if(x.inspectStatus===2){
        $('boundaryTitle').textContent=`${name} header needs more bytes`;
        $('boundaryText').textContent='The XEX magic is valid but the staged WASM prefix was not large enough for the complete header table.';
        log('warn',`${name} header truncated in staged prefix · ${probe.bytesRead} bytes staged`);
      } else {
        $('boundaryTitle').textContent=`${name} header rejected`;
        $('boundaryText').textContent='The XEX magic matched, but structural validation failed. Render360 is not treating malformed header state as a successful boot.';
        log('error',`${name} structural validation failed · status ${x.inspectStatus}`);
      }
    } else if(probe.kind>=10&&probe.kind<=12){
      $('boundaryTitle').textContent=`${name} package recognized`;
      $('boundaryText').textContent='STFS package mounting is not in the native core yet. V28 keeps this strict rather than replacing Xenia VFS behavior with a JavaScript guess.';
      log('ok',`${name} package magic recognized · ${formatBytes(file.size)}`);
    } else if(probe.kind===20){
      $('boundaryTitle').textContent='PowerPC ELF recognized';
      $('boundaryText').textContent='CPU execution is intentionally not faked. The next CPU milestone is a browser-compatible Xenia execution backend.';
      log('ok','PowerPC ELF recognized');
    } else {
      $('boundaryTitle').textContent='Unknown Xbox container';
      $('boundaryText').textContent='No supported Xbox container magic was recognized by the native WASM core.';
      log('warn',`Unknown container · first ${probe.bytesRead} bytes inspected`);
    }
  }catch(err){log('error',`File probe failed: ${err.message}`)}
});

$('ejectButton').onclick=()=>{
  $('gameInput').value=''; $('gameState').classList.add('hidden'); $('emptyState').classList.remove('hidden'); resetXexDetails(); log('ok','Container ejected');
};
$('consoleButton').onclick=()=>openSheet('consoleSheet');
$('settingsButton').onclick=()=>openSheet('statusSheet');
$('closeConsole').onclick=closeSheets; $('closeStatus').onclick=closeSheets; $('scrim').onclick=closeSheets;
$('clearLogs').onclick=()=>{logs.length=0;renderLogs()};
$('copyLogs').onclick=async()=>{try{await navigator.clipboard.writeText(logs.map(x=>x.text).join('\n'));log('ok','Console copied')}catch{log('warn','Clipboard permission unavailable')}};
document.querySelectorAll('.control').forEach(btn=>{const down=e=>{e.preventDefault();btn.classList.add('pressed')},up=e=>{e.preventDefault();btn.classList.remove('pressed')};btn.addEventListener('pointerdown',down);btn.addEventListener('pointerup',up);btn.addEventListener('pointercancel',up);btn.addEventListener('pointerleave',up)});

boot();
