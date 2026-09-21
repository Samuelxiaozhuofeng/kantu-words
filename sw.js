// PWA：静态文件网络优先、失败用缓存；/tts、/packs（进库后就不需要了）和外部接口不缓存
const C = 'kantu-v1';
const FILES = ['./', 'index.html', 'app.js', 'lib.js', 'ai.js', 'tts.js', 'anki.js', 'editor.js', 'study.js', 'gen.js', 'manifest.json', 'icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/tts') || u.pathname.startsWith('/packs/')) return;
  e.respondWith(fetch(e.request).then(r => { caches.open(C).then(c => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request)));
});
