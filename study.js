// 学习页：九种练法（打单词 / 听音点图 / 听句子点图 / 选单词 / 选中文 / 填搭配 / 说出来 / 记忆宫殿 / 少了什么）+ 新词「先猜后看」；「今天」题单每题按熟练度自带练法，答完当场写记忆状态并显示升降
import { db, esc, toast, settings, LANGS, langOf, wrongEntries, keysOf, comboOf, colOf, hitAt, inside, ding, fitCrops } from './lib.js';
import { keyOf, record, modeFor, buildToday, prog, logDay, streak, levelName, dueText, MASTER, hardWords } from './progress.js';
import { speak } from './tts.js';
import { boxStyle } from './editor.js';
import { canListen, listen } from './speech.js';
import { renderResult } from './result.js';

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
// 说出来判对：识别出的任一候选整句算对，或句子里含这个词（「it's a kettle」）；日语不分词，直接看包含
export const heard = (list, it, lang = 'en') => list.some(t => isRight(t, it, lang) || [it.en, ...(it.alts || [])].some(w => {
  const b = norm(w, lang), a = norm(t, lang);
  return b && (lang === 'ja' ? a.includes(b) : [b, b + 's', b + 'es'].some(x => ` ${a} `.includes(` ${x} `)));
}));

export const MODES = { type: '打单词', tap: '听音点图', sent: '听句子点图', pickEn: '选单词', pickZh: '选中文', col: '填搭配', speak: '说出来', palace: '记忆宫殿', miss: '少了什么' };
const isPick = m => m.startsWith('pick') || m === 'miss', isTap = m => m === 'tap' || m === 'sent', isTyped = m => m === 'type' || m === 'col' || m === 'palace';
const shuffle = a => { for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } return a; };
// 能出题的搭配：括号里至少有一个答案（手打成「[] the kettle」或坏备份里的空串，出了题谁也答不对）
const colsOf = it => (it.col || []).filter(c => c && colOf(c.en).answers.length);
const pickCol = it => { const a = colsOf(it); return a[Math.floor(Math.random() * a.length)]; };
const SPECIAL = ['today', 'first', 'wrong', 'all', 'hard']; // 这些不是课程 id，别拿去 db.get

// 入口共用题单 [{ lesson, item, mode, fresh?, col? }]。first = 新手第一场：只认 3 个新词再考一遍
async function loadQuiz(id, given, only) {
  if (given) return given;
  if (id === 'today' || id === 'first') {
    let { due, fresh } = buildToday(await db.all(), await prog.all(), only);
    if (id === 'first') { due = []; fresh = fresh.slice(0, 3); }
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
  // 记忆宫殿整课按从左到右走一圈（位置就是线索）；点图、少了什么打乱，不然按位置就能记住
  if (mode === 'palace' && !SPECIAL.includes(id)) return quiz.sort((a, b) => (a.item.box[1] + a.item.box[3]) - (b.item.box[1] + b.item.box[3]));
  return isTap(mode) || mode === 'miss' ? shuffle(quiz) : quiz;
}

export async function renderStudy(view, id, given, only) {
  const items = await loadQuiz(id, given, only), isToday = id === 'today' || id === 'first';
  const back = SPECIAL.includes(id) ? (id === 'wrong' || id === 'hard' ? '#/stats' : '#/') : '#/scene/' + id;
  if (!items.length) {
    const k = streak();
    view.innerHTML = isToday ? `<div class="empty"><b>今天的都学完了 🎉</b>${k ? `连续学习 ${k} 天。` : ''}明天到期的词会在这里等你。想多玩一会儿，去「世界」挑个场景逛逛记忆宫殿。<div class="bar" style="justify-content:center;margin-top:16px"><a class="btn primary" href="#/world">去世界</a></div></div>`
      : id === 'wrong' ? '<div class="empty"><b>错题本是空的</b>练完有答错过的词会记在这里</div>'
      : id === 'all' ? '<div class="empty"><b>没有能这样练的词</b>先去「世界」挑一课，或换一种练法（听句子 / 填搭配要词带例句 / 搭配）</div>'
      : id === 'hard' ? '<div class="empty"><b>还没有错过的词</b>练的时候答错过的会记在这里</div>'
      : '<div class="empty"><b>这一课还没有词</b>先去编辑页让 AI 识别一下</div>';
    return;
  }
  const s = settings.get(), done = new Map(), fbs = new Map(), pending = []; // i -> 是否一次答对；i -> 记忆状态反馈；pending = 进度写入
  const before = new Map((await prog.all()).map(p => [p.key, p])); // 开场时的进度，结果页拿来画「上色前」
  const fixed = !isToday && !given?.some(q => q.fresh || q.mode === 'learn') ? items[0].mode : null; // 固定练法的场次才能换练法
  const hasSent = items.some(q => q.item.sent), hasCol = items.some(q => colsOf(q.item).length);
  const allLessons = await db.all();
  const urls = new Map();
  const urlOf = l => { if (!urls.has(l.id)) urls.set(l.id, URL.createObjectURL(l.image)); return urls.get(l.id); };
  const hintMode = s.hintMode || 'always', autoNext = s.autoNext !== false, keys = keysOf(); // 这两个开关在「我 → 学习」里改，学习页不摆开关
  let i = 0, wrong = 0, revealed = false, choices = [], bad = new Set(), stageKey = '', mode = items[0].mode, inp = null, listening = false, peek = false; // peek = 说出来这题先听过答案
  // 错题本随答随写：没一次答对的当场记进去，勾选框能立刻反映、中途退出也不丢
  const setBook = (k, on) => { const b = { ...settings.get().wrong }; if (on) b[k] ||= Date.now(); else delete b[k]; settings.set({ ...settings.get(), wrong: b }); };
  // 提示区放什么：打单词 / 选单词 / 说出来给中文，听音点图 / 选中文给外文，听句子给句子，填搭配给中文 + 挖空句，新词先问「叫什么」，记忆宫殿只问位置（答错才给中文）
  const hintOf = () => {
    const q = cur(), it = q.item;
    if (mode === 'learn') return revealed ? '新词' : '你觉得它叫什么？';
    if (mode === 'palace') return wrong || revealed ? it.zh : '这里是什么？';
    if (mode === 'miss') return '图里少了什么？';
    if (mode === 'col') { const c = q.col; return (c.zh ? c.zh + ' · ' : '') + colOf(c.en).blank; }
    return mode === 'type' || mode === 'pickEn' || mode === 'speak' ? it.zh : mode === 'sent' ? (it.sent || it.en) : it.en;
  };
  const label = it => mode === 'pickZh' && it.zh ? it.zh : it.en;
  const cur = () => items[i];
  // 填搭配读整条搭配（练的是短语，只读名词等于没读）
  const say = () => speak(mode === 'sent' && cur().item.sent ? cur().item.sent : mode === 'col' ? colOf(cur().col.en).text : cur().item.en, langOf(cur().lesson));
  const colHtml = it => (it.col || []).filter(c => c && c.en).map(c => {
    const t = colOf(c.en).text;
    return t ? `<div class="col">${esc(t)}${c.zh ? ' — ' + esc(c.zh) : ''}</div>` : '';
  }).join('');
  // 一词多图：同语种别的课里的同一个词（最多 3 张裁图）
  const others = q => {
    const lang = langOf(q.lesson), en = String(q.item.en).trim().toLowerCase(), out = [];
    for (const l of allLessons) {
      if (l.id === q.lesson.id || langOf(l) !== lang) continue;
      const it = l.items.find(x => String(x.en).trim().toLowerCase() === en);
      if (it) out.push({ l, it });
    }
    return out;
  };
  // 记忆状态一句话：升到几级、下次几天后见
  const fbText = f => !f ? '' : !f.counted ? `今天已计过 · ${dueText(f.due)}再见` : !f.first ? (f.before <= 1 ? `记下了 · ${dueText(f.due)}再考` : `↓ 回到 ${levelName(f.after)} · ${dueText(f.due)}再考`) : f.after >= MASTER && f.before < MASTER ? `🏅 已掌握，图里这样东西上色了 · ${dueText(f.due)}再见` : `↑ ${levelName(f.after)} · ${dueText(f.due)}再见`;

  view.innerHTML = `<div class="study" tabindex="-1">
    <div class="top"><a class="btn quit" href="${back}" title="退出">✕</a><div class="progress"><i id="bar"></i></div><span class="step"><span id="prog"></span><small id="tot"></small></span>
      ${fixed ? `<select id="modeSel" title="换一种练法">${Object.entries(MODES).filter(([k]) => (hasSent || k !== 'sent') && (hasCol || k !== 'col')).map(([k, v]) => `<option value="${k}" ${k === fixed ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}</div>
    <div class="two">
      <div><div class="stage" id="stage"></div><p class="where muted" id="title"></p></div>
      <div class="panel deck" id="deck"></div>
    </div></div>`;
  const $ = q => view.querySelector(q), root = $('.study');
  if ($('#modeSel')) $('#modeSel').onchange = e => { settings.set({ ...settings.get(), studyMode: e.target.value }); renderStudy(view, id, undefined, only); };

  // 每题重建答题区（练法可能变了）：输入框 / 四选一 / 话筒 / 新词卡
  function drawDeck() {
    root.className = 'study ' + mode;
    const mic = mode === 'speak' && canListen();
    $('#deck').innerHTML = `<div class="hint" id="hint"></div>
        ${isTyped(mode) ? `<input class="big" id="in" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="">` : ''}
        ${isPick(mode) ? '<div class="choices" id="choices"></div>' : ''}
        ${mic ? '<button id="mic" class="mic">🎤 按一下，说出来</button>' : ''}
        <div class="answer" id="ans"></div><div class="fb" id="fb"></div>
        ${mode === 'speak' ? '<div class="bar grade" id="grade" hidden><button id="gradeOk" class="okb">✓ 我说对了</button><button id="gradeNo">✗ 没说对</button></div>' : ''}
        <div class="bar">
          <button id="prev" title="上一个">‹</button><button id="say" title="发音">🔊</button>${mode === 'learn' ? '<button id="show" class="primary">揭晓 ⏎</button><button id="forgot">还没记住 ⌫</button><button id="next" class="primary">记住了 ⏎</button>' : `<button id="show">答案</button>${isTyped(mode) ? '<button id="submit" class="primary">提交 ⏎</button>' : ''}<button id="next" title="下一个">›</button>`}
          <label class="chk"><input type="checkbox" id="mark"> 错题本</label>
        </div>`;
    inp = $('#in');
  }
  function drawStage() {
    const L = cur().lesson, kind = isTap(mode) ? 'tap' : mode === 'palace' ? 'palace' : 'one', key = L.id + '/' + kind;
    if (stageKey === key) return;
    stageKey = key;
    $('#stage').innerHTML = `<div class="cam" id="cam"><img src="${urlOf(L)}">` + (kind === 'one' ? '<div class="box sel" id="box"></div>'
      : L.items.map((it, k) => `<div class="box${kind === 'palace' ? ' ghost' : ''}" data-i="${k}" style="${boxStyle(it.box)}"><span class="tag">${esc(it.en)}</span></div>`).join('') + (kind === 'palace' ? '<div class="box sel" id="box"></div>' : '')) + '</div>';
  }
  // 镜头：新词推近到那样东西（留一圈周围好记位置），别的练法拉回全景
  function camTo(b) {
    const cam = $('#cam'); if (!cam) return;
    let s = 1, tx = 0, ty = 0;
    if (b) {
      const [y1, x1, y2, x2] = b;
      s = Math.max(1, Math.min(2.2, .55 / Math.max((x2 - x1) / 1000, (y2 - y1) / 1000)));
      tx = Math.min(0, Math.max(1 - s, .5 - s * (x1 + x2) / 2000)); ty = Math.min(0, Math.max(1 - s, .5 - s * (y1 + y2) / 2000));
    }
    cam.style.transform = `translate(${tx * 100}%,${ty * 100}%) scale(${s})`;
    cam.style.setProperty('--z', s);
  }
  function drawHint(force) {
    const on = force || ['learn', 'palace', 'miss'].includes(mode) || hintMode === 'always' || (hintMode === 'wrong' && wrong > 0);
    $('#hint').textContent = on ? hintOf() : '···';
    $('#hint').className = 'hint' + (on ? '' : ' blank');
  }
  function show() {
    const q = cur(), it = q.item, ok = done.has(i), learn = mode === 'learn', open = ok || revealed;
    $('#prog').textContent = i + 1;
    $('#title').textContent = q.lesson.title;
    $('#tot').textContent = '/ ' + items.length;
    $('#bar').style.width = (done.size / items.length * 100) + '%';
    drawHint();
    $('#ans').className = 'answer' + (ok && !learn ? ' ok' : '');
    $('#mark').checked = !!settings.get().wrong[keyOf(q)];
    // 揭晓 / 答对后：词、读音、中文先给；例句和搭配折起来，想看再展开；别的图里也有这个词就摆裁图
    const more = (it.sent ? `<div class="sent">${esc(it.sent)}</div><div class="sentZh">${esc(it.sentZh)}</div>` : '') + colHtml(it);
    const also = others(q);
    $('#ans').innerHTML = open ? `<div class="word">${ok && !learn ? '✓ ' : ''}${esc(it.en)}</div><div class="meta"><span class="ipa">${esc(it.ipa)}</span> ${esc(it.pos)} · ${esc(it.zh)}</div>
      ${more ? `<details class="more"><summary>例句 · 搭配</summary>${more}</details>` : ''}
      ${also.length ? `<div class="also"><a href="#/word/${langOf(q.lesson)}/${encodeURIComponent(it.en)}">它还在 ${also.length} 张图里 ›</a><div class="crops">${also.slice(0, 3).map(o => `<div class="crop"><img src="${urlOf(o.l)}" data-box="${o.it.box.join(',')}"></div>`).join('')}</div></div>` : ''}` : '';
    fitCrops($('#ans'));
    $('#fb').textContent = fbText(fbs.get(i)) || (mode === 'speak' && !ok && !revealed && !canListen() ? '先大声说出来，再点「答案」对一下' : q.again && !ok && !revealed ? (learn ? '再看一遍' : '刚才没答对，再来一次') : '');
    if (learn) { $('#show').hidden = revealed; $('#next').hidden = $('#forgot').hidden = !revealed; }
    if ($('#grade')) $('#grade').hidden = !(revealed && !ok);
    if ($('#mic')) $('#mic').disabled = ok;
    if (isTap(mode)) {
      const L = q.lesson;
      for (const b of $('#stage').querySelectorAll('.box')) {
        const itB = L.items[+b.dataset.i];
        const qi = items.findIndex((x, k) => x.lesson === L && x.item === itB && x.mode !== 'learn' && done.has(k));
        b.className = 'box' + (qi >= 0 ? ' ok' : '') + (itB === it && open ? ' sel' : '');
      }
    } else {
      $('#box').style.cssText = boxStyle(it.box);
      $('#box').className = 'box ' + (mode === 'miss' && !open ? 'fog' : 'sel');
      $('#stage').classList.toggle('lit', mode === 'palace' && open); // 记忆宫殿：答出来灯就亮
    }
    camTo(learn ? it.box : null);
    if (inp) {
      inp.placeholder = mode === 'palace' ? '按位置回想' : '输入' + LANGS[langOf(q.lesson)].name;
      inp.className = 'big' + (ok ? ' ok' : '');
      inp.value = ok ? (mode === 'col' ? (colOf(q.col.en).answers[0] || '') : it.en) : '';
      inp.readOnly = ok; // 用 readOnly 不用 disabled，焦点留在框里，快捷键才有效
      inp.focus();
    }
    if (isPick(mode)) $('#choices').innerHTML = choices.map((c, k) =>
      `<button data-k="${k}" class="${c === it && open ? 'ok' : bad.has(c) ? 'bad' : ''}" ${ok ? 'disabled' : ''}>${esc(label(c))}</button>`).join('');
  }
  // 换题：干扰项从这道题所在课抽 3 个（按显示文字去重，识别重复框同一个词时不会出两个正确答案）
  function newQuestion() {
    wrong = 0; peek = false; bad = new Set(); mode = cur().mode; revealed = mode === 'learn' && done.has(i);
    drawDeck(); drawStage();
    if (isPick(mode)) {
      const it = cur().item, seen = new Set([label(it)]);
      const pool = shuffle(cur().lesson.items.filter(x => x !== it && !seen.has(label(x)) && seen.add(label(x))));
      choices = shuffle([it, ...pool.slice(0, 3)]);
    }
    show();
    if (!inp) root.focus({ preventScroll: true }); // 快捷键挂在 view 上，焦点得在里面
    if (isTap(mode) && !done.has(i)) say();
  }
  // 揭晓：新词这一下才算看过、才读出来；说出来揭晓后出「我说对了 / 没说对」
  function reveal() {
    if (revealed) return;
    revealed = true;
    if (mode === 'learn' && !done.has(i)) { done.set(i, true); say(); }
    show();
  }
  // skipDone：答对后自动前进时跳过已答完的，直到剩下的都做完
  const go = (d, skipDone) => {
    const n = items.length;
    do i = (i + d + n) % n; while (skipDone && done.has(i) && done.size < n);
    newQuestion();
  };
  // 答完了往下走：跳过已答的，全答完就出结果；没答的题就是普通翻页
  const next = () => !done.has(i) ? go(1) : done.size === items.length ? finish() : go(1, true);
  // 这一场里再见一次（新词「还没记住」/ 新词考错）：复制一张插到 3 张之后；done / fbs 按下标记，插入点之后的往后挪。副本不记进度、不进结果页和日志
  const again = q => {
    const p = Math.min(i + 4, items.length);
    items.splice(p, 0, { ...q, again: true });
    for (const m of [done, fbs]) { const e = [...m]; m.clear(); for (const [k, v] of e) m.set(k >= p ? k + 1 : k, v); }
  };
  function miss() { wrong++; ding(false); drawHint(); }
  function correct(first = wrong === 0 && !revealed) {
    const at = i, q = cur();
    done.set(at, first);
    ding(first);
    if (!first) setBook(keyOf(q), true);
    if (!first && q.fresh) again(q); // 新词考错了，过几张再考，直到答对
    if (!isTap(mode)) say(); // 点图模式刚播过，不重复
    show();
    // 记忆状态当场写，回来还在这题就把升降显示出来
    if (!q.again) pending.push(record(q, first).then(f => { fbs.set(items.indexOf(q), f); if (root.isConnected && cur() === q) $('#fb').textContent = fbText(f); }).catch(e => console.warn('进度没存上', e)));
    if (autoNext) setTimeout(() => { if (root.isConnected && cur() === q) next(); }, 1300); // 期间已手动翻页 / 切模式 / 离开就作废；按题目认不按下标（again 插卡会挪下标）
  }
  function submit() {
    if (done.has(i)) return next();
    const q = cur();
    const a = mode === 'col' ? colOf(q.col.en).answers : null;
    const target = a ? { en: a[0] || '', alts: a.slice(1) } : q.item;
    if (isRight(inp.value, target, langOf(q.lesson))) return correct();
    miss(); inp.className = 'big'; void inp.offsetWidth; inp.className = 'big bad';
    inp.select();
  }
  function choose(c) {
    if (done.has(i) || bad.has(c)) return;
    if (c === cur().item) return correct();
    bad.add(c); miss(); show();
  }
  // 说出来：识别到了就自动判；识别坏了（没权限 / 连不上）这场改成自己判
  async function mic() {
    if (done.has(i) || listening) return;
    const q = cur(), btn = $('#mic');
    listening = true; btn.classList.add('on'); btn.textContent = '在听…';
    try {
      const got = await listen(LANGS[langOf(q.lesson)].tag).done;
      if (!root.isConnected || cur() !== q) return;
      if (heard(got, q.item, langOf(q.lesson))) return correct();
      miss();
      $('#fb').textContent = got.length ? `听成了「${got[0]}」· 再说一次，或点「答案」对一下` : '没听清，再说一次';
    } catch (e) {
      toast(e.message + (canListen() ? '' : '，改成自己判：说出来再点「答案」'));
      if (!canListen() && root.isConnected && cur() === q) { drawDeck(); show(); return; }
    } finally { listening = false; }
    if (root.isConnected && cur() === q && $('#mic')) { $('#mic').classList.remove('on'); $('#mic').textContent = '🎤 再说一次'; }
  }
  // 自己判：揭晓后对照答案，说对了算一次答对（揭晓本身不扣分，本来就得看答案才能判）
  const grade = ok => { if (done.has(i)) return; if (!ok) wrong++; correct(ok && wrong === 0 && !peek); }; // 先点🔊听过答案再说，不算一次答对
  // 点图：只看点的位置在不在目标框里，不管碰到的是哪个框——床上的枕头、毯子不再挡住「床」
  function tapAt(e) {
    if (!isTap(mode)) return done.has(i) && !autoNext ? next() : undefined;
    if (done.has(i)) return autoNext ? undefined : next(); // 停住模式：答完再点图任何地方 = 下一题（手机上比找 › 顺手）
    const r = $('#stage').getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 1000, y = (e.clientY - r.top) / r.height * 1000;
    if (inside(cur().item.box, x, y)) return correct();
    miss();
    // 点错了：把碰到的那个物品（最小的那个框）亮红一下并带名字，顺手认一个
    const hit = hitAt(cur().lesson.items, x, y);
    if (!hit) return;
    const b = $(`.box[data-i="${hit[1]}"]`);
    b.classList.add('bad'); setTimeout(() => b.classList.remove('bad'), 1000);
  }
  let finished = false; // 结果页画完后 Enter / 自动下一题还可能再进来，日志只记一次
  async function finish() {
    if (finished) return;
    finished = true;
    const quizIdx = [...items.keys()].filter(k => items[k].mode !== 'learn' && !items[k].again);
    const modes = {};
    for (const k of quizIdx) {
      const m = items[k].mode;
      if (!MODES[m]) continue;
      modes[m] ||= { n: 0, right: 0 };
      modes[m].n++;
      if (done.get(k)) modes[m].right++;
    }
    if (quizIdx.length) logDay({ n: quizIdx.length, right: quizIdx.filter(k => done.get(k)).length, new: items.filter(q => q.mode === 'learn' && !q.again).length, modes });
    await Promise.all(pending);
    if (!root.isConnected) return; // 等进度写完这会儿用户已经离开，别把别的页面画成结果页
    renderResult(view, { id, only, given, items, quizIdx, done, fbs, before, setBook, restart: g => renderStudy(view, id, g, only) });
  }
  // 答题区每题重建，事件挂在 view 上按 id 分发
  view.onclick = e => {
    const t = e.target.closest('button, #stage'); if (!t) return;
    if (t.id === 'stage') return tapAt(e);
    if (t.id === 'submit') return submit();
    if (t.id === 'prev') return go(-1);
    if (t.id === 'next') return next();
    if (t.id === 'forgot') { again(cur()); return next(); }
    if (t.id === 'say') { if (mode === 'speak' && !done.has(i)) { peek = true; reveal(); } return say(); } // 说出来：先听答案就等于揭晓
    if (t.id === 'show') return reveal();
    if (t.id === 'mic') return mic();
    if (t.id === 'gradeOk') return grade(true);
    if (t.id === 'gradeNo') return grade(false);
    if (t.dataset.k !== undefined && t.closest('#choices')) return choose(choices[t.dataset.k]);
  };
  view.onchange = e => { if (e.target.id === 'mark') setBook(keyOf(cur()), e.target.checked); };
  view.onkeydown = e => {
    if (e.isComposing || e.target.id === 'modeSel') return; // 日语 / 韩语输入法选字时的回车不算提交
    const c = comboOf(e); // 先配自定义组合键，再看普通 Enter（用户把 Ctrl+Enter 之类设成快捷键也能用）
    if (c === keys.say) { if (mode === 'speak' && !done.has(i)) { peek = true; reveal(); } say(); }
    else if (c === keys.show) reveal();
    else if (c === keys.mark) $('#mark').click();
    else if (e.key === 'Backspace' && mode === 'learn' && revealed) { again(cur()); next(); }
    else if (e.key === 'Enter') isTyped(mode) ? submit() : (mode === 'learn' || mode === 'speak') && !revealed && !done.has(i) ? reveal() : next();
    else if (isPick(mode) && /^[1-4]$/.test(e.key) && choices[e.key - 1]) choose(choices[e.key - 1]);
    else return;
    e.preventDefault();
  };
  newQuestion();
}
