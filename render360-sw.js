const VERSION='44.27';
const SHELL_CACHE=`render360-shell-v${VERSION}`;
const RUNTIME_CACHE=`render360-runtime-v${VERSION}`;
const SHELL_ASSETS=[
  './index.html',
  './manifest.webmanifest',
  './render360-app-icon.svg',
  './rendr360-apple-touch-icon.png',
  './rendr360-apple-touch-icon.svg',
  './ui-v44-mobile-fix-v25.css',
  './app-v41.js?v=44.16',
  './app-v42-patch.js?v=44.18',
  './rendr360-mobile-runtime-fix.mjs?v=44.23',
];

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL_ASSETS.map(url=>cache.add(new Request(url,{cache:'reload'}))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(names.filter(name=>(name.startsWith('render360-shell-v')||name.startsWith('render360-runtime-v'))&&!name.endsWith(VERSION)).map(name=>caches.delete(name)));
    if(self.registration.navigationPreload)await self.registration.navigationPreload.enable().catch(()=>{});
    await self.clients.claim();
  })());
});

function sameOrigin(request){try{return new URL(request.url).origin===self.location.origin;}catch{return false;}}
function isMutableRuntime(request){const pathname=new URL(request.url).pathname.toLowerCase();return /\.(?:m?js|wasm)$/.test(pathname);}
function isShellAsset(request){const pathname=new URL(request.url).pathname.toLowerCase();return /\.(?:css|svg|webmanifest|png|jpg|jpeg|webp)$/.test(pathname);}
async function fetchBounded(request,ms=2500){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),ms);
  try{return await fetch(new Request(request,{cache:'no-store',signal:controller.signal}));}
  finally{clearTimeout(timer);}
}

async function runtimeAsset(request){
  const cache=await caches.open(RUNTIME_CACHE);
  const cached=await cache.match(request);
  try{
    const response=await fetchBounded(request,cached?1000:3500);
    if(response?.ok)cache.put(request,response.clone()).catch(()=>{});
    return response;
  }catch{
    if(cached)return cached;
    return Response.error();
  }
}

async function shellAsset(request){
  const cache=await caches.open(SHELL_CACHE);
  const cached=await cache.match(request);
  if(cached){
    fetchBounded(request,1800).then(response=>{if(response?.ok)cache.put(request,response.clone()).catch(()=>{});}).catch(()=>{});
    return cached;
  }
  try{
    const response=await fetchBounded(request,2800);
    if(response?.ok)cache.put(request,response.clone()).catch(()=>{});
    return response;
  }catch{return Response.error();}
}

async function navigation(event){
  const cache=await caches.open(SHELL_CACHE);
  const cached=await cache.match('./index.html')||await cache.match('./');
  const network=(async()=>{
    try{
      const preload=await Promise.race([event.preloadResponse,new Promise(resolve=>setTimeout(()=>resolve(null),900))]).catch(()=>null);
      if(preload?.ok){cache.put('./index.html',preload.clone()).catch(()=>{});return preload;}
      const response=await fetchBounded(event.request,1800);
      if(response?.ok)cache.put('./index.html',response.clone()).catch(()=>{});
      return response;
    }catch{return null;}
  })();
  if(cached){network.catch(()=>{});return cached;}
  return await network||Response.error();
}

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||!sameOrigin(request))return;
  if(request.mode==='navigate'){event.respondWith(navigation(event));return;}
  if(isMutableRuntime(request)){event.respondWith(runtimeAsset(request));return;}
  if(isShellAsset(request))event.respondWith(shellAsset(request));
});
