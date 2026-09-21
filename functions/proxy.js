// 有的中转站不允许网页直接调（没开 CORS），网页就把请求经这里转一手。只转三个接口、只带用户自己的 key。
const ALLOWED = /^https:\/\/[^?#]+\/(models|chat\/completions|images\/generations)$/;
export async function onRequest({ request }) {
  const target = new URL(request.url).searchParams.get('url') || '';
  if (!ALLOWED.test(target)) return new Response('url not allowed', { status: 400 });
  const r = await fetch(target, {
    method: request.method,
    headers: { Authorization: request.headers.get('Authorization') || '', 'Content-Type': 'application/json' },
    body: request.method === 'POST' ? request.body : undefined,
  });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json' } });
}
