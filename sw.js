// PWA：静态文件网络优先、失败用缓存；/tts、/packs（进库后就不需要了）、/sync（同步必须拿真云端，拿缓存会按旧快照合并）和外部接口不缓存
const C = 'kantu-v3';
const FILES = ['./', 'index.html', 'app.js', 'lib.js', 'ai.js', 'tts.js', 'anki.js', 'editor.js', 'study.js', 'progress.js', 'stats.js', 'word.js', 'gen.js', 'home.js', 'scene.js', 'result.js', 'paint.js', 'packs.js', 'speech.js', 'sync.js', 'manifest.json', 'icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname === '/tts' || u.pathname.startsWith('/sync/') || u.pathname.startsWith('/packs/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request))); // 先复制再交给页面：等 caches.open 回来再 clone，页面可能已读完 body
});
