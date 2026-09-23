// WebDAV 中转：坚果云等网盘不许网页直接连（没开 CORS），同步请求经这里转一手。只转 kantu-sync/ 文件夹里的读写、只带用户自己的账号，不存任何东西
const METHODS = new Set(['GET', 'PUT', 'PROPFIND', 'MKCOL']);
export async function onRequest({ request }) {
  let t;
  try { t = new URL(new URL(request.url).searchParams.get('url')); } catch { return new Response('bad url', { status: 400 }); }
  const okHost = t.protocol === 'https:' ? !/^[\d.]+$|^\[/.test(t.hostname) : t.protocol === 'http:' && t.hostname === 'localhost'; // http 只给本地调试；不转 IP 字面量
  if (!okHost || !t.pathname.includes('/kantu-sync/') || !METHODS.has(request.method) || !request.headers.get('Authorization')) return new Response('not allowed', { status: 400 });
  const headers = {};
  for (const k of ['Authorization', 'Depth', 'If-Match', 'If-None-Match', 'Content-Type']) { const v = request.headers.get(k); if (v) headers[k] = v; }
  const r = await fetch(t, { method: request.method, headers, body: request.method === 'PUT' ? await request.arrayBuffer() : undefined });
  const out = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': r.headers.get('Content-Type') || 'application/octet-stream' });
  if (r.headers.get('ETag')) out.set('ETag', r.headers.get('ETag'));
  return new Response(r.body, { status: r.status, headers: out });
}
