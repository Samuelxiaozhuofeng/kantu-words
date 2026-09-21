// 学习页：六种练法（打英文 / 听音点图 / 听句子点图 / 选英文 / 选中文 / 填搭配），框亮起或全部可点，走完出结果
import { db, esc, toast, settings, LANGS, langOf, setArchived, wrongEntries, keysOf, keyParts, comboOf, colOf } from './lib.js';
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

const MODES = { type: '打单词', tap: '听音点图', sent: '听句子点图', pickEn: '选单词', pickZh: '选中文', col: '填搭配' };
const HINTS = { always: '一直显示', wrong: '答错后显示', never: '不显示' };
const NEXTS = [[1, '自动下一题'], [0, '答完停住']];
const kbd = combo => keyParts(combo).map(k => `<kbd>${esc(k)}</kbd>`).join('+');
// 提示条：快捷键按设置里的来；停住模式多一句 Enter 下一题
const tips = (mode, keys, autoNext) => ({
  type: '<kbd>Enter</kbd> 提交', col: '<kbd>Enter</kbd> 提交',
  tap: `听发音，点图里对应的物品`,
  sent: `听句子，点图里说到的物品`,
  pickEn: '<kbd>1</kbd>–<kbd>4</kbd> 选', pickZh: '<kbd>1</kbd>–<kbd>4</kbd> 选',
}[mode] + ` · ${kbd(keys.say)} 发音 · ${kbd(keys.show)} 答案 · ${kbd(keys.mark)} 错题本` + (autoNext ? '' : ' · <kbd>Enter</kbd> 下一题'));
const shuffle = a => { for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } return a; };

// 三种入口共用题单：整课 / 错题本 / 本次错的。id === 'wrong' 不是课程 id，别拿去 db.get
async function loadQuiz(id, given) {
  if (given) return given;
  if (id === 'wrong') return wrongEntries(await db.all(), settings.get().wrong);
  const lesson = await db.get(id);
  return lesson?.items.length ? lesson.items.map(item => ({ lesson, item })) : [];
}

export async function renderStudy(view, id, given) {
  const quiz0 = await loadQuiz(id, given);
  if (!quiz0.length) {
    view.innerHTML = id === 'wrong'
      ? '<div class="empty"><b>错题本是空的</b>练完有答错过的词会记在这里</div>'
      : '<div class="empty"><b>这一课还没有词</b>先去编辑页让 AI 识别一下</div>';
    return;
  }
  const s = settings.get(), hasSent = quiz0.some(q => q.item.sent);
  // 能出题的搭配：括号里至少有一个答案（手打成「[] the kettle」或坏备份里的空串，出了题谁也答不对）
  const colsOf = it => (it.col || []).filter(c => c && colOf(c.en).answers.length);
  const hasCol = quiz0.some(q => colsOf(q.item).length);
  const mode = s.studyMode === 'sent' && !hasSent ? 'tap' : s.studyMode === 'col' && !hasCol ? 'type' : MODES[s.studyMode] ? s.studyMode : 'type';
  const pick = mode.startsWith('pick'), tap = mode === 'tap' || mode === 'sent', typed = mode === 'type' || mode === 'col';
  const pickCol = it => { const a = colsOf(it); return a[Math.floor(Math.random() * a.length)]; };
  // 填搭配：只出有搭配的词，每人随机抽一条；点图模式打乱出题顺序，不然按位置就能记住
  const quiz = mode === 'col' ? quiz0.filter(q => colsOf(q.item).length).map(q => ({ ...q, col: pickCol(q.item) })) : quiz0;
  const items = tap ? shuffle([...quiz]) : quiz, n = items.length, done = new Map(); // i -> 是否一次答对
  const allLessons = await db.all();
  const urls = new Map();
  const urlOf = l => { if (!urls.has(l.id)) urls.set(l.id, URL.createObjectURL(l.image)); return urls.get(l.id); };
  let i = 0, wrong = 0, revealed = false, hintMode = s.hintMode, choices = [], bad = new Set(), stageId = '';
  const keys = keysOf(); let autoNext = s.autoNext !== false; // 答对后自动下一题（默认）还是停在答案上看
  const keyOf = q => q.lesson.id + '|' + q.item.en;
  // 错题本随答随写：没一次答对的当场记进去，勾选框能立刻反映、中途退出也不丢
  const setBook = (k, on) => { const b = { ...settings.get().wrong }; if (on) b[k] ||= Date.now(); else delete b[k]; settings.set({ ...settings.get(), wrong: b }); };
  // 提示区放什么：打英文 / 选英文时给中文，听音点图 / 选中文时给英文，听句子点图给句子（没有就给词），填搭配给中文 + 挖空句
  const hintOf = () => {
    const q = cur(), it = q.item;
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

  view.innerHTML = `<div class="study ${mode}" tabindex="-1">
    <div class="top"><span class="step"><span id="prog"></span><small>/ ${n}</small></span><b id="title"></b>
      <span class="segs"><span class="seg" id="modeSeg">${Object.entries(MODES).filter(([k]) => (hasSent || k !== 'sent') && (hasCol || k !== 'col')).map(([k, v]) => `<button data-mode="${k}" class="${k === mode ? 'on' : ''}">${v}</button>`).join('')}</span>
      <span class="seg" id="hintSeg">${Object.entries(HINTS).map(([k, v]) => `<button data-m="${k}">${v}</button>`).join('')}</span>
      <span class="seg" id="nextSeg">${NEXTS.map(([k, v]) => `<button data-n="${k}" class="${+k === +autoNext ? 'on' : ''}">${v}</button>`).join('')}</span></span></div>
    <div class="progress"><i id="bar"></i></div>
    <div class="two">
      <div class="stage" id="stage"></div>
      <div class="panel deck">
        <div class="hint" id="hint"></div>
        ${typed ? `<input class="big" id="in" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="">` : ''}
        ${pick ? '<div class="choices" id="choices"></div>' : ''}
        <div class="answer" id="ans"></div>
        <div class="bar">
          <button id="prev" title="上一个">‹</button><button id="say">🔊 发音</button><button id="show">答案</button>${typed ? '<button id="submit" class="primary">提交 ⏎</button>' : ''}<button id="next" title="下一个">›</button>
          <label class="chk"><input type="checkbox" id="mark"> 错题本</label>
        </div>
        <p class="muted tips">${tips(mode, keys, autoNext)}</p>
      </div>
    </div></div>`;
  const $ = q => view.querySelector(q), inp = $('#in'), root = $('.study');
  $('#modeSeg').onclick = e => { const m = e.target.dataset.mode; if (m && m !== mode) { settings.set({ ...settings.get(), studyMode: m }); renderStudy(view, id, given); } };
  $('#hintSeg').onclick = e => { if (e.target.dataset.m) { hintMode = e.target.dataset.m; settings.set({ ...settings.get(), hintMode }); show(); } };
  // 切开关不重画页面（进度别丢），只换按钮高亮和提示条
  $('#nextSeg').onclick = e => {
    const v = e.target.dataset.n; if (!v) return;
    autoNext = !!+v; settings.set({ ...settings.get(), autoNext });
    for (const b of $('#nextSeg').children) b.classList.toggle('on', +b.dataset.n === +autoNext);
    $('.tips').innerHTML = tips(mode, keys, autoNext);
  };

  function drawStage() {
    const L = cur().lesson;
    if (stageId === L.id) return;
    stageId = L.id;
    $('#stage').innerHTML = `<img src="${urlOf(L)}">` + (tap
      ? L.items.map((it, k) => `<div class="box" data-i="${k}" style="${boxStyle(it.box)}"><span class="tag">${esc(it.en)}</span></div>`).join('')
      : '<div class="box sel" id="box"></div>');
  }
  function drawHint(force) {
    const on = force || hintMode === 'always' || (hintMode === 'wrong' && wrong > 0);
    $('#hint').textContent = on ? hintOf() : '···';
    $('#hint').className = 'hint' + (on ? '' : ' blank');
  }
  function show() {
    const q = cur(), it = q.item, ok = done.has(i);
    $('#prog').textContent = i + 1;
    $('#title').textContent = q.lesson.title;
    $('#bar').style.width = (done.size / n * 100) + '%';
    for (const b of $('#hintSeg').children) b.classList.toggle('on', b.dataset.m === hintMode);
    drawHint();
    $('#ans').className = 'answer' + (ok ? ' ok' : '');
    $('#mark').checked = !!settings.get().wrong[keyOf(q)];
    // 揭晓 / 答对后把中文和例句一起给出来：点图模式提示区只有外文，不给中文就等于没学到
    const nOther = otherN(q);
    const extra = (it.sent ? `<div class="sent">${esc(it.sent)}</div><div class="sentZh">${esc(it.sentZh)}</div>` : '') + colHtml(it)
      + (nOther ? `<div class="more"><a href="#/word/${langOf(q.lesson)}/${encodeURIComponent(it.en)}">还在 ${nOther} 课出现过</a></div>` : '');
    $('#ans').innerHTML = ok || revealed ? `${ok ? '✓ ' : ''}${esc(it.en)} <span class="ipa">${esc(it.ipa)}</span> ${esc(it.pos)} · ${esc(it.zh)}${extra}` : '';
    if (tap) {
      const L = q.lesson;
      for (const b of $('#stage').querySelectorAll('.box')) {
        const itB = L.items[+b.dataset.i];
        const qi = items.findIndex(x => x.lesson === L && x.item === itB);
        b.className = 'box' + (qi >= 0 && done.has(qi) ? ' ok' : '') + (itB === it && (ok || revealed) ? ' sel' : '');
      }
    } else $('#box').style.cssText = boxStyle(it.box);
    if (typed) {
      inp.placeholder = '输入' + LANGS[langOf(q.lesson)].name;
      inp.className = 'big' + (ok ? ' ok' : '');
      inp.value = ok ? (mode === 'col' ? (colOf(q.col.en).answers[0] || '') : it.en) : '';
      inp.readOnly = ok; // 用 readOnly 不用 disabled，焦点留在框里，快捷键才有效
      inp.focus();
    }
    if (pick) $('#choices').innerHTML = choices.map((c, k) =>
      `<button data-k="${k}" class="${c === it && (ok || revealed) ? 'ok' : bad.has(c) ? 'bad' : ''}" ${ok ? 'disabled' : ''}>${esc(label(c))}</button>`).join('');
  }
  // 换题：干扰项从这道题所在课抽 3 个（按显示文字去重，识别重复框同一个词时不会出两个正确答案）
  function newQuestion() {
    wrong = 0; revealed = false; bad = new Set();
    drawStage();
    if (pick) {
      const it = cur().item, seen = new Set([label(it)]);
      const others = shuffle(cur().lesson.items.filter(x => x !== it && !seen.has(label(x)) && seen.add(label(x))));
      choices = shuffle([it, ...others.slice(0, 3)]);
    }
    show();
    if (!inp) $('.study').focus({ preventScroll: true }); // 快捷键挂在 view 上，焦点得在里面
    if (tap && !done.has(i)) say();
  }
  // skipDone：答对后自动前进时跳过已答完的，直到剩下的都做完
  const go = (d, skipDone) => {
    do i = (i + d + n) % n; while (skipDone && done.has(i) && done.size < n);
    newQuestion();
  };
  // 答完了往下走：跳过已答的，全答完就出结果；没答的题就是普通翻页
  const next = () => !done.has(i) ? go(1) : done.size === n ? finish() : go(1, true);
  function correct() {
    const first = wrong === 0 && !revealed;
    done.set(i, first);
    if (!first) setBook(keyOf(cur()), true);
    if (!tap) say(); // 点图模式刚播过，不重复
    show();
    const at = i;
    if (autoNext) setTimeout(() => { if (root.isConnected && i === at) next(); }, 900); // 900ms 内已手动翻页 / 切模式 / 离开就作废
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
  function finish() {
    const first = [...done.values()].filter(Boolean).length;
    // 没一次答对的在答题那一刻已进错题本；答对的不自动移出（错完马上再练一遍答对就没了，来不及导 Anki），由下面的勾选框决定
    const book = settings.get().wrong, missed = items.filter((q, k) => !done.get(k));
    // 整课练完才有课可归档（错题本混练没有单一课）；整课从头全对才突出，只练一部分全对不算
    const lesson = id !== 'wrong' && items[0]?.lesson;
    const archBtn = !lesson ? '' : lesson.archived ? '<button disabled>已归档</button>' : `<button id="arch" class="${!given && first === n ? 'primary' : ''}">归档这一课</button>`;
    view.innerHTML = `<div class="result"><div class="score">${first} / ${n}</div><p class="muted">一次答对</p>
      <ul>${items.map((q, k) => `<li><span class="k ${done.get(k) ? 'ok' : 'no'}">${done.get(k) ? '✓' : '△'}</span><b>${esc(q.item.en)}</b><span class="muted">${esc(q.item.zh)}</span><label class="chk"><input type="checkbox" data-key="${esc(keyOf(q))}"${book[keyOf(q)] ? ' checked' : ''}> 错题本</label></li>`).join('')}</ul>
      <div class="bar"><button id="again" class="primary">再来一遍</button>${missed.length ? `<button id="retry">再练错的 ${missed.length} 个</button>` : ''}${archBtn}<a class="btn" href="#/">回列表</a></div></div>`;
    // 勾 = 在错题本；同一个词两个框共用一个键，一起勾一起取消
    view.querySelector('ul').onchange = e => {
      const k = e.target.dataset.key; if (!k) return;
      setBook(k, e.target.checked);
      for (const c of view.querySelectorAll('input[data-key]')) if (c.dataset.key === k) c.checked = e.target.checked;
    };
    const arch = view.querySelector('#arch');
    if (arch) arch.onclick = async () => { await setArchived(id, true); toast('已收进「已学完」'); location.hash = '#/'; };
    view.querySelector('#again').onclick = () => renderStudy(view, id, quiz0); // 重练刚才这份题单，错题本练完全对也不会变成空页
    const retry = view.querySelector('#retry');
    if (retry) retry.onclick = () => renderStudy(view, id, missed);
  }
  if (typed) $('#submit').onclick = submit;
  if (pick) $('#choices').onclick = e => { const k = e.target.dataset.k; if (k) choose(choices[k]); };
  $('#stage').onclick = tap ? tapAt : () => { if (done.has(i) && !autoNext) next(); };
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = next;
  $('#say').onclick = say;
  $('#show').onclick = () => { revealed = true; show(); };
  $('#mark').onchange = e => setBook(keyOf(cur()), e.target.checked);
  view.onkeydown = e => {
    if (e.isComposing) return; // 日语 / 韩语输入法选字时的回车不算提交
    const c = comboOf(e); // 先配自定义组合键，再看普通 Enter（用户把 Ctrl+Enter 之类设成快捷键也能用）
    if (c === keys.say) $('#say').click();
    else if (c === keys.show) $('#show').click();
    else if (c === keys.mark) $('#mark').click();
    else if (e.key === 'Enter') typed ? submit() : next();
    else if (pick && /^[1-4]$/.test(e.key) && choices[e.key - 1]) choose(choices[e.key - 1]);
    else return;
    e.preventDefault();
  };
  newQuestion();
}
