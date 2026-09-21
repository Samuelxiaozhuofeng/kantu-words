// 入口：hash 路由、课程列表、设置页、导入导出、注册 PWA
import { db, esc, settings, toast } from './lib.js';
import { listModels } from './ai.js';
import { speak } from './tts.js';
import { renderEditor } from './editor.js';
import { renderStudy } from './study.js';

const view = document.getElementById('view');

async function renderList() {
  const lessons = (await db.all()).sort((a, b) => b.created - a.created);
  view.innerHTML = `
    <div class="bar"><a class="btn primary" href="#/edit" style="background:var(--acc)">＋ 新建课程</a><button id="export">导出全部</button>
      <label class="btn">导入<input type="file" id="import" accept=".json" hidden></label></div>
    ${lessons.length ? '' : '<p class="muted">还没有课程。点「新建课程」，传一张图，让 AI 把物品框出来。</p>'}
    <div class="cards">${lessons.map(l => `<div class="card"><img src="${URL.createObjectURL(l.image)}">
      <div class="body"><b>${esc(l.title)}</b> <span class="muted">${l.items.length} 个词</span>
      <div class="bar"><a class="btn primary" href="#/study/${l.id}">开始学</a><a class="btn" href="#/edit/${l.id}">编辑</a><button class="danger" data-del="${l.id}">删</button></div></div></div>`).join('')}</div>`;
  view.onclick = async e => {
    const id = e.target.dataset.del;
    if (id && confirm('删除这一课？')) { await db.del(id); renderList(); }
  };
  view.querySelector('#export').onclick = async () => {
    const out = await Promise.all(lessons.map(async l => ({ ...l, image: await blobToDataUrl(l.image) })));
    download(`看图记词-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out));
  };
  view.querySelector('#import').onchange = async e => {
    try {
      const arr = JSON.parse(await e.target.files[0].text());
      for (const l of arr) await db.put({ ...l, image: await (await fetch(l.image)).blob() });
      toast(`导入 ${arr.length} 课`); renderList();
    } catch (err) { alert('导入失败：' + err.message); }
  };
}
const blobToDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
function download(name, text) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text])), download: name });
  a.click();
}

function renderSettings() {
  const s = settings.get();
  view.innerHTML = `
    <div style="max-width:560px">
      <h3>AI 接口（OpenAI 兼容）</h3>
      <label class="field">API 地址 <input id="apiUrl" placeholder="https://xxx/v1" value="${esc(s.apiUrl)}"></label>
      <label class="field">API Key <input id="apiKey" type="password" value="${esc(s.apiKey)}"></label>
      <button id="fetch">拉取模型列表</button> <span class="muted" id="fetched"></span>
      <datalist id="models"></datalist>
      <label class="field">识别模型（要能看图）<input id="visionModel" list="models" value="${esc(s.visionModel)}"></label>
      <h3>生图接口（可选）</h3>
      <p class="muted">生图和识图不是同一家时才填；留空就用上面的接口。</p>
      <label class="field">生图 API 地址 <input id="imageApiUrl" placeholder="留空 = 同上" value="${esc(s.imageApiUrl)}"></label>
      <label class="field">生图 API Key <input id="imageApiKey" type="password" value="${esc(s.imageApiKey)}"></label>
      <button id="fetchImg">拉取生图模型列表</button> <span class="muted" id="fetchedImg"></span>
      <datalist id="imgModels"></datalist>
      <label class="field">生图模型 <input id="imageModel" list="imgModels" value="${esc(s.imageModel)}"></label>
      <h3>发音</h3>
      <label class="field">Edge TTS 发音人 <input id="voice" list="voices" value="${esc(s.voice)}"></label>
      <datalist id="voices"><option>en-US-JennyNeural<option>en-US-GuyNeural<option>en-US-AriaNeural<option>en-GB-SoniaNeural<option>en-GB-RyanNeural<option>en-AU-NatashaNeural</datalist>
      <button id="test">🔊 试听 hello</button>
      <p class="muted">Key 只存在这台设备的浏览器里，不会上传到别处。</p>
      <div class="bar"><button id="save" class="primary">保存</button></div>
    </div>`;
  const $ = s => view.querySelector(s);
  const collect = () => ({ ...s, ...Object.fromEntries(['apiUrl', 'apiKey', 'visionModel', 'imageApiUrl', 'imageApiKey', 'imageModel', 'voice'].map(k => [k, $('#' + k).value.trim()])) });
  $('#fetch').onclick = async () => {
    settings.set(collect());
    try {
      const ms = await listModels();
      $('#models').innerHTML = ms.map(m => `<option>${esc(m)}`).join('');
      $('#fetched').textContent = `${ms.length} 个模型，在下面输入框里点开选`;
    } catch (e) { alert(e.message); }
  };
  $('#fetchImg').onclick = async () => {
    settings.set(collect());
    try {
      const ms = await listModels(true);
      $('#imgModels').innerHTML = ms.map(m => `<option>${esc(m)}`).join('');
      $('#fetchedImg').textContent = `${ms.length} 个模型`;
    } catch (e) { alert(e.message); }
  };
  $('#test').onclick = () => { settings.set(collect()); speak('hello'); };
  $('#save').onclick = () => { settings.set(collect()); toast('已保存'); location.hash = '#/'; };
}

function route() {
  const [, page, id] = location.hash.slice(1).split('/');
  view.onclick = view.onkeydown = null;
  if (page === 'edit') renderEditor(view, id);
  else if (page === 'study') renderStudy(view, id);
  else if (page === 'settings') renderSettings();
  else renderList();
}
addEventListener('hashchange', route);
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
