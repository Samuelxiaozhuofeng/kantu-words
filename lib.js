// 公共小工具：IndexedDB 存课程和发音缓存、localStorage 存设置、HTML 转义、提示条
const open = new Promise((res, rej) => {
  const r = indexedDB.open('kantu', 2);
  // v1：lessons + audio；v2：progress（词级学习进度，见 progress.js）。只补缺的表，老表不动
  r.onupgradeneeded = () => {
    const d = r.result, has = n => d.objectStoreNames.contains(n);
    if (!has('lessons')) d.createObjectStore('lessons', { keyPath: 'id' });
    if (!has('audio')) d.createObjectStore('audio');
    if (!has('progress')) d.createObjectStore('progress', { keyPath: 'key' });
  };
  r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); }; // 别的标签页升库时让路，不然它永远开不了
  r.onerror = () => rej(r.error);
  r.onblocked = () => alert('请先关掉其他「看图记词」标签页，再刷新这一页');
});
export const tx = (store, mode, fn) => open.then(db => new Promise((res, rej) => {
  const t = db.transaction(store, mode), req = fn(t.objectStore(store));
  t.oncomplete = () => res(req && req.result);
  t.onerror = () => rej(t.error);
}));
export const db = {
  all: () => tx('lessons', 'readonly', s => s.getAll()),
  get: id => tx('lessons', 'readonly', s => s.get(id)),
  put: l => tx('lessons', 'readwrite', s => s.put(l)),
  del: id => tx('lessons', 'readwrite', s => s.delete(id)),
  audioGet: k => tx('audio', 'readonly', s => s.get(k)),
  audioPut: (k, v) => tx('audio', 'readwrite', s => s.put(v, k)),
};
// 改一课的某几个字段：读和写放同一个事务里，别拿旧快照盖掉别处刚存的
export const patchLesson = (id, fn) => tx('lessons', 'readwrite', s => {
  const r = s.get(id);
  r.onsuccess = () => { const l = r.result; if (!l) return; fn(l); s.put(l); };
  return r;
});
// 归档 / 放回：只动 archived 一个字段；放回就把字段删掉，跟老课一个样
export const setArchived = (id, on) => patchLesson(id, l => { if (on) l.archived = Date.now(); else delete l.archived; });
export const settings = {
  get: () => ({ voice: 'en-US-JennyNeural', hintMode: 'always', studyMode: 'type', wrong: {}, ...JSON.parse(localStorage.kantu || '{}') }),
  set: o => localStorage.kantu = JSON.stringify(o),
};
// 错题本：键是「课程id|外文词」，读的时候按现有课程过滤（已删的课不出现，不主动清存储）
export const wrongEntries = (lessons, book) => {
  const byId = Object.fromEntries(lessons.map(l => [l.id, l]));
  return Object.entries(book || {}).map(([k, t]) => {
    const p = k.indexOf('|'), lesson = byId[k.slice(0, p)];
    const item = lesson?.items.find(it => it.en === k.slice(p + 1));
    return item ? { lesson, item, t, key: k } : null;
  }).filter(Boolean).sort((a, b) => b.t - a.t);
};
// 支持的语种：界面名、Edge 发音人、浏览器朗读的语言码、给 AI 的语言名、读音字段叫什么、判对时忽略的冠词
export const LANGS = {
  en: { name: '英语', voice: 'en-US-JennyNeural', tag: 'en-US', ai: 'English', ipa: 'American English IPA', ipaName: '音标', articles: /^(a|an|the)\s+/ },
  ja: { name: '日语', voice: 'ja-JP-NanamiNeural', tag: 'ja-JP', ai: 'Japanese', ipa: 'the reading in hiragana', ipaName: '假名', articles: null },
  ko: { name: '韩语', voice: 'ko-KR-SunHiNeural', tag: 'ko-KR', ai: 'Korean', ipa: 'Revised Romanization', ipaName: '罗马音', articles: null },
  fr: { name: '法语', voice: 'fr-FR-DeniseNeural', tag: 'fr-FR', ai: 'French', ipa: 'IPA', ipaName: '音标', articles: /^(le|la|les|un|une|des)\s+|^l'/ },
  de: { name: '德语', voice: 'de-DE-KatjaNeural', tag: 'de-DE', ai: 'German', ipa: 'IPA', ipaName: '音标', articles: /^(der|die|das|ein|eine)\s+/ },
  es: { name: '西班牙语', voice: 'es-ES-ElviraNeural', tag: 'es-ES', ai: 'Spanish', ipa: 'IPA', ipaName: '音标', articles: /^(el|la|los|las|un|una)\s+/ },
};
// 学习者水平（全局设置 settings.level）：basic 一个字都不加提示词，老用户零变化；mid / high 让 AI 出课的三步（列子话题、画图、识词）都往难推
export const LEVELS = { basic: '基础', mid: '进阶（约 B1–B2）', high: '高阶（约 C1+）' };
export const levelOf = () => Object.hasOwn(LEVELS, settings.get().level) ? settings.get().level : 'basic';
export const langOf = lesson => LANGS[lesson?.lang] ? lesson.lang : 'en'; // 老课、内置课、旧备份没这个字段，一律英语
// 课程文件夹：「AI 出课」的大类，也是编辑页下拉的选项；folder 缺省 / 空串当未分组，不按这张表校验（老数据改名不丢）
export const FOLDERS = ['家居', '厨房', '衣物', '食物', '交通', '学校', '办公', '动物', '自然', '运动', '医疗', '城市'];
export const allFolders = () => [...new Set([...FOLDERS, ...(settings.get().folders || [])])]; // 内置 12 个 + 用户自己加的（settings.folders）
export const folderOf = lesson => typeof lesson?.folder === 'string' && lesson.folder ? lesson.folder : '';
// 学习页快捷键：存 settings.keys，值是「修饰键+按键码」（Ctrl+Quote），按键用 e.code 不受输入法 / Shift 影响；没设的用默认
export const KEYS = { say: 'Ctrl+Quote', show: 'Ctrl+Semicolon', mark: 'Ctrl+Slash' };
export const KEY_NAMES = { say: '发音', show: '答案', mark: '收进 / 移出错题本' };
export const keysOf = () => ({ ...KEYS, ...(settings.get().keys || {}) });
export const comboOf = e => [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift', e.code].filter(Boolean).join('+');
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const KEY_LABELS = { Ctrl: MAC ? '⌃' : 'Ctrl', Meta: MAC ? '⌘' : 'Win', Alt: MAC ? '⌥' : 'Alt', Shift: MAC ? '⇧' : 'Shift', Quote: "'", Semicolon: ';', Slash: '/', Period: '.', Comma: ',', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: '空格' };
export const keyParts = combo => combo.split('+').map(k => KEY_LABELS[k] || k.replace(/^(Key|Digit|Arrow)/, ''));
export const keyLabel = combo => keyParts(combo).join(MAC ? ' ' : '+');
// 点图命中：点的位置落在哪些框里，取面积最小的那个（床上的枕头优先于床）。学习页点错提示、场景页探索共用
export const inside = ([y1, x1, y2, x2], x, y) => y >= y1 && y <= y2 && x >= x1 && x <= x2;
const area = ([y1, x1, y2, x2]) => (y2 - y1) * (x2 - x1);
export const hitAt = (items, x, y) => items.map((it, k) => [it, k]).filter(([it]) => inside(it.box, x, y)).sort((a, b) => area(a[0].box) - area(b[0].box))[0];
// 答对 / 答错的一声 + 手机轻震；设置里能关（settings.sfx === false）
let ac;
export function ding(ok) {
  if (settings.get().sfx === false) return;
  try {
    ac ||= new AudioContext();
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = 'triangle';
    o.frequency.setValueAtTime(ok ? 660 : 196, t);
    if (ok) o.frequency.setValueAtTime(990, t + .09);
    g.gain.setValueAtTime(.18, t); g.gain.exponentialRampToValueAtTime(.001, t + (ok ? .32 : .22));
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + .34);
  } catch {}
  navigator.vibrate?.(ok ? 12 : [25, 40, 25]);
}
export const dots = s => `${s}<span class="dots"><i>.</i><i>.</i><i>.</i></span>`; // 「生图中」+ 三个轮流闪的点，等 AI 的地方都用它
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function toast(msg, ms = 2500) {
  document.querySelectorAll('.toast').forEach(d => d.remove()); // 新的顶掉旧的，连着报进度时不会叠成一摞
  const d = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.append(d); setTimeout(() => d.remove(), ms);
}
// 词卡裁图：把整图按框裁出来——高固定 80px，宽跟框的比例走（最窄 48、最宽 160，超出就居中裁）。错题本词卡和词视图共用
export function fitCrops(root) {
  for (const img of root.querySelectorAll('.crop img')) {
    img.onload = () => {
      const [y1, x1, y2, x2] = img.dataset.box.split(',').map(Number), W = img.naturalWidth, H = img.naturalHeight;
      const s = 80 / ((y2 - y1) / 1000 * H), bw = (x2 - x1) / 1000 * W * s, cw = Math.min(160, Math.max(48, bw));
      img.parentElement.style.width = cw + 'px';
      img.style.cssText = `width:${W * s}px;height:${H * s}px;left:${(cw - bw) / 2 - x1 / 1000 * W * s}px;top:${-y1 / 1000 * H * s}px`;
    };
    if (img.complete) img.onload();
  }
}
// 搭配：方括号标要练的词，| 分开多种写法。坏数据返回空对象，学习页没有 try
export function colOf(str) {
  if (typeof str !== 'string') return { text: '', blank: '', answers: [] };
  const m = str.match(/\[([^\]]*)\]/);
  const answers = (m ? m[1].split('|') : [str]).map(s => s.trim()).filter(Boolean);
  return {
    text: str.replace(/\[([^\]]*)\]/g, (_, inner) => inner.split('|')[0].trim()),
    blank: str.replace(/\[[^\]]*\]/g, '___'),
    answers,
  };
}
