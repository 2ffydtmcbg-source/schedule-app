const CACHE = 'schedule-app-shell-v1';
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

self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);
  // Firebase / Google の通信は常にネットワークから（データは常に最新を取得）
  if(/google|gstatic|firebase/.test(url.hostname)) return;
  e.respondWith(
    caches.match(e.request).then(cached=> cached || fetch(e.request))
  );
});
