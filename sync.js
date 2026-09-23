// 备份与同步：导出 / 导入备份 JSON、经本站 /sync 存到云端的自动同步。两条路共用同一套校验（外来数据先整理再写库）和合并规则
import { db, tx, settings, toast, langOf, LANGS } from './lib.js';
import { prog } from './progress.js';
import { packsReady } from './packs.js';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const blobToDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });

// —— 校验：备份文件和云端的 data.json 都是外来输入 ——
// 课程（不管图）：缺字段的返回 null，其余补齐默认值
function cleanLesson(l) {
  if (!isObj(l) || !l.id || typeof l.id !== 'string' || l.id.includes('|') || !Array.isArray(l.items)) return null;
  return {
    title: '未命名', created: Date.now(), ...l,
    items: l.items.filter(i => isObj(i) && i.en && Array.isArray(i.box) && i.box.length === 4).map(i => {
      const it = { zh: '', ipa: '', pos: '', alts: [], sent: '', sentZh: '', col: [], ...i };
      it.col = Array.isArray(it.col) ? it.col.filter(c => c && typeof c.en === 'string') : [];
      return it;
    }),
  };
}
const cleanProgress = list => Array.isArray(list) ? list.filter(p => isObj(p) && typeof p.key === 'string' && Number.isInteger(p.level) && p.level >= 0 && p.level <= 6 && Number.isFinite(p.due) && ['seen', 'right', 'wrong'].every(k => p[k] == null || Number.isFinite(p[k]))) : [];
// 「键 → 时间戳」表：错题本（键含 |）、删课记录（课程 id，不含 |）
const cleanStamps = (raw, ok) => Object.fromEntries(Object.entries(isObj(raw) ? raw : {}).filter(([k, t]) => ok(k) && Number.isFinite(t)));
const isWordKey = k => k.includes('|'), isLessonId = k => !!k && !k.includes('|');
const maxStamps = (a, b) => { const o = { ...a }; for (const [k, t] of Object.entries(b)) if (!(o[k] >= t)) o[k] = t; return o; };
// 日志：只留像样的日子（日期键、对象值），按天各项取大；同一天两台都学时题数取大不相加（接受）
function mergeDays(local, raw) {
  const days = { ...local };
  for (const [d, v] of Object.entries(isObj(raw) ? raw : {})) {
    if (!isObj(v) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const loc = isObj(days[d]) ? days[d] : {};
    const row = { ...loc, n: Math.max(num(v.n), num(loc.n)), new: Math.max(num(v.new), num(loc.new)), right: Math.max(num(v.right), num(loc.right)) };
    if (isObj(v.modes)) {
      const modes = { ...(isObj(loc.modes) ? loc.modes : {}) };
      for (const [k, mv] of Object.entries(v.modes)) {
        if (!isObj(mv) || typeof mv.n !== 'number' || typeof mv.right !== 'number') continue;
        const prev = isObj(modes[k]) ? modes[k] : {};
        modes[k] = { n: Math.max(mv.n, num(prev.n)), right: Math.max(mv.right, num(prev.right)) };
      }
      row.modes = modes;
    }
    days[d] = row;
  }
  return days;
}

// —— 备份文件 ——
// v2 备份：课程 + 学习进度 + 错题本 + 每日日志；旧版本导入这份会报「导入失败」，得先更新 App
export async function exportBackup() {
  const lessons = await db.all();
  const out = { v: 2, lessons: await Promise.all(lessons.map(async l => ({ ...l, image: await blobToDataUrl(l.image) }))), progress: await prog.all(), wrong: settings.get().wrong, days: settings.get().days || {} };
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(out)])), download: `看图记词-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
}
// 先把整份备份校验、整理完（含图片解码），全部没问题才开始写库：坏备份要么整份不动，要么只跳过坏的那几条，不会写一半再报错
export async function importBackup(file) {
  let raw;
  try { raw = JSON.parse(await file.text()); } catch { throw new Error('文件不是有效的 JSON'); }
  // 旧备份是课程数组；v2 是对象 { lessons, progress, wrong, days }
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.lessons) ? raw.lessons : null;
  if (!arr) throw new Error('这不是看图记词的备份文件');
  // 课程：缺字段、图片不是图片 data URL 或解不开的跳过
  const ok = [];
  for (const x of arr) {
    const l = cleanLesson(x);
    if (!l || typeof l.image !== 'string' || !l.image.startsWith('data:image/')) continue;
    try { l.image = await (await fetch(l.image)).blob(); } catch { continue; }
    ok.push({ ...l, updated: Date.now() }); // 导入是用户明确要这份：打上修改时间，同步时不会被另一台的删除记录或旧版本盖掉
  }
  const v2 = !Array.isArray(raw);
  // 进度：同一个词保留更晚的那条（merge 里比）
  const pl = v2 ? cleanProgress(raw.progress) : [];
  // 错题本：并集（备份里的错题会加回来）
  const wrong = cleanStamps(v2 ? raw.wrong : null, isWordKey);
  // 都整理好了，才写：课程一个事务（要么全进要么全不进），再合进度，最后读最新设置合日志和错题本（本地优先）
  // ponytail: 课程和进度是两个事务，写完课程后进度那步因配额失败会留下课程；要真原子得把 prog.merge 并进同一个跨表事务
  if (ok.length) await tx('lessons', 'readwrite', st => { for (const l of ok) st.put(l); });
  if (pl.length) await prog.merge(pl);
  if (v2) { const s1 = settings.get(); settings.set({ ...s1, days: mergeDays(s1.days || {}, raw.days), wrong: { ...wrong, ...s1.wrong } }); }
  const np = pl.length;
  toast(`导入 ${ok.length} 课${np ? `、${np} 条学习进度` : ''}` + (ok.length < arr.length ? `，跳过 ${arr.length - ok.length} 条坏数据` : ''));
}

// —— 云端同步 ——
// 云端每个同步码一份：data.json（课程去掉图 + 进度 + 错题本 + 日志 + 删除记录）和 img/<图片哈希>（同一张图只传一次），见 functions/sync
// 一次同步：拉 data.json → 在内存里合并 → 下载缺的图 → 写本机 → 上传缺的图 → 带 If-Match 推回（别的设备刚推过就重来一次）
const V = 1;
class SyncError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
const errOf = async r => (await r.json().catch(() => ({}))).error || '同步服务器返回 ' + r.status;
async function api(code, method, path, body, headers = {}) {
  const r = await fetch('/sync/' + path, { method, body, cache: 'no-store', headers: { Authorization: 'Bearer ' + code, ...headers } });
  if (r.status === 401 || r.status === 429) throw Object.assign(new SyncError(r.status === 401 ? '同步码不对或已失效' : await errOf(r), r.status), { code });
  return r;
}
export const normCode = s => String(s || '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/[^0-9A-Z]/g, '');
export const showCode = c => (c || '').match(/.{1,4}/g)?.join('-') || '';

const sha = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
// 比内容用：键排好序再转字符串，两台设备算出来一样
const canon = v => JSON.stringify(v, (k, x) => isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : 1)) : x);
const bare = l => { const { image, img, story, archived, archAt, ...rest } = l; return rest; }; // 课程的「内容」：不含图、故事、收起状态
const sigOf = l => l.items.map(i => i.en).join('|');
// 两台都有的课（a 本机、b 云端）：内容取 updated 大的，一样大取云端（有 If-Match 兜着，后推的那台会先拉到先推的结果，照样收敛）；收起状态按 archAt 另比；赢的那份没有对得上的故事就借另一份的
function pickLesson(a, b) {
  let [w, o] = (a.updated || 0) > (b.updated || 0) ? [a, b] : [b, a];
  w = { ...w };
  if ((o.archAt || 0) > (w.archAt || 0)) { w.archAt = o.archAt; if (o.archived) w.archived = o.archived; else delete w.archived; }
  const sig = sigOf(w), ok = x => x.story?.sig === sig;
  if (ok(o) && (!ok(w) || canon(o.story) > canon(w.story))) w.story = o.story; // 两份都对得上号就按内容定一个，两台结果一致
  return w;
}
const same = (a, b) => canon({ ...a, image: 0, img: 0 }) === canon({ ...b, image: 0, img: 0 });
const packPart = l => ({ lang: langOf(l), items: l.items });
// 只留对得上号的进度：课在、词也还在这课里（换了语种 / 改了词的旧进度不再传来传去）
const aliveIn = lessons => { const m = new Map(lessons.map(l => [l.id, new Set(l.items.map(i => i.en))])); return p => { const k = p.key.indexOf('|'); return !!m.get(p.key.slice(0, k))?.has(p.key.slice(k + 1)); }; };

// mode：'merge' 已经在用的设备加入（内置课两边对不上时问以哪边为准）、'fresh' 新手引导里加入（一律以云端为准）；加入后第一次同步成功前都记在 settings.syncJoin
async function syncNow(retry = true) {
  const mode = settings.get().syncJoin || '', code = settings.get().syncCode; // 这一轮从头到尾用同一个码（中途换码 / 加入不串号）
  // 1. 拉云端
  const r = await api(code, 'GET', 'data');
  if (!r.ok) throw new SyncError(r.status === 404 ? '云端的同步数据不见了' : await errOf(r), r.status);
  const etag = r.headers.get('ETag');
  const R = await r.json().catch(() => null);
  if (!isObj(R)) throw new SyncError('云端的同步数据坏了');
  if (num(R.v) > V) throw new SyncError('另一台设备的 App 比这台新，先刷新这一页再同步');
  const remote = new Map();
  for (const x of Array.isArray(R.lessons) ? R.lessons : []) { const l = cleanLesson(x); if (l && /^[0-9a-f]{32}$/.test(l.img)) remote.set(l.id, l); }
  let local = new Map((await db.all()).map(l => [l.id, l]));
  // 2. 加入时内置课两边不一样（切过语种或改过词，又都没有修改时间可比）：默认云端赢；已经在用的设备先问一句
  if (mode === 'merge') {
    const diff = [...remote.values()].filter(b => b.id.startsWith('pack-') && local.has(b.id) && !b.updated && !local.get(b.id).updated && canon(packPart(local.get(b.id))) !== canon(packPart(b)));
    if (diff.length) {
      const a0 = local.get(diff[0].id), b0 = diff[0], name = l => LANGS[langOf(l)].name;
      const langs = langOf(a0) !== langOf(b0) ? `（这台是${name(a0)}，云端是${name(b0)}）` : '（有些词改得不一样）';
      if (confirm(`内置课在这台和云端不一样${langs}。\n\n点「确定」以这台为准，点「取消」以云端为准。两边语种不同时，被换掉那边这几课的学习进度会清掉。`)) {
        const now = Date.now();
        await tx('lessons', 'readwrite', st => { for (const b of diff) st.put({ ...local.get(b.id), updated: now }); });
        local = new Map((await db.all()).map(l => [l.id, l]));
      }
    }
  }
  // 3. 内存里合并
  const s0 = settings.get();
  const del = maxStamps(cleanStamps(s0.del, isLessonId), cleanStamps(R.del, isLessonId));
  const localSha = new Map();
  for (const l of local.values()) localSha.set(l.id, await sha(l.image));
  const remoteImgs = new Set([...remote.values()].map(l => l.img));
  const out = [], toWrite = [], toDelete = [], missing = [];
  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const a = local.get(id), b = remote.get(id);
    const m = a && b ? pickLesson(a, b) : { ...(a || b) };
    if (id in del && del[id] >= (m.updated || 0)) { if (a) toDelete.push(id); continue; } // 删得比最后一次改晚：两边都删
    if (mode === 'fresh' && !b && id.startsWith('pack-')) { toDelete.push(id); continue; } // 新手引导里加入：云端没有的内置课（那边早删了）这台也不要
    if (m.img === undefined || (a && m.img === localSha.get(id))) m.img = localSha.get(id); // 用的是本机那张图
    out.push(m);
    if (!a || !same(m, a) || m.img !== localSha.get(id)) toWrite.push(m);
  }
  // 4. 下载要写进本机的课缺的图；图在云端没了（404）就跳过那一课，云端的原条目照留
  const images = new Map();
  for (const m of toWrite) {
    if (m.img === localSha.get(m.id)) { images.set(m.id, local.get(m.id).image); continue; }
    const g = await api(code, 'GET', 'img/' + m.img);
    if (g.status === 404) { missing.push(m.id); continue; }
    if (!g.ok) throw new SyncError('下载图片失败（' + g.status + '）', g.status);
    images.set(m.id, new Blob([await g.arrayBuffer()], { type: 'image/jpeg' }));
  }
  const skip = new Set(missing), final = out.map(m => skip.has(m.id) ? remote.get(m.id) : m);
  // 5. 写本机：课程一个事务；内置课被另一台换了语种就清这几课的旧进度（同 switchPacks）；进度按「谁更晚学过」合；删掉的课连进度一起删；设置在写入那一刻读最新的再合
  const writes = toWrite.filter(m => !skip.has(m.id));
  if (writes.length || toDelete.length) await tx('lessons', 'readwrite', st => {
    // 同步途中用户又改 / 删了这一课（本机已不是开始时那份）就不动它，下次同步再合
    const untouched = (id, fn) => { const g = st.get(id), a = local.get(id); g.onsuccess = () => { const c = g.result; if (a ? c && (c.updated || 0) === (a.updated || 0) && (c.archAt || 0) === (a.archAt || 0) && canon(c.story) === canon(a.story) : !c) fn(); }; };
    for (const m of writes) { const { img, ...l } = m; untouched(m.id, () => st.put({ ...l, image: images.get(m.id) })); }
    for (const id of toDelete) untouched(id, () => st.delete(id));
  });
  for (const m of writes) {
    const a = local.get(m.id);
    if (a && m.id.startsWith('pack-') && langOf(a) !== langOf(m) && langOf(await db.get(m.id)) === langOf(m)) await prog.delPrefix(m.id + '|');
  }
  const kept = new Set(final.map(l => l.id)), gone = new Set(Object.keys(del).filter(id => !kept.has(id))); // 删了之后另一台又改过而留下的课，进度照留
  const rp = cleanProgress(R.progress).filter(aliveIn(final));
  if (rp.length) await prog.merge(rp);
  for (const id of toDelete) await prog.delPrefix(id + '|');
  const s1 = settings.get();
  const wrongAll = maxStamps(cleanStamps(s1.wrong, isWordKey), cleanStamps(R.wrong, isWordKey));
  const wrongDel = maxStamps(cleanStamps(s1.wrongDel, isWordKey), cleanStamps(R.wrongDel, isWordKey));
  const wrong = Object.fromEntries(Object.entries(wrongAll).filter(([k, t]) => t > (wrongDel[k] || 0))); // 最后一次加入比移出晚才算在
  const days = mergeDays(s1.days || {}, R.days);
  const folders = [...new Set([...(s1.folders || []), ...(Array.isArray(R.folders) ? R.folders.filter(f => typeof f === 'string' && f) : [])])];
  const pack = final.find(l => l.id.startsWith('pack-'));
  settings.set({ ...s1, wrong, wrongDel, del: maxStamps(cleanStamps(s1.del, isLessonId), del), days, folders, ...(pack ? { packLang: langOf(pack) } : {}) });
  // 6. 上传云端还没有的图；空间满（413）的那课先不推新版本（云端有旧版就留旧版），其余照推
  let up = 0;
  const full = new Set();
  for (const m of final) {
    if (remoteImgs.has(m.img) || !local.has(m.id) || m.img !== localSha.get(m.id)) continue;
    const p = await api(code, 'PUT', 'img/' + m.img, local.get(m.id).image, { 'Content-Type': 'image/jpeg' });
    if (p.status === 413) { full.add(m.id); continue; }
    if (!p.ok) throw new SyncError('上传图片失败（' + (await errOf(p)) + '）', p.status);
    remoteImgs.add(m.img);
    up++;
  }
  const pushed = final.flatMap(m => !full.has(m.id) ? [m] : remote.has(m.id) ? [remote.get(m.id)] : []);
  // 7. 推回：不认识的顶层字段原样带回（以后加字段，旧版本不会把它抹掉）
  const body = { ...R, v: V, at: Date.now(), lessons: pushed.map(({ image, ...l }) => l), progress: (await prog.all()).filter(aliveIn(pushed)), wrong, wrongDel, del: settings.get().del, days, folders };
  const put = await api(code, 'PUT', 'data', JSON.stringify(body), { 'Content-Type': 'application/json', 'If-Match': etag });
  if (put.status === 412 && retry) return syncNow(false); // 另一台刚推过：重来一次（本机已合并的部分再合一遍结果不变）
  if (!put.ok) throw new SyncError(put.status === 412 ? '另一台设备正在同步，稍后再试' : put.status === 413 ? '同步数据太大，推不上去' : await errOf(put), put.status);
  const { syncJoin, ...s2 } = settings.get();
  settings.set({ ...s2, syncAt: Date.now() });
  const changed = pushed.filter(m => !remote.has(m.id) || !same(m, remote.get(m.id))).length;
  const deleted = toDelete.length + [...remote.keys()].filter(id => gone.has(id) && !local.has(id)).length; // 本机删的、推上去让云端也删的都算
  return { pulled: writes.length, pushed: changed, deleted, up, missing: missing.length, full: full.size };
}

// —— 开启 / 加入 / 换码 / 停止 ——
export async function startSync() {
  const r = await fetch('/sync/new', { method: 'POST', cache: 'no-store' });
  if (!r.ok) throw new SyncError(await errOf(r), r.status);
  return joinSync((await r.json()).code, 'merge');
}
export async function joinSync(input, mode = 'merge') {
  const code = normCode(input);
  if (code.length !== 16) throw new SyncError('同步码是 16 位字母或数字');
  await running?.catch(() => {});
  const s = settings.get(), old = { syncCode: s.syncCode, syncJoin: s.syncJoin, syncAt: s.syncAt, syncErr: s.syncErr, del: s.del, wrongDel: s.wrongDel };
  // 开同步之前的删课 / 移出错题本记录不带过去：另一台还在用的课，不该因为这台很久以前删过同 id 的课而被删
  settings.set({ ...s, syncCode: code, syncJoin: mode, del: {}, wrongDel: {}, syncErr: '' });
  try { return await runSync(); }
  catch (e) { const t = { ...settings.get(), ...old }; for (const k in old) if (old[k] === undefined) delete t[k]; settings.set(t); throw e; } // 没加入成功就当没发生：码、删除记录都回到原样
}
// 新手引导里加入：等内置课进库（引导页出来时已在后台放了），再以云端为准，然后算走完引导
export async function joinFresh(input) {
  await packsReady();
  const r = await joinSync(input, 'fresh');
  settings.set({ ...settings.get(), onboarded: true });
  return r;
}
export async function rotateCode() {
  await running?.catch(() => {}); // 等正在跑的那轮完（它拿旧码推送会 401）
  const r = await api(settings.get().syncCode, 'POST', 'rotate');
  if (!r.ok) throw new SyncError(await errOf(r), r.status);
  const { code } = await r.json();
  settings.set({ ...settings.get(), syncCode: code });
  return code;
}
export const stopSync = () => { const { syncCode, syncJoin, syncAt, syncErr, ...s } = settings.get(); settings.set(s); };

// 同一时间只跑一次；跑着的时候又被叫，完了再补一次。结果通过 window 事件 kantu:sync 告诉页面；空间满之类的提醒只在变了时弹一次
let running = null, queued = false;
export function runSync() {
  if (running) { queued = true; return running; }
  const prev = settings.get().syncErr;
  running = syncNow().then(r => {
    const warn = r.full ? `同步空间满了（200MB），${r.full} 课只存在这台` : r.missing ? `${r.missing} 课的图片在云端找不到，先跳过` : '';
    settings.set({ ...settings.get(), syncErr: warn });
    if (warn && warn !== prev) toast(warn, 5000);
    dispatchEvent(new CustomEvent('kantu:sync', { detail: r }));
    return r;
  }).finally(() => { running = null; if (queued) { queued = false; autoSync(); } });
  return running;
}
// 自动同步：打开 App、离开页面、学完一场时调；没开同步、没联网就什么都不做。失败只在原因变了时提示一次；码失效就在这台停掉
export function autoSync() {
  if (!settings.get().syncCode || !navigator.onLine) return Promise.resolve(null);
  return runSync().catch(e => {
    const msg = e instanceof TypeError ? '连不上同步服务器' : e.message;
    if (e.status === 401 && settings.get().syncCode === e.code) { stopSync(); toast('同步码已失效（可能在别的设备上换过），这台已停止同步；去「我 → 备份」重新输入', 6000); }
    else { if (settings.get().syncErr !== msg) toast('同步没成功：' + msg, 4000); settings.set({ ...settings.get(), syncErr: msg }); }
    dispatchEvent(new CustomEvent('kantu:sync', { detail: null }));
    return null;
  });
}
