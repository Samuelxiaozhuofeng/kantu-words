// 今天页（一个开始按钮 + 正在点亮的场景）、世界页（所有场景的上色地图）、新手引导（选语言 → 选起点 → 马上认 3 个词）
import { db, esc, dots, settings, LANGS, LEVELS, langOf, folderOf, setArchived } from './lib.js';
import { prog, buildToday, streak, week, masteredLessons, lessonStat } from './progress.js';
import { paintAll } from './paint.js';
import { queue, retryFailed, clearQueue } from './gen.js';
import { packsReady, switchPacks } from './packs.js';
import { withPhoto } from './editor.js';

export const isPack = l => l.id.startsWith('pack-'); // 内置课按编号认，改过名、改过词还算内置
const UNGROUPED = '未分组';
const photoBtn = (text = '📷 拍一拍') => `<label class="btn">${text}<input type="file" accept="image/*" capture="environment" hidden data-photo></label>`;
const bindPhoto = view => { for (const f of view.querySelectorAll('[data-photo]')) f.onchange = e => e.target.files[0] && withPhoto(e.target.files[0]); };
const greet = () => { const h = new Date().getHours(); return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好'; };

// AI 出课的后台队列进度（今天页和世界页都摆）
function genBar() {
  if (!queue.length) return '';
  const by = st => queue.filter(j => j.state === st), names = st => by(st).map(j => esc(j.topic)).join('、');
  return `<div class="bar genprog"><span>AI 出课：完成 ${by('done').length} / ${queue.length}${by('run').length ? ` · 生成中 ${by('run').length}：${dots(names('run'))}` : ''}${by('wait').length ? ` · 排队 ${by('wait').length}` : ''}${by('fail').length ? ` · 失败 ${by('fail').length}` : ''}</span>
    ${by('fail').map(j => `<span class="muted">${esc(j.topic)}：${esc(j.error.slice(0, 60))}</span>`).join('')}
    ${by('fail').length ? '<button id="genRetry">重试失败的</button>' : ''}${by('run').length + by('wait').length ? '' : '<button id="genClear">清除记录</button>'}</div>`;
}
// 场景卡：上色图 + 到期角标 + 上色进度；点进场景页
function card(l, plist) {
  const st = lessonStat(l, plist);
  return `<a class="scard${st.total && st.mastered === st.total ? ' full' : ''}" href="${l.items.length ? '#/scene/' + l.id : '#/edit/' + l.id}"><div class="pic"><img data-paint="${esc(l.id)}" alt=""></div>
    ${st.due && !l.archived ? `<span class="n due">该复习 ${st.due}</span>` : ''}${langOf(l) === 'en' ? '' : `<span class="n lang">${LANGS[langOf(l)].name}</span>`}
    <div class="meta"><b>${esc(l.title)}</b><span class="muted">${!st.total ? '待整理' : st.mastered === st.total ? '✨ 集齐' : `亮起 ${st.mastered + st.learning} / ${st.total}`}</span></div></a>`;
}
function bindCommon(view, lessons, plist, again) {
  paintAll(view, lessons, new Map(plist.map(p => [p.key, p])), 640);
  bindPhoto(view);
  view.onclick = async e => {
    if (e.target.id === 'genRetry') return retryFailed();
    if (e.target.id === 'genClear') return clearQueue();
    const arch = e.target.dataset.arch;
    if (arch) { await setArchived(arch, true); again(); }
  };
}

export async function renderToday(view) {
  const lessons = (await db.all()).sort((a, b) => b.created - a.created), plist = await prog.all();
  if (!settings.get().onboarded) {
    // 新人（没进度、没自己的课）先走引导；老用户直接标记过
    if (!plist.length && !lessons.some(l => !isPack(l))) return renderWelcome(view);
    settings.set({ ...settings.get(), onboarded: true });
  }
  const td = buildToday(lessons, plist), k = streak(), mastered = masteredLessons(lessons, plist);
  const nothing = !td.due.length && !td.fresh.length, live = lessons.filter(l => !l.archived && l.items.length);
  // 正在点亮的场景：学过、还没集齐的，按最近学的排
  const last = new Map();
  for (const p of plist) { const id = p.key.slice(0, p.key.indexOf('|')); last.set(id, Math.max(last.get(id) || 0, p.last || 0)); }
  const lit = live.filter(l => last.has(l.id) && !mastered.includes(l)).sort((a, b) => last.get(b.id) - last.get(a.id)).slice(0, 4);
  const mins = Math.max(1, Math.round((td.due.length + td.fresh.length * 2) / 5));
  view.innerHTML = `<div class="todaypage">
    <section class="hero panel">
      <div class="greet">${greet()}${k ? `，🔥 连续 ${k} 天` : ''}</div>
      <div class="tn">${nothing ? (live.length ? (td.freshAll ? '今天的份学完了 🎉' : '全部学完了 🎉') : '先挑一个场景') : `${td.due.length ? `<b>${td.due.length}</b> 个复习` : ''}${td.due.length && td.fresh.length ? '<span class="muted"> + </span>' : ''}${td.fresh.length ? `<b>${td.fresh.length}</b> 个新词` : ''}`}</div>
      <p class="muted">${nothing ? (td.freshAll ? `还有 ${td.freshAll} 个新词明天继续。想多玩，去场景里逛逛记忆宫殿。` : '去「世界」挑一张图，或拍一张自己的。') : `约 ${mins} 分钟 · 学过的东西会在图里慢慢变彩色`}</p>
      ${nothing ? '<a class="btn big" href="#/world">去世界 ›</a>' : '<a class="btn primary big" href="#/study/today">开始 →</a>'}
      <div class="week" title="最近 7 天">${week().map(d => `<i class="${d.on ? 'on' : d.ice ? 'ice' : ''}${d.isToday ? ' now' : ''}" title="${d.day}${d.ice ? ' · 冻结卡保住了' : ''}"></i>`).join('')}<span class="muted">${week().some(d => d.ice) ? '❄ 漏了一天，冻结卡帮你保住了' : '最近 7 天'}</span></div>
      ${mastered.length ? `<p class="muted">「${esc(mastered[0].title)}」整张图都亮了 <button data-arch="${mastered[0].id}" class="mini">收起这一课</button></p>` : ''}
    </section>
    ${genBar()}
    ${lit.length ? `<h3>正在点亮的场景</h3><div class="cards">${lit.map(l => card(l, plist)).join('')}</div>`
      : live.length ? `<h3>从一个场景开始</h3><div class="cards">${live.slice(0, 4).map(l => card(l, plist)).join('')}</div>` : ''}
    <h3>添一个新场景</h3>
    <div class="bar">${photoBtn('📷 拍一拍自己的房间 / 冰箱 / 书桌')}<a class="btn" href="#/gen">✨ AI 出课</a><a class="btn" href="#/world">逛逛世界 ›</a></div>
  </div>`;
  bindCommon(view, lessons, plist, () => renderToday(view));
}

let curFolder = ''; // 世界页当前筛选：'' 全部 / '@pack' 内置 / '@done' 已收起 / 文件夹名；只记在内存里
export async function renderWorld(view) {
  const lessons = (await db.all()).sort((a, b) => b.created - a.created), plist = await prog.all();
  const done = lessons.filter(l => l.archived), live = lessons.filter(l => !l.archived);
  const mine = live.filter(l => !isPack(l)), packs = live.filter(isPack), packLang = settings.get().packLang || 'en';
  const folders = [...new Set(mine.map(folderOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  if (folders.length && mine.some(l => !folderOf(l))) folders.push(UNGROUPED);
  const chips = [['', `全部 ${live.length}`], ...(packs.length ? [['@pack', `内置 ${packs.length}`]] : []), ...folders.map(f => [f, f]), ...(done.length ? [['@done', `已收起 ${done.length}`]] : [])];
  if (!chips.some(([k]) => k === curFolder)) curFolder = '';
  const shown = curFolder === '@done' ? done : curFolder === '@pack' ? packs : !curFolder ? live : mine.filter(l => (folderOf(l) || UNGROUPED) === curFolder);
  view.innerHTML = `<div class="world">
    <div class="bar">${photoBtn()}<a class="btn" href="#/gen">✨ AI 出课</a><a class="btn" href="#/edit">＋ 传图新建</a><span style="flex:1"></span>
      ${packs.length ? `<label class="chk">内置课语言 <select id="packLang">${Object.entries(LANGS).map(([k, L]) => `<option value="${k}" ${k === packLang ? 'selected' : ''}>${L.name}</option>`).join('')}</select></label>` : ''}</div>
    ${genBar()}
    ${chips.length > 2 ? `<div class="bar"><span class="seg" id="folders">${chips.map(([k, t]) => `<button data-folder="${esc(k)}" class="${k === curFolder ? 'on' : ''}">${esc(t)}</button>`).join('')}</span></div>` : ''}
    ${shown.length ? `<div class="cards">${shown.map(l => card(l, plist)).join('')}</div>`
      : curFolder === '@done' ? '<div class="empty"><b>还没有收起的场景</b>整张图都亮了之后可以收起，不再催复习。</div>'
      : '<div class="empty"><b>还没有场景</b>拍一张自己身边的东西，AI 会把物品框出来；或者让 AI 画一张。</div>'}
  </div>`;
  bindCommon(view, lessons, plist, () => renderWorld(view));
  const fl = view.querySelector('#folders');
  if (fl) fl.onclick = e => { const f = e.target.dataset.folder; if (f !== undefined) { curFolder = f; renderWorld(view); } };
  const sel = view.querySelector('#packLang');
  if (sel) sel.onchange = async () => {
    if (!confirm(`把 ${packs.length} 个内置场景换成${LANGS[sel.value].name}版？你在内置课上改过的词会被换掉，这些课的学习进度也会清零。`)) { sel.value = packLang; return; }
    try { await switchPacks(sel.value); renderWorld(view); }
    catch (e) { alert('没换成，检查一下网络：' + e.message); sel.value = packLang; }
  };
}

// 新手引导：不填表、不要 Key，选完两下就开始认第一张图里的 3 个词；每天学几个等第一场学完再问
const LEVEL_EG = { basic: '床 · 杯子 · 窗户 · 苹果', mid: '扶手椅 · 杯垫 · 水龙头 · 床头柜', high: '帷幔 · 壁炉台 · 踢脚线 · 软包' };
export function renderWelcome(view) {
  let lang = settings.get().lastLang || 'en';
  const step1 = () => {
    view.innerHTML = `<div class="welcome"><h1>看图记词</h1><p class="muted">每个词都住在一张图里的一个位置上。学会一个，图里那样东西就会亮起颜色。</p>
      <h2>你想学哪种语言？</h2><div class="langs">${Object.entries(LANGS).map(([k, L]) => `<button data-lang="${k}" class="${k === lang ? 'on' : ''}">${L.name}</button>`).join('')}</div>
      <p><button class="link" id="skip">跳过，自己逛逛</button></p></div>`;
  };
  const step2 = () => {
    view.innerHTML = `<div class="welcome"><h2>从哪一档学起？</h2><p class="muted">选你<b>大多还说不出来</b>的那一行</p>
      <div class="levels">${Object.entries(LEVELS).map(([k, v]) => `<button data-level="${k}"><b>${LEVEL_EG[k]}</b><span>${v}</span></button>`).join('')}</div>
      <p class="muted small">内置的 12 个场景是基础词；进阶和高阶的词，之后用「AI 出课」按你的水平生成。</p></div>`;
  };
  step1();
  view.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'skip') { settings.set({ ...settings.get(), onboarded: true }); return renderToday(view); }
    if (b.dataset.lang) { lang = b.dataset.lang; settings.set({ ...settings.get(), lastLang: lang }); return step2(); }
    if (b.dataset.level) {
      settings.set({ ...settings.get(), level: b.dataset.level });
      view.innerHTML = `<div class="welcome"><h2>${dots('正在摆好你的第一张图')}</h2></div>`;
      try {
        await packsReady();
        if ((settings.get().packLang || 'en') !== lang) await switchPacks(lang);
        settings.set({ ...settings.get(), onboarded: true });
        location.hash = '#/study/first';
      } catch (err) { alert('内置场景没下载下来，检查一下网络再试：' + err.message); step2(); }
    }
  };
}
