// 内置课程：首次打开放进本机、词表只填空升级、整体换语种
import { db, settings, langOf } from './lib.js';
import { prog } from './progress.js';

// 内置课程：index.json 里每课带英语词表 + 其他语种的译词（tr[lang] 和 items 一一对应，框 / 中文 / 词性共用）
const fetchPacks = async () => { const r = await fetch('packs/index.json'); if (!r.ok) throw new Error(r.status); return r.json(); };
const packItems = (p, lang) => lang === 'en' || !p.tr?.[lang] ? p.items : p.items.map((it, k) => ({ ...it, ...p.tr[lang][k] }));
// 第一次打开把内置课放进本机课程库（已有同 id 的跳过），之后不再放——删了不会再冒出来
export async function addPacks() {
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
// 内置课词表升级：只给本机 pack 课里「词没被用户改过且还没有的字段」填上，别的一律不动；跑过一次记版本号
const PACKS_VER = 3;
export async function fillPackSents() {
  if (settings.get().packsVer === PACKS_VER) return;
  for (const p of await fetchPacks()) {
    const l = await db.get(p.id);
    if (!l) continue;
    const fresh = packItems(p, langOf(l));
    let changed = false;
    l.items.forEach((it, k) => {
      const f = fresh[k];
      if (!it.sent && f?.sent && f.en === it.en) { it.sent = f.sent; it.sentZh = f.sentZh || ''; changed = true; }
      if (!it.col?.length && f?.col?.length && f.en === it.en) { it.col = f.col; changed = true; }
    });
    if (changed) await db.put(l);
  }
  settings.set({ ...settings.get(), packsVer: PACKS_VER });
}
// 内置课换语种：原地替换本机已有的那几课的词表（删掉的不复活，图不重下）
export async function switchPacks(lang) {
  const packs = await fetchPacks();
  for (const p of packs) {
    const l = await db.get(p.id);
    if (l) await db.put({ ...l, items: packItems(p, lang), lang });
  }
  for (const p of packs) await prog.delPrefix(p.id + '|'); // 词全换了，原来的进度对不上号；只清 index.json 里这几课，不按前缀误伤同名前缀的自建课
  settings.set({ ...settings.get(), packLang: lang });
}
// 首页、新手引导都要等内置课进库；只跑一次，失败了下次再试
let ready;
export const packsReady = () => ready ||= addPacks().then(async k => { await fillPackSents(); return k; }).catch(e => { ready = null; throw e; });
