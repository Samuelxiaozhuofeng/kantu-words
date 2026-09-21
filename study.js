// 学习页：框依次亮起，看提示打英文，听发音，走完出结果
import { db, esc, settings } from './lib.js';
import { speak } from './tts.js';
import { boxStyle } from './editor.js';

const norm = s => s.toLowerCase().trim().replace(/^(a|an|the)\s+/, '').replace(/[^a-z\s'-]/g, '').replace(/\s+/g, ' ').trim();
// 判对：不分大小写、忽略冠词和标点、AI 给的同义词算对、单复数差一个 s 也算对
export const isRight = (input, it) => {
  const a = norm(input);
  return !!a && [it.en, ...(it.alts || [])].some(w => { const b = norm(w); return a === b || a === b + 's' || a + 's' === b; });
};

export async function renderStudy(view, id) {
  const lesson = await db.get(id);
  if (!lesson?.items.length) { view.innerHTML = '<p>这一课还没有词，先去编辑。</p>'; return; }
  const items = lesson.items, done = new Map(); // i -> 是否一次答对
  let i = 0, wrong = 0, revealed = false;
  const imgUrl = URL.createObjectURL(lesson.image);

  view.innerHTML = `
    <div class="bar"><b>${esc(lesson.title)}</b><span class="muted" id="prog"></span><span class="sp" style="flex:1"></span>
      <label class="muted">中文提示 <select id="mode" style="width:auto"><option value="always">一直显示</option><option value="wrong">答错后显示</option><option value="never">不显示</option></select></label></div>
    <div class="progress"><i id="bar"></i></div>
    <div class="two">
      <div class="stage"><img src="${imgUrl}"><div class="box sel" id="box"></div></div>
      <div class="study-right">
        <div class="hint" id="hint"></div>
        <input class="big" id="in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入英文">
        <div class="answer" id="ans"></div>
        <div class="bar" style="justify-content:center">
          <button id="prev">‹ 上一个</button><button id="say">🔊 发音</button><button id="show">显示答案</button><button id="submit" class="primary">提交 ⏎</button><button id="next">下一个 ›</button>
        </div>
        <p class="muted"><kbd>Enter</kbd> 提交 · <kbd>Ctrl</kbd>+<kbd>'</kbd> 发音 · <kbd>Ctrl</kbd>+<kbd>;</kbd> 答案</p>
      </div>
    </div>`;
  const $ = s => view.querySelector(s), inp = $('#in'), mode = $('#mode');
  mode.value = settings.get().hintMode;
  mode.onchange = () => { settings.set({ ...settings.get(), hintMode: mode.value }); show(); };

  function show() {
    const it = items[i];
    $('#box').style.cssText = boxStyle(it.box);
    $('#prog').textContent = `${i + 1} / ${items.length}`;
    $('#bar').style.width = (done.size / items.length * 100) + '%';
    const m = mode.value;
    $('#hint').textContent = m === 'always' || (m === 'wrong' && wrong > 0) ? it.zh : '';
    $('#ans').textContent = revealed ? `${it.en}  ${it.ipa}  ${it.pos}` : '';
    inp.className = 'big' + (done.has(i) ? ' ok' : '');
    inp.value = done.has(i) ? it.en : '';
    inp.disabled = done.has(i);
    inp.focus();
  }
  const go = d => { i = (i + d + items.length) % items.length; wrong = 0; revealed = false; show(); };
  function submit() {
    if (done.has(i)) return go(1);
    const it = items[i];
    if (isRight(inp.value, it)) {
      done.set(i, wrong === 0 && !revealed);
      inp.className = 'big ok'; inp.disabled = true; $('#ans').textContent = `✓ ${it.en}  ${it.ipa}`;
      speak(it.en);
      setTimeout(() => done.size === items.length ? finish() : go(1), 900);
    } else {
      wrong++; inp.className = 'big'; void inp.offsetWidth; inp.className = 'big bad';
      if (mode.value === 'wrong') $('#hint').textContent = it.zh;
      inp.select();
    }
  }
  function finish() {
    const first = [...done.values()].filter(Boolean).length;
    view.innerHTML = `<div class="study-right"><h2>完成！</h2><p>一次答对 ${first} / ${items.length}</p>
      <div>${items.map((it, k) => `<div>${done.get(k) ? '✓' : '△'} ${esc(it.en)} <span class="muted">${esc(it.zh)}</span></div>`).join('')}</div>
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
