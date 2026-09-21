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
  get: () => ({ voice: 'en-US-JennyNeural', hintMode: 'always', ...JSON.parse(localStorage.kantu || '{}') }),
  set: o => localStorage.kantu = JSON.stringify(o),
};
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function toast(msg, ms = 2500) {
  const d = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.append(d); setTimeout(() => d.remove(), ms);
}
