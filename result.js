// 结果页：一次答对几个、场景「上色」前后对比、每个词的升降和下次复习、错题本勾选、下一步；新手第一场后问每天学几个新词
import { esc, toast, settings, setArchived } from './lib.js';
import { keyOf, streak, levelName, dueText, masteredLessons, prog, MASTER } from './progress.js';
import { paint } from './paint.js';
import { autoSync } from './sync.js';

// c = { id, only, given, items, quizIdx, done, fbs, before: 开场时的进度 Map, restart(题单), setBook }
export async function renderResult(view, c) {
  const { id, only, given, items, quizIdx, done, fbs } = c;
  const first = quizIdx.filter(k => done.get(k)).length, k = streak(), book = settings.get().wrong;
  const missed = quizIdx.filter(k => !done.get(k)).map(k => items[k]);
  const plist = await prog.all(), after = new Map(plist.map(p => [p.key, p]));
  autoSync(); // 学完一场就推一次，换设备能接着学
  const isToday = id === 'today' || id === 'first', mix = isToday || ['wrong', 'all', 'hard'].includes(id);
  const lessons = [...new Map(items.map(q => [q.lesson.id, q.lesson])).values()];
  const ready = masteredLessons(lessons, plist);
  // 场景上色对比：这一场里颜色变了的课，最多 3 张
  const moved = lessons.filter(l => l.items.some(it => (c.before.get(l.id + '|' + it.en)?.level || 0) !== (after.get(l.id + '|' + it.en)?.level || 0))).slice(0, 3);
  const lesson = !mix && items[0]?.lesson, hideOld = lesson && ready.some(l => l.id === lesson.id);
  const archBtn = !lesson || hideOld ? '' : lesson.archived ? '<button disabled>已收起</button>' : `<button id="arch" class="${!given && first === quizIdx.length ? 'primary' : ''}">收起这一课</button>`;
  const fbLine = q => { const f = fbs.get(items.indexOf(q)); return f ? `<span class="lv">${f.before === 0 ? '新学' : !f.first ? '↓' : f.after > f.before ? '↑' : '·'} ${levelName(f.after)} · ${dueText(f.due)}</span>` : ''; };
  const count = (l, m, min) => new Set(l.items.filter(it => (m.get(l.id + '|' + it.en)?.level || 0) >= min).map(it => it.en)).size;
  const askDaily = id === 'first' && !settings.get().newPerDayAsked;
  view.innerHTML = `<div class="result">
    ${id === 'first' ? '<p class="big-cheer">第一批词记住了 🎉</p>' : ''}
    <div class="score">${first} / ${quizIdx.length}</div><p class="muted">一次答对${k ? ` · 🔥 连续学习 ${k} 天` : ''}</p>
    ${moved.map(l => `<figure class="shift"><div class="pair"><img data-l="${esc(l.id)}" data-v="0"><img class="after" data-l="${esc(l.id)}" data-v="1"></div><figcaption>${esc(l.title)} · 亮起 <b>${count(l, after, 1)}</b> 样${count(l, after, MASTER) ? ` · 掌握 ${count(l, after, MASTER)} 样` : ''}<span class="muted"> · 越熟颜色越鲜艳</span></figcaption></figure>`).join('')}
    ${askDaily ? `<div class="panel daily"><b>以后每天学几个新词？</b><div class="bar">${[5, 10, 20].map(n => `<button data-daily="${n}">${n} 个</button>`).join('')}</div><p class="muted">到期的复习不算在内。以后在「我 → 学习」里随时能改。</p></div>` : ''}
    <ul>${quizIdx.map(k => { const q = items[k]; return `<li><span class="k ${done.get(k) ? 'ok' : 'no'}">${done.get(k) ? '✓' : '△'}</span><b>${esc(q.item.en)}</b><span class="muted">${esc(q.item.zh)}</span>${fbLine(q)}<label class="chk"><input type="checkbox" data-key="${esc(keyOf(q))}"${book[keyOf(q)] ? ' checked' : ''}> 错题本</label></li>`; }).join('')}</ul>
    ${ready.map(l => `<p class="muted">「${esc(l.title)}」全部掌握了，整张图都亮了 <button data-arch="${esc(l.id)}" class="mini">收起这一课</button></p>`).join('')}
    <div class="bar">${isToday ? `<a class="btn primary" href="#/study/today${only ? '/' + only : ''}" id="more">再来一组</a>` : '<button id="again" class="primary">再来一遍</button>'}${missed.length ? `<button id="retry">再练错的 ${missed.length} 个</button>` : ''}${archBtn}<a class="btn" href="${lesson ? '#/scene/' + lesson.id : '#/'}">${lesson ? '回场景' : '回今天'}</a></div></div>`;
  const $ = s => view.querySelector(s);
  for (const img of view.querySelectorAll('.shift img')) {
    const l = lessons.find(x => x.id === img.dataset.l);
    if (img.dataset.v === '1') img.onload = () => img.classList.add('go'); // 彩色那张加载完再慢慢浮上来
    paint(l, img.dataset.v === '1' ? after : c.before, 720, true).then(u => { img.src = u; });
  }
  // 勾 = 在错题本；同一个词两个框共用一个键，一起勾一起取消
  $('ul').onchange = e => {
    const key = e.target.dataset.key; if (!key) return;
    c.setBook(key, e.target.checked);
    for (const x of view.querySelectorAll('input[data-key]')) if (x.dataset.key === key) x.checked = e.target.checked;
  };
  for (const b of view.querySelectorAll('[data-daily]')) b.onclick = () => {
    settings.set({ ...settings.get(), newPerDay: +b.dataset.daily, newPerDayAsked: true });
    b.closest('.daily').innerHTML = `<b>好，每天 ${b.dataset.daily} 个新词</b>`;
  };
  for (const b of view.querySelectorAll('[data-arch]')) b.onclick = async e => {
    await setArchived(e.target.dataset.arch, true);
    toast('已收起，不再催复习');
    e.target.closest('p').textContent = '已收起';
  };
  if ($('#arch')) $('#arch').onclick = async () => { await setArchived(id, true); toast('已收起，不再催复习'); location.hash = '#/world'; };
  if ($('#again')) $('#again').onclick = () => c.restart(items); // 重练刚才这份题单，错题本练完全对也不会变成空页
  if ($('#more')) $('#more').onclick = e => { if (location.hash === $('#more').getAttribute('href')) { e.preventDefault(); c.restart(); } }; // hash 没变就手动重进；新手第一场（#/study/first）照常跳过去
  if ($('#retry')) $('#retry').onclick = () => c.restart(missed);
}
