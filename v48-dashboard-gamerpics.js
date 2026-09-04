// Replace the generic archived game-pack samples with Xbox 360 Dashboard gamerpics (Title ID FFFE07D1).
const DASHBOARD_GAMERPICS=Array.from({length:18},(_,i)=>`https://raw.githubusercontent.com/birabittoh/xtitles/refs/heads/main/titles/fffe07d1/${(0x20000+i).toString(16)}.png`);
function patchDashboardGamerpics(){
  const grid=document.getElementById('r360XboxAvatarGrid');
  if(!grid||grid.dataset.r360DashboardPics==='1')return;
  grid.dataset.r360DashboardPics='1';
  let selected='';
  try{selected=JSON.parse(localStorage.getItem('render360.profile.v1')||'{}').gamerpicUrl||''}catch{}
  grid.innerHTML=DASHBOARD_GAMERPICS.map((url,i)=>`<button type="button" data-gamerpic="${url}" class="r360-avatar-choice${selected===url?' selected':''}" aria-label="Use Xbox 360 Dashboard gamerpic ${i+1}"><img src="${url}" alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer"></button>`).join('');
  const heading=grid.previousElementSibling;if(heading?.classList.contains('r360-avatar-heading'))heading.textContent='Xbox 360 Dashboard Gamerpics';
  const note=document.getElementById('r360ProfileNotice');if(note&&!note.dataset.kind)note.textContent='Choose an original Xbox 360 Dashboard gamerpic, a Render360 icon, or your own photo. Your selection is saved on this device.';
}
new MutationObserver(patchDashboardGamerpics).observe(document.documentElement,{childList:true,subtree:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',patchDashboardGamerpics,{once:true});else patchDashboardGamerpics();
