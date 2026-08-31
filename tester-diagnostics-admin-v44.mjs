// Render360 V44 owner/admin diagnostic submitter.
//
// This module is intentionally separate from the public tester path. A repository
// owner may paste a fine-grained GitHub token for the CURRENT PAGE SESSION only.
// The token is held in this module closure, never written to localStorage,
// sessionStorage, IndexedDB, logs, reports, URLs, or globalThis.
//
// Recommended token scope:
//   Repository access: matthewcodergamer/Render360 only
//   Repository permissions: Issues = Read and write
//
// Public testers do not need this. They continue to use the sanitized pre-filled
// issue/share path or an owner-controlled diagnostics collector endpoint.

const REPO='matthewcodergamer/Render360';
const API_ROOT='https://api.github.com';
const SETTINGS_KEY='render360-admin-diagnostics-v1';
const $=id=>document.getElementById(id);

let adminToken='';
let connectedLogin='';
let sending=false;
let lastSendAt=0;
const sentFingerprints=new Set();
let prefs=loadPrefs();

function loadPrefs(){
  try{
    const saved=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}');
    return {autoSend:saved.autoSend!==false};
  }catch{return {autoSend:true};}
}
function savePrefs(){try{localStorage.setItem(SETTINGS_KEY,JSON.stringify({autoSend:!!prefs.autoSend}));}catch{}}
function api(){return globalThis.render360TesterDiagnostics||null;}
function officialOrigin(){
  const host=String(location.hostname||'').toLowerCase();
  return host==='matthewcodergamer.github.io'||host==='localhost'||host==='127.0.0.1';
}
function issuePayload(envelope){
  const helper=api();
  if(!helper?.githubIssueUrl)throw new Error('Tester diagnostics are not ready yet.');
  const prefill=new URL(helper.githubIssueUrl(envelope));
  return {
    title:prefill.searchParams.get('title')||'[Tester Diagnostic] Render360 runtime report',
    body:prefill.searchParams.get('body')||JSON.stringify(envelope,null,2)
  };
}
function tokenLooksPlausible(value){
  const token=String(value||'').trim();
  return /^(?:github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)||token.length>=30;
}
async function githubFetch(path,{method='GET',body=null}={}){
  if(!adminToken)throw new Error('Admin session is not connected.');
  const response=await fetch(`${API_ROOT}${path}`,{
    method,
    headers:{
      'accept':'application/vnd.github+json',
      'authorization':`Bearer ${adminToken}`,
      'x-github-api-version':'2022-11-28',
      ...(body?{'content-type':'application/json'}:{})
    },
    body:body?JSON.stringify(body):undefined,
    credentials:'omit',
    cache:'no-store',
    mode:'cors'
  });
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok){
    const message=data?.message||`GitHub returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}
async function connectToken(value){
  if(!officialOrigin())throw new Error('Admin token entry is limited to the official Render360 site or localhost.');
  const candidate=String(value||'').trim();
  if(!tokenLooksPlausible(candidate))throw new Error('Enter a valid fine-grained or classic GitHub token.');
  // Keep the candidate only in memory. If validation fails, erase it immediately.
  adminToken=candidate;
  try{
    const user=await githubFetch('/user');
    const repo=await githubFetch(`/repos/${REPO}`);
    connectedLogin=String(user?.login||'GitHub user');
    updateUi();
    toast(`Admin connected as ${connectedLogin}`);
    return {login:connectedLogin,permissions:repo?.permissions||null};
  }catch(error){
    adminToken='';connectedLogin='';updateUi();throw error;
  }
}
function disconnect(){
  adminToken='';connectedLogin='';sentFingerprints.clear();updateUi();toast('Admin diagnostic session disconnected');
}
async function submitEnvelope(envelope,{force=false}={}){
  if(!adminToken)return {ok:false,reason:'not-connected'};
  const fingerprint=String(envelope?.fingerprint||envelope?.id||'');
  const now=Date.now();
  if(!force&&(sending||sentFingerprints.has(fingerprint)||now-lastSendAt<1800))return {ok:false,reason:'deduplicated'};
  sending=true;
  try{
    const payload=issuePayload(envelope);
    const issue=await githubFetch(`/repos/${REPO}/issues`,{method:'POST',body:payload});
    lastSendAt=Date.now();if(fingerprint)sentFingerprints.add(fingerprint);
    toast(`Diagnostic sent · issue #${issue?.number??'created'}`);
    updateUi();
    return {ok:true,issueNumber:issue?.number||null,url:issue?.html_url||null};
  }catch(error){
    console.warn('[Render360 Admin Diagnostics] issue submission failed:',error?.message||String(error));
    toast(`Admin send failed · ${error?.message||'GitHub error'}`);
    return {ok:false,error};
  }finally{sending=false;}
}
async function submitLatest(reason='admin-manual',force=true){
  const helper=api();if(!helper?.build)throw new Error('Tester diagnostics are not ready yet.');
  return submitEnvelope(helper.build(reason),{force});
}
let blockerTimer=0;
function scheduleAutoSubmit(reason){
  if(!prefs.autoSend||!adminToken)return;
  clearTimeout(blockerTimer);
  blockerTimer=setTimeout(async()=>{
    const helper=api();if(!helper?.build)return;
    const envelope=helper.build(reason);
    const blocker=envelope?.report?.blocker;
    if(!blocker)return;
    await submitEnvelope(envelope,{force:false});
  },900);
}
function installRuntimeListeners(){
  globalThis.addEventListener('render360:runtimeBlocker',()=>scheduleAutoSubmit('admin-runtime-blocker'));
  globalThis.addEventListener('render360:fatalError',()=>scheduleAutoSubmit('admin-fatal-error'));
  globalThis.addEventListener('render360:bootStage',event=>{
    if(String(event.detail?.stage||'').toLowerCase()==='blocked')scheduleAutoSubmit('admin-boot-blocked');
  });
}
function rowHtml(title,detail,tail){return `<div class="row"><div class="setting-copy"><span>${title}</span><small>${detail}</small></div>${tail}</div>`;}
function installStyle(){
  if($('r360AdminDiagStyle'))return;
  const style=document.createElement('style');style.id='r360AdminDiagStyle';style.textContent=`
.r360-admin-token{width:min(48vw,260px);height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(118,118,128,.12);color:inherit;padding:0 10px;font:500 13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;outline:none}.r360-admin-token:focus{border-color:#0a84ff}.r360-admin-status{font-size:13px;color:#8e8e93;text-align:right;max-width:42%}.r360-admin-connected{color:#30d158}.r360-admin-warning{margin:8px 16px 18px;color:#8e8e93;font-size:12px;line-height:1.4}.r360-admin-warning b{color:#ff9f0a;font-weight:600}
`;
  document.head.appendChild(style);
}
function installUi(){
  const body=document.querySelector('#appSettingsView .settings-body');
  const tester=$('r360TesterDiagnosticsGroup');
  if(!body||!tester||$('r360AdminDiagnosticsGroup'))return;
  const anchor=tester.nextElementSibling;
  const title=document.createElement('div');title.className='group-title';title.id='r360AdminDiagnosticsTitle';title.textContent='Owner / Admin Testing';
  const group=document.createElement('div');group.className='group';group.id='r360AdminDiagnosticsGroup';
  group.innerHTML=`
    ${rowHtml('GitHub Token','Optional owner-only direct submitter. Token lives only in this page session.','<input id="r360AdminToken" class="r360-admin-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Fine-grained token">')}
    <button id="r360AdminConnect" class="row row-button" type="button"><span>Connect for This Session</span><span class="chev">›</span></button>
    ${rowHtml('Admin Status','Direct issue creation on matthewcodergamer/Render360.','<span id="r360AdminStatus" class="r360-admin-status">Not connected</span>')}
    ${rowHtml('Auto-Send New Blockers','After a concrete blocker is captured, create one de-duplicated GitHub issue automatically.','<label class="switch"><input id="r360AdminAuto" type="checkbox" '+(prefs.autoSend?'checked':'')+'><span></span></label>')}
    <button id="r360AdminSendNow" class="row row-button" type="button"><span>Send Test Diagnostic Now</span><span class="chev">›</span></button>
    <button id="r360AdminDisconnect" class="row row-button danger" type="button"><span>Disconnect Admin Session</span><span></span></button>`;
  const warning=document.createElement('p');warning.className='r360-admin-warning';warning.id='r360AdminWarning';warning.innerHTML='<b>Owner testing only.</b> Use a fine-grained token restricted to this repository with Issues read/write. Render360 never persists the token. Reloading or closing the page disconnects it.';
  if(anchor){body.insertBefore(title,anchor);body.insertBefore(group,anchor);body.insertBefore(warning,anchor);}else{tester.after(title,group,warning);}
  $('r360AdminConnect')?.addEventListener('click',async()=>{
    const input=$('r360AdminToken'),button=$('r360AdminConnect');
    if(!input||!button)return;button.disabled=true;
    try{await connectToken(input.value);input.value='';}
    catch(error){toast(`Admin connect failed · ${error?.message||'GitHub error'}`);}
    finally{button.disabled=false;}
  });
  $('r360AdminAuto')?.addEventListener('change',event=>{prefs.autoSend=event.target.checked;savePrefs();});
  $('r360AdminSendNow')?.addEventListener('click',async()=>{try{await submitLatest('admin-manual',true);}catch(error){toast(error?.message||'Diagnostic unavailable');}});
  $('r360AdminDisconnect')?.addEventListener('click',disconnect);
  updateUi();
}
function updateUi(){
  const status=$('r360AdminStatus');if(status){status.textContent=adminToken?`Connected · ${connectedLogin||'GitHub'}`:'Not connected';status.classList.toggle('r360-admin-connected',!!adminToken);}
  const send=$('r360AdminSendNow');if(send)send.disabled=!adminToken||sending;
  const disconnectButton=$('r360AdminDisconnect');if(disconnectButton)disconnectButton.disabled=!adminToken;
}
function toast(message){
  const existing=$('r360DiagnosticToast');
  if(existing){existing.textContent=message;existing.classList.add('show');clearTimeout(existing._hide);existing._hide=setTimeout(()=>existing.classList.remove('show'),2800);return;}
  let node=$('r360AdminDiagToast');if(!node){node=document.createElement('div');node.id='r360AdminDiagToast';node.style.cssText='position:fixed;left:50%;bottom:30px;z-index:140000;transform:translateX(-50%);background:rgba(28,28,30,.96);color:#fff;border-radius:13px;padding:10px 14px;font:600 13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif';document.body.appendChild(node);}node.textContent=message;clearTimeout(node._hide);node._hide=setTimeout(()=>node.remove(),2800);
}
function boot(){
  installStyle();installRuntimeListeners();
  const observer=new MutationObserver(()=>installUi());observer.observe(document.body,{childList:true,subtree:true});installUi();
  // Deliberately expose status/actions without exposing the token itself.
  globalThis.render360AdminDiagnostics={
    get connected(){return !!adminToken;},
    get login(){return connectedLogin||null;},
    connect:connectToken,
    disconnect,
    sendLatest:submitLatest
  };
  console.log('[Render360 Admin Diagnostics] session-only owner submitter ready · token persistence disabled');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
