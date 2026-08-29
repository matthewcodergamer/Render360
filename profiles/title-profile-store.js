const PREFIX='render360.profile.';
const DEFAULT_PROFILE=Object.freeze({
  resolution:'auto',renderer:'auto',dynamicResolution:true,
  halfPixelOffset:true,treat3DTexturesAs2D:false,allowInvalidFetchConstants:false,readbackResolves:false,
  targetFps:30,audioBackend:'auto',audioLatency:'balanced',patches:[],developerMode:false,
});

function keyFor(game){const title=Number(game?.titleId||0)>>>0;return `${PREFIX}${title?title.toString(16).toUpperCase().padStart(8,'0'):game?.id||'default'}`;}
export function loadTitleProfile(game){
  try{const raw=localStorage.getItem(keyFor(game));return raw?{...DEFAULT_PROFILE,...JSON.parse(raw)}:{...DEFAULT_PROFILE};}catch{return {...DEFAULT_PROFILE};}
}
export function saveTitleProfile(game,profile){const value={...DEFAULT_PROFILE,...profile};localStorage.setItem(keyFor(game),JSON.stringify(value));return value;}
export function resetTitleProfile(game){localStorage.removeItem(keyFor(game));return {...DEFAULT_PROFILE};}
export function profileDefaults(){return {...DEFAULT_PROFILE};}

export function buildPatchPlan(game,profile,availableFeatures={}){
  const patches=Array.isArray(profile?.patches)?profile.patches:[];
  return patches.filter(p=>p&&p.enabled!==false).map(p=>({
    id:String(p.id||''),titleId:Number(game?.titleId||0)>>>0,mediaId:Number(game?.mediaId||0)>>>0,
    expectedHash:p.expectedHash||null,address:Number(p.address||0)>>>0,bytes:Array.isArray(p.bytes)?p.bytes:[],
    applicable:Boolean(availableFeatures.guestMemoryPatch&&p.expectedHash&&p.address&&Array.isArray(p.bytes)&&p.bytes.length),
  }));
}
