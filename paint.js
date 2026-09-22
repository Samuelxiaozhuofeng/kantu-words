// 场景上色：整张图先褪成暖灰，学过的物品按熟练度把颜色「涂」回来（掌握 = 全彩），到期该复习的物品蒙一层灰雾。世界页、今天页、场景页、结果页共用
import { MASTER } from './progress.js';

const cache = new Map(); // 课程 id + 宽度 → { sig, url }；状态没变就不重画
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };
// 每个物品的状态：lv 0 = 新词（灰），1..MASTER = 颜色浓度，due = 蒙灰雾
export const stateOf = (lesson, byKey, end = endOfToday()) => lesson.items.map(it => {
  const p = byKey.get(lesson.id + '|' + it.en);
  return { lv: p ? p.level : 0, due: !!p && p.due <= end && !lesson.archived };
});

// 返回图片 URL。fresh = 不进缓存（结果页要同时摆「之前 / 之后」两张）
export async function paint(lesson, byKey, width = 640, fresh = false) {
  // 签名带上每个框的坐标：编辑页挪过框也要重画
  const st = stateOf(lesson, byKey), sig = (lesson.image?.size || 0) + ':' + st.map((s, i) => s.lv + (s.due ? 'd' : '') + '@' + lesson.items[i].box.join('.')).join(','), ck = lesson.id + '@' + width;
  const hit = !fresh && cache.get(ck);
  if (hit && hit.sig === sig) return hit.url;
  const bmp = await createImageBitmap(lesson.image);
  const k = Math.min(1, width / bmp.width), W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, W, H);
  const full = st.length && st.every(s => s.lv >= MASTER);
  if (!full) {
    const d = g.getImageData(0, 0, W, H), a = d.data;
    for (let i = 0; i < a.length; i += 4) {
      const v = a[i] * .3 + a[i + 1] * .59 + a[i + 2] * .11;
      a[i] = v * .82 + 40; a[i + 1] = v * .8 + 38; a[i + 2] = v * .76 + 32; // 偏暖的浅灰，跟纸色一个调
    }
    g.putImageData(d, 0, 0);
    // 大框先涂、小框后涂，床上的枕头不会被床的颜色浓度盖掉
    const order = lesson.items.map((it, i) => i).sort((x, y) => area(lesson.items[y].box) - area(lesson.items[x].box));
    for (const i of order) {
      if (!st[i].lv) continue;
      const [y1, x1, y2, x2] = lesson.items[i].box;
      g.globalAlpha = Math.min(1, .35 + .65 * st[i].lv / MASTER);
      g.drawImage(bmp, x1 / 1000 * bmp.width, y1 / 1000 * bmp.height, (x2 - x1) / 1000 * bmp.width, (y2 - y1) / 1000 * bmp.height, x1 / 1000 * W, y1 / 1000 * H, (x2 - x1) / 1000 * W, (y2 - y1) / 1000 * H);
    }
    g.globalAlpha = 1;
  }
  g.fillStyle = 'rgba(236,229,214,.62)';
  for (const [i, it] of lesson.items.entries()) if (st[i].due) { const [y1, x1, y2, x2] = it.box; g.fillRect(x1 / 1000 * W, y1 / 1000 * H, (x2 - x1) / 1000 * W, (y2 - y1) / 1000 * H); }
  const url = URL.createObjectURL(await new Promise(r => c.toBlob(r, 'image/jpeg', .86)));
  if (!fresh) { if (hit) URL.revokeObjectURL(hit.url); cache.set(ck, { sig, url }); }
  return url;
}
const area = ([y1, x1, y2, x2]) => (y2 - y1) * (x2 - x1);
// 页面上所有 <img data-paint="课程id"> 异步换成上色图（先画出页面，图随后到）
export function paintAll(root, lessons, byKey, width) {
  const byId = new Map(lessons.map(l => [l.id, l]));
  for (const img of root.querySelectorAll('img[data-paint]')) {
    const l = byId.get(img.dataset.paint);
    if (l?.image) paint(l, byKey, width).then(u => { img.src = u; }).catch(e => console.warn('上色失败', e));
  }
}
