import '../render360-browser-features.mjs';
import './execution-engine.js';

const KEY='render360.settings.v44';
const LEGACY_KEYS=['render360.settings.v43','render360.settings.v41'];
const MEMORY_RESERVES_MB=new Set([0,96,128,160,192,256,384,512]);

const DEFAULTS=Object.freeze({
  appearance:'system',
  autoPersistImports:true,
  preferredExecutionMode:'auto',
  preferredRenderer:'auto',
  defaultResolutionScale:1,
  defaultTargetFps:30,
  wasmMemoryReserveMb:0,
  performanceHud:true,
  controllerOpacity:0.14,
  controllerScale:1,
  gamepadEnabled:true,
  audioEnabled:true,
  audioLatency:'balanced',
  developerMode:false,
});

function normalizeExecutionMode(value){return ['auto','emulator','recompiled'].includes(String(value))?String(value):'auto';}
function publishExecutionMode(value){const mode=normalizeExecutionMode(value);globalThis.render360ExecutionModePreference=mode;return mode;}
function normalizeMemoryReserve(value){const mb=Number(value);return MEMORY_RESERVES_MB.has(mb)?mb:0;}
function publishMemoryReserve(value){const mb=normalizeMemoryReserve(value);globalThis.render360MemoryReserveMb=mb;return mb;}
function normalizeSettings(value={}){const next={...DEFAULTS,...value};next.preferredExecutionMode=publishExecutionMode(next.preferredExecutionMode);next.wasmMemoryReserveMb=publishMemoryReserve(next.wasmMemoryReserveMb);return next;}
function readJson(key){try{const raw=localStorage.getItem(key);return raw?JSON.parse(raw):null;}catch{return null;}}

export function loadAppSettings(){
  try{
    const current=readJson(KEY);if(current)return normalizeSettings(current);
    for(const legacyKey of LEGACY_KEYS){
      const legacy=readJson(legacyKey);if(!legacy)continue;
      const migrated=normalizeSettings({...legacy,performanceHud:true});
      localStorage.setItem(KEY,JSON.stringify(migrated));return migrated;
    }
    return normalizeSettings();
  }catch{return normalizeSettings();}
}

export function saveAppSettings(value){
  // Execution Engine and WASM memory reserve controls are injected by
  // execution-engine.js rather than owned by app.js. app.js keeps an in-memory
  // settings snapshot, so preserve both live preferences when any of the older
  // settings controls saves.
  const stored=readJson(KEY)||{};
  const liveMode=normalizeExecutionMode(globalThis.render360ExecutionModePreference||stored.preferredExecutionMode||value?.preferredExecutionMode||'auto');
  const liveMemory=normalizeMemoryReserve(globalThis.render360MemoryReserveMb??stored.wasmMemoryReserveMb??value?.wasmMemoryReserveMb??0);
  const next=normalizeSettings({...value,preferredExecutionMode:liveMode,wasmMemoryReserveMb:liveMemory});
  localStorage.setItem(KEY,JSON.stringify(next));return next;
}
export function resetAppSettings(){localStorage.removeItem(KEY);for(const key of LEGACY_KEYS)localStorage.removeItem(key);return normalizeSettings();}
export function appSettingDefaults(){return {...DEFAULTS};}
export function resolveAppearance(appearance='system'){if(appearance==='light'||appearance==='dark')return appearance;return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches?'light':'dark';}
