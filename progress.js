// 词级学习进度：每个「课程id|词」一条记忆状态（IndexedDB progress 表），复习间隔、按熟练度选练法、今天的题单、每日日志与连续天数
import { tx, settings, colOf } from './lib.js';

// 等级 1–6，答对升一级、下次间隔按这张表拉长（天）；答错掉回 1 级明天再见；≥ MASTER 算已掌握。没有记录 = 新词（0 级）
export const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
export const MASTER = 5;
const DAY = 86400000;
export const keyOf = q => q.lesson.id + '|' + q.item.en;
export const today = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };
// n 天后那天的零点（按本地日历走，夏令时切换不会差一小时把「明天」算成今天）
const dayStart = n => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); };
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.getTime(); };
export const levelName = lv => lv <= 0 ? '新词' : lv >= MASTER ? '已掌握' : `学习中 ${lv} 级`;
// 「3 天后」「明天」「今天」——给用户看的下次复习时间
export const dueText = due => { const d = Math.round((due - dayStart(0)) / DAY); return d <= 0 ? '今天' : d === 1 ? '明天' : `${d} 天后`; };

export const prog = {
  all: () => tx('progress', 'readonly', s => s.getAll()),
  put: r => tx('progress', 'readwrite', s => s.put(r)),
  // 删一课（或所有 pack- 内置课）的进度：键是「课程id|词」，按前缀范围一次删掉；课程 id 不含 |
  delPrefix: pre => tx('progress', 'readwrite', s => s.delete(IDBKeyRange.bound(pre, pre + '\uffff'))),
  // 导入合并：同 key 保留 last 更晚的那条
  merge: list => tx('progress', 'readwrite', s => { for (const p of list) { const g = s.get(p.key); g.onsuccess = () => { if (!g.result || (g.result.last || 0) <= (p.last || 0)) s.put(p); }; } }),
};

// 答题那一刻写一条。同一词一天只计一次排期（再来一遍 / 再练错的不会重复升级），但次数照记。返回 { before, after, due } 给界面反馈
export const record = (q, first) => {
  let fb;
  return tx('progress', 'readwrite', s => {
    const key = keyOf(q), g = s.get(key);
    g.onsuccess = () => {
      const p = g.result || { key, level: 0, due: 0, last: 0, day: '', seen: 0, right: 0, wrong: 0 };
      const before = p.level, d = today(), counted = p.day !== d; // 今天第一次答这个词才动排期
      p.seen++; first ? p.right++ : p.wrong++; p.last = Date.now();
      if (p.day !== d) {
        p.level = first ? Math.min(p.level + 1, INTERVALS.length - 1) : 1;
        p.due = dayStart(INTERVALS[p.level]); p.day = d;
      }
      s.put(p);
      fb = { before, after: p.level, due: p.due, counted, first };
    };
  }).then(() => fb);
};

// 按熟练度选练法——认 → 指 → 拼 → 说 → 用：刚认识的选词 / 听音点图，学习中打单词，4 级这一关必须「说出来」才升到已掌握，掌握后轮换句子 / 搭配 / 说
const hasCol = it => (it.col || []).some(c => c && colOf(c.en).answers.length);
export function modeFor(level, it) {
  if (level <= 1) return Math.random() < 0.5 ? 'pickEn' : 'tap'; // 新词考的是目标语言的词，不出「选中文」（自由练里仍可手选）
  if (level <= 3) return 'type';
  if (level === 4) return 'speak';
  const pool = ['speak', 'type', ...(it.sent ? ['sent'] : []), ...(hasCol(it) ? ['col'] : [])];
  return pool[Math.floor(Math.random() * pool.length)];
}

// 每日日志：settings.days = { 'YYYY-MM-DD': { n, new, right, modes? } }；modes = { type: { n, right }, ... }，learn 不记；老日子没这字段读时当 {}
const MODE_KEYS = { type: 1, tap: 1, sent: 1, pickEn: 1, pickZh: 1, col: 1, speak: 1, palace: 1, miss: 1 };
export const days = () => settings.get().days || {};
export const logDay = (add) => {
  const s = settings.get(), d = today(), all = { ...(s.days || {}) }, cur = all[d] || { n: 0, new: 0, right: 0 };
  const modes = { ...(cur.modes || {}) };
  if (add.modes && typeof add.modes === 'object' && !Array.isArray(add.modes)) {
    for (const [k, v] of Object.entries(add.modes)) {
      if (!MODE_KEYS[k] || !v || typeof v !== 'object') continue;
      const prev = modes[k] || { n: 0, right: 0 };
      modes[k] = { n: prev.n + (v.n || 0), right: prev.right + (v.right || 0) };
    }
  }
  all[d] = { ...cur, n: cur.n + (add.n || 0), new: (cur.new || 0) + (add.new || 0), right: (cur.right || 0) + (add.right || 0), modes };
  settings.set({ ...s, days: all });
};
// 连续天数：从今天（今天没学就从昨天）往前数学过的日子。冻结卡：漏掉的单独一天自动冻结、不算断，但 7 天里只冻一次；连漏两天才断
function run(all) {
  let n = 0, k = all[today()] ? 0 : 1, lastMiss = -99;
  const frozen = new Set();
  for (;; k++) {
    const d = today(daysAgo(k));
    if (all[d]) { n++; continue; }
    // 漏的这天前一天学过、7 天内没冻过，且后面有人接上（已经数到学过的日子，或漏的就是昨天、今天还来得及）
    if ((n || k === 1) && k - lastMiss >= 7 && all[today(daysAgo(k + 1))]) { lastMiss = k; frozen.add(d); continue; }
    return { n, frozen };
  }
}
export const streak = (all = days()) => run(all).n;
export const week = (all = days()) => { const { frozen } = run(all); return Array.from({ length: 7 }, (_, k) => { const d = today(daysAgo(6 - k)); return { day: d, on: !!all[d], ice: frozen.has(d), isToday: k === 6 }; }); };
export const newPerDay = () => { const n = +settings.get().newPerDay; return Number.isInteger(n) && n >= 0 ? n : 10; };

// 今天的题单：到期的复习 + 新词（限每日上限，减掉今天已学的）。only 给了就只看那一课；归档课不进来
export function buildToday(lessons, plist, only) {
  const byKey = new Map(plist.map(p => [p.key, p]));
  const live = lessons.filter(l => !l.archived && l.items.length && (!only || l.id === only)).sort((a, b) => b.created - a.created);
  const due = [], fresh = [], end = endOfToday();
  for (const lesson of live) for (const item of lesson.items) {
    const q = { lesson, item }, p = byKey.get(keyOf(q));
    if (!p) fresh.push(q);
    else if (p.due <= end) due.push({ ...q, level: p.level });
  }
  // 新词优先给「已经开了头、还没学完」的课，一课学完再开下一课；同一词两个框只算一个
  const started = new Set(plist.map(p => p.key.slice(0, p.key.indexOf('|'))));
  fresh.sort((a, b) => (started.has(b.lesson.id) - started.has(a.lesson.id)) || (b.lesson.created - a.lesson.created));
  const seen = new Set(), uniq = fresh.filter(q => !seen.has(keyOf(q)) && seen.add(keyOf(q)));
  const cap = Math.max(0, newPerDay() - (days()[today()]?.new || 0));
  return { due, fresh: uniq.slice(0, cap), freshAll: uniq.length };
}
// 已经全部掌握、还没收起的课（首页提示「收起？」）
export const masteredLessons = (lessons, plist) => {
  const lv = new Map(plist.map(p => [p.key, p.level]));
  return lessons.filter(l => !l.archived && l.items.length && l.items.every(it => (lv.get(l.id + '|' + it.en) || 0) >= MASTER));
};
// 最难的词：level < MASTER 且错过的，按错次数、错占比排，对回现有课程取前 10（课已删 / 词已改名的跳过、往后补）
export function hardWords(lessons, plist) {
  const byId = Object.fromEntries(lessons.map(l => [l.id, l]));
  const ranked = plist.filter(p => p.level < MASTER && p.wrong > 0)
    .sort((a, b) => (b.wrong - a.wrong) || ((b.wrong / (b.seen || 1)) - (a.wrong / (a.seen || 1))));
  const out = [];
  for (const p of ranked) {
    const i = p.key.indexOf('|');
    if (i < 0) continue;
    const lesson = byId[p.key.slice(0, i)];
    const item = lesson?.items.find(it => it.en === p.key.slice(i + 1));
    if (!item) continue;
    out.push({ lesson, item, wrong: p.wrong, seen: p.seen, level: p.level });
    if (out.length === 10) break;
  }
  return out;
}
// 一课的掌握情况 { mastered, learning, fresh, due }
export function lessonStat(l, plist) {
  const lv = new Map(plist.filter(p => p.key.startsWith(l.id + '|')).map(p => [p.key, p])), end = endOfToday(), st = { mastered: 0, learning: 0, fresh: 0, due: 0, total: 0 };
  const seen = new Set();
  for (const it of l.items) {
    const k = l.id + '|' + it.en; if (seen.has(k)) continue; seen.add(k); st.total++;
    const p = lv.get(k);
    if (!p) st.fresh++; else { p.level >= MASTER ? st.mastered++ : st.learning++; if (p.due <= end) st.due++; }
  }
  return st;
}
