const CACHE = 'schedule-app-shell-v4';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

// 常にネットワークを優先し、成功したらキャッシュも更新する（更新の取りこぼしを防ぐ）
self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);
  if(/google|gstatic|firebase/.test(url.hostname)) return;
  e.respondWith(
    fetch(e.request).then(res=>{
      const resClone = res.clone();
      caches.open(CACHE).then(c=>c.put(e.request, resClone));
      return res;
    }).catch(()=> caches.match(e.request))
  );
});
