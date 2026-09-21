// 公共小工具：IndexedDB 存课程和发音缓存、localStorage 存设置、HTML 转义、提示条
const open = new Promise((res, rej) => {
  const r = indexedDB.open('kantu', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('lessons', { keyPath: 'id' }); r.result.createObjectStore('audio'); };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = (store, mode, fn) => open.then(db => new Promise((res, rej) => {
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
// 归档 / 放回：只动 archived 一个字段，其他原样；放回就把字段删掉，跟老课一个样。读和写放同一个事务里，别拿旧快照盖掉别处刚存的
export const setArchived = (id, on) => tx('lessons', 'readwrite', s => {
  const r = s.get(id);
  r.onsuccess = () => { const l = r.result; if (!l) return; if (on) l.archived = Date.now(); else delete l.archived; s.put(l); };
  return r;
});
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
