// Service Worker：仅缓存“应用外壳”（HTML/JS/CSS）。
// 数据接口默认网络优先；离线包由页面通过 /api/offline/pack 获取并自行保存。
const CACHE = 'lighthouse-shell-v1';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // API 不缓存（尤其管理写入）
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match('/index.html'))));
});
