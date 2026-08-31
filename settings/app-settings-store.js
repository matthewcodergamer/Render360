const KEY='render360.settings.v44';
const LEGACY_KEYS=['render360.settings.v43','render360.settings.v41'];

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

function readJson(key){try{const raw=localStorage.getItem(key);return raw?JSON.parse(raw):null;}catch{return null;}}

export function loadAppSettings(){
  try{
    const current=readJson(KEY);if(current)return {...DEFAULTS,...current};
    for(const legacyKey of LEGACY_KEYS){
      const legacy=readJson(legacyKey);if(!legacy)continue;
      const migrated={...DEFAULTS,...legacy,performanceHud:true};
      localStorage.setItem(KEY,JSON.stringify(migrated));return migrated;
    }
    return {...DEFAULTS};
  }catch{return {...DEFAULTS};}
}

export function saveAppSettings(value){const next={...DEFAULTS,...value};localStorage.setItem(KEY,JSON.stringify(next));return next;}
export function resetAppSettings(){localStorage.removeItem(KEY);for(const key of LEGACY_KEYS)localStorage.removeItem(key);return {...DEFAULTS};}
export function appSettingDefaults(){return {...DEFAULTS};}
export function resolveAppearance(appearance='system'){if(appearance==='light'||appearance==='dark')return appearance;return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches?'light':'dark';}
