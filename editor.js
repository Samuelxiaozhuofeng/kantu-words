// 备课页：传图 / AI 生图 → AI 识别出框 → 手动改词、拖框、删框 → 保存
import { db, esc, dots, toast, settings, LANGS, langOf, allFolders, folderOf } from './lib.js';
import { detect, fillSents, shrink } from './ai.js';
import { speak } from './tts.js';

const pct = v => (v / 10).toFixed(2) + '%';
// 小框叠在大框上面，不然点不到被衣柜包住的裙子
export const boxStyle = ([y1, x1, y2, x2]) => `left:${pct(x1)};top:${pct(y1)};width:${pct(x2 - x1)};height:${pct(y2 - y1)};z-index:${1000 - Math.round((x2 - x1) * (y2 - y1) / 1000)}`;

// 拍一拍：首页 / 世界页选了照片就带着它进新建页，填过 Key 就顺手识别
let photo = null;
export const withPhoto = blob => { photo = blob; location.hash = '#/edit'; };

export async function renderEditor(view, id) {
  const lesson = (id && await db.get(id)) || { id: crypto.randomUUID(), title: '', image: null, items: [], created: Date.now(), lang: settings.get().lastLang };
  lesson.lang = langOf(lesson); // 老课没这个字段：当英语，保存时写进去
  const isPack = lesson.id.startsWith('pack-'), folder = folderOf(lesson);
  const folders = [...new Set([...allFolders(), folder].filter(Boolean))]; // 老数据里的名字不在表里也保留
  let sel = -1, imgUrl = lesson.image && URL.createObjectURL(lesson.image);
  view.innerHTML = `
    <div class="bar">
      <input id="title" placeholder="课程标题，比如：衣柜" value="${esc(lesson.title)}">
      <select id="lang" title="这课学哪种语言">${Object.entries(LANGS).map(([k, L]) => `<option value="${k}" ${k === lesson.lang ? 'selected' : ''}>${L.name}</option>`).join('')}</select>
      ${isPack ? '' : `<select id="folder" title="放进哪个文件夹"><option value="">未分组</option>${folders.map(f => `<option ${f === folder ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>`}
      <label class="btn">上传图片<input type="file" id="file" accept="image/*" hidden></label>
      <button id="gen">AI 生图</button>
      <button id="detect">AI 识别</button>
      <label class="chk"><input type="checkbox" id="withSent"${settings.get().withSent ? ' checked' : ''}> 生成例句和搭配</label>
      <button id="fill">补例句和搭配</button>
      <button id="add">＋ 手动加框</button>
      <button id="save" class="primary">保存</button>
    </div>
    <div class="two">
      <div class="stage" id="stage"></div>
      <div class="panel" id="panel"></div>
    </div>`;
  const $ = s => view.querySelector(s);
  const stage = $('#stage');
  const touch = () => view.dirty = true; // 有没保存的改动，离开时 app.js 会拦一下

  function drawStage() {
    if (!lesson.image) {
      stage.innerHTML = `<div class="placeholder"><b>先来一张图</b><span>拍一张衣柜、书桌、冰箱……或者让 AI 画一张</span>
        <div class="bar"><label class="btn primary">上传图片<input type="file" class="file" accept="image/*" hidden></label><button class="gen2">AI 生图</button></div></div>`;
      stage.querySelector('.file').onchange = $('#file').onchange;
      stage.querySelector('.gen2').onclick = () => $('#gen').click();
      return;
    }
    stage.innerHTML = `<img src="${imgUrl}">` +
      lesson.items.map((it, i) => `<div class="box ${i === sel ? 'sel' : ''}" data-i="${i}" style="${boxStyle(it.box)}"><span class="tag">${esc(it.en)}</span></div>`).join('');
  }
  function drawPanel() {
    const it = lesson.items[sel];
    $('#panel').innerHTML = `
      <div class="hintbar"><b>${lesson.items.length} 个词</b><span class="muted">${it ? '拖框移动 · 方向键微调 · Delete 删' : lesson.items.length ? '点框或点词来编辑' : '点「AI 识别」自动框出物品'}</span></div>
      ${it ? `<div class="form">
      <label class="field">${LANGS[lesson.lang].name}单词 <input id="f-en" value="${esc(it.en)}"></label>
      <label class="field">中文 <input id="f-zh" value="${esc(it.zh)}"></label>
      <div class="row"><label class="field">${LANGS[lesson.lang].ipaName} <input id="f-ipa" value="${esc(it.ipa)}"></label><label class="field">词性 <input id="f-pos" value="${esc(it.pos)}"></label></div>
      <label class="field">也算对（逗号分隔）<input id="f-alts" value="${esc(it.alts.join(', '))}"></label>
      <label class="field">例句 <input id="f-sent" value="${esc(it.sent || '')}"></label>
      <label class="field">例句中文 <input id="f-sentZh" value="${esc(it.sentZh || '')}"></label>
      <label class="field">搭配 <textarea id="f-col" rows="4" placeholder="[boil] the kettle = 烧水">${esc((it.col || []).filter(c => c && c.en).map(c => c.en + (c.zh ? ' = ' + c.zh : '')).join('\n'))}</textarea></label>
      <div class="bar"><button id="say">🔊 试听</button><button id="saySent"${it.sent ? '' : ' hidden'}>🔊 听例句</button><button id="del" class="danger">删除这个框</button></div></div>` : ''}
      <div class="words">${lesson.items.map((x, i) => `<div class="${i === sel ? 'sel' : ''}" data-i="${i}"><b>${esc(x.en)}</b><span class="muted">${esc(x.zh)}</span></div>`).join('')}</div>`;
    $('.words .sel')?.scrollIntoView({ block: 'nearest' });
    if (!it) return;
    for (const k of ['en', 'zh', 'ipa', 'pos', 'sent', 'sentZh']) $('#f-' + k).oninput = e => { it[k] = e.target.value; touch(); if (k === 'en') drawStage(); if (k === 'sent') $('#saySent').hidden = !it.sent; };
    $('#f-alts').oninput = e => { it.alts = e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean); touch(); };
    $('#f-col').oninput = e => {
      it.col = e.target.value.split('\n').map(line => {
        const s = line.trim(); if (!s) return null;
        const k = s.search(/[=＝]/);
        const en = (k < 0 ? s : s.slice(0, k)).trim();
        const zh = k < 0 ? '' : s.slice(k + 1).trim();
        return en ? { en, zh } : null;
      }).filter(Boolean);
      touch();
    };
    $('#say').onclick = () => speak(it.en, lesson.lang);
    $('#saySent').onclick = () => speak(it.sent, lesson.lang);
    $('#del').onclick = removeSel;
  }
  const select = i => { sel = i; drawStage(); drawPanel(); };
  const removeSel = () => { if (sel < 0) return; lesson.items.splice(sel, 1); sel = -1; touch(); drawStage(); drawPanel(); };
  const setImage = async blob => {
    lesson.image = await shrink(blob); lesson.items = []; sel = -1; touch();
    imgUrl = URL.createObjectURL(lesson.image); drawStage(); drawPanel();
  };
  const moveBox = (i, dx, dy) => {
    const [y1, x1, y2, x2] = lesson.items[i].box, bh = y2 - y1, bw = x2 - x1;
    const ny = Math.max(0, Math.min(1000 - bh, y1 + dy)), nx = Math.max(0, Math.min(1000 - bw, x1 + dx));
    lesson.items[i].box = [ny, nx, ny + bh, nx + bw];
    stage.querySelector(`.box[data-i="${i}"]`).style.cssText = boxStyle(lesson.items[i].box);
    touch();
  };

  // 选中 + 拖动（只移动，不缩放）
  let drag = null;
  stage.onpointerdown = e => {
    const b = e.target.closest('.box');
    if (!b) return lesson.image && select(-1);
    const i = +b.dataset.i;
    if (i !== sel) select(i);
    const r = stage.getBoundingClientRect();
    drag = { i, x: e.clientX, y: e.clientY, box: [...lesson.items[i].box], w: r.width, h: r.height };
    stage.setPointerCapture(e.pointerId);
  };
  stage.onpointermove = e => {
    if (!drag) return;
    lesson.items[drag.i].box = [...drag.box];
    moveBox(drag.i, (e.clientX - drag.x) / drag.w * 1000, (e.clientY - drag.y) / drag.h * 1000);
  };
  stage.onpointerup = () => drag = null;
  $('#panel').onclick = e => { const d = e.target.closest('.words div'); if (d) select(+d.dataset.i); };
  view.onkeydown = e => {
    if (sel < 0 || e.target.matches('input, textarea')) return;
    const step = e.shiftKey ? 20 : 4;
    const d = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[e.key];
    if (d) moveBox(sel, ...d);
    else if (e.key === 'Delete' || e.key === 'Backspace') removeSel();
    else return;
    e.preventDefault();
  };

  $('#file').onchange = e => e.target.files[0] && setImage(e.target.files[0]).catch(err => alert('这张图打不开：' + err.message));
  $('#gen').onclick = () => location.hash = '#/gen'; // AI 生图统一走选题页：选大类 / 子话题或自己输入，生成的是新课
  $('#detect').onclick = async () => {
    if (!lesson.image) return toast('先放一张图');
    if (lesson.items.length && !confirm('会替换现有的框，继续？')) return;
    await busy($('#detect'), '识别中', async () => { lesson.items = await detect(lesson.image, lesson.lang, $('#withSent').checked); sel = -1; touch(); drawStage(); drawPanel(); toast(`识别出 ${lesson.items.length} 个物品`); });
  };
  $('#withSent').onchange = e => settings.set({ ...settings.get(), withSent: e.target.checked });
  $('#fill').onclick = async () => {
    if (!lesson.items.length) return toast('先识别或加几个词');
    await busy($('#fill'), '补例句和搭配中', async () => {
      const arr = await fillSents(lesson.items, lesson.lang);
      const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const by = new Map();
      for (const r of arr || []) if (norm(r?.en) && (r.sent || r.col?.length)) by.set(norm(r.en), r);
      let n = 0, miss = 0;
      // 没配上的词保留原来的例句和搭配（模型漏回一条不该把已有的抹掉）
      for (const it of lesson.items) {
        const r = by.get(norm(it.en));
        if (r) {
          if (r.sent) { it.sent = String(r.sent); it.sentZh = String(r.sentZh || ''); }
          if (r.col?.length) it.col = r.col;
          n++;
        } else miss++;
      }
      touch(); drawPanel();
      toast(`补了 ${n} 句` + (miss ? `，${miss} 个词没配上` : ''));
    });
  };
  $('#add').onclick = () => {
    if (!lesson.image) return toast('先放一张图');
    lesson.items.push({ en: 'new', zh: '', ipa: '', pos: '', alts: [], box: [400, 400, 600, 600] });
    touch(); select(lesson.items.length - 1);
    $('#f-en').select();
  };
  $('#save').onclick = async () => {
    if (!lesson.image) return toast('还没有图');
    lesson.title = $('#title').value.trim() || '未命名';
    lesson.updated = Date.now(); // 同步按它比哪台的版本新
    await db.put(lesson);
    view.dirty = false;
    toast('已保存');
    location.hash = '#/scene/' + lesson.id;
  };
  $('#title').oninput = touch;
  // 换语种：发音立刻跟着变，词表要再点「AI 识别」才换；记住上次选的，常学一种语言就不用每次点
  $('#lang').onchange = e => { lesson.lang = e.target.value; settings.set({ ...settings.get(), lastLang: lesson.lang }); touch(); drawPanel(); };
  if (!isPack) $('#folder').onchange = e => { lesson.folder = e.target.value; touch(); };
  drawStage(); drawPanel();
  if (!id && photo) {
    const b = photo; photo = null;
    try { await setImage(b); } catch (err) { return alert('这张图打不开：' + err.message); }
    const c = settings.get();
    if (c.apiUrl && c.apiKey && c.visionModel) $('#detect').click();
    else toast('去「我 → 接口」填好 AI，就能自动框出物品；也可以手动加框');
  }
}

async function busy(btn, label, fn) {
  const old = btn.textContent; btn.disabled = true; btn.innerHTML = dots(label);
  try { await fn(); } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = old; }
}
