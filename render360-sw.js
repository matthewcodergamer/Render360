const VERSION='73';
const SHELL_CACHE=`render360-shell-v${VERSION}`;
const SHELL_ASSETS=[
  './index.html',
  './manifest.webmanifest',
  './render360-app-icon.svg',
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
    // Runtime builds are immutable by provenance but keep stable public names.
    // Purge every older Render360 CacheStorage namespace so a service worker
    // from an earlier release cannot keep serving an old JS/WASM pair after a
    // verified bootstrap has been published.
    await Promise.all(names.filter(name=>name.startsWith('render360-')&&name!==SHELL_CACHE).map(name=>caches.delete(name)));
    if(self.registration.navigationPreload)await self.registration.navigationPreload.enable().catch(()=>{});
    await self.clients.claim();
  })());
});

self.addEventListener('message',event=>{
  if(event.data?.type==='R360_SKIP_WAITING')self.skipWaiting();
});

function sameOrigin(request){
  try{return new URL(request.url).origin===self.location.origin;}catch{return false;}
}
function isMutableRuntime(request){
  const pathname=new URL(request.url).pathname.toLowerCase();
  // JavaScript, WASM and provenance JSON must always come from the network.
  // In particular this protects xenia_ppc_bootstrap.wasm + its metadata from
  // iOS Safari reusing a pre-fix runtime after GitHub Pages publishes a build.
  return /\.(?:m?js|wasm|json)$/.test(pathname);
}
function isShellAsset(request){
  const pathname=new URL(request.url).pathname.toLowerCase();
  return /\.(?:css|svg|webmanifest|png|jpg|jpeg|webp)$/.test(pathname);
}
async function networkFirstNoStore(request){
  return fetch(new Request(request,{cache:'no-store'}));
}
async function shellAsset(request){
  const cache=await caches.open(SHELL_CACHE);
  const cached=await cache.match(request);
  const network=fetch(new Request(request,{cache:'no-cache'})).then(response=>{
    if(response?.ok)cache.put(request,response.clone()).catch(()=>{});
    return response;
  }).catch(()=>null);
  return cached||await network||Response.error();
}
async function navigation(event){
  const cache=await caches.open(SHELL_CACHE);
  const preload=await event.preloadResponse;
  if(preload){
    if(preload.ok)cache.put('./index.html',preload.clone()).catch(()=>{});
    return preload;
  }
  try{
    const response=await fetch(new Request(event.request,{cache:'no-store'}));
    if(response.ok)cache.put('./index.html',response.clone()).catch(()=>{});
    return response;
  }catch{
    return await cache.match('./index.html')||await cache.match('./')||Response.error();
  }
}

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||!sameOrigin(request))return;
  if(request.mode==='navigate'){event.respondWith(navigation(event));return;}
  if(isMutableRuntime(request)){event.respondWith(networkFirstNoStore(request));return;}
  if(isShellAsset(request))event.respondWith(shellAsset(request));
});
