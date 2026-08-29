const hex8=value=>(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0');

async function fetchBlob(url){
  const response=await fetch(url,{mode:'cors',credentials:'omit',cache:'force-cache'});
  if(!response.ok)throw new Error(`cover request failed ${response.status}`);
  const blob=await response.blob();
  if(!blob.type.startsWith('image/'))throw new Error('cover response is not an image');
  return blob;
}

export async function resolveTitleCover({titleId,signal}={}){
  const id=Number(titleId||0)>>>0;if(!id)return null;
  // XboxUnity is a best-effort public metadata source. CORS/network failure is
  // intentionally non-fatal: ZIP sidecar art, cached art and user-selected art
  // remain the authoritative fallbacks.
  try{
    const response=await fetch(`https://xboxunity.net/api/Covers/${hex8(id)}`,{mode:'cors',credentials:'omit',cache:'force-cache',signal});
    if(!response.ok)return null;
    const data=await response.json();
    const list=Array.isArray(data)?data:Array.isArray(data?.covers)?data.covers:[];
    const entry=list.find(x=>x?.official)||list[0];
    const url=entry?.front||entry?.url||entry?.front_url;
    if(!url)return null;
    const blob=await fetchBlob(url);
    return {blob,name:entry?.name||null,source:'xboxunity',url};
  }catch{return null;}
}

export function coverResolutionPolicy(){return ['embedded-or-zip-sidecar','cached-title-cover','title-id-network-cover','user-selected-cover','placeholder'];}
