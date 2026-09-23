// AI 出课页：大类 → AI 列子话题一层层往下钻 → 就画这个 / 勾选批量生成：生图 → 识别 → 存成一课
import { db, esc, dots, toast, settings, LANGS, LEVELS, levelOf, FOLDERS, allFolders } from './lib.js';
import { detect, generateImage, listTopics, shrink } from './ai.js';

const cache = {}; // 「水平|路径」→ 子话题，回退再进不重新问 AI；换了水平要重问

// 画一张 → 识词 → 存课；批量生成也走这条
// 同一话题不同水平各出一课，标题区分开：「客厅」「客厅 · 进阶」「客厅 · 高阶」
const titleOf = (topic, level) => level === 'basic' ? topic : `${topic} · ${LEVELS[level].split('（')[0]}`;
// level 在排队那一刻定死，中途改设置不影响已排的课
export async function makeLesson(topic, folder, lang, level = levelOf(), onStep = () => {}) {
  onStep('生图中');
  const image = await shrink(await generateImage(topic, level));
  onStep('识别中');
  const items = await detect(image, lang, settings.get().withSent, level);
  const lesson = { id: crypto.randomUUID(), title: titleOf(topic, level), folder, lang, image, items, created: Date.now(), updated: Date.now() };
  await db.put(lesson);
  return lesson;
}

// 后台批量队列：模块级、纯内存，换页照跑，整个网页关掉才丢；每变一次状态往 window 派 kantu:gen 事件
export const queue = []; // { topic, folder, lang, level, state: wait|run|done|fail, error }
const notify = () => dispatchEvent(new Event('kantu:gen'));
const parallel = () => { const n = +settings.get().genParallel; return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 3; };
let running = 0;
function pump() {
  while (running < parallel()) {
    const job = queue.find(j => j.state === 'wait');
    if (!job) return;
    running++; job.state = 'run'; notify();
    makeLesson(job.topic, job.folder, job.lang, job.level)
      .then(() => { job.state = 'done'; }, e => { job.state = 'fail'; job.error = String(e?.message || e || '未知错误'); })
      .then(() => { running--; notify(); pump(); });
  }
}
export function enqueue(jobs) { queue.push(...jobs.map(j => ({ ...j, state: 'wait', error: '' }))); notify(); pump(); }
export function retryFailed() { queue.forEach(j => { if (j.state === 'fail') j.state = 'wait'; }); notify(); pump(); }
export function clearQueue() { queue.length = 0; notify(); }

export async function renderGen(view) {
  const have = new Set((await db.all()).filter(l => !l.id.startsWith('pack-')).map(l => l.title));
  let path = [], lang = settings.get().lastLang || 'en';
  const picked = new Map(); // 「大类›话题」→ { topic, folder }；记在页面内，换层不丢；两个大类下同名话题各算各的
  const pkey = t => (path[0] || t) + '›' + t;
  let seq = 0; // 每次进层 +1；AI 回来时层已经换了就不画、不回退
  view.innerHTML = `
    <div class="bar"><span class="crumbs" id="crumbs"></span><span style="flex:1"></span>
      <select id="lang" title="这课学哪种语言">${Object.entries(LANGS).map(([k, L]) => `<option value="${k}" ${k === lang ? 'selected' : ''}>${L.name}</option>`).join('')}</select>
      <select id="level" title="按我的水平出词（设置页里也能改）">${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}" ${k === levelOf() ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="bar" id="draw"></div>
    <div class="topics" id="topics"></div>
    <div class="bar"><input id="custom" placeholder="自己输入想画的，比如：修车铺"><button id="go">画这个</button></div>
    <div class="bar genbar"><span id="pickN"></span><button id="genAll" class="primary"></button><button id="pickClear">清空勾选</button></div>`;
  const $ = s => view.querySelector(s);

  const drawCrumbs = () => {
    $('#crumbs').innerHTML = ['全部', ...path].map((n, i) => `<button data-up="${i}">${esc(n)}</button>`).join(' › ');
    $('#draw').innerHTML = path.length ? `<button id="drawIt" class="primary">就画「${esc(path.at(-1))}」</button>` : '';
  };
  const drawTopics = list => {
    $('#topics').innerHTML = list.map(t => `<span class="topic"><input type="checkbox" data-pick="${esc(t)}"${picked.has(pkey(t)) ? ' checked' : ''}><button data-topic="${esc(t)}">${esc(t)}${have.has(titleOf(t, levelOf())) ? '<span class="muted">已有</span>' : ''}</button>${!path.length && !FOLDERS.includes(t) ? `<button class="x" data-rm="${esc(t)}" title="删掉这个大类">×</button>` : ''}</span>`).join('')
      + (path.length ? '' : '<button id="addFolder">＋ 添加大类</button>');
  };
  const drawBar = () => {
    $('#pickN').textContent = `已勾 ${picked.size} 个`;
    $('#genAll').textContent = `生成 ${picked.size} 课`;
    $('#genAll').disabled = !picked.size;
  };
  async function enter() {
    const my = ++seq;
    drawCrumbs();
    if (!path.length) return drawTopics(allFolders());
    const key = levelOf() + '|' + path.join('›');
    if (!cache[key]) {
      $('#topics').innerHTML = `<span class="muted thinking">${dots('AI 在想')}</span>`;
      try {
        const list = await listTopics(path);
        if (!list.length) throw new Error('AI 没想出子话题，换一个试试'); // 空结果不进缓存，下次还能重问
        cache[key] = list;
      } catch (e) { if (my !== seq) return; alert(e.message); path.pop(); return enter(); }
      if (my !== seq) return;
    }
    drawTopics(cache[key]);
  }
  async function make(topic, btn) {
    const old = btn.textContent;
    btn.disabled = true;
    try {
      const l = await makeLesson(topic, path[0] || '', lang, levelOf(), s => btn.innerHTML = dots(s));
      toast(`「${l.title}」已生成，${l.items.length} 个词`);
      if (location.hash === '#/gen') location.hash = '#/scene/' + l.id; // 用户已经去别处了就别把人拽过去
    } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = old; }
  }

  view.onclick = e => {
    if (e.target.id === 'addFolder') {
      const name = prompt('新大类叫什么？比如：乐器 / 露营', '')?.trim();
      if (name && !allFolders().includes(name)) settings.set({ ...settings.get(), folders: [...(settings.get().folders || []), name] });
      return enter();
    }
    const rm = e.target.dataset.rm;
    if (rm) { settings.set({ ...settings.get(), folders: (settings.get().folders || []).filter(f => f !== rm) }); picked.delete(pkey(rm)); drawBar(); return enter(); }
    const p = e.target.dataset.pick;
    if (p !== undefined) { e.target.checked ? picked.set(pkey(p), { topic: p, folder: path[0] || p }) : picked.delete(pkey(p)); return drawBar(); }
    const t = e.target.closest('[data-topic]')?.dataset.topic;
    if (t) { path.push(t); return enter(); }
    const up = e.target.dataset.up;
    if (up !== undefined) { path = path.slice(0, +up); return enter(); }
    if (e.target.id === 'drawIt') make(path.at(-1), e.target);
    if (e.target.id === 'go') { const v = $('#custom').value.trim(); if (v) make(v, e.target); }
    if (e.target.id === 'pickClear') { picked.clear(); drawBar(); view.querySelectorAll('[data-pick]').forEach(c => c.checked = false); }
    if (e.target.id === 'genAll' && picked.size) {
      enqueue([...picked.values()].map(j => ({ ...j, lang, level: levelOf() })));
      toast(`已排队 ${picked.size} 课，在世界页看进度`);
      picked.clear();
      location.hash = '#/world';
    }
  };
  $('#lang').onchange = e => { lang = e.target.value; settings.set({ ...settings.get(), lastLang: lang }); };
  $('#level').onchange = e => { settings.set({ ...settings.get(), level: e.target.value }); enter(); }; // 子话题按水平重问，「已有」标记也按新标题重算
  drawBar();
  enter();
}
