// 入口：hash 路由、课程列表、设置页、导入导出、注册 PWA
import { db, esc, settings, toast } from './lib.js';
import { listModels } from './ai.js';
import { speak } from './tts.js';
import { renderEditor } from './editor.js';
import { renderStudy } from './study.js';

const view = document.getElementById('view');

const isPack = l => l.id.startsWith('pack-'); // 内置课按编号认，改过名、改过词还算内置
async function renderList() {
  const lessons = (await db.all()).sort((a, b) => b.created - a.created);
  const mine = lessons.filter(l => !isPack(l)), packs = lessons.filter(isPack);
  // 没手动切过标签时：自己有课就看自己的，没有就看内置的，别让新用户开门见空页
  const tab = settings.get().homeTab || (mine.length ? 'mine' : 'packs');
  const shown = tab === 'packs' ? packs : mine;
  view.innerHTML = `
    <div class="bar"><a class="btn primary" href="#/edit">＋ 新建课程</a>
      <span class="seg" id="tabs"><button data-tab="mine" class="${tab === 'mine' ? 'on' : ''}">我的课程 ${mine.length}</button><button data-tab="packs" class="${tab === 'packs' ? 'on' : ''}">内置课程 ${packs.length}</button></span>
      <span style="flex:1"></span><button id="export">导出备份</button>
      <label class="btn">导入<input type="file" id="import" accept=".json" hidden></label></div>
    ${shown.length ? '' : tab === 'packs' ? '<div class="empty"><b>内置课程都删掉了</b>去「我的课程」看看自己的课吧。</div>' : '<div class="empty"><b>还没有自己的课程</b>点「新建课程」，传一张图，让 AI 把物品框出来；或者先去「内置课程」玩现成的。</div>'}
    <div class="cards">${shown.map(l => `<div class="card"><a class="pic" href="#/study/${l.id}"><img src="${URL.createObjectURL(l.image)}"><span class="n">${l.items.length} 词</span></a>
      <div class="body"><b>${esc(l.title)}</b>
      <div class="bar"><a class="btn primary" href="#/study/${l.id}">开始学</a><a class="btn" href="#/edit/${l.id}">编辑</a><span style="flex:1"></span><button class="danger" data-del="${l.id}">删</button></div></div></div>`).join('')}</div>`;
  view.querySelector('#tabs').onclick = e => { const t = e.target.dataset.tab; if (t) { settings.set({ ...settings.get(), homeTab: t }); renderList(); } };
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
      // 缺字段的记录跳过并补齐默认值，不然一条坏数据会把整个列表页搞挂
      const ok = arr.filter(l => l && l.id && typeof l.image === 'string' && Array.isArray(l.items));
      for (const l of ok) await db.put({
        title: '未命名', created: Date.now(), ...l, image: await (await fetch(l.image)).blob(),
        items: l.items.filter(i => i && i.en && Array.isArray(i.box) && i.box.length === 4).map(i => ({ zh: '', ipa: '', pos: '', alts: [], ...i })),
      });
      toast(`导入 ${ok.length} 课` + (ok.length < arr.length ? `，跳过 ${arr.length - ok.length} 条坏数据` : '')); renderList();
    } catch (err) { alert('导入失败：' + err.message); }
  };
}
const blobToDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
function download(name, text) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text])), download: name });
  a.click();
}

// 内置课程：第一次打开把 packs/ 里的课放进本机课程库（已有同 id 的跳过），之后不再放——删了不会再冒出来
async function addPacks() {
  if (settings.get().packsAdded) return 0;
  const have = new Set((await db.all()).map(l => l.id));
  const r = await fetch('packs/index.json');
  if (!r.ok) throw new Error(r.status);
  let k = 0;
  for (const [i, p] of (await r.json()).entries()) {
    if (have.has(p.id)) continue;
    const image = await (await fetch('packs/' + p.image)).blob();
    await db.put({ id: p.id, title: p.title, items: p.items, image, created: Date.UTC(2026, 0, 1) - i * 1000 }); // 固定旧时间：排在用户自己的课后面
    k++;
  }
  settings.set({ ...settings.get(), packsAdded: true });
  return k;
}

function renderSettings() {
  const s = settings.get();
  view.innerHTML = `
    <div style="max-width:560px;margin:0 auto">
      <div class="panel">
      <h3 style="margin-top:0">AI 接口（OpenAI 兼容）</h3>
      <label class="field">API 地址 <input id="apiUrl" placeholder="https://xxx/v1" value="${esc(s.apiUrl)}"></label>
      <label class="field">API Key <input id="apiKey" type="password" value="${esc(s.apiKey)}"></label>
      <div class="bar"><button id="fetch">拉取模型列表</button> <span class="muted" id="fetched"></span></div>
      <datalist id="models"></datalist>
      <label class="field">识别模型（要能看图）<input id="visionModel" list="models" placeholder="gemini-2.5-flash" value="${esc(s.visionModel)}"></label>
      </div>
      <div class="panel" style="margin-top:16px">
      <h3 style="margin-top:0">生图接口（可选）</h3>
      <p class="muted">生图和识图不是同一家时才填；留空就用上面的接口。</p>
      <label class="field">生图 API 地址 <input id="imageApiUrl" placeholder="留空 = 同上" value="${esc(s.imageApiUrl)}"></label>
      <label class="field">生图 API Key <input id="imageApiKey" type="password" value="${esc(s.imageApiKey)}"></label>
      <div class="bar"><button id="fetchImg">拉取生图模型列表</button> <span class="muted" id="fetchedImg"></span></div>
      <datalist id="imgModels"></datalist>
      <label class="field">生图模型 <input id="imageModel" list="imgModels" value="${esc(s.imageModel)}"></label>
      </div>
      <div class="panel" style="margin-top:16px">
      <h3 style="margin-top:0">发音</h3>
      <label class="field">Edge TTS 发音人 <input id="voice" list="voices" value="${esc(s.voice)}"></label>
      <datalist id="voices"><option>en-US-JennyNeural<option>en-US-GuyNeural<option>en-US-AriaNeural<option>en-GB-SoniaNeural<option>en-GB-RyanNeural<option>en-AU-NatashaNeural</datalist>
      <button id="test">🔊 试听 hello</button>
      </div>
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

let cur = null; // 当前已渲染的 hash；编辑页没保存就离开时用来把地址退回去
function route() {
  if (location.hash === cur) return;
  if (view.dirty && !confirm('这一课还没保存，改动会丢。确定离开？')) { location.hash = cur; return; }
  view.dirty = false;
  cur = location.hash;
  const [, page, id] = cur.slice(1).split('/');
  view.onclick = view.onkeydown = null;
  if (page === 'edit') renderEditor(view, id);
  else if (page === 'study') renderStudy(view, id);
  else if (page === 'settings') renderSettings();
  else {
    renderList();
    addPacks().then(k => { if (k) { toast(`已放入 ${k} 课内置课程，不填 Key 也能玩`); if (cur === location.hash) renderList(); } }).catch(e => console.warn('内置课程没拿到，下次再试', e));
  }
}
addEventListener('hashchange', route);
addEventListener('beforeunload', e => { if (view.dirty) e.preventDefault(); });
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
