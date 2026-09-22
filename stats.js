// 统计页：已掌握 / 学习中 / 新词、最近 30 天柱状、各练法强弱、最难的词。只读，不写数据
import { db, esc, settings } from './lib.js';
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

  view.innerHTML = `<div class="stats">
    <div class="panel nums"><div><b>${mastered}</b>已掌握</div><div><b>${learning}</b>学习中</div><div><b>${fresh}</b>新词</div></div>
    <h3>最近 30 天</h3>
    <div class="panel"><div class="stats-bars">${bars}</div><p class="muted">${dayLine}</p></div>
    <h3>练法</h3>
    <div class="panel"><ul class="modes">${modeRows}</ul></div>
    <h3>最难的词</h3>
    <div class="panel">${hard.length ? '<a class="btn" href="#/study/hard">一起练</a>' : ''}<ul class="hard">${hardRows}</ul></div>
  </div>`;
  view.onclick = e => {
    const m = e.target.dataset.drill; if (!m || !MODES[m]) return;
    settings.set({ ...settings.get(), studyMode: m });
    location.hash = '#/study/all';
  };
}
