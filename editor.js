// 备课页：传图 / AI 生图 → AI 识别出框 → 手动改词、拖框、删框 → 保存
import { db, esc, toast } from './lib.js';
import { detect, generateImage } from './ai.js';
import { speak } from './tts.js';

const pct = v => (v / 10).toFixed(2) + '%';
// 小框叠在大框上面，不然点不到被衣柜包住的裙子
export const boxStyle = ([y1, x1, y2, x2]) => `left:${pct(x1)};top:${pct(y1)};width:${pct(x2 - x1)};height:${pct(y2 - y1)};z-index:${1000 - Math.round((x2 - x1) * (y2 - y1) / 1000)}`;

export async function renderEditor(view, id) {
  const lesson = (id && await db.get(id)) || { id: crypto.randomUUID(), title: '', image: null, items: [], created: Date.now() };
  let sel = -1;
  view.innerHTML = `
    <div class="bar">
      <input id="title" placeholder="课程标题，比如：衣柜" value="${esc(lesson.title)}">
      <label class="btn">上传图片<input type="file" id="file" accept="image/*" hidden></label>
      <button id="gen">AI 生图</button>
      <button id="detect">AI 识别</button>
      <button id="add">手动加框</button>
      <button id="save" class="primary">保存</button>
    </div>
    <div class="two">
      <div class="stage" id="stage"><p class="muted" style="padding:40px;text-align:center">先上传一张图，或让 AI 生成一张</p></div>
      <div id="panel"></div>
    </div>`;
  const $ = s => view.querySelector(s);
  const stage = $('#stage');

  function drawStage() {
    if (!lesson.image) return;
    stage.innerHTML = `<img src="${URL.createObjectURL(lesson.image)}">` +
      lesson.items.map((it, i) => `<div class="box ${i === sel ? 'sel' : ''}" data-i="${i}" style="${boxStyle(it.box)}"><span class="tag">${esc(it.en)}</span></div>`).join('');
  }
  function drawPanel() {
    const it = lesson.items[sel];
    $('#panel').innerHTML = `
      <p class="muted">${lesson.items.length} 个词 · 点框或列表选中，拖框可移动</p>
      <div class="list">${lesson.items.map((x, i) => `<div class="${i === sel ? 'sel' : ''}" data-i="${i}">${esc(x.en)} <span class="muted">${esc(x.zh)}</span></div>`).join('')}</div>
      ${it ? `
      <label class="field">英文 <input id="f-en" value="${esc(it.en)}"></label>
      <label class="field">中文 <input id="f-zh" value="${esc(it.zh)}"></label>
      <label class="field">音标 <input id="f-ipa" value="${esc(it.ipa)}"></label>
      <label class="field">词性 <input id="f-pos" value="${esc(it.pos)}"></label>
      <label class="field">也算对（逗号分隔）<input id="f-alts" value="${esc(it.alts.join(', '))}"></label>
      <div class="bar"><button id="say">🔊 试听</button><button id="del" class="danger">删除这个框</button></div>` : ''}`;
    if (!it) return;
    for (const k of ['en', 'zh', 'ipa', 'pos']) $('#f-' + k).oninput = e => { it[k] = e.target.value; if (k === 'en') drawStage(); };
    $('#f-alts').oninput = e => it.alts = e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    $('#say').onclick = () => speak(it.en);
    $('#del').onclick = () => { lesson.items.splice(sel, 1); sel = -1; drawStage(); drawPanel(); };
  }
  const select = i => { sel = i; drawStage(); drawPanel(); };
  const setImage = blob => { lesson.image = blob; lesson.items = []; sel = -1; drawStage(); drawPanel(); };

  // 选中 + 拖动（只移动，不缩放）
  let drag = null;
  stage.onpointerdown = e => {
    const b = e.target.closest('.box');
    if (!b) return select(-1);
    const i = +b.dataset.i;
    if (i !== sel) select(i);
    const r = stage.getBoundingClientRect();
    drag = { i, x: e.clientX, y: e.clientY, box: [...lesson.items[i].box], w: r.width, h: r.height };
    stage.setPointerCapture(e.pointerId);
  };
  stage.onpointermove = e => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / drag.w * 1000, dy = (e.clientY - drag.y) / drag.h * 1000;
    const [y1, x1, y2, x2] = drag.box, bh = y2 - y1, bw = x2 - x1;
    const ny = Math.max(0, Math.min(1000 - bh, y1 + dy)), nx = Math.max(0, Math.min(1000 - bw, x1 + dx));
    lesson.items[drag.i].box = [ny, nx, ny + bh, nx + bw];
    stage.querySelector(`.box[data-i="${drag.i}"]`).style.cssText = boxStyle(lesson.items[drag.i].box);
  };
  stage.onpointerup = () => drag = null;
  $('#panel').onclick = e => { const d = e.target.closest('.list div'); if (d) select(+d.dataset.i); };

  $('#file').onchange = e => e.target.files[0] && setImage(e.target.files[0]);
  $('#gen').onclick = async () => {
    const p = prompt('描述想要的图（英文更准）：', 'A tidy children\'s bedroom with a bed, desk, lamp, bookshelf, toys and a window, flat illustration style');
    if (!p) return;
    await busy($('#gen'), '生图中…', async () => setImage(await generateImage(p)));
  };
  $('#detect').onclick = async () => {
    if (!lesson.image) return toast('先放一张图');
    if (lesson.items.length && !confirm('会替换现有的框，继续？')) return;
    await busy($('#detect'), '识别中…', async () => { lesson.items = await detect(lesson.image); sel = -1; drawStage(); drawPanel(); toast(`识别出 ${lesson.items.length} 个物品`); });
  };
  $('#add').onclick = () => {
    if (!lesson.image) return toast('先放一张图');
    lesson.items.push({ en: 'new', zh: '', ipa: '', pos: '', alts: [], box: [400, 400, 600, 600] });
    select(lesson.items.length - 1);
  };
  $('#save').onclick = async () => {
    if (!lesson.image) return toast('还没有图');
    lesson.title = $('#title').value.trim() || '未命名';
    await db.put(lesson);
    toast('已保存');
    location.hash = '#/';
  };
  drawStage(); drawPanel();
}

async function busy(btn, label, fn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn(); } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = old; }
}
