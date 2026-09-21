// Cloudflare Pages 函数：替网页去连微软 Edge 朗读接口（浏览器不能自己设这些请求头），返回 MP3
// GET /tts?text=skirt&voice=en-US-JennyNeural
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// ponytail: 微软偶尔会改版本号 / UA 校验，403 了先来这里对
const VERSION = '1-143.0.3650.75';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.3650.75';

const uuid = () => crypto.randomUUID().replace(/-/g, '');
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Sec-MS-GEC：Windows 文件时间纪元、按 5 分钟取整、拼 token 做 SHA256
async function gec() {
  let unix = Math.floor(Date.now() / 1000) + 11644473600;
  unix -= unix % 300;
  const ticks = (BigInt(unix) * 10000000n).toString();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticks + TOKEN));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const text = (u.searchParams.get('text') || '').trim().slice(0, 500);
  const voice = u.searchParams.get('voice') || 'en-US-JennyNeural';
  if (!text) return new Response('text required', { status: 400 });

  const url = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}&ConnectionId=${uuid()}&Sec-MS-GEC=${await gec()}&Sec-MS-GEC-Version=${VERSION}`;
  const resp = await fetch(url, {
    headers: {
      Upgrade: 'websocket',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': UA,
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Cookie: `muid=${uuid().toUpperCase()};`,
    },
  });
  const ws = resp.webSocket;
  if (!ws) return new Response('edge tts refused: HTTP ' + resp.status, { status: 502 });
  ws.accept();

  const ts = new Date().toString();
  ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
  ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${esc(voice)}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${esc(text)}</prosody></voice></speak>`);

  // 先把二进制帧按顺序攒下来（本地 wrangler 给 Blob、线上给 ArrayBuffer，收完再统一解析）
  const frames = [];
  try {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timeout')), 12000);
      ws.addEventListener('message', ev => {
        if (typeof ev.data === 'string') { if (ev.data.includes('Path:turn.end')) { clearTimeout(timer); res(); } }
        else frames.push(ev.data);
      });
      ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('websocket error')); });
      ws.addEventListener('close', () => { clearTimeout(timer); res(); });
    });
  } catch (e) {
    return new Response('edge tts failed: ' + e.message, { status: 502 });
  } finally { try { ws.close(); } catch {} }
  const chunks = [];
  for (const f of frames) {
    const b = new Uint8Array(f instanceof ArrayBuffer ? f : await f.arrayBuffer()), n = (b[0] << 8) | b[1];
    if (new TextDecoder().decode(b.subarray(2, 2 + n)).includes('Content-Type:audio/mpeg')) chunks.push(b.subarray(2 + n));
  }
  if (!chunks.length) return new Response('edge tts returned no audio (bad voice name?)', { status: 502 });
  return new Response(new Blob(chunks, { type: 'audio/mpeg' }), {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000' },
  });
}
