// 入口：hash 路由、课程列表、设置页、导入导出、注册 PWA
import { db, esc, dots, settings, toast, LANGS, langOf, folderOf, wrongEntries } from './lib.js';
import { listModels } from './ai.js';
import { speak } from './tts.js';
import { renderEditor } from './editor.js';
import { renderStudy } from './study.js';
import { renderGen, queue, retryFailed, clearQueue } from './gen.js';
import { PRESETS, pingAnki, listDecks, exportWrong } from './anki.js';

const view = document.getElementById('view');

const isPack = l => l.id.startsWith('pack-'); // 内置课按编号认，改过名、改过词还算内置
const UNGROUPED = '未分组';
let curFolder = ''; // 「我的课程」当前选中的文件夹标签，空串 = 全部；只记在内存里
async function renderList() {
  const lessons = (await db.all()).sort((a, b) => b.created - a.created);
  const mine = lessons.filter(l => !isPack(l)), packs = lessons.filter(isPack);
  // 没手动切过标签时：自己有课就看自己的，没有就看内置的，别让新用户开门见空页
  const tab = settings.get().homeTab || (mine.length ? 'mine' : 'packs');
  // 文件夹标签：只列实际有课的，没分组的课归「未分组」排最后；一个都没分组时整排不显示
  const folders = [...new Set(mine.map(folderOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  if (mine.some(l => !folderOf(l))) folders.push(UNGROUPED);
  if (!folders.includes(curFolder)) curFolder = '';
  const inFolder = l => !curFolder || (folderOf(l) || UNGROUPED) === curFolder;
  const shown = tab === 'packs' ? packs : mine.filter(inFolder), packLang = settings.get().packLang || 'en';
  const wrongs = wrongEntries(lessons, settings.get().wrong);
  const by = st => queue.filter(j => j.state === st), names = st => by(st).map(j => esc(j.topic)).join('、');
  const genBar = !queue.length ? '' : `<div class="bar genprog"><span>AI 出课：完成 ${by('done').length} / ${queue.length}${by('run').length ? ` · 生成中 ${by('run').length}：${dots(names('run'))}` : ''}${by('wait').length ? ` · 排队 ${by('wait').length}` : ''}${by('fail').length ? ` · 失败 ${by('fail').length}` : ''}</span>
    ${by('fail').map(j => `<span class="muted">${esc(j.topic)}：${esc(j.error.slice(0, 60))}</span>`).join('')}
    ${by('fail').length ? '<button id="genRetry">重试失败的</button>' : ''}${by('run').length + by('wait').length ? '' : '<button id="genClear">清除记录</button>'}</div>`;
  const wrongPanel = `
    <div class="bar">${wrongs.length ? `<a class="btn primary" href="#/study/wrong">练习错题本</a><button id="exportAnki">导出到 Anki</button><label class="chk"><input type="checkbox" id="ankiClear"${settings.get().ankiClear ? ' checked' : ''}> 导出后清空错题本</label>` : ''}<button id="clearWrong">清空错题本</button></div>
    ${wrongs.length ? `<div class="words wrongs">${wrongs.map(q =>
      `<div><b>${esc(q.item.en)}</b> ${esc(q.item.zh)} <span class="muted">${esc(q.lesson.title)}</span><button data-unwrong="${esc(q.key)}">移出</button></div>`
    ).join('')}</div>` : '<div class="empty"><b>错题本是空的</b>练完没一次答对的词会记在这里，下次一次答对就会拿掉。</div>'}`;
  view.innerHTML = `
    <div class="bar"><a class="btn primary" href="#/edit">＋ 新建课程</a>
      <span class="seg" id="tabs"><button data-tab="mine" class="${tab === 'mine' ? 'on' : ''}">我的课程 ${mine.length}</button><button data-tab="packs" class="${tab === 'packs' ? 'on' : ''}">内置课程 ${packs.length}</button><button data-tab="wrong" class="${tab === 'wrong' ? 'on' : ''}">错题本 ${wrongs.length}</button></span>
      ${tab === 'packs' ? `<select id="packLang" title="内置课程用哪种语言">${Object.entries(LANGS).map(([k, L]) => `<option value="${k}" ${k === packLang ? 'selected' : ''}>${L.name}</option>`).join('')}</select>` : ''}
      <span style="flex:1"></span><button id="export">导出备份</button>
      <label class="btn">导入<input type="file" id="import" accept=".json" hidden></label></div>
    ${tab === 'mine' ? genBar : ''}
    ${tab === 'mine' && folders.length && folders[0] !== UNGROUPED ? `<div class="bar"><span class="seg" id="folders"><button data-folder="" class="${curFolder ? '' : 'on'}">全部</button>${folders.map(f => `<button data-folder="${esc(f)}" class="${f === curFolder ? 'on' : ''}">${esc(f)}</button>`).join('')}</span></div>` : ''}
    ${tab === 'wrong' ? wrongPanel : shown.length ? '' : tab === 'packs' ? '<div class="empty"><b>内置课程都删掉了</b>去「我的课程」看看自己的课吧。</div>' : '<div class="empty"><b>还没有自己的课程</b>点「新建课程」，传一张图，让 AI 把物品框出来；或者先去「内置课程」玩现成的。</div>'}
    ${tab === 'wrong' ? '' : `<div class="cards">${shown.map(l => `<div class="card"><a class="pic" href="#/study/${l.id}"><img src="${URL.createObjectURL(l.image)}"><span class="n">${l.items.length ? l.items.length + ' 词' : '待整理'}</span>${langOf(l) === 'en' ? '' : `<span class="n lang">${LANGS[langOf(l)].name}</span>`}</a>
      <div class="body"><b>${esc(l.title)}</b>
      <div class="bar"><a class="btn primary" href="#/study/${l.id}">开始学</a><a class="btn" href="#/edit/${l.id}">编辑</a><span style="flex:1"></span><button class="danger" data-del="${l.id}">删</button></div></div></div>`).join('')}</div>`}`;
  view.querySelector('#tabs').onclick = e => { const t = e.target.dataset.tab; if (t) { settings.set({ ...settings.get(), homeTab: t }); renderList(); } };
  const fl = view.querySelector('#folders');
  if (fl) fl.onclick = e => { const f = e.target.dataset.folder; if (f !== undefined) { curFolder = f; renderList(); } };
  const sel = view.querySelector('#packLang');
  if (sel) sel.onchange = async () => {
    if (!confirm(`把 ${packs.length} 课内置课程换成${LANGS[sel.value].name}版？你在内置课上改过的词会被换掉。`)) { sel.value = packLang; return; }
    try { await switchPacks(sel.value); toast(`内置课程已换成${LANGS[sel.value].name}`); renderList(); }
    catch (e) { alert('没换成，检查一下网络：' + e.message); sel.value = packLang; }
  };
  view.onclick = async e => {
    if (e.target.id === 'genRetry') return retryFailed();
    if (e.target.id === 'genClear') return clearQueue();
    if (e.target.id === 'exportAnki') {
      try { if (await exportWrong(wrongs)) renderList(); }
      catch (err) { alert('导出失败：' + err.message); }
      return;
    }
    if (e.target.id === 'ankiClear') {
      settings.set({ ...settings.get(), ankiClear: e.target.checked });
      return;
    }
    if (e.target.id === 'clearWrong' && confirm('把记着的错词都拿掉？')) {
      settings.set({ ...settings.get(), wrong: {} }); renderList(); return;
    }
    const k = e.target.dataset.unwrong;
    if (k) {
      const book = { ...settings.get().wrong };
      delete book[k];
      settings.set({ ...settings.get(), wrong: book });
      renderList();
      return;
    }
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
        items: l.items.filter(i => i && i.en && Array.isArray(i.box) && i.box.length === 4).map(i => ({ zh: '', ipa: '', pos: '', alts: [], sent: '', sentZh: '', ...i })),
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

// 内置课程：index.json 里每课带英语词表 + 其他语种的译词（tr[lang] 和 items 一一对应，框 / 中文 / 词性共用）
const fetchPacks = async () => { const r = await fetch('packs/index.json'); if (!r.ok) throw new Error(r.status); return r.json(); };
const packItems = (p, lang) => lang === 'en' || !p.tr?.[lang] ? p.items : p.items.map((it, k) => ({ ...it, ...p.tr[lang][k] }));
// 第一次打开把内置课放进本机课程库（已有同 id 的跳过），之后不再放——删了不会再冒出来
async function addPacks() {
  if (settings.get().packsAdded) return 0;
  const have = new Set((await db.all()).map(l => l.id)), lang = settings.get().packLang || 'en';
  let k = 0;
  for (const [i, p] of (await fetchPacks()).entries()) {
    if (have.has(p.id)) continue;
    const image = await (await fetch('packs/' + p.image)).blob();
    await db.put({ id: p.id, title: p.title, items: packItems(p, lang), lang, image, created: Date.UTC(2026, 0, 1) - i * 1000 }); // 固定旧时间：排在用户自己的课后面
    k++;
  }
  settings.set({ ...settings.get(), packsAdded: true });
  return k;
}
// 内置课词表升级（目前只加了例句）：只给本机 pack 课里「词没被用户改过且还没有例句」的词填上，别的一律不动；跑过一次记版本号
const PACKS_VER = 2;
async function fillPackSents() {
  if (settings.get().packsVer === PACKS_VER) return;
  for (const p of await fetchPacks()) {
    const l = await db.get(p.id);
    if (!l) continue;
    const fresh = packItems(p, langOf(l));
    let changed = false;
    l.items.forEach((it, k) => {
      const f = fresh[k];
      if (!it.sent && f?.sent && f.en === it.en) { it.sent = f.sent; it.sentZh = f.sentZh || ''; changed = true; }
    });
    if (changed) await db.put(l);
  }
  settings.set({ ...settings.get(), packsVer: PACKS_VER });
}
// 内置课换语种：原地替换本机已有的那几课的词表（删掉的不复活，图不重下）
async function switchPacks(lang) {
  const packs = await fetchPacks();
  for (const p of packs) {
    const l = await db.get(p.id);
    if (l) await db.put({ ...l, items: packItems(p, lang), lang });
  }
  settings.set({ ...settings.get(), packLang: lang });
}

function renderSettings() {
  const s = settings.get();
  const preset = PRESETS[s.ankiPreset] ? s.ankiPreset : 'pic';
  view.innerHTML = `
    <div style="max-width:560px;margin:0 auto">
      <div class="bar"><span class="seg" id="setTabs"><button data-stab="api" class="on">接口</button><button data-stab="anki">Anki</button></span></div>
      <div id="pane-api">
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
      <label class="field">同时生成几张图（AI 出课批量时）<input id="genParallel" type="number" min="1" max="8" value="${s.genParallel || 3}"></label>
      </div>
      <div class="panel" style="margin-top:16px">
      <h3 style="margin-top:0">发音</h3>
      <label class="field">英语发音人（其他语种自动配）<input id="voice" list="voices" value="${esc(s.voice)}"></label>
      <datalist id="voices"><option>en-US-JennyNeural<option>en-US-GuyNeural<option>en-US-AriaNeural<option>en-GB-SoniaNeural<option>en-GB-RyanNeural<option>en-AU-NatashaNeural</datalist>
      <button id="test">🔊 试听 hello</button>
      </div>
      </div>
      <div id="pane-anki" hidden>
      <div class="panel">
      <h3 style="margin-top:0">连接状态</h3>
      <p id="ankiStatus">尚未连接</p>
      <p class="muted" id="ankiHelp" hidden>需要电脑上开着 Anki 桌面版并装 AnkiConnect 插件（代码 2055492159）；第一次连接 Anki 会弹框问是否允许，点「是」；手机浏览器连不上（AnkiConnect 只有桌面版有）。</p>
      <button id="ankiPing">重新连接</button>
      </div>
      <div class="panel" style="margin-top:16px">
      <label class="field">牌组 <select id="ankiDeck">${s.ankiDeck ? `<option selected>${esc(s.ankiDeck)}</option>` : ''}</select></label>
      <label class="field">或新建牌组 <input id="ankiNew" placeholder="填了就用新名字"></label>
      <label class="field">卡片样式 <select id="ankiPreset">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${k === preset ? 'selected' : ''}>${p.name}</option>`).join('')}</select></label>
      <p class="muted" id="ankiHint">${PRESETS[preset].hint}</p>
      </div>
      </div>
      <p class="muted">Key 只存在这台设备的浏览器里，不会上传到别处。</p>
      <div class="bar"><button id="save" class="primary">保存</button></div>
    </div>`;
  const $ = s => view.querySelector(s);
  const collect = () => ({
    ...s,
    ...Object.fromEntries(['apiUrl', 'apiKey', 'visionModel', 'imageApiUrl', 'imageApiKey', 'imageModel', 'voice'].map(k => [k, $('#' + k).value.trim()])),
    ankiDeck: $('#ankiNew').value.trim() || $('#ankiDeck').value || s.ankiDeck || '',
    ankiPreset: $('#ankiPreset').value || 'pic',
    genParallel: (n => Number.isInteger(n) && n >= 1 && n <= 8 ? n : 3)(+$('#genParallel').value),
  });
  const connectAnki = async () => {
    $('#ankiStatus').textContent = '正在连接…';
    $('#ankiHelp').hidden = true;
    try {
      const r = await pingAnki();
      const decks = await listDecks();
      const cur = $('#ankiNew').value.trim() || s.ankiDeck || '';
      if (cur && !decks.includes(cur)) decks.unshift(cur);
      $('#ankiDeck').innerHTML = decks.map(d => `<option${d === (cur || decks[0]) ? ' selected' : ''}>${esc(d)}</option>`).join('');
      $('#ankiStatus').textContent = `已连接 Anki（AnkiConnect v${r.version || 6}）`;
    } catch {
      $('#ankiStatus').textContent = '未连接';
      $('#ankiHelp').hidden = false;
    }
  };
  $('#setTabs').onclick = e => {
    const t = e.target.dataset.stab;
    if (!t) return;
    $('#pane-api').hidden = t !== 'api';
    $('#pane-anki').hidden = t !== 'anki';
    $('#setTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.stab === t));
    if (t === 'anki') connectAnki();
  };
  $('#ankiPing').onclick = connectAnki;
  $('#ankiPreset').onchange = () => { $('#ankiHint').textContent = PRESETS[$('#ankiPreset').value].hint; };
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
  else if (page === 'gen') renderGen(view);
  else {
    renderList();
    addPacks().then(k => { if (k) { toast(`已放入 ${k} 课内置课程，不填 Key 也能玩`); if (cur === location.hash) renderList(); } }).then(fillPackSents).catch(e => console.warn('内置课程没拿到，下次再试', e));
  }
}
addEventListener('hashchange', route);
addEventListener('kantu:gen', () => { if (location.hash === '#/' || !location.hash) renderList(); }); // 批量出课进度变了，在首页就重画
addEventListener('beforeunload', e => { if (view.dirty) e.preventDefault(); });
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
