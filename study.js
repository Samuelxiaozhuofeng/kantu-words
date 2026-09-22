// 学习页：六种练法（打英文 / 听音点图 / 听句子点图 / 选英文 / 选中文 / 填搭配）+ 新词「先过一遍」；「今天」题单每题按熟练度自带练法，答完当场写记忆状态并显示升降
import { db, esc, toast, settings, LANGS, langOf, setArchived, wrongEntries, keysOf, keyParts, comboOf, colOf } from './lib.js';
import { keyOf, record, modeFor, buildToday, prog, logDay, streak, levelName, dueText, MASTER, hardWords, masteredLessons } from './progress.js';
import { speak } from './tts.js';
import { boxStyle } from './editor.js';

// 只留字母、数字（含重音字母、假名、汉字、谚文）和空格、撇号、连字符；冠词按语种忽略
const norm = (s, lang) => {
  const a = LANGS[lang].articles;
  s = String(s).normalize('NFC').toLowerCase().trim();
  if (a) s = s.replace(a, '');
  return s.replace(/[^\p{L}\p{N}\s'-]/gu, '').replace(/\s+/g, ' ').trim();
};
// 判对：不分大小写、忽略冠词和标点、AI 给的同义词（日语的假名读音也在里面）算对、单复数（s / es）也算对
export const isRight = (input, it, lang = 'en') => {
  const a = norm(input, lang);
  return !!a && [it.en, ...(it.alts || [])].some(w => { const b = norm(w, lang); return [b, b + 's', b + 'es'].includes(a) || [a + 's', a + 'es'].includes(b); });
};

export const MODES = { type: '打单词', tap: '听音点图', sent: '听句子点图', pickEn: '选单词', pickZh: '选中文', col: '填搭配' };
const HINTS = { always: '一直显示', wrong: '答错后显示', never: '不显示' };
const NEXTS = [[1, '自动下一题'], [0, '答完停住']];
const isPick = m => m.startsWith('pick'), isTap = m => m === 'tap' || m === 'sent', isTyped = m => m === 'type' || m === 'col';
const kbd = combo => keyParts(combo).map(k => `<kbd>${esc(k)}</kbd>`).join('+');
// 提示条：快捷键按设置里的来；停住模式多一句 Enter 下一题
const tips = (mode, keys, autoNext) => ({
  type: '<kbd>Enter</kbd> 提交', col: '<kbd>Enter</kbd> 提交',
  tap: `听发音，点图里对应的物品`,
  sent: `听句子，点图里说到的物品`,
  pickEn: '<kbd>1</kbd>–<kbd>4</kbd> 选', pickZh: '<kbd>1</kbd>–<kbd>4</kbd> 选',
  learn: '新词先认一遍 · <kbd>Enter</kbd> 下一个',
}[mode] + ` · ${kbd(keys.say)} 发音 · ${kbd(keys.show)} 答案 · ${kbd(keys.mark)} 错题本` + (autoNext || mode === 'learn' ? '' : ' · <kbd>Enter</kbd> 下一题'));
const shuffle = a => { for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } return a; };
// 能出题的搭配：括号里至少有一个答案（手打成「[] the kettle」或坏备份里的空串，出了题谁也答不对）
const colsOf = it => (it.col || []).filter(c => c && colOf(c.en).answers.length);
const pickCol = it => { const a = colsOf(it); return a[Math.floor(Math.random() * a.length)]; };

// 入口共用题单 [{ lesson, item, mode, fresh?, col? }]。'today' 'wrong' 'all' 'hard' 不是课程 id，别拿去 db.get
async function loadQuiz(id, given, only) {
  if (given) return given;
  if (id === 'today') {
    const { due, fresh } = buildToday(await db.all(), await prog.all(), only);
    const q = shuffle([...fresh.map(q => ({ ...q, fresh: true, mode: modeFor(0, q.item) })), ...due.map(q => ({ ...q, mode: modeFor(q.level, q.item) }))]);
    for (const x of q) if (x.mode === 'col') x.col = pickCol(x.item);
    return [...fresh.map(q => ({ ...q, mode: 'learn' })), ...q]; // 新词先全部过一遍，再混着考
  }
  let base;
  if (id === 'wrong') base = wrongEntries(await db.all(), settings.get().wrong);
  else if (id === 'hard') base = hardWords(await db.all(), await prog.all());
  else if (id === 'all') {
    const seen = new Set();
    base = [];
    for (const lesson of await db.all()) {
      if (lesson.archived) continue;
      for (const item of lesson.items) {
        const k = lesson.id + '|' + item.en; if (seen.has(k)) continue; seen.add(k);
        base.push({ lesson, item });
      }
    }
    // 先按当前练法筛能出的词再抽，不然抽到的 20 个里没句子 / 搭配的会被硬当句子题练、记进错的练法
    const sm = settings.get().studyMode;
    if (sm === 'sent') base = base.filter(q => q.item.sent);
    else if (sm === 'col') base = base.filter(q => colsOf(q.item).length);
    base = shuffle(base).slice(0, 20);
  } else {
    const lesson = await db.get(id);
    base = (lesson?.items || []).map(item => ({ lesson, item }));
  }
  if (!base.length) return [];
  // 固定练法（用户选的）：题单里没句子 / 搭配时退回可用的
  const s = settings.get(), hasSent = base.some(q => q.item.sent), hasCol = base.some(q => colsOf(q.item).length);
  const mode = s.studyMode === 'sent' && !hasSent ? 'tap' : s.studyMode === 'col' && !hasCol ? 'type' : MODES[s.studyMode] ? s.studyMode : 'type';
  const quiz = mode === 'col' ? base.filter(q => colsOf(q.item).length).map(q => ({ ...q, col: pickCol(q.item) })) : base.map(q => ({ ...q }));
  for (const q of quiz) q.mode = mode;
  return isTap(mode) ? shuffle(quiz) : quiz; // 点图模式打乱出题顺序，不然按位置就能记住
}

export async function renderStudy(view, id, given, only) {
  const items = await loadQuiz(id, given, only), isToday = id === 'today';
  if (!items.length) {
    const k = streak();
    view.innerHTML = isToday ? `<div class="empty"><b>今天的都学完了 🎉</b>${k ? `连续学习 ${k} 天。` : ''}明天到期的词会在这里等你。<div class="bar" style="justify-content:center;margin-top:16px"><a class="btn primary" href="#/">回首页</a></div></div>`
      : id === 'wrong' ? '<div class="empty"><b>错题本是空的</b>练完有答错过的词会记在这里</div>'
      : id === 'all' ? '<div class="empty"><b>没有能这样练的词</b>先去首页建一课，或换一种练法（听句子 / 填搭配要词带例句 / 搭配）</div>'
      : id === 'hard' ? '<div class="empty"><b>还没有错过的词</b>练的时候答错过的会记在这里</div>'
      : '<div class="empty"><b>这一课还没有词</b>先去编辑页让 AI 识别一下</div>';
    return;
  }
  const s = settings.get(), n = items.length, done = new Map(), fbs = new Map(), pending = []; // i -> 是否一次答对；i -> 记忆状态反馈；pending = 进度写入
  const quizN = items.filter(q => q.mode !== 'learn').length;
  const fixed = !isToday && !given?.some(q => q.fresh || q.mode === 'learn') ? items[0].mode : null; // 固定练法的场次才有练法切换条
  const hasSent = items.some(q => q.item.sent), hasCol = items.some(q => colsOf(q.item).length);
  const allLessons = await db.all();
  const urls = new Map();
  const urlOf = l => { if (!urls.has(l.id)) urls.set(l.id, URL.createObjectURL(l.image)); return urls.get(l.id); };
  let i = 0, wrong = 0, revealed = false, hintMode = s.hintMode, choices = [], bad = new Set(), stageKey = '', mode = items[0].mode, inp = null;
  const keys = keysOf(); let autoNext = s.autoNext !== false; // 答对后自动下一题（默认）还是停在答案上看
  // 错题本随答随写：没一次答对的当场记进去，勾选框能立刻反映、中途退出也不丢
  const setBook = (k, on) => { const b = { ...settings.get().wrong }; if (on) b[k] ||= Date.now(); else delete b[k]; settings.set({ ...settings.get(), wrong: b }); };
  // 提示区放什么：打英文 / 选英文时给中文，听音点图 / 选中文时给英文，听句子点图给句子（没有就给词），填搭配给中文 + 挖空句，认词给「新词」
  const hintOf = () => {
    const q = cur(), it = q.item;
    if (mode === 'learn') return '新词 · 先认一下';
    if (mode === 'col') { const c = q.col; return (c.zh ? c.zh + ' · ' : '') + colOf(c.en).blank; }
    return mode === 'type' || mode === 'pickEn' ? it.zh : mode === 'sent' ? (it.sent || it.en) : it.en;
  };
  const label = it => mode === 'pickZh' && it.zh ? it.zh : it.en;
  const cur = () => items[i];
  // 填搭配读整条搭配（练的是短语，只读名词等于没读）
  const say = () => speak(mode === 'sent' && cur().item.sent ? cur().item.sent : mode === 'col' ? colOf(cur().col.en).text : cur().item.en, langOf(cur().lesson));
  const colHtml = it => (it.col || []).filter(c => c && c.en).map(c => {
    const t = colOf(c.en).text;
    return t ? `<div class="col">${esc(t)}${c.zh ? ' — ' + esc(c.zh) : ''}</div>` : '';
  }).join('');
  const otherN = q => {
    const lang = langOf(q.lesson), en = String(q.item.en).trim().toLowerCase();
    let n = 0;
    for (const l of allLessons) {
      if (l.id === q.lesson.id || langOf(l) !== lang) continue;
      if (l.items.some(it => String(it.en).trim().toLowerCase() === en)) n++;
    }
    return n;
  };
  // 记忆状态一句话：升到几级、下次几天后见
  const fbText = f => !f ? '' : !f.counted ? `今天已计过 · ${dueText(f.due)}再见` : !f.first ? (f.before <= 1 ? `记下了 · ${dueText(f.due)}再考` : `↓ 回到 ${levelName(f.after)} · ${dueText(f.due)}再考`) : f.after >= MASTER && f.before < MASTER ? `🏅 已掌握 · ${dueText(f.due)}再见` : `↑ ${levelName(f.after)} · ${dueText(f.due)}再见`;

  view.innerHTML = `<div class="study" tabindex="-1">
    <div class="top"><span class="step"><span id="prog"></span><small>/ ${n}</small></span><b id="title"></b>
      <span class="segs">${fixed ? `<span class="seg" id="modeSeg">${Object.entries(MODES).filter(([k]) => (hasSent || k !== 'sent') && (hasCol || k !== 'col')).map(([k, v]) => `<button data-mode="${k}" class="${k === fixed ? 'on' : ''}">${v}</button>`).join('')}</span>` : '<span class="muted auto">按熟练度自动出题</span>'}
      <span class="seg" id="hintSeg">${Object.entries(HINTS).map(([k, v]) => `<button data-m="${k}">${v}</button>`).join('')}</span>
      <span class="seg" id="nextSeg">${NEXTS.map(([k, v]) => `<button data-n="${k}" class="${+k === +autoNext ? 'on' : ''}">${v}</button>`).join('')}</span></span></div>
    <div class="progress"><i id="bar"></i></div>
    <div class="two">
      <div class="stage" id="stage"></div>
      <div class="panel deck" id="deck"></div>
    </div></div>`;
  const $ = q => view.querySelector(q), root = $('.study');
  const modeSeg = $('#modeSeg');
  if (modeSeg) modeSeg.onclick = e => { const m = e.target.dataset.mode; if (m && m !== fixed) { settings.set({ ...settings.get(), studyMode: m }); renderStudy(view, id, undefined, only); } };
  $('#hintSeg').onclick = e => { if (e.target.dataset.m) { hintMode = e.target.dataset.m; settings.set({ ...settings.get(), hintMode }); show(); } };
  // 切开关不重画页面（进度别丢），只换按钮高亮和提示条
  $('#nextSeg').onclick = e => {
    const v = e.target.dataset.n; if (!v) return;
    autoNext = !!+v; settings.set({ ...settings.get(), autoNext });
    for (const b of $('#nextSeg').children) b.classList.toggle('on', +b.dataset.n === +autoNext);
    $('.tips').innerHTML = tips(mode, keys, autoNext);
  };

  // 每题重建答题区（练法可能变了）：输入框 / 四选一 / 认词卡
  function drawDeck() {
    root.className = 'study ' + mode;
    $('#deck').innerHTML = `<div class="hint" id="hint"></div>
        ${isTyped(mode) ? `<input class="big" id="in" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="">` : ''}
        ${isPick(mode) ? '<div class="choices" id="choices"></div>' : ''}
        <div class="answer" id="ans"></div><div class="fb" id="fb"></div>
        <div class="bar">
          <button id="prev" title="上一个">‹</button><button id="say">🔊 发音</button>${mode === 'learn' ? '<button id="next" class="primary">记住了，下一个 ⏎</button>' : `<button id="show">答案</button>${isTyped(mode) ? '<button id="submit" class="primary">提交 ⏎</button>' : ''}<button id="next" title="下一个">›</button>`}
          <label class="chk"><input type="checkbox" id="mark"> 错题本</label>
        </div>
        <p class="muted tips">${tips(mode, keys, autoNext)}</p>`;
    inp = $('#in');
  }
  function drawStage() {
    const L = cur().lesson, key = L.id + (isTap(mode) ? '/tap' : '/one');
    if (stageKey === key) return;
    stageKey = key;
    $('#stage').innerHTML = `<img src="${urlOf(L)}">` + (isTap(mode)
      ? L.items.map((it, k) => `<div class="box" data-i="${k}" style="${boxStyle(it.box)}"><span class="tag">${esc(it.en)}</span></div>`).join('')
      : '<div class="box sel" id="box"></div>');
  }
  function drawHint(force) {
    const on = force || mode === 'learn' || hintMode === 'always' || (hintMode === 'wrong' && wrong > 0);
    $('#hint').textContent = on ? hintOf() : '···';
    $('#hint').className = 'hint' + (on ? '' : ' blank');
  }
  function show() {
    const q = cur(), it = q.item, ok = done.has(i), learn = mode === 'learn';
    $('#prog').textContent = i + 1;
    $('#title').textContent = q.lesson.title;
    $('#bar').style.width = (done.size / n * 100) + '%';
    for (const b of $('#hintSeg').children) b.classList.toggle('on', b.dataset.m === hintMode);
    drawHint();
    $('#ans').className = 'answer' + (ok && !learn ? ' ok' : '');
    $('#mark').checked = !!settings.get().wrong[keyOf(q)];
    // 揭晓 / 答对后把中文和例句一起给出来：点图模式提示区只有外文，不给中文就等于没学到
    const nOther = otherN(q);
    const extra = (it.sent ? `<div class="sent">${esc(it.sent)}</div><div class="sentZh">${esc(it.sentZh)}</div>` : '') + colHtml(it)
      + (nOther ? `<div class="more"><a href="#/word/${langOf(q.lesson)}/${encodeURIComponent(it.en)}">还在 ${nOther} 课出现过</a></div>` : '');
    $('#ans').innerHTML = ok || revealed || learn ? `${ok && !learn ? '✓ ' : ''}${esc(it.en)} <span class="ipa">${esc(it.ipa)}</span> ${esc(it.pos)} · ${esc(it.zh)}${extra}` : '';
    $('#fb').textContent = fbText(fbs.get(i));
    if (isTap(mode)) {
      const L = q.lesson;
      for (const b of $('#stage').querySelectorAll('.box')) {
        const itB = L.items[+b.dataset.i];
        const qi = items.findIndex((x, k) => x.lesson === L && x.item === itB && x.mode !== 'learn' && done.has(k));
        b.className = 'box' + (qi >= 0 ? ' ok' : '') + (itB === it && (ok || revealed) ? ' sel' : '');
      }
    } else $('#box').style.cssText = boxStyle(it.box);
    if (inp) {
      inp.placeholder = '输入' + LANGS[langOf(q.lesson)].name;
      inp.className = 'big' + (ok ? ' ok' : '');
      inp.value = ok ? (mode === 'col' ? (colOf(q.col.en).answers[0] || '') : it.en) : '';
      inp.readOnly = ok; // 用 readOnly 不用 disabled，焦点留在框里，快捷键才有效
      inp.focus();
    }
    if (isPick(mode)) $('#choices').innerHTML = choices.map((c, k) =>
      `<button data-k="${k}" class="${c === it && (ok || revealed) ? 'ok' : bad.has(c) ? 'bad' : ''}" ${ok ? 'disabled' : ''}>${esc(label(c))}</button>`).join('');
  }
  // 换题：干扰项从这道题所在课抽 3 个（按显示文字去重，识别重复框同一个词时不会出两个正确答案）
  function newQuestion() {
    wrong = 0; revealed = false; bad = new Set(); mode = cur().mode;
    drawDeck(); drawStage();
    if (isPick(mode)) {
      const it = cur().item, seen = new Set([label(it)]);
      const others = shuffle(cur().lesson.items.filter(x => x !== it && !seen.has(label(x)) && seen.add(label(x))));
      choices = shuffle([it, ...others.slice(0, 3)]);
    }
    if (mode === 'learn' && !done.has(i)) done.set(i, true); // 认词不算答题，看过就算过
    show();
    if (!inp) root.focus({ preventScroll: true }); // 快捷键挂在 view 上，焦点得在里面
    if ((isTap(mode) || mode === 'learn') && (mode === 'learn' || !done.has(i))) say();
  }
  // skipDone：答对后自动前进时跳过已答完的，直到剩下的都做完
  const go = (d, skipDone) => {
    do i = (i + d + n) % n; while (skipDone && done.has(i) && done.size < n);
    newQuestion();
  };
  // 答完了往下走：跳过已答的，全答完就出结果；没答的题就是普通翻页
  const next = () => !done.has(i) ? go(1) : done.size === n ? finish() : go(1, true);
  async function correct() {
    const first = wrong === 0 && !revealed, at = i, q = cur();
    done.set(at, first);
    if (!first) setBook(keyOf(q), true);
    if (!isTap(mode)) say(); // 点图模式刚播过，不重复
    show();
    // 记忆状态当场写，回来还在这题就把升降显示出来
    pending.push(record(q, first).then(f => { fbs.set(at, f); if (root.isConnected && i === at) $('#fb').textContent = fbText(f); }).catch(e => console.warn('进度没存上', e)));
    if (autoNext) setTimeout(() => { if (root.isConnected && i === at) next(); }, 1300); // 期间已手动翻页 / 切模式 / 离开就作废
  }
  function submit() {
    if (done.has(i)) return next();
    const q = cur();
    const a = mode === 'col' ? colOf(q.col.en).answers : null;
    const target = a ? { en: a[0] || '', alts: a.slice(1) } : q.item;
    if (isRight(inp.value, target, langOf(q.lesson))) return correct();
    wrong++; inp.className = 'big'; void inp.offsetWidth; inp.className = 'big bad';
    drawHint(); inp.select();
  }
  function choose(c) {
    if (done.has(i) || bad.has(c)) return;
    if (c === cur().item) return correct();
    wrong++; bad.add(c); show();
  }
  // 点图：只看点的位置在不在目标框里，不管碰到的是哪个框——床上的枕头、毯子不再挡住「床」
  const inside = ([y1, x1, y2, x2], x, y) => y >= y1 && y <= y2 && x >= x1 && x <= x2;
  function tapAt(e) {
    if (!isTap(mode)) return done.has(i) && !autoNext ? next() : undefined;
    if (done.has(i)) return autoNext ? undefined : next(); // 停住模式：答完再点图任何地方 = 下一题（手机上比找 › 顺手）
    const r = $('#stage').getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 1000, y = (e.clientY - r.top) / r.height * 1000;
    if (inside(cur().item.box, x, y)) return correct();
    wrong++; drawHint();
    // 点错了：把碰到的那个物品（最小的那个框）亮红一下并带名字，顺手认一个
    const hit = cur().lesson.items.map((it, k) => [it, k]).filter(([it]) => inside(it.box, x, y))
      .sort((a, b) => (a[0].box[2] - a[0].box[0]) * (a[0].box[3] - a[0].box[1]) - (b[0].box[2] - b[0].box[0]) * (b[0].box[3] - b[0].box[1]))[0];
    if (!hit) return;
    const b = $(`.box[data-i="${hit[1]}"]`);
    b.classList.add('bad'); setTimeout(() => b.classList.remove('bad'), 1000);
  }
  let finished = false; // 结果页画完后 Enter / 自动下一题还可能再进来，日志只记一次
  async function finish() {
    if (finished) return;
    finished = true;
    const quizIdx = [...items.keys()].filter(k => items[k].mode !== 'learn');
    const first = quizIdx.filter(k => done.get(k)).length;
    // 没一次答对的在答题那一刻已进错题本；答对的不自动移出（错完马上再练一遍答对就没了，来不及导 Anki），由下面的勾选框决定
    const book = settings.get().wrong, missed = quizIdx.filter(k => !done.get(k)).map(k => items[k]);
    const modes = {};
    for (const k of quizIdx) {
      const m = items[k].mode;
      if (!MODES[m]) continue;
      if (!modes[m]) modes[m] = { n: 0, right: 0 };
      modes[m].n++;
      if (done.get(k)) modes[m].right++;
    }
    if (quizIdx.length) logDay({ n: quizIdx.length, right: first, new: items.filter(q => q.mode === 'learn').length, modes });
    const k = streak();
    await Promise.all(pending);
    const plist = await prog.all();
    if (!root.isConnected) return; // 等进度写完这会儿用户已经离开，别把别的页面画成结果页
    const mix = id === 'today' || id === 'wrong' || id === 'all' || id === 'hard';
    const seen = [], seenIds = new Set();
    for (const q of items) {
      if (!q.lesson || seenIds.has(q.lesson.id)) continue;
      seenIds.add(q.lesson.id);
      seen.push(q.lesson);
    }
    const ready = masteredLessons(seen, plist);
    // 整课自由练才有按钮行里的「收起这一课」；已经出现在上方提示行的课不再重复
    const lesson = !mix && items[0]?.lesson, hideOld = lesson && ready.some(l => l.id === lesson.id);
    const archBtn = !lesson || hideOld ? '' : lesson.archived ? '<button disabled>已收起</button>' : `<button id="arch" class="${!given && first === quizN ? 'primary' : ''}">收起这一课</button>`;
    const fbLine = q => { const f = fbs.get(items.indexOf(q)); return f ? `<span class="lv">${f.before === 0 ? '新学' : !f.first ? '↓' : f.after > f.before ? '↑' : '·'} ${levelName(f.after)} · ${dueText(f.due)}</span>` : ''; };
    const hints = ready.map(l => `<p class="muted">「${esc(l.title)}」全部掌握了 <button data-arch="${esc(l.id)}" class="mini">收起这一课</button></p>`).join('');
    view.innerHTML = `<div class="result"><div class="score">${first} / ${quizIdx.length}</div><p class="muted">一次答对${k ? ` · 🔥 连续学习 ${k} 天` : ''}</p>
      <ul>${quizIdx.map(k => { const q = items[k]; return `<li><span class="k ${done.get(k) ? 'ok' : 'no'}">${done.get(k) ? '✓' : '△'}</span><b>${esc(q.item.en)}</b><span class="muted">${esc(q.item.zh)}</span>${fbLine(q)}<label class="chk"><input type="checkbox" data-key="${esc(keyOf(q))}"${book[keyOf(q)] ? ' checked' : ''}> 错题本</label></li>`; }).join('')}</ul>
      ${hints}
      <div class="bar">${isToday ? `<a class="btn primary" href="#/study/today${only ? '/' + only : ''}" id="more">再来一组</a>` : '<button id="again" class="primary">再来一遍</button>'}${missed.length ? `<button id="retry">再练错的 ${missed.length} 个</button>` : ''}${archBtn}<a class="btn" href="#/">回首页</a></div></div>`;
    // 勾 = 在错题本；同一个词两个框共用一个键，一起勾一起取消
    view.querySelector('ul').onchange = e => {
      const k = e.target.dataset.key; if (!k) return;
      setBook(k, e.target.checked);
      for (const c of view.querySelectorAll('input[data-key]')) if (c.dataset.key === k) c.checked = e.target.checked;
    };
    for (const b of view.querySelectorAll('[data-arch]')) b.onclick = async e => {
      await setArchived(e.target.dataset.arch, true);
      toast('已收起，不再催复习');
      e.target.closest('p').textContent = '已收起';
    };
    const arch = view.querySelector('#arch');
    if (arch) arch.onclick = async () => { await setArchived(id, true); toast('已收起，不再催复习'); location.hash = '#/'; };
    const again = view.querySelector('#again');
    if (again) again.onclick = () => renderStudy(view, id, items, only); // 重练刚才这份题单，错题本练完全对也不会变成空页
    const more = view.querySelector('#more');
    if (more) more.onclick = e => { e.preventDefault(); renderStudy(view, 'today', undefined, only); }; // hash 没变，手动重进
    const retry = view.querySelector('#retry');
    if (retry) retry.onclick = () => renderStudy(view, id, missed, only);
  }
  // 答题区每题重建，事件挂在 view 上按 id 分发
  view.onclick = e => {
    const t = e.target.closest('button, #stage'); if (!t) return;
    if (t.id === 'stage') return tapAt(e);
    if (t.id === 'submit') return submit();
    if (t.id === 'prev') return go(-1);
    if (t.id === 'next') return next();
    if (t.id === 'say') return say();
    if (t.id === 'show') { revealed = true; return show(); }
    if (t.dataset.k !== undefined && t.closest('#choices')) return choose(choices[t.dataset.k]);
  };
  view.onchange = e => { if (e.target.id === 'mark') setBook(keyOf(cur()), e.target.checked); };
  view.onkeydown = e => {
    if (e.isComposing) return; // 日语 / 韩语输入法选字时的回车不算提交
    const c = comboOf(e); // 先配自定义组合键，再看普通 Enter（用户把 Ctrl+Enter 之类设成快捷键也能用）
    if (c === keys.say) say();
    else if (c === keys.show && mode !== 'learn') { revealed = true; show(); }
    else if (c === keys.mark) $('#mark').click();
    else if (e.key === 'Enter') isTyped(mode) ? submit() : next();
    else if (isPick(mode) && /^[1-4]$/.test(e.key) && choices[e.key - 1]) choose(choices[e.key - 1]);
    else return;
    e.preventDefault();
  };
  newQuestion();
}
