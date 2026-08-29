const hex8=value=>(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0');
const X360DB_RAW='https://raw.githubusercontent.com/xenia-manager/x360db/main';

async function fetchBlob(url,{signal}={}){
  const response=await fetch(url,{mode:'cors',credentials:'omit',cache:'force-cache',signal});
  if(!response.ok)throw new Error(`cover request failed ${response.status}`);
  const blob=await response.blob();
  if(!blob.type.startsWith('image/'))throw new Error('cover response is not an image');
  return blob;
}

async function fetchJson(url,{signal}={}){
  const response=await fetch(url,{mode:'cors',credentials:'omit',cache:'force-cache',signal});
  if(!response.ok)throw new Error(`metadata request failed ${response.status}`);
  return response.json();
}

function secureXboxUrl(url){
  if(!url)return null;
  return String(url).replace(/^http:\/\/download\.xbox\.com\//i,'https://download.xbox.com/');
}

export async function resolveTitleCover({titleId,signal,timeoutMs=6500}={}){
  const id=Number(titleId||0)>>>0;if(!id)return null;
  const tid=hex8(id);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort('cover-timeout'),Math.max(1200,Number(timeoutMs)||6500));
  const forwardAbort=()=>controller.abort(signal?.reason||'caller-abort');
  if(signal){if(signal.aborted)forwardAbort();else signal.addEventListener('abort',forwardAbort,{once:true});}
  try{
    let info=null;
    try{info=await fetchJson(`${X360DB_RAW}/titles/${tid}/info.json`,{signal:controller.signal});}catch{}
    const name=info?.title?.full||info?.title?.reduced||null;

    // x360db caches the original Xbox 360 Marketplace artwork by Title ID.
    try{
      const url=`${X360DB_RAW}/titles/${tid}/artwork/boxart.jpg`;
      const blob=await fetchBlob(url,{signal:controller.signal});
      return {blob,name,source:'x360db',url};
    }catch{}

    // If the archive image is missing, try the original Marketplace URL recorded by x360db.
    try{
      const url=secureXboxUrl(info?.artwork?.boxart);
      if(url){const blob=await fetchBlob(url,{signal:controller.signal});return {blob,name,source:'xbox-marketplace',url};}
    }catch{}

    // XboxUnity remains a useful secondary source for titles not yet archived by x360db.
    try{
      const response=await fetch(`https://xboxunity.net/api/Covers/${tid}`,{mode:'cors',credentials:'omit',cache:'force-cache',signal:controller.signal});
      if(!response.ok)return null;
      const data=await response.json();
      const list=Array.isArray(data)?data:Array.isArray(data?.covers)?data.covers:[];
      const entry=list.find(x=>x?.official)||list[0];
      const url=entry?.front||entry?.url||entry?.front_url;
      if(!url)return null;
      const blob=await fetchBlob(url,{signal:controller.signal});
      return {blob,name:name||entry?.name||null,source:'xboxunity',url};
    }catch{return null;}
  }finally{clearTimeout(timer);signal?.removeEventListener?.('abort',forwardAbort);}
}

export function coverResolutionPolicy(){return ['embedded-or-zip-sidecar','cached-title-cover','x360db-title-id-boxart','original-xbox-marketplace-artwork','xboxunity-fallback','user-selected-cover','placeholder'];}
