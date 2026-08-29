const KEY='render360.settings.v41';

const DEFAULTS=Object.freeze({
  appearance:'system',
  autoPersistImports:true,
  preferredRenderer:'auto',
  defaultResolutionScale:1,
  defaultTargetFps:30,
  performanceHud:true,
  controllerOpacity:0.14,
  controllerScale:1,
  gamepadEnabled:true,
  audioEnabled:true,
  audioLatency:'balanced',
  developerMode:false,
});

export function loadAppSettings(){
  try{const raw=localStorage.getItem(KEY);return raw?{...DEFAULTS,...JSON.parse(raw)}:{...DEFAULTS};}
  catch{return {...DEFAULTS};}
}

export function saveAppSettings(value){
  const next={...DEFAULTS,...value};
  localStorage.setItem(KEY,JSON.stringify(next));
  return next;
}

export function resetAppSettings(){localStorage.removeItem(KEY);return {...DEFAULTS};}
export function appSettingDefaults(){return {...DEFAULTS};}

export function resolveAppearance(appearance='system'){
  if(appearance==='light'||appearance==='dark')return appearance;
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches?'light':'dark';
}
