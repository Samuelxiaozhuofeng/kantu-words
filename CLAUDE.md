# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

看图记词：纯前端 PWA（原生 ES module，无框架、无构建、无 npm 依赖、无测试），部署在 Cloudflare Pages。README 是给用户看的功能说明，本文只写开发者要知道的。

## 命令

```bash
npx wrangler pages dev .                                    # 本地跑（含 /tts /proxy 函数；纯静态服务器跑不了发音和代理）
npx wrangler pages deploy . --project-name kantu-words --branch master   # 上线（Pages 生产分支叫 master，本地 git 分支是 main，别改）
```

没有 lint / test / build。验收靠浏览器真跑一遍。

## 架构

- `app.js` 是入口：hash 路由 `#/`（列表）`#/edit/:id` `#/study/:id` `#/settings` `#/stats`（统计页，只读）`#/gen`（AI 出课；批量队列在 gen.js 模块级，进度靠 window 事件 `kantu:gen` 通知首页）`#/word/:lang/:word`（跨课词视图，只读；第三段 `decodeURIComponent` 后交给 `renderWord`），每次路由把 `#view` 整个 `innerHTML` 重画。页面模块导出一个 `renderX(view, id)`，自己往 `view` 上挂事件；路由切换前会清掉 `view.onclick / onkeydown`。
- **未保存拦截约定**：编辑页有改动就设 `view.dirty = true`；`app.js` 的 `route()` 和 `beforeunload` 靠这个标记拦离开。新增会改数据的页面要跟这个约定。
- **学习进度**（`progress.js`，IndexedDB `kantu` 库 v2 新增 `progress` 表，keyPath `key`）：每条 `{ key: '课程id|词', level: 1..6, due, last, day: 'YYYY-MM-DD', seen, right, wrong }`，没有记录 = 新词。键和错题本 / Anki 同一把。`record(q, first)` 在答题那一刻读改写同事务：`day !== 今天` 才动 `level / due`（一天只计一次），次数照记；`INTERVALS` 是各级间隔天数，`MASTER = 5` 起算掌握。删课 / 切语种用 `prog.delPrefix('课程id|')` / `('pack-')` 按键前缀范围删。`#/study/today[/课程id]` 走 `buildToday()`：到期 + 新词（`settings.newPerDay` 上限减今天已学），归档课不进；题单每题自带 `mode`（`modeFor(level, item)`），新词先以 `'learn'` 模式过一遍。每日日志 `settings.days`，`days[d]` 为 `{ n, new, right, modes? }`，`modes` 是各练法 `{ n, right }`（键只用六种练法名，`learn` 不记；老日子没这字段读时当 `{}`），`streak()` 算连续天数。`hardWords(lessons, plist)` 给出最难的 10 个词（level < MASTER 且 wrong > 0，课已删 / 词已改名的跳过），统计页和学习页 `#/study/hard` 共用。备份 v2 是 `{ v, lessons, progress, wrong, days }`，导入时顶层数组 = 旧格式；老版本 App 导不了 v2 备份（会报「导入失败」）。`lib.js` 的 `open` 建表全带 `contains` 守卫，`onversionchange` 关连接、`onblocked` 提示关其他标签页。
- **数据模型**（IndexedDB `kantu` 库 `lessons` 表，`lib.js`）：`{ id, title, image: Blob(JPEG≤1600px), items: [{ en, zh, ipa, pos, alts: [], box: [ymin, xmin, ymax, xmax], sent?, sentZh?, col? }], created, lang?, folder?, archived? }`。`archived` 是归档（界面叫「收起」）时间戳（可选）：有就进首页「已收起」标签、不出现在「我的课程 / 内置课程」、不进「今天」题单，放回时删掉字段；错题本、自由练题单、Anki 都不看它。`folder` 是课程文件夹：可选字符串，缺省 / 空串当未分组，内置课不写，读一律用 `folderOf(lesson)`，不按 `FOLDERS` 校验（老数据改名不丢）。大类列表 = `FOLDERS`（内置 12 个）+ `settings.folders`（用户加的），取用 `allFolders()`。`sent` / `sentZh` 是例句和它的中文（可选，缺省 `''`）：识别时勾了「生成例句和搭配」才要，或编辑页「补例句和搭配」按 `en` 匹配回填（没配上的保留原句和搭配）；学习页「听句子点图」只在题单里有句子时出现。`col` 是搭配（可选，缺省 `[]`）：每项 `{ en, zh }`，`en` 里方括号标要练的词；读一律走 `lib.js` 的 `colOf()`。学习页「填搭配」只在题单里有搭配时出现。`lang` 是课程语种（`lib.js` 的 `LANGS` 表：en/ja/ko/fr/de/es），缺省当 `en`（老课、内置课、旧备份），一律用 `langOf(lesson)` 取；**`en` 字段名不改**，存的是该语种的词。`box` 是 0–1000 归一化坐标，顺序是 **y 在前**（跟 Gemini 输出一致），`editor.js` 的 `boxStyle` 负责转 CSS。导出/导入 JSON 时 `image` 转 data URL。
- **设置**全在 `localStorage.kantu` 一个 JSON 里（`settings.get/set`），键：`apiUrl apiKey visionModel imageApiUrl imageApiKey imageModel voice hintMode studyMode autoNext keys homeTab packsAdded packLang lastLang wrong ankiDeck ankiPreset ankiClear withSent packsVer genParallel folders newPerDay days level`。`level` 是学习者水平（`lib.js` 的 `LEVELS`：basic/mid/high，读一律 `levelOf()`，缺省 basic）：只影响 `ai.js` 三处提示词（`LEVEL_HINT`：列子话题 / 画图 / 识词，basic 一个字都不加），不写进课程；`gen.js` 子话题缓存键带水平，mid/high 出的课标题带「· 进阶 / · 高阶」。`days[d].modes` 见学习进度段。`wrong` 是错题本 `{ "课程id|词": 加入时间戳 }`，只在学习页写（答题那一刻：没一次答对的加进去；答对的**不自动移出**；练习中和结果页的「错题本」勾选框实时增删）、首页错题本标签删。`keys` 是学习页快捷键 `{ say, show, mark }`，值是 `comboOf(e)` 的「修饰键+e.code」串，默认 `KEYS`，读一律 `keysOf()`；`autoNext` 缺省 `true`（答对 900ms 自动下一题），`false` 停在答案上，**不进 IndexedDB 课程对象**（练习页拿的是课程快照，写回会盖掉编辑页的改动）；读一律用 `lib.js` 的 `wrongEntries(lessons, book)`，它按现有课程过滤。
- **AI 调用**（`ai.js`）：只认 OpenAI 兼容接口，`call()` 先直连，fetch 抛错（CORS）就改走 `/proxy?url=`。`functions/proxy.js` 只放行 `/models` `/chat/completions` `/images/generations` 三个路径。识图 prompt 由 `ai.js` 的 `prompt(lang)` 按语种生成，改输出字段要同步改 `detect()` 的过滤和 `app.js` 导入时的补默认值。
- **学习页**（`study.js`）：`renderStudy(view, id, given?, only?)` 先组「题单」`[{ lesson, item, mode, fresh?, col? }]`——`id` 是课程 id 就是整课（固定练法，有切换条），`'wrong'` 是错题本跨课混练，`'today'` 是到期 + 新词（`only` 限一课；每题自带练法，无切换条），`'all'` 是所有没收起的课随机抽 20 词（固定练法，有切换条），`'hard'` 是 `hardWords` 那 10 个最难的词（固定练法，有切换条），`given` 是结果页「再练错的 / 再来一遍」传回来的子集；`'today'` `'wrong'` `'all'` `'hard'` 都不是课程 id，别拿去 `db.get`。每题按自己的课取图、画框、抽干扰项，答题区每题重建（`drawDeck`），事件挂 `view.onclick / onchange / onkeydown` 按 id 分发。`'learn'` 模式是新词认读：自动揭晓、看过即算完成、不写进度、不计分。新入口只需组题单。结果页在按钮行上方按 `masteredLessons` 提示「全部掌握了 [收起这一课]」（课 id 从题单取，点了不跳走）。
- **统计页**（`stats.js`）：`#/stats`，`renderStats(view)` 只读。四块：已掌握（含已收起课、level ≥ MASTER）/ 学习中 / 新词（后两口只算没收起，按「课程id|词」去重）、最近 30 天柱状（`days[d].n`）、六种练法累加 `days[d].modes`（≥10 题里答对率最低标最弱，「专练」写 `studyMode` 后跳 `#/study/all`）、最难的 10 词（`hardWords`，「一起练」跳 `#/study/hard`）。
- **Anki 导出**（`anki.js`）：走 AnkiConnect `http://127.0.0.1:8765`（只有 Anki 桌面版有；Claude 桌面版自带浏览器连不了本机端口，验收用真 Chrome）。先 `requestPermission`，笔记类型 `看图记词·<预设名>` 由我们建 / 刷（字段固定 `Key Word IPA Meaning Picture Audio`，`Key = 课程id|词` 做去重），图和 MP3 以 base64 随 `addNotes` 送；`canAddNotesWithErrorDetail` 的 error 含 `duplicate` 算「已存在」。改模板只改 `PRESETS`，下次导出会自动刷到 Anki。本地 `wrangler pages dev` 的 `/tts` 连不上 Edge TTS（返回 500），导出时「没配上音频」在本地是环境问题，线上正常。
- **发音**（`tts.js` → `functions/tts.js`）：`speak(text, lang)` 英语用设置里的发音人、其他语种用 `LANGS` 里配的；IndexedDB `audio` 表按 `voice|text` 缓存 MP3；`/tts` 函数用 Cloudflare 的 `fetch` Upgrade: websocket 代连微软 Edge TTS 非公开接口，返回 403 时先对顶部的 `VERSION` / `UA`。失败降级到 `speechSynthesis`。
- **PWA**（`sw.js`）：`FILES` 列表是硬编码的预缓存清单，**新增 JS 文件必须加进去**；策略是网络优先、失败用缓存，`/tts` 不缓存。改了静态文件线上没生效先想到 SW 缓存。
- **内置课程**（`packs/`）：`index.json` 是 12 课的英语词表 + 框 + 其他语种译词（`tr[lang]` 数组和 `items` 一一对应，只有 en/ipa/alts），图片 1024px JPEG。首页「内置课程」标签的语种下拉走 `switchPacks()` 原地替换本机 `pack-*` 课的 items/lang，`settings.packLang` 记当前语种。`app.js` 的 `addPacks()` 首次打开导入 IndexedDB（id `pack-<slug>`，已存在的跳过，`settings.packsAdded` 标记只放一次），之后和用户课程无区别。改词表直接改 `index.json`；重新识别用的是和 `ai.js` 同一份 prompt 调 Gemini。内置课词表升级走 `app.js` 的 `fillPackSents()`（`PACKS_VER` 版本号，跑过一次记 `settings.packsVer`）：**只填空、不整份替换**——词没被用户改过且还没有的字段才填，永远不覆盖用户对内置课的手改；整份替换只在用户主动切语种时做（有 confirm）。例句是 2026-09-21 用 gemini-3.7-flash 带图按语种一次性生成的，`tr[lang][k]` 各有自己的 `sent/sentZh`。
- `study.js` 的 `isRight(input, it, lang)` 是判对规则的唯一实现（Unicode 字母、按语种忽略冠词、标点、alts、s/es）。

## 约束

- 保持零依赖、零构建；新功能优先原生 API。
- 文件按「管什么」拆，README 的结构表要和实际文件对上。
- 用户数据只在本机浏览器，任何碰 IndexedDB 结构的改动（版本号、字段）要考虑老数据和导入的旧 JSON。
