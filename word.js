// 跨课词视图：只读，列出这个词在各课（含已归档）的出现
import { db, esc, langOf, colOf, fitCrops } from './lib.js';
import { speak } from './tts.js';

export async function renderWord(view, lang, word) {
  const key = String(word || '').trim().toLowerCase();
  const lessons = await db.all();
  const hits = [];
  for (const l of lessons) {
    if (langOf(l) !== lang) continue;
    for (const it of l.items) {
      if (String(it.en).trim().toLowerCase() === key) hits.push({ lesson: l, item: it });
    }
  }
  if (!hits.length) {
    view.innerHTML = '<div class="empty"><b>这个词不在任何课里</b><p><a class="btn" href="#/">回首页</a></p></div>';
    return;
  }
  const first = hits[0].item;
  const seen = new Set(), cols = [];
  for (const h of hits) {
    for (const c of h.item.col || []) {
      if (!c || typeof c.en !== 'string') continue;
      const t = colOf(c.en).text;
      if (!t || seen.has(t)) continue;
      seen.add(t);
      cols.push({ text: t, zh: c.zh || '' });
    }
  }
  const urls = new Map();
  const imgUrl = l => { if (!urls.has(l.id)) urls.set(l.id, URL.createObjectURL(l.image)); return urls.get(l.id); };
  view.innerHTML = `
    <div class="wordpage">
      <div class="bar"><a class="btn" href="#/">回首页</a></div>
      <div class="panel wordhead">
        <h2>${esc(first.en)} <button id="say">🔊</button></h2>
        <div><span class="ipa">${esc(first.ipa)}</span> <span class="muted">${esc(first.pos)}</span></div>
        <div>${esc(first.zh)}</div>
        ${cols.length ? `<h3>搭配</h3><ul class="cols">${cols.map(c => `<li>${esc(c.text)}${c.zh ? ' — ' + esc(c.zh) : ''}</li>`).join('')}</ul>` : ''}
      </div>
      ${hits.map(h => {
        const it = h.item, L = h.lesson;
        return `<div class="wcard">
          <div class="crop"><img src="${imgUrl(L)}" data-box="${it.box.join(',')}"></div>
          <div class="info"><b><a href="#/scene/${L.id}">${esc(L.title)}</a></b>
            <a class="btn" href="#/edit/${L.id}">编辑</a>
            ${it.sent ? `<div class="sent">${esc(it.sent)}</div><div class="sentZh">${esc(it.sentZh)}</div>` : ''}</div>
        </div>`;
      }).join('')}
    </div>`;
  fitCrops(view);
  view.querySelector('#say').onclick = () => speak(first.en, lang);
}
