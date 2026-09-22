// 入口：hash 路由、底部四个标签（今天 / 世界 / 词库 / 我）、「我」页（设置 + 备份）、注册 PWA
import { db, esc, settings, toast, LEVELS, levelOf, KEYS, KEY_NAMES, keysOf, comboOf, keyLabel } from './lib.js';
import { listModels } from './ai.js';
import { speak } from './tts.js';
import { renderEditor } from './editor.js';
import { renderStudy } from './study.js';
import { renderStats } from './stats.js';
import { renderWord } from './word.js';
import { renderGen } from './gen.js';
import { renderScene } from './scene.js';
import { renderToday, renderWorld } from './home.js';
import { packsReady } from './packs.js';
import { PRESETS, pingAnki, listDecks } from './anki.js';
import { prog, newPerDay } from './progress.js';

const view = document.getElementById('view');

const blobToDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
function download(name, text) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text])), download: name });
  a.click();
}
// v2 备份：课程 + 学习进度 + 错题本 + 每日日志；旧版本导入这份会报「导入失败」，得先更新 App
async function exportBackup() {
  const lessons = await db.all();
  const out = { v: 2, lessons: await Promise.all(lessons.map(async l => ({ ...l, image: await blobToDataUrl(l.image) }))), progress: await prog.all(), wrong: settings.get().wrong, days: settings.get().days || {} };
  download(`看图记词-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out));
}
async function importBackup(file) {
  const raw = JSON.parse(await file.text());
  // 旧备份是课程数组；v2 是对象 { lessons, progress, wrong, days }
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.lessons) ? raw.lessons : null;
  if (!arr) throw new Error('这不是看图记词的备份文件');
  // 缺字段的记录跳过并补齐默认值，不然一条坏数据会把整个列表页搞挂
  const ok = arr.filter(l => l && l.id && typeof l.image === 'string' && Array.isArray(l.items));
  for (const l of ok) await db.put({
    title: '未命名', created: Date.now(), ...l, image: await (await fetch(l.image)).blob(),
    items: l.items.filter(i => i && i.en && Array.isArray(i.box) && i.box.length === 4).map(i => {
      const it = { zh: '', ipa: '', pos: '', alts: [], sent: '', sentZh: '', col: [], ...i };
      it.col = Array.isArray(it.col) ? it.col.filter(c => c && typeof c.en === 'string') : [];
      return it;
    }),
  });
  let np = 0;
  if (!Array.isArray(raw)) {
    // 进度：同一个词保留更晚的那条；错题本：并集（备份里的错题会加回来）；日志：同一天取大
    const pl = (raw.progress || []).filter(p => p && typeof p.key === 'string' && Number.isInteger(p.level) && p.level >= 0 && p.level <= 6 && Number.isFinite(p.due) && ['seen', 'right', 'wrong'].every(k => p[k] == null || Number.isFinite(p[k])));
    if (pl.length) { await prog.merge(pl); np = pl.length; }
    const s0 = settings.get(), days = { ...(s0.days || {}) };
    for (const [d, v] of Object.entries(raw.days || {})) {
      const loc = days[d] || {};
      const row = { ...loc, n: Math.max(v.n || 0, loc.n || 0), new: Math.max(v.new || 0, loc.new || 0), right: Math.max(v.right || 0, loc.right || 0) };
      const bm = v && typeof v.modes === 'object' && !Array.isArray(v.modes) ? v.modes : null;
      if (bm) {
        const modes = { ...(typeof loc.modes === 'object' && loc.modes && !Array.isArray(loc.modes) ? loc.modes : {}) };
        for (const [k, mv] of Object.entries(bm)) {
          if (!mv || typeof mv !== 'object' || typeof mv.n !== 'number' || typeof mv.right !== 'number') continue;
          const prev = modes[k];
          modes[k] = { n: Math.max(mv.n, prev && typeof prev.n === 'number' ? prev.n : 0), right: Math.max(mv.right, prev && typeof prev.right === 'number' ? prev.right : 0) };
        }
        row.modes = modes;
      }
      days[d] = row;
    }
    settings.set({ ...s0, days, wrong: { ...(raw.wrong || {}), ...s0.wrong } });
  }
  toast(`导入 ${ok.length} 课${np ? `、${np} 条学习进度` : ''}` + (ok.length < arr.length ? `，跳过 ${arr.length - ok.length} 条坏数据` : ''));
}

function renderSettings() {
  const s = settings.get();
  const preset = PRESETS[s.ankiPreset] ? s.ankiPreset : 'pic', keys = keysOf();
  view.innerHTML = `
    <div style="max-width:560px;margin:0 auto">
      <div class="bar"><span class="seg" id="setTabs"><button data-stab="learn" class="on">学习</button><button data-stab="api">接口</button><button data-stab="data">备份</button><button data-stab="anki">Anki</button><button data-stab="keys">快捷键</button></span></div>
      <div id="pane-learn">
      <div class="panel">
      <h3 style="margin-top:0">每天学多少</h3>
      <p class="muted">「今天」里每天最多给几个新词；到期复习的词不受限制。学得吃力就调小，想快就调大。</p>
      <label class="field">每日新词 <input id="newPerDay" type="number" min="0" max="100" value="${newPerDay()}"></label>
      </div>
      <div class="panel">
      <h3 style="margin-top:0">我的水平</h3>
      <p class="muted">AI 出课和「AI 识别」按这个水平挑词：基础 = 现在这样；进阶跳过入门词、用更精确的叫法（armchair 不是 chair）并标零件和材质；高阶只出 B2 以上的词。内置 12 课不受影响。</p>
      <label class="field">水平 <select id="level">${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}" ${k === levelOf() ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <div class="panel">
      <h3 style="margin-top:0">答题时</h3>
      <label class="field">中文提示 <select id="hintMode">${[['always', '一直显示'], ['wrong', '答错后才显示'], ['never', '不显示']].map(([k, v]) => `<option value="${k}" ${k === (s.hintMode || 'always') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">答对之后 <select id="autoNext"><option value="1" ${s.autoNext !== false ? 'selected' : ''}>自动下一题</option><option value="0" ${s.autoNext === false ? 'selected' : ''}>停在答案上，Enter 或点图再走</option></select></label>
      <label class="chk"><input type="checkbox" id="sfx"${s.sfx === false ? '' : ' checked'}> 答对 / 答错的提示音和手机震动</label>
      </div>
      </div>
      <div id="pane-data" hidden>
      <div class="panel">
      <h3 style="margin-top:0">备份</h3>
      <p class="muted">所有东西只存在这台设备的浏览器里。换设备、清浏览器数据之前，先导出一份。备份带课程、学习进度、错题本和每日记录。</p>
      <div class="bar"><button id="export">导出备份</button><label class="btn">导入备份<input type="file" id="import" accept=".json" hidden></label></div>
      </div>
      </div>
      <div id="pane-api" hidden>
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
      <div id="pane-keys" hidden>
      <div class="panel">
      <h3 style="margin-top:0">学习页快捷键</h3>
      <p class="muted">点进框里，按下你想用的组合键。要带 Ctrl / ⌘ / Alt（打单词时纯字母会打进输入框）。Enter 提交 / 下一题、1–4 选项不能改。</p>
      ${Object.entries(KEY_NAMES).map(([k, name]) => `<label class="field">${name} <input data-key="${k}" readonly value="${esc(keyLabel(keys[k]))}" placeholder="按下组合键"></label>`).join('')}
      <div class="bar"><button id="keysReset">恢复默认</button></div>
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
    newPerDay: (n => Number.isInteger(n) && n >= 0 && n <= 100 ? n : 10)(+$('#newPerDay').value),
    level: LEVELS[$('#level').value] ? $('#level').value : 'basic',
    hintMode: $('#hintMode').value,
    autoNext: $('#autoNext').value === '1',
    sfx: $('#sfx').checked,
    keys,
  });
  // 录快捷键：只认带修饰键的组合（或 F 键），光按修饰键不算；和另一个撞了就提醒
  for (const inp of view.querySelectorAll('input[data-key]')) inp.onkeydown = e => {
    e.preventDefault();
    if (/^(Control|Meta|Alt|Shift)/.test(e.code)) return;
    if (!(e.ctrlKey || e.metaKey || e.altKey) && !/^F\d+$/.test(e.code)) return toast('要带 Ctrl / ⌘ / Alt');
    const c = comboOf(e), k = inp.dataset.key, dup = Object.keys(keys).find(o => o !== k && keys[o] === c);
    if (dup) return toast(`这个组合已经给了「${KEY_NAMES[dup]}」`);
    keys[k] = c; inp.value = keyLabel(c);
  };
  $('#keysReset').onclick = () => { Object.assign(keys, KEYS); for (const inp of view.querySelectorAll('input[data-key]')) inp.value = keyLabel(keys[inp.dataset.key]); };
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
    for (const p of view.querySelectorAll('[id^="pane-"]')) p.hidden = p.id !== 'pane-' + t;
    $('#setTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.stab === t));
    if (t === 'anki') connectAnki();
  };
  $('#ankiPing').onclick = connectAnki;
  $('#export').onclick = exportBackup;
  $('#import').onchange = async e => { try { await importBackup(e.target.files[0]); } catch (err) { alert('导入失败：' + err.message); } e.target.value = ''; };
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
  $('#save').onclick = () => { settings.set(collect()); toast('已保存'); };
}

// 底部四个标签：学习页、编辑页不摆（专心做一件事）；子页面亮它所属的标签
const TAB = { '': 'today', world: 'world', scene: 'world', gen: 'world', stats: 'stats', word: 'stats', settings: 'me' };
function nav(page) {
  const t = TAB[page ?? ''];
  document.body.classList.toggle('focus', !t);
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.tab === t);
}
let cur = null; // 当前已渲染的 hash；编辑页没保存就离开时用来把地址退回去
function route() {
  if (location.hash === cur) return;
  if (view.dirty && !confirm('这一课还没保存，改动会丢。确定离开？')) { location.hash = cur; return; }
  view.dirty = false;
  cur = location.hash;
  const parts = cur.slice(1).split('/');
  const page = parts[1], id = parts[2];
  view.onclick = view.onkeydown = view.onchange = null;
  nav(page);
  scrollTo(0, 0);
  if (page === 'edit') renderEditor(view, id);
  else if (page === 'study') renderStudy(view, id, undefined, parts[3]); // #/study/today/<课程id> 只练那一课
  else if (page === 'settings') renderSettings();
  else if (page === 'stats') renderStats(view);
  else if (page === 'gen') renderGen(view);
  else if (page === 'world') renderWorld(view);
  else if (page === 'scene') renderScene(view, id, parts[3]);
  else if (page === 'word') renderWord(view, id, decodeURIComponent(parts.slice(3).join('/')));
  else renderToday(view);
  // 第一次打开：内置课进库后重画今天 / 世界页（引导页正在选的时候别打断）
  if (!page || page === 'world') {
    const redraw = page ? renderWorld : renderToday, at = cur;
    packsReady().then(k => { if (k && cur === at && !view.querySelector('.welcome')) { toast(`已放入 ${k} 个内置场景，不填 Key 也能玩`); redraw(view); } }).catch(e => console.warn('内置课程没拿到，下次再试', e));
  }
}
addEventListener('hashchange', route);
addEventListener('kantu:gen', () => { const p = location.hash.split('/')[1] || ''; if (p === '') renderToday(view); else if (p === 'world') renderWorld(view); }); // 批量出课进度变了，在今天 / 世界页就重画
addEventListener('beforeunload', e => { if (view.dirty) e.preventDefault(); });
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
