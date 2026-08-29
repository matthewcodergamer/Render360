const DB_NAME='Render360Library';
const DB_VERSION=1;
const GAME_STORE='games';
const COVER_STORE='covers';

let dbPromise=null;

function openDatabase(){
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    if(!('indexedDB' in globalThis)){reject(new Error('IndexedDB is unavailable in this browser'));return;}
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(GAME_STORE)){
        const store=db.createObjectStore(GAME_STORE,{keyPath:'id'});
        store.createIndex('lastPlayed','lastPlayed',{unique:false});
        store.createIndex('titleId','titleId',{unique:false});
      }
      if(!db.objectStoreNames.contains(COVER_STORE))db.createObjectStore(COVER_STORE,{keyPath:'key'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('Unable to open Render360 library'));
  });
  return dbPromise;
}

function requestPromise(request){return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function txDone(tx){return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('IndexedDB transaction aborted'));});}

export function makeGameId(){
  if(globalThis.crypto?.randomUUID)return crypto.randomUUID();
  return `r360-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
}

export async function listGames(){
  const db=await openDatabase();
  const tx=db.transaction(GAME_STORE,'readonly');
  const games=await requestPromise(tx.objectStore(GAME_STORE).getAll());
  return games.sort((a,b)=>(b.lastPlayed||b.importedAt||0)-(a.lastPlayed||a.importedAt||0));
}

export async function getGame(id){
  const db=await openDatabase();
  const tx=db.transaction(GAME_STORE,'readonly');
  return (await requestPromise(tx.objectStore(GAME_STORE).get(id)))||null;
}

export async function putGame(game){
  if(!game?.id)throw new TypeError('GameRecord.id is required');
  const db=await openDatabase();
  const tx=db.transaction(GAME_STORE,'readwrite'),done=txDone(tx);
  tx.objectStore(GAME_STORE).put({...game,updatedAt:Date.now()});
  await done;return game;
}

export async function deleteGame(id){
  const game=await getGame(id);
  const db=await openDatabase();
  const tx=db.transaction([GAME_STORE,COVER_STORE],'readwrite'),done=txDone(tx);
  tx.objectStore(GAME_STORE).delete(id);
  if(game?.coverKey)tx.objectStore(COVER_STORE).delete(game.coverKey);
  await done;
}

export async function putCover(blob,key=`cover-${makeGameId()}`){
  if(!(blob instanceof Blob))throw new TypeError('Cover artwork must be a Blob');
  const db=await openDatabase();
  const tx=db.transaction(COVER_STORE,'readwrite'),done=txDone(tx);
  tx.objectStore(COVER_STORE).put({key,blob,updatedAt:Date.now()});
  await done;return key;
}

export async function getCover(key){
  if(!key)return null;
  const db=await openDatabase();
  const tx=db.transaction(COVER_STORE,'readonly');
  const record=await requestPromise(tx.objectStore(COVER_STORE).get(key));
  return record?.blob||null;
}

export async function markPlayed(id){
  const game=await getGame(id);if(!game)return null;
  game.lastPlayed=Date.now();await putGame(game);return game;
}

export function sourceKindFromName(name=''){
  const lower=String(name).trim().toLowerCase();
  if(lower.endsWith('.zip'))return 'zip';
  if(lower.endsWith('.iso'))return 'iso';
  if(lower.endsWith('.xex'))return 'xex';
  if(lower.endsWith('.live'))return 'live';
  if(lower.endsWith('.pirs'))return 'pirs';
  if(lower.endsWith('.con'))return 'con';
  // Xbox Live / STFS content is commonly stored on FATX-style media and shared
  // from iOS Files using its 40-hex content filename with no extension. Treat
  // that canonical content-addressed filename as an STFS package instead of
  // rejecting a previously identified CON library entry as UNKNOWN. The core
  // still validates the package magic and metadata before execution.
  const base=lower.split(/[\\/]/).pop()||'';
  if(/^[0-9a-f]{40}$/.test(base))return 'con';
  return 'unknown';
}
