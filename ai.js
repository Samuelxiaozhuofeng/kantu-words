// 调 OpenAI 兼容接口：拉模型、识图框物品、生图
import { settings, LANGS, levelOf } from './lib.js';

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
  const init = { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body && JSON.stringify(path === '/chat/completions' ? { stream: false, ...body } : body) }; // 有的中转站默认流式，明说不要
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

const parseArr = c => {
  try { return JSON.parse(c.slice(c.indexOf('['), c.lastIndexOf(']') + 1)); }
  catch { throw new Error('模型没按格式返回：' + c.slice(0, 200)); }
};
// 搭配：非数组当 []；en 必须是带 [...] 的字符串，最多 4 条；zh 缺省空串
const colArr = c => (Array.isArray(c) ? c : [])
  .filter(x => x && typeof x.en === 'string' && /\[[^\]]+\]/.test(x.en))
  .slice(0, 4)
  .map(x => ({ en: x.en, zh: x.zh || '' }));

// 按水平给三处提示词各加一句：basic 空串。识词这句是主力——同一张图，中级标 ottoman / sconce 而不是 stool / lamp
const LEVEL_HINT = {
  detect: {
    mid: 'The learner is intermediate (CEFR B1–B2 or equivalent). SKIP beginner (A1–A2) words such as table, chair, sofa, TV, book, plant, cup, window. Prefer the precise word over the generic one (armchair not chair, ottoman not stool, sconce not lamp), and also name distinct parts, materials, fixtures and smaller items (armrest, coaster, tassel, skirting board). Returning fewer objects is fine.',
    high: 'The learner is advanced (CEFR C1+ or equivalent). ONLY label objects, parts, materials and fixtures whose name an intermediate (B2) learner would NOT know: specialised, technical or less common vocabulary (valance, mantelpiece, newel post, upholstery, grout). Skip everything below B2 level. Returning only a few objects is fine.',
  },
  scene: {
    mid: '- The learner is intermediate: leave out beginner objects (sofa, TV, table, plant, book, cup) and instead fill the scene with less common, more specific items, parts and fixtures that belong to this place.',
    high: '- The learner is advanced: fill the scene with specialised, technical or rarely-named items, parts and fixtures of this place; no everyday basics at all.',
  },
  topics: {
    mid: '学习者是中级水平（约 B1–B2）：偏向更专门、更细分的场景或物件集合（比如「壁炉周边」「家庭影院线材」），避开入门级的通用场景。',
    high: '学习者是高级水平（C1+）：列专业、冷门的细分场景或物件集合（比如「木工房的手工具」「帆船的索具」「乐器内部构造」），避开常见场景。',
  },
};
const hint = (kind, level = levelOf()) => LEVEL_HINT[kind][level] || '';

// 识图 prompt 按课程语种生成；数据字段仍叫 en（改字段名会连累内置课和备份），存的是该语种的词
export const prompt = (lang, withSent, level = levelOf()) => {
  const L = LANGS[lang] || LANGS.en;
  const jaCol = lang === 'ja' ? ' For Japanese put 汉字|假名 inside the brackets, e.g. "[沸かす|わかす]やかんを".' : '';
  return `Identify every distinct object in this image that a ${L.ai} learner should be able to name (clothes, shoes, furniture, food, tools, animals, etc). Skip tiny or ambiguous details.
${hint('detect', level) ? hint('detect', level) + '\n' : ''}Return ONLY a JSON array, no prose, no markdown. Each element:
{"en":"<${L.ai} word>","zh":"裙子","ipa":"<${L.ipa}>","pos":"n.","alts":["<alternative>"],"box":[ymin,xmin,ymax,xmax]${withSent ? `,"sent":"<short ${L.ai} sentence>","sentZh":"这句话的中文","col":[{"en":"[verb] the word","zh":"搭配中文"}]` : ''}}
- en: the most common everyday ${L.ai} word for the object, written as it is normally written, WITHOUT any article (plural if the image shows a pair/multiple)
- zh: simplified Chinese
- ipa: ${L.ipa}
- alts: other acceptable ${L.ai} answers (synonyms, spelling variants${lang === 'ja' ? '; ALWAYS include the hiragana reading, and the katakana form if the word is usually written in katakana' : ''}), may be empty
- box: bounding box normalized to 0-1000 of the image, [ymin,xmin,ymax,xmax], tight around the object
${withSent ? `- sent: one short ${L.ai} sentence (≤ 12 words) describing the actual situation of this object in the picture; the word appears in the sentence exactly once
- sentZh: simplified Chinese of that sentence
- col: 2–4 high-frequency collocations of this word (verb + it, adjective + it). Each {"en":"collocation with the practised word in [square brackets]","zh":"整条搭配的中文"}.${jaCol}
` : ''}One element per object, no duplicates.`;
};

export async function detect(blob, lang = 'en', withSent, level = levelOf()) {
  const s = cfg();
  if (!s.visionModel) throw new Error('请先在「设置」里选识别模型');
  const j = await call('/chat/completions', {
    model: s.visionModel, max_tokens: 8000,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt(lang, withSent, level) }, { type: 'image_url', image_url: { url: await toJpeg(blob) } }] }],
  });
  return parseArr(j.choices[0].message.content)
    .filter(i => i.en && Array.isArray(i.box) && i.box.length === 4)
    .map(i => ({ en: String(i.en), zh: i.zh || '', ipa: i.ipa || '', pos: i.pos || '', alts: (i.alts || []).map(String), box: i.box.map(n => Math.max(0, Math.min(1000, +n || 0))), sent: i.sent || '', sentZh: i.sentZh || '', col: withSent ? colArr(i.col) : [] }));
}

// 只发文字：给已有词补例句和搭配，每条必须回显原词 en，调用方按 en 匹配
export async function fillSents(items, lang = 'en') {
  const s = cfg();
  if (!s.visionModel) throw new Error('请先在「设置」里选识别模型');
  const L = LANGS[lang] || LANGS.en;
  const jaCol = lang === 'ja' ? ' For Japanese put 汉字|假名 inside the brackets.' : '';
  const j = await call('/chat/completions', {
    model: s.visionModel, max_tokens: 8000,
    messages: [{ role: 'user', content: `For each word write one short ${L.ai} sentence (≤ 12 words) in which the word appears exactly once, plus simplified Chinese, plus 2–4 high-frequency collocations (verb + it, adjective + it). Put the practised word in [square brackets] in each collocation; zh is Chinese of the whole collocation.${jaCol}
Return ONLY a JSON array, no prose, no markdown. Each element:
{"en":"<original word exactly as given>","sent":"…","sentZh":"…","col":[{"en":"[verb] the word","zh":"搭配中文"}]}
Words: ${JSON.stringify(items.map(i => ({ en: i.en, zh: i.zh || '' })))}` }],
  });
  return parseArr(j.choices[0].message.content).filter(r => r && r.en).map(r => ({ en: String(r.en), sent: r.sent || '', sentZh: r.sentZh || '', col: colArr(r.col) }));
}

// 「AI 出课」列子话题：给面包屑路径，回 6–10 个更细一层、能画成认物图的中文名
export async function listTopics(path) {
  const s = cfg();
  if (!s.visionModel) throw new Error('请先在「设置」里选识别模型');
  const j = await call('/chat/completions', {
    model: s.visionModel, max_tokens: 2000,
    messages: [{ role: 'user', content: `这是一个看图认物的单词学习应用。给定分类路径「${path.join(' › ')}」，列出 6 到 10 个比它更细一层的具体场景 / 地点 / 物品集合的中文名。
要求：每一个都必须能画成一张含 8 到 14 个可以分开命名的物品的认物图；不要动作、不要抽象概念、不要跟路径里的名字相同。${hint('topics') ? '\n' + hint('topics') : ''}
只返回 JSON 字符串数组，不要别的。` }],
  });
  return parseArr(j.choices[0].message.content).filter(t => typeof t === 'string' && t.trim()).map(t => t.trim());
}

// 用户只给主题（一个词或一段话，中文也行），后面固定接「这图是拿来看图认物的」+ 规矩：每种物品只出现一次、分开摆、不要文字、不要人
const scene = (topic, level) => `Create a picture for a vocabulary-learning app: learners look at the picture and name the objects in it.
Scene / topic: ${topic}
Rules:
- Include 8 to 14 everyday objects that fit the scene, each one a distinct kind of thing a learner should be able to name.
- Each kind of object appears EXACTLY ONCE: no shelves, rows or piles of the same thing.
- Every object must belong to this specific scene / topic; do not pad the picture with unrelated generic decor.
- Objects are clearly separated from each other, fully visible, not overlapping, not stacked or piled; no object is tiny.
- Absolutely NO text, letters, numbers, logos, posters with words, labels or signs anywhere in the picture.
- No people, no hands, no faces.
- Eye-level view, even soft lighting, clean uncluttered background, clean flat illustration style.${hint('scene', level) ? '\n' + hint('scene', level) : ''}`;

export async function generateImage(topic, level = levelOf()) {
  const s = cfg();
  if (!s.imageModel) throw new Error('请先在「设置」里选生图模型');
  const j = await call('/images/generations', { model: s.imageModel, prompt: scene(topic, level), n: 1, size: '1024x1024' }, true);
  const d = j.data[0];
  const r = await fetch(d.b64_json ? 'data:image/png;base64,' + d.b64_json : d.url);
  return r.blob();
}
