// 词库页：已掌握 / 学习中 / 新词、最近 30 天柱状、各练法强弱、最难的词、错题本（词卡 + 导出 Anki）
import { db, esc, settings, langOf, colOf, fitCrops, wrongEntries, saveWrong } from './lib.js';
import { speak } from './tts.js';
import { exportWrong } from './anki.js';
import { prog, days, today, MASTER, levelName, hardWords } from './progress.js';
import { MODES } from './study.js';

const ymd = k => { const d = new Date(); d.setDate(d.getDate() - k); return today(d.getTime()); };
const pct = (r, n) => n ? Math.round(r / n * 100) + '%' : '';

export async function renderStats(view) {
  const lessons = await db.all(), plist = await prog.all(), log = days();
  const lv = new Map(plist.map(p => [p.key, p.level]));
  let mastered = 0, learning = 0, fresh = 0;
  for (const l of lessons) {
    const seen = new Set();
    for (const it of l.items) {
      const k = l.id + '|' + it.en; if (seen.has(k)) continue; seen.add(k);
      const n = lv.has(k) ? lv.get(k) : null;
      if ((n || 0) >= MASTER) mastered++;
      else if (l.archived) continue;
      else if (n == null) fresh++;
      else learning++;
    }
  }
  const keys = Array.from({ length: 30 }, (_, i) => ymd(29 - i));
  const ns = keys.map(d => log[d]?.n || 0), rs = keys.map(d => log[d]?.right || 0);
  const nSum = ns.reduce((a, b) => a + b, 0), rSum = rs.reduce((a, b) => a + b, 0), max = Math.max(0, ...ns);
  const bars = keys.map((d, i) => `<i title="${d} · ${ns[i]} 题" style="height:${max ? ns[i] / max * 100 : 0}%"></i>`).join('');
  const dayLine = nSum ? `这 30 天答了 ${nSum} 题 · 答对率 ${pct(rSum, nSum)}` : '还没开始';

  const tally = Object.fromEntries(Object.keys(MODES).map(k => [k, { n: 0, right: 0 }]));
  for (const v of Object.values(log)) {
    const m = v.modes && typeof v.modes === 'object' && !Array.isArray(v.modes) ? v.modes : {};
    for (const k of Object.keys(MODES)) {
      const x = m[k]; if (!x) continue;
      tally[k].n += x.n || 0;
      tally[k].right += x.right || 0;
    }
  }
  let weak = '', weakR = 2;
  for (const k of Object.keys(MODES)) {
    const t = tally[k]; if (t.n < 10) continue;
    const r = t.right / t.n;
    if (r < weakR) { weakR = r; weak = k; }
  }
  const modeRows = Object.entries(MODES).map(([k, name]) => {
    const t = tally[k];
    const extra = !t.n ? '' : t.n < 10 ? `<span class="muted">答了 ${t.n} 题 · 还不够 10 题</span>` : `<span>答了 ${t.n} 题 · 答对率 ${pct(t.right, t.n)}</span>${k === weak ? '<b class="tag">最弱</b>' : ''}`;
    return `<li class="${k === weak ? 'weak' : ''}"><b>${esc(name)}</b>${extra}<button data-drill="${k}">专练</button></li>`;
  }).join('');

  const hard = hardWords(lessons, plist);
  const hardRows = hard.length
    ? hard.map(q => `<li><b>${esc(q.item.en)}</b><span class="muted">${esc(q.item.zh)}</span><span>错 ${esc(q.wrong)} 次 / 共 ${esc(q.seen)} 次</span><span class="muted">${esc(levelName(q.level))}</span></li>`).join('')
    : '<li class="muted">还没有错过的词</li>';

  const wrongs = wrongEntries(lessons, settings.get().wrong), urls = new Map();
  const imgUrl = l => { if (!urls.has(l.id)) urls.set(l.id, URL.createObjectURL(l.image)); return urls.get(l.id); };
  const wrongPanel = `<div class="bar">${wrongs.length ? `<a class="btn primary" href="#/study/wrong">练习错题本</a><button id="exportAnki">导出到 Anki</button><label class="chk"><input type="checkbox" id="ankiClear"${settings.get().ankiClear ? ' checked' : ''}> 导出后清空</label><button id="clearWrong">清空</button>` : ''}</div>
    ${wrongs.length ? `<div class="wcards">${wrongs.map(q => { const it = q.item; return `<div class="wcard">
      <div class="crop"><img src="${imgUrl(q.lesson)}" data-box="${it.box.join(',')}"></div>
      <div class="info"><b><a href="#/word/${langOf(q.lesson)}/${encodeURIComponent(it.en)}">${esc(it.en)}</a></b> <span class="ipa">${esc(it.ipa)}</span> <span class="muted">${esc(it.pos)}</span><div>${esc(it.zh)}</div>
        ${it.sent ? `<div class="sent">${esc(it.sent)}</div><div class="sentZh">${esc(it.sentZh)}</div>` : ''}${(it.col || []).filter(c => c && c.en).map(c => `<div class="col">${esc(colOf(c.en).text)}${c.zh ? ' — ' + esc(c.zh) : ''}</div>`).join('')}<small class="muted">${esc(q.lesson.title)}</small></div>
      <div class="ops"><button data-say="${esc(it.en)}" data-lang="${langOf(q.lesson)}">🔊</button><button data-unwrong="${esc(q.key)}">移出</button></div></div>`; }).join('')}</div>`
    : '<p class="muted">错题本是空的。练的时候没一次答对的词会记在这里；答对了不会自动拿掉，在结果页取消勾选、或在这里点「移出」才拿掉。</p>'}`;
  view.innerHTML = `<div class="stats">
    <div class="panel nums"><div><b>${mastered}</b>已掌握</div><div><b>${learning}</b>学习中</div><div><b>${fresh}</b>新词</div></div>
    <h3>最近 30 天</h3>
    <div class="panel"><div class="stats-bars">${bars}</div><p class="muted">${dayLine}</p></div>
    <h3>练法</h3>
    <div class="panel"><ul class="modes">${modeRows}</ul></div>
    <h3>最难的词</h3>
    <div class="panel">${hard.length ? '<a class="btn" href="#/study/hard">一起练</a>' : ''}<ul class="hard">${hardRows}</ul></div>
    <h3>错题本 ${wrongs.length || ''}</h3>
    <div class="panel">${wrongPanel}</div>
  </div>`;
  fitCrops(view);
  const setBook = book => { saveWrong(book); renderStats(view); };
  view.onclick = async e => {
    const t = e.target, m = t.dataset.drill;
    if (m && MODES[m]) { settings.set({ ...settings.get(), studyMode: m }); location.hash = '#/study/all'; return; }
    if (t.id === 'exportAnki') { try { if (await exportWrong(wrongs)) renderStats(view); } catch (err) { alert('导出失败：' + err.message); } return; }
    if (t.id === 'ankiClear') return settings.set({ ...settings.get(), ankiClear: t.checked });
    if (t.id === 'clearWrong' && confirm('把记着的错词都拿掉？')) return setBook({});
    if (t.dataset.say) return speak(t.dataset.say, t.dataset.lang);
    if (t.dataset.unwrong) { const b = { ...settings.get().wrong }; delete b[t.dataset.unwrong]; setBook(b); }
  };
}
