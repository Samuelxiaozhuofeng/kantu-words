// AnkiConnect：连本机 Anki、建笔记类型、把错题导出成卡
import { settings, toast, langOf } from './lib.js';
import { getAudio } from './tts.js';

const AC = 'http://127.0.0.1:8765';
const FIELDS = ['Key', 'Word', 'IPA', 'Meaning', 'Picture', 'Audio'];
const CSS = `.card{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;text-align:center;background:#f5efe3;color:#1c2233;padding:24px 16px;line-height:1.5}
.card img{max-width:100%;border-radius:12px}
.word{font-size:36px;font-weight:800;margin:8px 0}
.ipa{color:#6f6a5e;font-size:18px}
.zh{font-size:22px;margin:8px 0}
hr#answer{border:none;border-top:1px solid #e3d9c6;margin:16px 0}`;
const PIC = '{{Picture}}';
const WORD = '<div class="word">{{Word}}</div>{{Audio}}';
const IPA = '<div class="ipa">{{IPA}}</div>';
const ZH = '<div class="zh">{{Meaning}}</div>';
const HR = '<hr id=answer>';
const card = (Name, Front, Back) => ({ Name, Front, Back: HR + Back });

export const PRESETS = {
  pic: { name: '图 → 词', hint: '正面：高亮图　背面：词 + 音标 + 发音 + 中文',
    cards: [card('卡', PIC, WORD + IPA + ZH)] },
  word: { name: '词 → 中文', hint: '正面：词 + 发音　背面：中文 + 高亮图',
    cards: [card('卡', WORD, ZH + PIC)] },
  zh: { name: '中文 → 图', hint: '正面：中文　背面：高亮图 + 词 + 音标 + 发音',
    cards: [card('卡', ZH, PIC + WORD + IPA)] },
  both: { name: '双向', hint: '两张卡：一张同「图 → 词」，一张同「中文 → 图」',
    cards: [card('图→词', PIC, WORD + IPA + ZH), card('中→图', ZH, PIC + WORD + IPA)] },
};
const modelOf = k => '看图记词·' + (PRESETS[k] || PRESETS.pic).name;

async function invoke(action, params = {}) {
  let j;
  try {
    const r = await fetch(AC, { method: 'POST', body: JSON.stringify({ action, version: 6, params }) });
    j = await r.json();
  } catch (e) {
    throw e instanceof TypeError ? new Error('连不上 Anki。请在电脑上打开 Anki 桌面版并安装 AnkiConnect 插件（代码 2055492159）。手机浏览器连不上。') : e;
  }
  if (j.error) throw new Error(j.error);
  return j.result;
}

export async function pingAnki() {
  const r = await invoke('requestPermission');
  if (r.permission !== 'granted') throw new Error('Anki 未允许本页连接，请在弹框里点「是」。');
  return r;
}

export const listDecks = () => invoke('deckNames');

async function ensureModel(key) {
  const p = PRESETS[key] || PRESETS.pic, name = modelOf(key);
  const have = await invoke('modelNames');
  if (!have.includes(name)) {
    await invoke('createModel', { modelName: name, inOrderFields: FIELDS, css: CSS, cardTemplates: p.cards });
    return name;
  }
  // 同名但字段对不上的不是我们建的，别去刷人家的模板
  const fields = await invoke('modelFieldNames', { modelName: name });
  if (fields.join() !== FIELDS.join()) throw new Error(`Anki 里已有一个叫「${name}」的笔记类型但不是本应用建的，请在 Anki 里改名后再导出。`);
  const templates =Object.fromEntries(p.cards.map(c => [c.Name, { Front: c.Front, Back: c.Back }]));
  await invoke('updateModelTemplates', { model: { name, templates } });
  await invoke('updateModelStyling', { model: { name, css: CSS } });
  return name;
}

const toB64 = blob => new Promise((res, rej) => {
  const f = new FileReader();
  f.onload = () => res(String(f.result).split(',')[1]);
  f.onerror = rej;
  f.readAsDataURL(blob);
});

// box 是 0–1000 归一化 [ymin, xmin, ymax, xmax]；框线用主色蓝，框外压暗
async function highlight(image, box) {
  const img = await createImageBitmap(image);
  const k = Math.min(1, 1024 / Math.max(img.width, img.height));
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  const [ymin, xmin, ymax, xmax] = box;
  const x = xmin / 1000 * w, y = ymin / 1000 * h;
  const bw = (xmax - xmin) / 1000 * w, bh = (ymax - ymin) / 1000 * h;
  g.fillStyle = 'rgba(28,34,51,.4)';
  g.fillRect(0, 0, w, h);
  g.drawImage(img, xmin / 1000 * img.width, ymin / 1000 * img.height,
    (xmax - xmin) / 1000 * img.width, (ymax - ymin) / 1000 * img.height, x, y, bw, bh);
  g.strokeStyle = '#2b5fd9';
  g.lineWidth = Math.max(2, w * 0.006);
  g.strokeRect(x, y, bw, bh);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

// 媒体文件名用 key 的哈希：日韩法语词、长词、同课近似词都不会撞名（撞了 Anki 会覆盖成同一张图）
const slug = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');

async function buildNote(q, deck, model) {
  const { lesson, item, key } = q, fname = 'kantu_' + await slug(key);
  const note = {
    deckName: deck, modelName: model,
    fields: { Key: key, Word: item.en, IPA: item.ipa || '', Meaning: item.zh || '', Picture: '', Audio: '' },
    options: { allowDuplicate: false, duplicateScope: 'deck' },
    picture: [{ data: await highlight(lesson.image, item.box), filename: fname + '.jpg', fields: ['Picture'] }],
  };
  try {
    note.audio = [{ data: await toB64(await getAudio(item.en, langOf(lesson))), filename: fname + '.mp3', fields: ['Audio'] }];
  } catch { /* 没配上音频：这张卡不带音，外面计数 */ }
  return note;
}

export async function exportWrong(wrongs) {
  try { await pingAnki(); }
  catch (e) { alert('未连接 Anki，去「设置 → Anki」看怎么办。\n' + e.message); return 0; }
  const s = settings.get();
  const deck = (s.ankiDeck || '').trim();
  if (!deck) { alert('先去「设置 → Anki」选一个牌组或填新牌组名并保存。'); return 0; }
  const preset = PRESETS[s.ankiPreset] ? s.ankiPreset : 'pic';
  await invoke('createDeck', { deck });
  const model = await ensureModel(preset);
  const notes = [];
  let noAudio = 0;
  for (let i = 0; i < wrongs.length; i++) {
    toast(`正在导出 ${i + 1} / ${wrongs.length}…`);
    const note = await buildNote(wrongs[i], deck, model);
    if (!note.audio) noAudio++;
    notes.push(note);
  }
  const checks = await invoke('canAddNotesWithErrorDetail', { notes });
  const addable = [], okKeys = [];
  let exists = 0, failed = 0, added = 0;
  checks.forEach((c, i) => {
    if (c.canAdd) addable.push(i);
    else if (String(c.error || '').includes('duplicate')) { exists++; okKeys.push(wrongs[i].key); }
    else failed++;
  });
  if (addable.length) {
    const ids = await invoke('addNotes', { notes: addable.map(i => notes[i]) });
    if (!ids) failed += addable.length;
    else ids.forEach((id, k) => { if (id) { added++; okKeys.push(wrongs[addable[k]].key); } else failed++; });
  }
  alert(`已加入 ${added} 张，${exists} 张已存在，${failed} 张失败，${noAudio} 张没配上音频 → 牌组「${deck}」`);
  if (settings.get().ankiClear && okKeys.length) {
    const wrong = { ...settings.get().wrong };
    for (const k of okKeys) delete wrong[k];
    settings.set({ ...settings.get(), wrong });
  }
  return okKeys.length;
}
