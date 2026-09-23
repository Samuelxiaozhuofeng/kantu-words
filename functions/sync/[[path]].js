// 多端同步的云端：R2 里每个同步码一份 data.json + 按哈希命名的图片。服务器不存同步码原文，只存它的哈希指向的账户 id
// k/<码的哈希> → { id }；a/<id>/data.json；a/<id>/img/<哈希>.jpg；ip/<日期>/<ip> 是当天建号计数
const ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32：不含 I L O U，手输不易认错
const MB = 1 << 20, QUOTA = 200 * MB, MAX_DATA = 10 * MB, MAX_IMG = 5 * MB, NEW_PER_IP = 5, GRACE = 3600e3;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async data => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));
const newCode = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => ABC[b % 32]).join(''); // 16 位 = 80 bit
const norm = s => String(s || '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/[^0-9A-Z]/g, '');
const out = (body, status = 200, headers = {}) => new Response(typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body), { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', ...headers } });
const bare = etag => String(etag || '').replace(/^W\//, '').replace(/"/g, '');

async function listAll(B, prefix) {
  const objs = [];
  let cursor;
  do { const r = await B.list({ prefix, cursor }); objs.push(...r.objects); cursor = r.truncated ? r.cursor : null; } while (cursor);
  return objs;
}
async function account(B, code) {
  const c = norm(code);
  if (c.length !== 16) return null;
  const hash = await sha(c), p = await B.get('k/' + hash);
  return p ? { id: (await p.json()).id, hash } : null;
}
async function pointTo(B, id) {
  const code = newCode();
  await B.put('k/' + await sha(code), JSON.stringify({ id }));
  return code;
}

export async function onRequest({ request, env, params, waitUntil }) {
  const B = env.SYNC, m = request.method, [op, arg] = params.path || [];
  if (op === 'new' && m === 'POST') {
    const key = `ip/${new Date().toISOString().slice(0, 10)}/${request.headers.get('CF-Connecting-IP') || 'local'}`;
    // ponytail: 读了再写不是原子的，并发请求能略超 5 个；要严格得换 Durable Object 计数
    const n = +(await (await B.get(key))?.text() || 0);
    if (n >= NEW_PER_IP) return out({ error: '今天开启同步的次数太多了，明天再试' }, 429);
    await B.put(key, String(n + 1));
    const id = crypto.randomUUID();
    await B.put(`a/${id}/data.json`, JSON.stringify({ v: 1 })); // 先放一份空的：之后推送一律带 If-Match
    return out({ code: await pointTo(B, id) });
  }
  const acc = await account(B, (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!acc) return out({ error: '同步码不对或已失效' }, 401);
  const base = `a/${acc.id}/`;

  if (op === 'rotate' && m === 'POST') {
    const code = await pointTo(B, acc.id);
    await B.delete('k/' + acc.hash);
    return out({ code });
  }
  if (op === 'data' && m === 'GET') {
    const o = await B.get(base + 'data.json');
    return o ? out(o.body, 200, { ETag: o.httpEtag }) : out({ error: '云端没有数据' }, 404);
  }
  if (op === 'data' && m === 'PUT') {
    const etag = bare(request.headers.get('If-Match'));
    if (!etag) return out({ error: '缺 If-Match' }, 428);
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_DATA) return out({ error: '同步数据太大' }, 413);
    let body;
    try { body = JSON.parse(new TextDecoder().decode(buf)); } catch { return out({ error: '不是 JSON' }, 400); }
    const r = await B.put(base + 'data.json', buf, { onlyIf: { etagMatches: etag } });
    if (!r) return out({ error: '另一台设备刚同步过' }, 412);
    // 顺手清掉没人引用的图；刚传一小时内的留着（另一台可能刚传完图、data.json 还没推上来）
    const used = new Set((Array.isArray(body.lessons) ? body.lessons : []).map(l => l?.img));
    waitUntil((async () => {
      const dead = (await listAll(B, base + 'img/')).filter(o => !used.has(o.key.slice(base.length + 4, -4)) && Date.now() - o.uploaded.getTime() > GRACE);
      for (let i = 0; i < dead.length; i += 1000) await B.delete(dead.slice(i, i + 1000).map(o => o.key));
    })());
    return out({ ok: true }, 200, { ETag: r.httpEtag });
  }
  if (op === 'img' && /^[0-9a-f]{32}$/.test(arg || '')) {
    const key = `${base}img/${arg}.jpg`;
    if (m === 'GET') { const o = await B.get(key); return o ? out(o.body, 200, { 'Content-Type': 'image/jpeg' }) : out({ error: '没有这张图' }, 404); }
    if (m === 'PUT') {
      if (await B.head(key)) return out({ ok: true });
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_IMG) return out({ error: '图片太大' }, 413);
      if ((await sha(buf)).slice(0, 32) !== arg) return out({ error: '图片和哈希对不上' }, 400);
      // ponytail: 列目录求和算用量，同时传多张会略超上限；要精确得另存计数
      const used = (await listAll(B, base)).reduce((s, o) => s + o.size, 0);
      if (used + buf.byteLength > QUOTA) return out({ error: '同步空间满了' }, 413);
      await B.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
      return out({ ok: true });
    }
  }
  return out({ error: 'not found' }, 404);
}
