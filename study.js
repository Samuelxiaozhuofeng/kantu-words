// 学习页：四种练法（打英文 / 听音点图 / 选英文 / 选中文），框亮起或全部可点，走完出结果
import { db, esc, settings, LANGS, langOf, wrongEntries } from './lib.js';
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

const MODES = { type: '打单词', tap: '听音点图', pickEn: '选单词', pickZh: '选中文' };
const HINTS = { always: '一直显示', wrong: '答错后显示', never: '不显示' };
const TIPS = {
  type: '<kbd>Enter</kbd> 提交 · <kbd>Ctrl</kbd>+<kbd>\'</kbd> 发音 · <kbd>Ctrl</kbd>+<kbd>;</kbd> 答案',
  tap: '听发音，点图里对应的物品 · <kbd>Ctrl</kbd>+<kbd>\'</kbd> 再听 · <kbd>Ctrl</kbd>+<kbd>;</kbd> 答案',
  pick: '<kbd>1</kbd>–<kbd>4</kbd> 选 · <kbd>Ctrl</kbd>+<kbd>\'</kbd> 发音 · <kbd>Ctrl</kbd>+<kbd>;</kbd> 答案',
};
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
  const s = settings.get(), mode = MODES[s.studyMode] ? s.studyMode : 'type', pick = mode.startsWith('pick');
  // 点图模式打乱出题顺序，不然按位置就能记住
  const items = mode === 'tap' ? shuffle([...quiz0]) : quiz0, n = items.length, done = new Map(); // i -> 是否一次答对
  const urls = new Map();
  const urlOf = l => { if (!urls.has(l.id)) urls.set(l.id, URL.createObjectURL(l.image)); return urls.get(l.id); };
  let i = 0, wrong = 0, revealed = false, hintMode = s.hintMode, choices = [], bad = new Set(), stageId = '';
  // 提示区放什么：打英文 / 选英文时给中文，听音点图 / 选中文时给英文
  const hintOf = it => mode === 'type' || mode === 'pickEn' ? it.zh : it.en;
  const label = it => mode === 'pickZh' && it.zh ? it.zh : it.en;
  const cur = () => items[i];
  const say = () => speak(cur().item.en, langOf(cur().lesson));

  view.innerHTML = `<div class="study ${mode}" tabindex="-1">
    <div class="top"><span class="step"><span id="prog"></span><small>/ ${n}</small></span><b id="title"></b>
      <span class="segs"><span class="seg" id="modeSeg">${Object.entries(MODES).map(([k, v]) => `<button data-mode="${k}" class="${k === mode ? 'on' : ''}">${v}</button>`).join('')}</span>
      <span class="seg" id="hintSeg">${Object.entries(HINTS).map(([k, v]) => `<button data-m="${k}">${v}</button>`).join('')}</span></span></div>
    <div class="progress"><i id="bar"></i></div>
    <div class="two">
      <div class="stage" id="stage"></div>
      <div class="panel deck">
        <div class="hint" id="hint"></div>
        ${mode === 'type' ? `<input class="big" id="in" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="">` : ''}
        ${pick ? '<div class="choices" id="choices"></div>' : ''}
        <div class="answer" id="ans"></div>
        <div class="bar">
          <button id="prev" title="上一个">‹</button><button id="say">🔊 发音</button><button id="show">答案</button>${mode === 'type' ? '<button id="submit" class="primary">提交 ⏎</button>' : ''}<button id="next" title="下一个">›</button>
        </div>
        <p class="muted tips">${TIPS[pick ? 'pick' : mode]}</p>
      </div>
    </div></div>`;
  const $ = q => view.querySelector(q), inp = $('#in'), root = $('.study');
  $('#modeSeg').onclick = e => { const m = e.target.dataset.mode; if (m && m !== mode) { settings.set({ ...settings.get(), studyMode: m }); renderStudy(view, id, given); } };
  $('#hintSeg').onclick = e => { if (e.target.dataset.m) { hintMode = e.target.dataset.m; settings.set({ ...settings.get(), hintMode }); show(); } };

  function drawStage() {
    const L = cur().lesson;
    if (stageId === L.id) return;
    stageId = L.id;
    $('#stage').innerHTML = `<img src="${urlOf(L)}">` + (mode === 'tap'
      ? L.items.map((it, k) => `<div class="box" data-i="${k}" style="${boxStyle(it.box)}"><span class="tag">${esc(it.en)}</span></div>`).join('')
      : '<div class="box sel" id="box"></div>');
  }
  function drawHint(force) {
    const it = cur().item, on = force || hintMode === 'always' || (hintMode === 'wrong' && wrong > 0);
    $('#hint').textContent = on ? hintOf(it) : '···';
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
    $('#ans').innerHTML = ok ? `✓ ${esc(it.en)} <span class="ipa">${esc(it.ipa)}</span>` : revealed ? `${esc(it.en)} <span class="ipa">${esc(it.ipa)}</span> ${esc(it.pos)}` : '';
    if (mode === 'tap') {
      const L = q.lesson;
      for (const b of $('#stage').querySelectorAll('.box')) {
        const itB = L.items[+b.dataset.i];
        const qi = items.findIndex(x => x.lesson === L && x.item === itB);
        b.className = 'box' + (qi >= 0 && done.has(qi) ? ' ok' : '') + (itB === it && (ok || revealed) ? ' sel' : '');
      }
    } else $('#box').style.cssText = boxStyle(it.box);
    if (mode === 'type') {
      inp.placeholder = '输入' + LANGS[langOf(q.lesson)].name;
      inp.className = 'big' + (ok ? ' ok' : '');
      inp.value = ok ? it.en : '';
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
    if (mode === 'tap' && !done.has(i)) say();
  }
  // skipDone：答对后自动前进时跳过已答完的，直到剩下的都做完
  const go = (d, skipDone) => {
    do i = (i + d + n) % n; while (skipDone && done.has(i) && done.size < n);
    newQuestion();
  };
  function correct() {
    done.set(i, wrong === 0 && !revealed);
    if (mode !== 'tap') say(); // 点图模式刚播过，不重复
    show();
    setTimeout(() => { if (root.isConnected) done.size === n ? finish() : go(1, true); }, 900); // 900ms 内切了模式或离开页面就作废
  }
  function submit() {
    if (done.has(i)) return go(1, true);
    if (isRight(inp.value, cur().item, langOf(cur().lesson))) return correct();
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
    if (done.has(i)) return;
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
    // 同一课两个框同一个词共用一个键：有一题没一次答对就算错，全对才移出（不看题目顺序）
    const book = { ...settings.get().wrong }, missed = items.filter((q, k) => !done.get(k));
    const keyOf = q => q.lesson.id + '|' + q.item.en, missedKeys = new Set(missed.map(keyOf));
    for (const q of items) {
      if (missedKeys.has(keyOf(q))) book[keyOf(q)] ||= Date.now();
      else delete book[keyOf(q)];
    }
    settings.set({ ...settings.get(), wrong: book });
    view.innerHTML = `<div class="result"><div class="score">${first} / ${n}</div><p class="muted">一次答对</p>
      <ul>${items.map((q, k) => `<li><span class="k ${done.get(k) ? 'ok' : 'no'}">${done.get(k) ? '✓' : '△'}</span><b>${esc(q.item.en)}</b><span class="muted">${esc(q.item.zh)}</span></li>`).join('')}</ul>
      <div class="bar"><button id="again" class="primary">再来一遍</button>${missed.length ? `<button id="retry">再练错的 ${missed.length} 个</button>` : ''}<a class="btn" href="#/">回列表</a></div></div>`;
    view.querySelector('#again').onclick = () => renderStudy(view, id, quiz0); // 重练刚才这份题单，错题本练完全对也不会变成空页
    const retry = view.querySelector('#retry');
    if (retry) retry.onclick = () => renderStudy(view, id, missed);
  }
  if (mode === 'type') $('#submit').onclick = submit;
  if (pick) $('#choices').onclick = e => { const k = e.target.dataset.k; if (k) choose(choices[k]); };
  if (mode === 'tap') $('#stage').onclick = tapAt;
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  $('#say').onclick = say;
  $('#show').onclick = () => { revealed = true; show(); };
  view.onkeydown = e => {
    if (e.isComposing) return; // 日语 / 韩语输入法选字时的回车不算提交
    if (e.key === 'Enter') mode === 'type' ? submit() : go(1);
    else if (e.ctrlKey && e.key === "'") $('#say').click();
    else if (e.ctrlKey && e.key === ';') $('#show').click();
    else if (pick && /^[1-4]$/.test(e.key) && choices[e.key - 1]) choose(choices[e.key - 1]);
    else return;
    e.preventDefault();
  };
  newQuestion();
}
