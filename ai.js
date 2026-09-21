// 调 OpenAI 兼容接口：拉模型、识图框物品、生图
import { settings, LANGS } from './lib.js';

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

// 图片按最长边缩放到 canvas 上（识别前缩到 1024 省 token；入库前缩到 1600 省空间）
async function draw(blob, max) {
  const img = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
export const toJpeg = async (blob, max = 1024) => (await draw(blob, max)).toDataURL('image/jpeg', 0.85);
export const shrink = async (blob, max = 1600) => new Promise(r => draw(blob, max).then(c => c.toBlob(r, 'image/jpeg', 0.85)));

// 识图 prompt 按课程语种生成；数据字段仍叫 en（改字段名会连累内置课和备份），存的是该语种的词
export const prompt = lang => {
  const L = LANGS[lang] || LANGS.en;
  return `Identify every distinct object in this image that a ${L.ai} learner should be able to name (clothes, shoes, furniture, food, tools, animals, etc). Skip tiny or ambiguous details.
Return ONLY a JSON array, no prose, no markdown. Each element:
{"en":"<${L.ai} word>","zh":"裙子","ipa":"<${L.ipa}>","pos":"n.","alts":["<alternative>"],"box":[ymin,xmin,ymax,xmax]}
- en: the most common everyday ${L.ai} word for the object, written as it is normally written, WITHOUT any article (plural if the image shows a pair/multiple)
- zh: simplified Chinese
- ipa: ${L.ipa}
- alts: other acceptable ${L.ai} answers (synonyms, spelling variants${lang === 'ja' ? '; ALWAYS include the hiragana reading, and the katakana form if the word is usually written in katakana' : ''}), may be empty
- box: bounding box normalized to 0-1000 of the image, [ymin,xmin,ymax,xmax], tight around the object
One element per object, no duplicates.`;
};

export async function detect(blob, lang = 'en') {
  const s = cfg();
  if (!s.visionModel) throw new Error('请先在「设置」里选识别模型');
  const j = await call('/chat/completions', {
    model: s.visionModel, max_tokens: 8000,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt(lang) }, { type: 'image_url', image_url: { url: await toJpeg(blob) } }] }],
  });
  const c = j.choices[0].message.content;
  let items; try { items = JSON.parse(c.slice(c.indexOf('['), c.lastIndexOf(']') + 1)); } catch { throw new Error('模型没按格式返回：' + c.slice(0, 200)); }
  return items
    .filter(i => i.en && Array.isArray(i.box) && i.box.length === 4)
    .map(i => ({ en: String(i.en), zh: i.zh || '', ipa: i.ipa || '', pos: i.pos || '', alts: (i.alts || []).map(String), box: i.box.map(n => Math.max(0, Math.min(1000, +n || 0))) }));
}

// 用户只给主题（一个词或一段话，中文也行），后面固定接「这图是拿来看图认物的」+ 规矩：每种物品只出现一次、分开摆、不要文字、不要人
const scene = topic => `Create a picture for a vocabulary-learning app: learners look at the picture and name the objects in it.
Scene / topic: ${topic}
Rules:
- Include 8 to 14 everyday objects that fit the scene, each one a distinct kind of thing a learner should be able to name.
- Each kind of object appears EXACTLY ONCE. No duplicates: one book (not a shelf of books), one plant, one rug, one cup.
- Objects are clearly separated from each other, fully visible, not overlapping, not stacked or piled; no object is tiny.
- Absolutely NO text, letters, numbers, logos, posters with words, labels or signs anywhere in the picture.
- No people, no hands, no faces.
- Eye-level view, even soft lighting, clean uncluttered background, clean flat illustration style.`;

export async function generateImage(topic) {
  const s = cfg();
  if (!s.imageModel) throw new Error('请先在「设置」里选生图模型');
  const j = await call('/images/generations', { model: s.imageModel, prompt: scene(topic), n: 1, size: '1024x1024' }, true);
  const d = j.data[0];
  const r = await fetch(d.b64_json ? 'data:image/png;base64,' + d.b64_json : d.url);
  return r.blob();
}
