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

- `app.js` 是入口：hash 路由 `#/`（列表）`#/edit/:id` `#/study/:id` `#/settings`，每次路由把 `#view` 整个 `innerHTML` 重画。页面模块导出一个 `renderX(view, id)`，自己往 `view` 上挂事件；路由切换前会清掉 `view.onclick / onkeydown`。
- **未保存拦截约定**：编辑页有改动就设 `view.dirty = true`；`app.js` 的 `route()` 和 `beforeunload` 靠这个标记拦离开。新增会改数据的页面要跟这个约定。
- **数据模型**（IndexedDB `kantu` 库 `lessons` 表，`lib.js`）：`{ id, title, image: Blob(JPEG≤1600px), items: [{ en, zh, ipa, pos, alts: [], box: [ymin, xmin, ymax, xmax] }], created }`。`box` 是 0–1000 归一化坐标，顺序是 **y 在前**（跟 Gemini 输出一致），`editor.js` 的 `boxStyle` 负责转 CSS。导出/导入 JSON 时 `image` 转 data URL。
- **设置**全在 `localStorage.kantu` 一个 JSON 里（`settings.get/set`），键：`apiUrl apiKey visionModel imageApiUrl imageApiKey imageModel voice hintMode studyMode`。
- **AI 调用**（`ai.js`）：只认 OpenAI 兼容接口，`call()` 先直连，fetch 抛错（CORS）就改走 `/proxy?url=`。`functions/proxy.js` 只放行 `/models` `/chat/completions` `/images/generations` 三个路径。识图 prompt 在 `ai.js` 的 `PROMPT`，改输出字段要同步改 `detect()` 的过滤和 `app.js` 导入时的补默认值。
- **发音**（`tts.js` → `functions/tts.js`）：IndexedDB `audio` 表按 `voice|text` 缓存 MP3；`/tts` 函数用 Cloudflare 的 `fetch` Upgrade: websocket 代连微软 Edge TTS 非公开接口，返回 403 时先对顶部的 `VERSION` / `UA`。失败降级到 `speechSynthesis`。
- **PWA**（`sw.js`）：`FILES` 列表是硬编码的预缓存清单，**新增 JS 文件必须加进去**；策略是网络优先、失败用缓存，`/tts` 不缓存。改了静态文件线上没生效先想到 SW 缓存。
- **内置课程**（`packs/`）：`index.json` 是 12 课的词表 + 框，图片 1024px JPEG。`app.js` 的 `addPacks()` 首次打开导入 IndexedDB（id `pack-<slug>`，已存在的跳过，`settings.packsAdded` 标记只放一次），之后和用户课程无区别。改词表直接改 `index.json`；重新识别用的是和 `ai.js` 同一份 prompt 调 Gemini。
- `study.js` 的 `isRight` 是判对规则的唯一实现（大小写、冠词、标点、alts、s/es）。

## 约束

- 保持零依赖、零构建；新功能优先原生 API。
- 文件按「管什么」拆，README 的结构表要和实际文件对上。
- 用户数据只在本机浏览器，任何碰 IndexedDB 结构的改动（版本号、字段）要考虑老数据和导入的旧 JSON。
