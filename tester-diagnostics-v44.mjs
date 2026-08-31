// Render360 V44 tester diagnostics.
//
// Goal: make every tester run produce a small, privacy-conscious technical
// envelope that can be sent to the Render360 issue inbox without embedding a
// GitHub token in the public web app. A future owner-controlled HTTPS collector
// can be configured through window.RENDER360_DIAGNOSTICS_ENDPOINT and the same
// client will POST to it automatically.

const REPO='matthewcodergamer/Render360';
const RELEASE=44;
const SETTINGS_KEY='render360-tester-diagnostics-v1';
const QUEUE_KEY='render360-tester-diagnostic-queue-v1';
const MAX_QUEUE=20;
const MAX_LOGS=80;
const $=id=>document.getElementById(id);

const defaults={enabled:false,autoPrompt:true,includeLogs:true,includeBrowser:true,autoSend:false};
let settings=loadJson(SETTINGS_KEY,defaults);
let lastFingerprint='';
let lastPromptAt=0;

function loadJson(key,fallback){try{return {...fallback,...JSON.parse(localStorage.getItem(key)||'{}')};}catch{return {...fallback};}}
function saveSettings(){try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));}catch{}syncSettingsUi();}
function loadQueue(){try{const value=JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]');return Array.isArray(value)?value:[];}catch{return [];}}
function saveQueue(queue){try{localStorage.setItem(QUEUE_KEY,JSON.stringify(queue.slice(-MAX_QUEUE)));}catch{}syncSettingsUi();}
function endpoint(){const value=String(globalThis.RENDER360_DIAGNOSTICS_ENDPOINT||'').trim();return /^https:\/\//i.test(value)?value:'';}

function redactText(value){
  let text=String(value??'');
  text=text.replace(/\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/gi,'[REDACTED_GITHUB_TOKEN]');
  text=text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi,'Bearer [REDACTED]');
  text=text.replace(/([?&](?:token|access_token|auth|key|secret)=)[^&#\s]+/gi,'$1[REDACTED]');
  text=text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[REDACTED_EMAIL]');
  text=text.replace(/file:\/\/\/[^\s)]+/gi,'file:///[REDACTED_LOCAL_PATH]');
  text=text.replace(/\/(?:private\/var|var\/mobile|Users)\/[^\s)]+/g,'/[REDACTED_LOCAL_PATH]');
  return text.length>2400?`${text.slice(0,2400)}…[truncated]`:text;
}
function sanitize(value,depth=0){
  if(depth>7)return '[depth-limit]';
  if(value==null||typeof value==='boolean'||typeof value==='number')return value;
  if(typeof value==='string')return redactText(value);
  if(Array.isArray(value))return value.slice(0,120).map(item=>sanitize(item,depth+1));
  if(typeof value==='object'){
    const out={};
    for(const [key,item] of Object.entries(value)){
      if(/^(?:bytes|buffer|blob|file|handle|data)$/i.test(key)&&item&&typeof item==='object'){out[key]='[omitted]';continue;}
      out[key]=sanitize(item,depth+1);
    }
    return out;
  }
  return redactText(value);
}
function cleanPage(){try{const u=new URL(location.href);return `${u.origin}${u.pathname}`;}catch{return location.origin||'';}}
function browserSnapshot(){
  return {
    userAgent:redactText(navigator.userAgent||''),
    platform:redactText(navigator.platform||''),
    language:navigator.language||null,
    standalone:Boolean(navigator.standalone)||matchMedia?.('(display-mode: standalone)')?.matches||false,
    screen:{width:screen?.width||0,height:screen?.height||0,dpr:devicePixelRatio||1},
    viewport:{width:innerWidth||0,height:innerHeight||0},
    online:navigator.onLine,
    crossOriginIsolated:Boolean(globalThis.crossOriginIsolated),
    webgpu:Boolean(navigator.gpu),
    sharedArrayBuffer:typeof SharedArrayBuffer!=='undefined',
    wasmStreaming:typeof WebAssembly?.instantiateStreaming==='function',
    offscreenCanvas:typeof OffscreenCanvas!=='undefined',
    serviceWorker:Boolean(navigator.serviceWorker),
    gamepad:typeof navigator.getGamepads==='function'
  };
}
function latestReport(){
  const dev=globalThis.render360DeveloperConsole;
  return typeof dev?.report==='function'?dev.report():null;
}
function fingerprintFor(report){
  const blocker=report?.blocker||{};
  const raw=blocker.raw?.blocker||blocker.raw||{};
  return [RELEASE,blocker.stage||'none',blocker.summary||'none',raw.entry||'',raw.guestAddress||'',raw.hirOpcode||'',raw.ordinal||'',raw.lastOpcode||''].join('|');
}
function buildEnvelope(reason='manual'){
  const source=latestReport()||{};
  const report={...source,page:cleanPage()};
  if(!settings.includeLogs)delete report.logs;
  else if(Array.isArray(report.logs))report.logs=report.logs.slice(-MAX_LOGS);
  const envelope={
    schema:'render360-tester-diagnostic/1',
    id:globalThis.crypto?.randomUUID?.()||`r360-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt:new Date().toISOString(),
    reason,
    release:RELEASE,
    report:sanitize(report)
  };
  if(settings.includeBrowser)envelope.browser=sanitize(browserSnapshot());
  envelope.fingerprint=fingerprintFor(envelope.report);
  return envelope;
}
function queueEnvelope(envelope){
  const queue=loadQueue();
  const existing=queue.findIndex(item=>item.fingerprint===envelope.fingerprint);
  if(existing>=0){queue[existing]={...envelope,occurrences:Number(queue[existing].occurrences||1)+1};}
  else queue.push({...envelope,occurrences:1});
  saveQueue(queue);
  return envelope;
}
function compactIssueBody(envelope){
  const r=envelope.report||{},b=r.blocker||{},runtime=r.runtime||{},result=runtime.result||{};
  const lines=(r.logs||[]).slice(-24).map(log=>`- \`${String(log.time||'').slice(11,19)}\` **${String(log.level||'info').toUpperCase()}** [${redactText(log.stage||log.source||'runtime')}] ${redactText(log.message||'')}`);
  const pipeline=Object.entries(r.pipeline||{}).map(([key,v])=>`- **${key}**: ${v?.state||'—'} — ${redactText(v?.detail||'')}`).join('\n');
  return `## Render360 tester diagnostic\n\n**Diagnostic ID:** \`${envelope.id}\`  \n**Release:** V${RELEASE}  \n**Generated:** ${envelope.createdAt}  \n**Page:** ${r.page||''}  \n**State:** ${r.state||'unknown'}  \n**Fingerprint:** \`${envelope.fingerprint}\`\n\n### Current blocker\n**Stage:** ${b.stage||'none'}  \n**Summary:** ${redactText(b.summary||'No blocker captured')}\n\n### Runtime\n- Input: ${redactText(runtime.inputKind||'unknown')}\n- Entry: ${result.entry?`0x${(Number(result.entry)>>>0).toString(16).toUpperCase()}`:'—'}\n- Boundary: ${redactText(result.runtimeBoundary||'—')}\n- Translated functions: ${Number(result.translatedFunctionCount||0)}\n- Kernel imports/calls: ${Number(result.kernelImportCount||0)} / ${Number(result.kernelCalls||0)}\n- Scheduler ready: ${Boolean(result.persistentCpu?.schedulerReady)}\n- GPU submitted: ${Boolean(runtime.gpuTraffic?.submitted)}\n- PM4 / draws / swaps: ${Number(runtime.gpuTraffic?.packets||0)} / ${Number(runtime.gpuTraffic?.draws||0)} / ${Number(runtime.gpuTraffic?.swaps||0)}\n\n### Pipeline\n${pipeline||'- unavailable'}\n\n### Browser\n\`\`\`json\n${JSON.stringify(envelope.browser||{},null,2)}\n\`\`\`\n\n### Recent emulator events\n${lines.join('\n')||'_No logs included._'}\n\n---\nSubmitted from Render360 Tester Diagnostics. No game image/file contents are included.`;
}
function issueTitle(envelope){const b=envelope.report?.blocker||{};const short=redactText(b.summary||'runtime report').replace(/\s+/g,' ').slice(0,92);return `[Tester Diagnostic] V${RELEASE} ${b.stage||'runtime'} · ${short}`;}
function githubIssueUrl(envelope){const url=new URL(`https://github.com/${REPO}/issues/new`);url.searchParams.set('title',issueTitle(envelope));url.searchParams.set('body',compactIssueBody(envelope));return url.toString();}

async function postEndpoint(envelope){
  const url=endpoint();if(!url)return {ok:false,reason:'no-endpoint'};
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(envelope),mode:'cors',credentials:'omit',cache:'no-store',keepalive:true});
  if(!response.ok)throw new Error(`Diagnostic collector returned HTTP ${response.status}`);
  return {ok:true,status:response.status};
}
async function sendEnvelope(envelope,{interactive=true}={}){
  if(endpoint()){
    try{const result=await postEndpoint(envelope);if(result.ok){removeQueued(envelope.id);toast('Diagnostic sent to Render360');return result;}}
    catch(error){console.warn('[Render360 Diagnostics] collector failed; keeping report queued',error);if(!interactive)return {ok:false,error};}
  }
  if(!interactive)return {ok:false,reason:'queued'};
  const popup=window.open(githubIssueUrl(envelope),'_blank','noopener,noreferrer');
  if(!popup){await navigator.clipboard?.writeText?.(compactIssueBody(envelope));toast('Report copied. GitHub pop-up was blocked.');return {ok:false,reason:'popup-blocked'};}
  toast('GitHub report opened · review and submit');
  return {ok:true,mode:'github-issue'};
}
function removeQueued(id){const queue=loadQueue().filter(item=>item.id!==id);saveQueue(queue);}
async function sendLatest(){const envelope=queueEnvelope(buildEnvelope('manual-send'));return sendEnvelope(envelope,{interactive:true});}
async function copyLatest(){const envelope=buildEnvelope('manual-copy'),text=JSON.stringify(envelope,null,2);try{await navigator.clipboard.writeText(text);toast('Full diagnostic copied');}catch{const a=document.createElement('textarea');a.value=text;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();toast('Full diagnostic copied');}}
async function shareLatest(){const envelope=buildEnvelope('manual-share'),text=JSON.stringify(envelope,null,2);if(navigator.share){try{await navigator.share({title:`Render360 V${RELEASE} Diagnostic`,text});return;}catch(error){if(error?.name==='AbortError')return;}}await copyLatest();}

function toast(message){
  let node=$('r360DiagnosticToast');if(!node){node=document.createElement('div');node.id='r360DiagnosticToast';node.className='r360-diagnostic-toast';document.body.appendChild(node);}
  node.textContent=message;node.classList.add('show');clearTimeout(node._hide);node._hide=setTimeout(()=>node.classList.remove('show'),2600);
}
function installStyle(){if($('r360TesterDiagnosticStyle'))return;const style=document.createElement('style');style.id='r360TesterDiagnosticStyle';style.textContent=`
.r360-diagnostic-toast{position:fixed;left:50%;bottom:max(24px,calc(env(safe-area-inset-bottom) + 14px));z-index:130000;transform:translate(-50%,18px);opacity:0;pointer-events:none;background:rgba(28,28,30,.94);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:10px 14px;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;transition:.2s ease;box-shadow:0 8px 30px rgba(0,0,0,.28)}
.r360-diagnostic-toast.show{opacity:1;transform:translate(-50%,0)}
.r360-diag-destination{font-size:13px;color:#8e8e93;text-align:right;max-width:44%}
.r360-diag-note{margin:8px 16px 18px;color:#8e8e93;font-size:12px;line-height:1.35}
`;
document.head.appendChild(style);}
function rowHtml(title,detail,id,checked){return `<div class="row"><div class="setting-copy"><span>${title}</span><small>${detail}</small></div><label class="switch"><input id="${id}" type="checkbox" ${checked?'checked':''}><span></span></label></div>`;}
function installSettingsUi(){
  const body=document.querySelector('#appSettingsView .settings-body');if(!body||$('r360TesterDiagnosticsGroup'))return;
  const advanced=[...body.querySelectorAll('.group-title')].find(node=>node.textContent.trim()==='Advanced');
  const title=document.createElement('div');title.className='group-title';title.textContent='Tester Diagnostics';title.id='r360TesterDiagnosticsTitle';
  const group=document.createElement('div');group.className='group';group.id='r360TesterDiagnosticsGroup';
  group.innerHTML=`${rowHtml('Collect Test Reports','Capture runtime blockers, PPC/HIR addresses, kernel/GPU state and recent emulator events.','r360DiagEnabled',settings.enabled)}${rowHtml('Prompt on Blocker','Keep one de-duplicated report ready whenever a title reaches a concrete blocker.','r360DiagPrompt',settings.autoPrompt)}${rowHtml('Include Technical Logs','Include the most recent Render360/Xenia events. Game file bytes are never included.','r360DiagLogs',settings.includeLogs)}${rowHtml('Include Browser Details','Include Safari/WebKit capability and screen-size details needed to reproduce device-specific bugs.','r360DiagBrowser',settings.includeBrowser)}<div class="row"><div class="setting-copy"><span>Report Destination</span><small>No GitHub token is stored in the public app.</small></div><span id="r360DiagDestination" class="r360-diag-destination">${endpoint()?'Render360 collector':'GitHub issue'}</span></div><div class="row"><span>Queued Reports</span><span id="r360DiagPending" class="value">${loadQueue().length}</span></div><button id="r360DiagSend" class="row row-button" type="button"><span>Send Latest Diagnostic</span><span class="chev">›</span></button><button id="r360DiagCopy" class="row row-button" type="button"><span>Copy Full Diagnostic</span><span class="chev">›</span></button>`;
  const note=document.createElement('p');note.className='r360-diag-note';note.textContent=endpoint()?'When enabled, Render360 can submit de-duplicated technical blocker reports to the configured collector.':'On this GitHub Pages build, Send opens a pre-filled Render360 GitHub issue for the tester to review and submit. A future HTTPS collector can make this fully automatic without exposing a repository token.';
  if(advanced){body.insertBefore(title,advanced);body.insertBefore(group,advanced);body.insertBefore(note,advanced);}else{body.append(title,group,note);}
  $('r360DiagEnabled')?.addEventListener('change',e=>{settings.enabled=e.target.checked;saveSettings();});
  $('r360DiagPrompt')?.addEventListener('change',e=>{settings.autoPrompt=e.target.checked;saveSettings();});
  $('r360DiagLogs')?.addEventListener('change',e=>{settings.includeLogs=e.target.checked;saveSettings();});
  $('r360DiagBrowser')?.addEventListener('change',e=>{settings.includeBrowser=e.target.checked;saveSettings();});
  $('r360DiagSend')?.addEventListener('click',sendLatest);
  $('r360DiagCopy')?.addEventListener('click',copyLatest);
}
function syncSettingsUi(){if($('r360DiagPending'))$('r360DiagPending').textContent=String(loadQueue().length);if($('r360DiagDestination'))$('r360DiagDestination').textContent=endpoint()?'Render360 collector':'GitHub issue';}
function installConsoleButton(){
  const share=$('r360DevShare');if(!share||$('r360DevSend'))return;
  const send=document.createElement('button');send.id='r360DevSend';send.className='r360-dev-iconbtn';send.type='button';send.textContent='Send';send.title='Send tester diagnostic';send.addEventListener('click',sendLatest);share.after(send);
}
function handleBlocker(reason){
  if(!settings.enabled)return;
  queueMicrotask(async()=>{
    const envelope=buildEnvelope(reason),fingerprint=envelope.fingerprint;
    if(fingerprint===lastFingerprint&&Date.now()-lastPromptAt<1000)return;
    lastFingerprint=fingerprint;lastPromptAt=Date.now();queueEnvelope(envelope);
    if(settings.autoSend&&endpoint())await sendEnvelope(envelope,{interactive:false});
    if(settings.autoPrompt)toast(endpoint()?'Diagnostic queued for Render360':'Diagnostic ready · tap Send in Developer Console');
  });
}
function installListeners(){
  globalThis.addEventListener('render360:runtimeBlocker',()=>handleBlocker('runtime-blocker'));
  globalThis.addEventListener('render360:fatalError',()=>handleBlocker('fatal-error'));
  globalThis.addEventListener('render360:bootStage',event=>{if(String(event.detail?.stage||'').toLowerCase()==='blocked')handleBlocker('boot-blocked');});
}
function boot(){
  installStyle();installSettingsUi();installListeners();
  const observer=new MutationObserver(()=>{installSettingsUi();installConsoleButton();});observer.observe(document.body,{childList:true,subtree:true});installConsoleButton();syncSettingsUi();
  globalThis.render360TesterDiagnostics={release:RELEASE,build:buildEnvelope,queue:()=>loadQueue(),sendLatest,copyLatest,shareLatest,githubIssueUrl,configureEndpoint(url){globalThis.RENDER360_DIAGNOSTICS_ENDPOINT=url;syncSettingsUi();}};
  console.log(`[Render360 Diagnostics] tester inbox active · destination ${endpoint()?'collector':'GitHub issue'} · no embedded repository token`);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
