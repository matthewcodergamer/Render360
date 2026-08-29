const PREFIX='render360.profile.';
const DEFAULT_PROFILE=Object.freeze({
  renderer:'inherit',
  resolutionScale:'inherit',
  targetFps:'inherit',
  dynamicResolution:false,
  presentMode:'browser-vsync',
  halfPixelOffset:false,
  treat3DTexturesAs2D:false,
  allowInvalidFetchConstants:false,
  readbackResolves:false,
  textureCache:'auto',
  shaderValidation:'auto',
  schedulerQuantum:1,
  strictKernelHle:true,
  audioEnabled:'inherit',
  audioLatency:'inherit',
  language:'system',
  patches:[],
  developerMode:false,
});

function keyFor(game){const title=Number(game?.titleId||0)>>>0;return `${PREFIX}${title?title.toString(16).toUpperCase().padStart(8,'0'):game?.id||'default'}`;}
export function loadTitleProfile(game){
  try{const raw=localStorage.getItem(keyFor(game));return raw?{...DEFAULT_PROFILE,...JSON.parse(raw)}:{...DEFAULT_PROFILE};}catch{return {...DEFAULT_PROFILE};}
}
export function saveTitleProfile(game,profile){const value={...DEFAULT_PROFILE,...profile};localStorage.setItem(keyFor(game),JSON.stringify(value));return value;}
export function resetTitleProfile(game){localStorage.removeItem(keyFor(game));return {...DEFAULT_PROFILE};}
export function profileDefaults(){return {...DEFAULT_PROFILE};}

export function resolveTitleProfile(game,profile,globalSettings={}){
  const p={...DEFAULT_PROFILE,...profile};
  return {
    ...p,
    renderer:p.renderer==='inherit'?(globalSettings.preferredRenderer||'auto'):p.renderer,
    resolutionScale:p.resolutionScale==='inherit'?Number(globalSettings.defaultResolutionScale||1):Number(p.resolutionScale||1),
    targetFps:p.targetFps==='inherit'?Number(globalSettings.defaultTargetFps||30):Number(p.targetFps||30),
    audioEnabled:p.audioEnabled==='inherit'?globalSettings.audioEnabled!==false:p.audioEnabled==='on',
    audioLatency:p.audioLatency==='inherit'?(globalSettings.audioLatency||'balanced'):p.audioLatency,
  };
}

export function buildPatchPlan(game,profile,availableFeatures={}){
  const patches=Array.isArray(profile?.patches)?profile.patches:[];
  return patches.filter(p=>p&&p.enabled!==false).map(p=>({
    id:String(p.id||''),titleId:Number(game?.titleId||0)>>>0,mediaId:Number(game?.mediaId||0)>>>0,
    expectedHash:p.expectedHash||null,address:Number(p.address||0)>>>0,bytes:Array.isArray(p.bytes)?p.bytes:[],
    applicable:Boolean(availableFeatures.guestMemoryPatch&&p.expectedHash&&p.address&&Array.isArray(p.bytes)&&p.bytes.length),
  }));
}
