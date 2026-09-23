// 备份与同步：导出 / 导入备份 JSON、WebDAV 按钮同步。两条路共用同一套校验（外来数据先整理再写库）和合并规则
import { db, tx, settings, toast, langOf } from './lib.js';
import { prog } from './progress.js';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const blobToDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });

// —— 校验：备份文件和网盘上的 data.json 都是外来输入 ——
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
    ok.push(l);
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

// —— WebDAV 同步 ——
// 网盘上固定一个 kantu-sync/ 文件夹：data.json（课程去掉图 + 进度 + 错题本 + 日志 + 删除记录）和 img/<图片哈希>.jpg（同一张图只传一次）
// 一次同步：拉 data.json → 在内存里合并 → 下载缺的图 → 写本机 → 上传缺的图 → 带 If-Match 推回 data.json（别人刚推过就重来一次）
const V = 1, DIR = 'kantu-sync/';
const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
async function dav(method, path, body, headers = {}) {
  const s = settings.get(), base = s.davUrl.trim().replace(/\/?$/, '/');
  // 一律经本站 /dav 中转：坚果云不许网页直连
  const r = await fetch('/dav?url=' + encodeURIComponent(base + DIR + path), { method, body, headers: { Authorization: 'Basic ' + b64(`${s.davUser}:${s.davPass}`), ...headers } });
  if (r.status === 401 || r.status === 403) throw new Error('账号或应用密码不对');
  return r;
}
const sha = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
// 比内容用：键排好序再转字符串，两台设备算出来一样
const canon = v => JSON.stringify(v, (k, x) => isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : 1)) : x);
const bare = l => { const { image, img, story, archived, archAt, ...rest } = l; return rest; }; // 课程的「内容」：不含图、故事、收起状态
const sigOf = l => l.items.map(i => i.en).join('|');
// 两台都有的课：内容取 updated 大的（一样大、内容却不同时按字符串大小定，两台结果一致，不会各留各的）；收起状态按 archAt 另比；赢的那份没有对得上的故事就借另一份的
function pickLesson(a, b) {
  const ua = a.updated || 0, ub = b.updated || 0;
  let [w, o] = ua > ub ? [a, b] : ub > ua ? [b, a] : canon(bare(a)) >= canon(bare(b)) ? [a, b] : [b, a];
  w = { ...w };
  if ((o.archAt || 0) > (w.archAt || 0)) { w.archAt = o.archAt; if (o.archived) w.archived = o.archived; else delete w.archived; }
  const sig = sigOf(w), ok = x => x.story?.sig === sig;
  if (ok(o) && (!ok(w) || canon(o.story) > canon(w.story))) w.story = o.story; // 两份都对得上号就按内容定一个，两台结果一致
  return w;
}
const same = (a, b) => canon({ ...a, image: 0, img: 0 }) === canon({ ...b, image: 0, img: 0 });

export async function syncNow(retry = true) {
  // 1. 拉远端
  let r = await dav('GET', 'data.json');
  let R = {}, etag = null;
  if (r.status === 404) {
    const mk = await dav('MKCOL', ''); // 第一次：建文件夹（已存在回 405 也算好）
    if (!mk.ok && mk.status !== 405) throw new Error(mk.status === 404 || mk.status === 409 ? '地址不对，找不到这个网盘目录' : '网盘建不了文件夹（' + mk.status + '）');
    await dav('MKCOL', 'img/');
  } else if (!r.ok) throw new Error('网盘返回 ' + r.status);
  else {
    etag = r.headers.get('ETag');
    try { R = await r.json(); } catch { throw new Error('网盘上的同步文件坏了（kantu-sync/data.json）'); }
    if (!isObj(R)) throw new Error('网盘上的同步文件坏了（kantu-sync/data.json）');
    if (num(R.v) > V) throw new Error('另一台设备的 App 比这台新，先刷新这一页再同步');
  }
  // 2. 内存里合并
  const s0 = settings.get();
  const del = maxStamps(cleanStamps(s0.del, isLessonId), cleanStamps(R.del, isLessonId));
  const local = new Map((await db.all()).map(l => [l.id, l]));
  const localSha = new Map();
  for (const l of local.values()) localSha.set(l.id, await sha(l.image));
  const remote = new Map();
  for (const x of Array.isArray(R.lessons) ? R.lessons : []) { const l = cleanLesson(x); if (l && /^[0-9a-f]{32}$/.test(l.img)) remote.set(l.id, l); }
  const remoteImgs = new Set([...remote.values()].map(l => l.img));
  const out = [], toWrite = [], toDelete = [], missing = [];
  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const a = local.get(id), b = remote.get(id);
    const m = a && b ? pickLesson(a, b) : { ...(a || b) };
    if (id in del && del[id] >= (m.updated || 0)) { if (a) toDelete.push(id); continue; } // 删得比最后一次改晚：两边都删
    if (m.img === undefined || (a && m.img === localSha.get(id))) m.img = localSha.get(id); // 用的是本机那张图
    out.push(m);
    if (!a || !same(m, a) || m.img !== localSha.get(id)) toWrite.push(m);
  }
  // 3. 下载要写进本机的课缺的图；图在网盘上没了（404）就跳过那一课，网盘上的原条目照留
  const images = new Map();
  for (const m of toWrite) {
    if (m.img === localSha.get(m.id)) { images.set(m.id, local.get(m.id).image); continue; }
    const g = await dav('GET', 'img/' + m.img + '.jpg');
    if (g.status === 404) { missing.push(m.id); continue; }
    if (!g.ok) throw new Error('下载图片失败（' + g.status + '）');
    images.set(m.id, new Blob([await g.arrayBuffer()], { type: 'image/jpeg' }));
  }
  const skip = new Set(missing), final = out.map(m => skip.has(m.id) ? remote.get(m.id) : m);
  // 4. 写本机：课程一个事务；进度按「谁更晚学过」合；删掉的课连进度一起删；设置在写入那一刻读最新的再合
  const writes = toWrite.filter(m => !skip.has(m.id));
  if (writes.length || toDelete.length) await tx('lessons', 'readwrite', st => {
    // 同步途中用户又改 / 删了这一课（本机已不是开始时那份）就不动它，下次同步再合
    const untouched = (id, fn) => { const g = st.get(id), a = local.get(id); g.onsuccess = () => { const c = g.result; if (a ? c && (c.updated || 0) === (a.updated || 0) && (c.archAt || 0) === (a.archAt || 0) && canon(c.story) === canon(a.story) : !c) fn(); }; };
    for (const m of writes) { const { img, ...l } = m; untouched(m.id, () => st.put({ ...l, image: images.get(m.id) })); }
    for (const id of toDelete) untouched(id, () => st.delete(id));
  });
  const kept = new Set(final.map(l => l.id)), gone = new Set(Object.keys(del).filter(id => !kept.has(id))); // 删了之后另一台又改过而留下的课，进度照留
  const alive = p => !gone.has(p.key.slice(0, p.key.indexOf('|')));
  const rp = cleanProgress(R.progress).filter(alive);
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
  // 5. 上传网盘上还没有的图（全部成功才推 data.json，不然网盘会指向不存在的图）
  let up = 0;
  for (const m of final) {
    if (remoteImgs.has(m.img) || !local.has(m.id) || m.img !== localSha.get(m.id)) continue;
    remoteImgs.add(m.img);
    const p = await dav('PUT', 'img/' + m.img + '.jpg', local.get(m.id).image, { 'Content-Type': 'image/jpeg' });
    if (!p.ok) throw new Error('上传图片失败（' + p.status + '）');
    up++;
  }
  // 6. 推回：不认识的顶层字段原样带回（以后加字段，旧版本不会把它抹掉）
  const body = { ...R, v: V, at: Date.now(), lessons: final, progress: (await prog.all()).filter(alive), wrong, wrongDel, del: settings.get().del, days, folders };
  const put = await dav('PUT', 'data.json', JSON.stringify(body), { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) }); // 第一次创建也防另一台同时创建
  if (put.status === 412 && retry) return syncNow(false); // 另一台刚推过：重来一次（本机已合并的部分再合一遍结果不变）
  if (!put.ok) throw new Error(put.status === 412 ? '另一台设备正在同步，稍后再点一次' : '上传失败（' + put.status + '）');
  settings.set({ ...settings.get(), davAt: Date.now() });
  const pulled = writes.length, pushed = final.filter(m => !remote.has(m.id) || !same(m, remote.get(m.id))).length;
  const deleted = toDelete.length + [...remote.keys()].filter(id => gone.has(id) && !local.has(id)).length; // 本机删的、推上去让网盘也删的都算
  return { pulled, pushed, deleted, up, missing: missing.length };
}
