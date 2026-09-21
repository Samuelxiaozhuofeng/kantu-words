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
export const settings = {
  get: () => ({ voice: 'en-US-JennyNeural', hintMode: 'always', studyMode: 'type', ...JSON.parse(localStorage.kantu || '{}') }),
  set: o => localStorage.kantu = JSON.stringify(o),
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
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function toast(msg, ms = 2500) {
  const d = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.append(d); setTimeout(() => d.remove(), ms);
}
