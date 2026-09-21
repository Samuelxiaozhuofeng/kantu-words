// 学习页：框依次亮起，看提示打英文，听发音，走完出结果
import { db, esc, settings } from './lib.js';
import { speak } from './tts.js';
import { boxStyle } from './editor.js';

const norm = s => s.toLowerCase().trim().replace(/^(a|an|the)\s+/, '').replace(/[^a-z\s'-]/g, '').replace(/\s+/g, ' ').trim();
// 判对：不分大小写、忽略冠词和标点、AI 给的同义词算对、单复数（s / es）也算对
export const isRight = (input, it) => {
  const a = norm(input);
  return !!a && [it.en, ...(it.alts || [])].some(w => { const b = norm(w); return [b, b + 's', b + 'es'].includes(a) || [a + 's', a + 'es'].includes(b); });
};

const MODES = { always: '一直显示', wrong: '答错后显示', never: '不显示' };

export async function renderStudy(view, id) {
  const lesson = await db.get(id);
  if (!lesson?.items.length) { view.innerHTML = '<div class="empty"><b>这一课还没有词</b>先去编辑页让 AI 识别一下</div>'; return; }
  const items = lesson.items, n = items.length, done = new Map(); // i -> 是否一次答对
  let i = 0, wrong = 0, revealed = false, hintMode = settings.get().hintMode;
  const imgUrl = URL.createObjectURL(lesson.image);

  view.innerHTML = `<div class="study">
    <div class="top"><span class="step"><span id="prog"></span><small>/ ${n}</small></span><b>${esc(lesson.title)}</b>
      <span class="seg" id="mode">${Object.entries(MODES).map(([k, v]) => `<button data-m="${k}">${v}</button>`).join('')}</span></div>
    <div class="progress"><i id="bar"></i></div>
    <div class="two">
      <div class="stage"><img src="${imgUrl}"><div class="box sel" id="box"></div></div>
      <div class="panel deck">
        <div class="hint" id="hint"></div>
        <input class="big" id="in" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="输入英文">
        <div class="answer" id="ans"></div>
        <div class="bar">
          <button id="prev" title="上一个">‹</button><button id="say">🔊 发音</button><button id="show">答案</button><button id="submit" class="primary">提交 ⏎</button><button id="next" title="下一个">›</button>
        </div>
        <p class="muted tips"><kbd>Enter</kbd> 提交 · <kbd>Ctrl</kbd>+<kbd>'</kbd> 发音 · <kbd>Ctrl</kbd>+<kbd>;</kbd> 答案</p>
      </div>
    </div></div>`;
  const $ = s => view.querySelector(s), inp = $('#in');
  $('#mode').onclick = e => { if (e.target.dataset.m) { hintMode = e.target.dataset.m; settings.set({ ...settings.get(), hintMode }); show(); } };

  function show() {
    const it = items[i];
    $('#box').style.cssText = boxStyle(it.box);
    $('#prog').textContent = i + 1;
    $('#bar').style.width = (done.size / n * 100) + '%';
    for (const b of $('#mode').children) b.classList.toggle('on', b.dataset.m === hintMode);
    const showHint = hintMode === 'always' || (hintMode === 'wrong' && wrong > 0);
    $('#hint').textContent = showHint ? it.zh : '···';
    $('#hint').className = 'hint' + (showHint ? '' : ' blank');
    $('#ans').className = 'answer';
    $('#ans').innerHTML = revealed ? `${esc(it.en)} <span class="ipa">${esc(it.ipa)}</span> ${esc(it.pos)}` : '';
    inp.className = 'big' + (done.has(i) ? ' ok' : '');
    inp.value = done.has(i) ? it.en : '';
    inp.readOnly = done.has(i); // 用 readOnly 不用 disabled，焦点留在框里，快捷键才有效
    inp.focus();
  }
  // skipDone：答对后自动前进时跳过已答完的，直到剩下的都做完
  const go = (d, skipDone) => {
    do i = (i + d + n) % n; while (skipDone && done.has(i) && done.size < n);
    wrong = 0; revealed = false; show();
  };
  function submit() {
    if (done.has(i)) return go(1, true);
    const it = items[i];
    if (isRight(inp.value, it)) {
      done.set(i, wrong === 0 && !revealed);
      inp.className = 'big ok'; inp.readOnly = true;
      $('#ans').className = 'answer ok'; $('#ans').innerHTML = `✓ ${esc(it.en)} <span class="ipa">${esc(it.ipa)}</span>`;
      speak(it.en);
      setTimeout(() => done.size === n ? finish() : go(1, true), 900);
    } else {
      wrong++; inp.className = 'big'; void inp.offsetWidth; inp.className = 'big bad';
      if (hintMode === 'wrong') { $('#hint').textContent = it.zh; $('#hint').className = 'hint'; }
      inp.select();
    }
  }
  function finish() {
    const first = [...done.values()].filter(Boolean).length;
    view.innerHTML = `<div class="result"><div class="score">${first} / ${n}</div><p class="muted">一次答对</p>
      <ul>${items.map((it, k) => `<li><span class="k ${done.get(k) ? 'ok' : 'no'}">${done.get(k) ? '✓' : '△'}</span><b>${esc(it.en)}</b><span class="muted">${esc(it.zh)}</span></li>`).join('')}</ul>
      <div class="bar"><button id="again" class="primary">再来一遍</button><a class="btn" href="#/">回列表</a></div></div>`;
    view.querySelector('#again').onclick = () => renderStudy(view, id);
  }
  $('#submit').onclick = submit;
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  $('#say').onclick = () => speak(items[i].en);
  $('#show').onclick = () => { revealed = true; show(); };
  view.onkeydown = e => {
    if (e.key === 'Enter') submit();
    else if (e.ctrlKey && e.key === "'") $('#say').click();
    else if (e.ctrlKey && e.key === ';') $('#show').click();
    else return;
    e.preventDefault();
  };
  show();
}
