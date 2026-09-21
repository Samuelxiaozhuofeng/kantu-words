// 调 OpenAI 兼容接口：拉模型、识图框物品、生图
import { settings } from './lib.js';

function cfg() {
  const s = settings.get();
  if (!s.apiUrl || !s.apiKey) throw new Error('请先在「设置」里填 API 地址和 Key');
  return s;
}
// forImage=true 时优先用单独填的生图接口；直连被 CORS 拦下就改走 /proxy 转一手
async function call(path, body, forImage) {
  const s = cfg();
  const url = ((forImage && s.imageApiUrl) || s.apiUrl).replace(/\/+$/, '') + path;
  const key = (forImage && s.imageApiUrl && s.imageApiKey) || s.apiKey;
  const init = { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) };
  let r;
  try { r = await fetch(url, init); }
  catch { r = await fetch('/proxy?url=' + encodeURIComponent(url), init); }
  const text = await r.text();
  // ponytail: 有的中转站在 JSON 后面多拖一行 "data: [DONE]"，只取最外层大括号
  let json; try { json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { throw new Error('接口返回不是 JSON：' + text.slice(0, 200)); }
  if (!r.ok || json.error) throw new Error(json.error?.message || ('HTTP ' + r.status));
  return json;
}
export const listModels = forImage => call('/models', null, forImage).then(j => j.data.map(m => m.id).sort());

// 图片缩到 1024 内再上传，省 token
export async function toJpeg(blob, max = 1024) {
  const img = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

const PROMPT = `Identify every distinct object in this image that an English learner should be able to name (clothes, shoes, furniture, food, tools, animals, etc). Skip tiny or ambiguous details.
Return ONLY a JSON array, no prose, no markdown. Each element:
{"en":"skirt","zh":"裙子","ipa":"/skɜːrt/","pos":"n.","alts":["dress"],"box":[ymin,xmin,ymax,xmax]}
- en: the most common everyday English word (plural if the image shows a pair/multiple, e.g. "jeans", "boots")
- zh: simplified Chinese
- ipa: American English IPA
- alts: other acceptable English answers (synonyms, British spelling), may be empty
- box: bounding box normalized to 0-1000 of the image, [ymin,xmin,ymax,xmax], tight around the object
One element per object, no duplicates.`;

export async function detect(blob) {
  const s = cfg();
  if (!s.visionModel) throw new Error('请先在「设置」里选识别模型');
  const j = await call('/chat/completions', {
    model: s.visionModel, max_tokens: 8000,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: await toJpeg(blob) } }] }],
  });
  const c = j.choices[0].message.content;
  let items; try { items = JSON.parse(c.slice(c.indexOf('['), c.lastIndexOf(']') + 1)); } catch { throw new Error('模型没按格式返回：' + c.slice(0, 200)); }
  return items
    .filter(i => i.en && Array.isArray(i.box) && i.box.length === 4)
    .map(i => ({ en: String(i.en), zh: i.zh || '', ipa: i.ipa || '', pos: i.pos || '', alts: (i.alts || []).map(String), box: i.box.map(n => Math.max(0, Math.min(1000, +n || 0))) }));
}

export async function generateImage(prompt) {
  const s = cfg();
  if (!s.imageModel) throw new Error('请先在「设置」里选生图模型');
  const j = await call('/images/generations', { model: s.imageModel, prompt, n: 1, size: '1024x1024' }, true);
  const d = j.data[0];
  const r = await fetch(d.b64_json ? 'data:image/png;base64,' + d.b64_json : d.url);
  return r.blob();
}
