// 场景页：一张图就是一个场景。上色大图可以点着探索；从这里继续学、玩记忆宫殿 / 少了什么、听故事、描述这张图；⋯ 里编辑 / 收起 / 删除
import { db, esc, dots, toast, settings, LANGS, langOf, patchLesson, setArchived, hitAt, colOf } from './lib.js';
import { prog, buildToday, lessonStat, record, logDay } from './progress.js';
import { paint } from './paint.js';
import { speak } from './tts.js';
import { boxStyle } from './editor.js';
import { MODES } from './study.js';
import { writeStory, reviewDescription, storyOf } from './ai.js';
import { canListen, listen } from './speech.js';

const GAMES = { palace: 1, miss: 1 }; // 这两个练法算「玩一玩」，不进专项练下拉
const sigOf = l => l.items.map(it => it.en).join('|'); // 故事按词号引用，词改过就对不上了
const hasKey = () => { const s = settings.get(); return s.apiUrl && s.apiKey && s.visionModel; };
const noKey = '<p class="muted">这个要用 AI：先去 <a href="#/settings">我 → 接口</a> 填好 API 地址、Key 和识别模型。</p>';
const head = (l, title) => `<div class="bar head"><a class="btn" href="#/scene/${esc(l.id)}">‹ ${esc(l.title)}</a><h2>${title}</h2></div>`;

export async function renderScene(view, id, sub) {
  const l = await db.get(id);
  if (!l) { view.innerHTML = '<div class="empty"><b>这个场景不在了</b><p><a class="btn" href="#/world">回世界</a></p></div>'; return; }
  if (sub === 'story') return renderStory(view, l);
  if (sub === 'describe') return renderDescribe(view, l);
  const plist = await prog.all(), byKey = new Map(plist.map(p => [p.key, p])), st = lessonStat(l, plist), lang = langOf(l);
  const td = l.archived ? { due: [], fresh: [] } : buildToday([l], plist, l.id);
  const hasSent = l.items.some(it => it.sent), hasCol = l.items.some(it => (it.col || []).some(c => c && colOf(c.en).answers.length));
  const drills = Object.entries(MODES).filter(([k]) => !GAMES[k] && (hasSent || k !== 'sent') && (hasCol || k !== 'col'));
  const sm = settings.get().studyMode;
  view.innerHTML = `<div class="scene">
    <div class="bar head"><a class="btn" href="#/world">‹ 世界</a><h2>${esc(l.title)}</h2><span style="flex:1"></span>
      <details class="menu"><summary class="btn" title="更多">⋯</summary><div class="pop panel">
        <a href="#/edit/${esc(l.id)}">编辑词和框</a><button data-act="arch">${l.archived ? '放回世界（继续复习）' : '收起（不再催复习）'}</button><button data-act="del" class="danger">删除这个场景</button></div></details></div>
    <div class="two">
      <div><div class="stage explore" id="stage"><img id="pic" alt=""><div class="label" id="label" hidden></div></div>
        <p class="muted legend">点图里的东西听它怎么读 · 彩色 = 学过（越熟越鲜艳）· 灰雾 = 该复习了 · 亮起 <b>${st.mastered + st.learning}</b> / ${st.total} · 掌握 ${st.mastered}</p></div>
      <div class="acts">
        ${td.due.length || td.fresh.length ? `<a class="btn primary big" href="#/study/today/${esc(l.id)}">继续学 · ${[td.due.length && td.due.length + ' 个复习', td.fresh.length && td.fresh.length + ' 个新词'].filter(Boolean).join(' + ')}</a>`
          : `<p class="muted">${l.archived ? '这个场景收起了，不再催复习。' : st.total && st.mastered === st.total ? '整张图都亮了 ✨' : '这张图今天没有要学的了，明天再来。'}</p>`}
        <h3>玩一玩</h3>
        <div class="games">
          <button class="game" data-mode="palace"><b>🏛 记忆宫殿</b><span>图暗下来，只剩轮廓，按位置说出每样东西</span></button>
          <button class="game" data-mode="miss"${l.items.length < 2 ? ' disabled' : ''}><b>🔍 少了什么？</b><span>一样东西被雾遮住了，它是什么</span></button>
          <a class="game" href="#/scene/${esc(l.id)}/story"><b>📖 听故事</b><span>用这张图的词讲个小故事，读到哪亮到哪</span></a>
          <a class="game" href="#/scene/${esc(l.id)}/describe"><b>✍️ 描述这张图</b><span>用几句话说说你看到的，AI 帮你改</span></a>
        </div>
        <h3>专项练</h3>
        <div class="bar"><select id="drill">${drills.map(([k, v]) => `<option value="${k}" ${k === sm ? 'selected' : ''}>${v}</option>`).join('')}</select><button data-mode="">开始</button></div>
      </div>
    </div></div>`;
  const $ = s => view.querySelector(s);
  const pic = $('#pic');
  paint(l, byKey, 1200).then(u => { if (pic.isConnected) pic.src = u; }); // 已经换页就别往新页面里塞旧图
  // 探索：点到哪样东西就读出来，框上标名字
  $('#stage').onclick = e => {
    const r = $('#stage').getBoundingClientRect(), hit = hitAt(l.items, (e.clientX - r.left) / r.width * 1000, (e.clientY - r.top) / r.height * 1000);
    const lab = $('#label');
    if (!hit) { lab.hidden = true; return; }
    const it = hit[0];
    speak(it.en, lang);
    lab.hidden = false;
    lab.innerHTML = `<span class="tag">${esc(it.en)}<span>${esc(it.zh)}</span></span>`;
    lab.style.cssText = boxStyle(it.box);
  };
  view.onclick = async e => {
    const b = e.target.closest('[data-mode], [data-act]'); if (!b) return;
    if (b.dataset.mode !== undefined) {
      settings.set({ ...settings.get(), studyMode: b.dataset.mode || $('#drill').value });
      location.hash = '#/study/' + l.id;
    } else if (b.dataset.act === 'arch') { await setArchived(l.id, !l.archived); toast(l.archived ? '放回了，到期照常复习' : '已收起，不再催复习'); renderScene(view, id); }
    else if (b.dataset.act === 'del' && confirm(`删除「${l.title}」？学习进度一起删。`)) { settings.set({ ...settings.get(), del: { ...settings.get().del, [l.id]: Date.now() } }); await db.del(l.id); await prog.delPrefix(l.id + '|'); location.hash = '#/world'; } // 先记删除时间（同步时另一台跟着删），再删；中途关掉下次同步也会删干净
  };
}

// 听故事：AI 看图写 5–8 句，每句带词号；播到哪句，图里那几样东西亮到哪
async function renderStory(view, l) {
  const lang = langOf(l), url = URL.createObjectURL(l.image);
  let story = l.story?.sig === sigOf(l) ? storyOf(l.story.lines, l.items.length) : null, at = 0, playing = false, zh = false, heardAll = false;
  view.innerHTML = `<div class="scene story">${head(l, '📖 听故事')}
    <div class="two"><div class="stage" id="stage"><img src="${url}">${l.items.map((it, k) => `<div class="box glow" data-i="${k}" style="${boxStyle(it.box)}"><span class="tag">${esc(it.en)}</span></div>`).join('')}</div>
    <div class="panel deck" id="deck"></div></div></div>`;
  const $ = s => view.querySelector(s), root = $('.story');
  const mark = line => line.words.reduce((h, k) => { const w = esc(l.items[k].en); return w ? h.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<b>$&</b>') : h; }, esc(line.en));
  if (!story?.length) story = null; // 坏备份里的故事当没有
  function draw() {
    if (!story) {
      $('#deck').innerHTML = `<p class="hint small">${l.story ? '这张图的词改过了，故事对不上号，重新写一个吧' : '让 AI 用这张图里的词讲一个小故事'}</p>${hasKey() ? '<button id="gen" class="primary">写一个故事</button>' : noKey}`;
      return;
    }
    const line = story[at];
    for (const b of $('#stage').querySelectorAll('.box')) b.classList.toggle('on', line.words.includes(+b.dataset.i));
    $('#deck').innerHTML = `<p class="line">${mark(line)}</p><p class="zh"${zh ? '' : ' hidden'}>${esc(line.zh)}</p>
      <div class="bar"><button id="prev">‹</button><button id="play" class="primary">${playing ? '⏸ 停' : at ? '▶ 从这句播' : '▶ 播放'}</button><button id="next">›</button><button id="zh">${zh ? '藏中文' : '看中文'}</button></div>
      <ol class="lines">${story.map((s, k) => `<li class="${k === at ? 'on' : ''}" data-at="${k}">${esc(s.en)}</li>`).join('')}</ol>
      ${hasKey() ? '<button id="gen" class="link">不喜欢？重新写一个</button>' : ''}`;
  }
  // 每次开播 / 停 token +1：停了又马上点播放时，还在等上一句读完的旧循环看到号变了就自己退出
  let token = 0;
  const stop = () => { playing = false; token++; };
  async function play() {
    const my = ++token;
    playing = true;
    while (my === token && root.isConnected) {
      draw();
      await speak(story[at].en, lang);
      if (my !== token || !root.isConnected) return;
      if (at === story.length - 1) { if (!heardAll) { heardAll = true; logDay({}); toast('听完了 🎧'); } break; }
      at++;
    }
    playing = false;
    if (root.isConnected) draw();
  }
  view.onclick = async e => {
    const t = e.target.closest('button, li[data-at]'); if (!t) return;
    if (t.dataset.at) { at = +t.dataset.at; stop(); draw(); return speak(story[at].en, lang); }
    if (t.id === 'play') return playing ? (stop(), draw()) : play();
    if (t.id === 'prev' || t.id === 'next') { stop(); at = Math.max(0, Math.min(story.length - 1, at + (t.id === 'next' ? 1 : -1))); draw(); return speak(story[at].en, lang); }
    if (t.id === 'zh') { zh = !zh; return draw(); }
    if (t.id === 'gen') {
      stop(); t.disabled = true; t.innerHTML = dots('AI 在写');
      try {
        const lines = await writeStory(l), s = { sig: sigOf(l), lines };
        await patchLesson(l.id, x => { x.story = s; });
        l.story = s; story = lines; at = 0;
        if (root.isConnected) draw();
      } catch (err) { if (root.isConnected) { alert(err.message); draw(); } }
    }
  };
  draw();
}

// 描述这张图（「用」这一级）：写或口述几句，AI 按词号告诉你用对了哪些，给改法和更地道的说法；用对的词记一次答对
async function renderDescribe(view, l) {
  const lang = langOf(l), L = LANGS[lang], url = URL.createObjectURL(l.image);
  view.innerHTML = `<div class="scene describe">${head(l, '✍️ 描述这张图')}
    <div class="two"><div class="stage" id="stage"><img src="${url}">${l.items.map((it, k) => `<div class="box glow" data-i="${k}" style="${boxStyle(it.box)}"><span class="tag">${esc(it.en)}</span></div>`).join('')}</div>
    <div class="panel deck">
      <p class="hint small">用${L.name}说说这张图：有什么、在哪儿、在发生什么。三五句就够。</p>
      <textarea id="txt" rows="5" lang="${L.tag}" placeholder="${lang === 'en' ? 'There is a bed next to the window…' : ''}"></textarea>
      <div class="bar">${canListen() ? '<button id="dict">🎤 口述</button>' : ''}${hasKey() ? '<button id="go" class="primary">请 AI 看看</button>' : ''}</div>
      ${hasKey() ? '' : noKey}<div id="out"></div></div></div></div>`;
  const $ = s => view.querySelector(s), root = $('.describe');
  let rec = null;
  view.onclick = async e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.id === 'say') return speak(t.dataset.text, lang);
    if (t.id === 'dict') {
      if (rec) return rec.stop();
      rec = listen(L.tag, true); t.classList.add('on'); t.textContent = '■ 说完了';
      try { const [said] = await rec.done; if (said && root.isConnected) $('#txt').value = ($('#txt').value + ' ' + said).trim(); }
      catch (err) { toast(err.message); }
      rec = null;
      if (root.isConnected && $('#dict')) { $('#dict').classList.remove('on'); $('#dict').textContent = '🎤 口述'; }
      return;
    }
    if (t.id === 'go') {
      const text = $('#txt').value.trim();
      if (text.length < 8) return toast('再多写几个词');
      t.disabled = true; t.innerHTML = dots('AI 在看');
      try {
        const r = await reviewDescription(l, text);
        if (!root.isConnected) return;
        for (const b of $('#stage').querySelectorAll('.box')) b.classList.toggle('on', r.used.includes(+b.dataset.i));
        $('#out').innerHTML = `${r.comment ? `<p class="comment">${esc(r.comment)}</p>` : ''}
          <p>用对了 <b>${r.used.length}</b> 个这张图的词${r.used.length ? '：' + r.used.map(k => `<span class="chip">${esc(l.items[k].en)}</span>`).join('') : ''}</p>
          ${r.fixes.length ? `<h4>可以这样改</h4><ul class="fixes">${r.fixes.map(f => `<li><s>${esc(f.from)}</s> → <b>${esc(f.to)}</b>${f.why ? `<span class="muted">${esc(f.why)}</span>` : ''}</li>`).join('')}</ul>` : ''}
          ${r.better ? `<h4>更地道的说法 <button id="say" class="mini" data-text="${esc(r.better)}">🔊</button></h4><p>${esc(r.better)}</p><p class="muted">${esc(r.betterZh)}</p>` : ''}`;
        // 用对了 = 能在真实表达里用出来，按一次答对记（同一词一天只计一次，由 record 管）
        const seen = new Set();
        for (const k of r.used) { const it = l.items[k]; if (seen.has(it.en)) continue; seen.add(it.en); await record({ lesson: l, item: it }, true); }
        logDay({});
      } catch (err) { alert(err.message); }
      t.disabled = false; t.textContent = '再看一次';
    }
  };
}
