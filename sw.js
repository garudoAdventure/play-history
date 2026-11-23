// 離線快取：先回傳快取內容，同時在背景向網路更新（stale-while-revalidate）。
// 修改任何靜態檔案後，請把版本號加一，讓舊快取被清除。
const CACHE = 'play-history-v2';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  const network = fetch(e.request).then(async (res) => {
    if (res.ok) await (await caches.open(CACHE)).put(e.request, res.clone());
    return res;
  });
  e.waitUntil(network.catch(() => {}));
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((cached) => cached || network)
  );
});
