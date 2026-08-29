const hex8=value=>(Number(value)>>>0).toString(16).toUpperCase().padStart(8,'0');

async function fetchBlob(url,{signal}={}){
  const response=await fetch(url,{mode:'cors',credentials:'omit',cache:'force-cache',signal});
  if(!response.ok)throw new Error(`cover request failed ${response.status}`);
  const blob=await response.blob();
  if(!blob.type.startsWith('image/'))throw new Error('cover response is not an image');
  return blob;
}

export async function resolveTitleCover({titleId,signal,timeoutMs=4500}={}){
  const id=Number(titleId||0)>>>0;if(!id)return null;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort('cover-timeout'),Math.max(750,Number(timeoutMs)||4500));
  const forwardAbort=()=>controller.abort(signal?.reason||'caller-abort');
  if(signal){if(signal.aborted)forwardAbort();else signal.addEventListener('abort',forwardAbort,{once:true});}
  try{
    const response=await fetch(`https://xboxunity.net/api/Covers/${hex8(id)}`,{mode:'cors',credentials:'omit',cache:'force-cache',signal:controller.signal});
    if(!response.ok)return null;
    const data=await response.json();
    const list=Array.isArray(data)?data:Array.isArray(data?.covers)?data.covers:[];
    const entry=list.find(x=>x?.official)||list[0];
    const url=entry?.front||entry?.url||entry?.front_url;
    if(!url)return null;
    const blob=await fetchBlob(url,{signal:controller.signal});
    return {blob,name:entry?.name||null,source:'xboxunity',url};
  }catch{return null;}
  finally{clearTimeout(timer);signal?.removeEventListener?.('abort',forwardAbort);}
}

export function coverResolutionPolicy(){return ['embedded-or-zip-sidecar','cached-title-cover','bounded-title-id-network-cover','user-selected-cover','placeholder'];}
