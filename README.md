# 看图记词 · Kantu Words

一张图 → AI 自动把图里的物品框出来、配好英文 / 中文 / 音标 → 学习时框依次亮起，看中文提示打英文，听发音。

纯前端 PWA，无框架无构建；一个 Cloudflare Pages 函数负责发音。手机 / 电脑浏览器打开即用，可「添加到主屏幕」。

在线试用：https://kantu-words.pages.dev/

## 功能

- **备课**：上传图片，或输入描述让 AI 生图；「AI 识别」自动框出物品并生成单词、中文、美式音标、词性、同义答案；可以改词、拖框、删框、手动加框
- **学习**：框依次高亮，输入英文回车判对；中文提示三种模式（一直显示 / 答错后显示 / 不显示）；显示答案、上一个 / 下一个；走完出一次答对率
- **判对规则**：不分大小写、忽略冠词和标点、AI 给的同义词算对、单复数差一个 s 算对
- **发音**：微软 Edge 朗读（免费、不要 Key），发音人可换；本地缓存；失败自动降级浏览器自带朗读
- **数据**：全部存在本机浏览器（IndexedDB），支持导出 / 导入 JSON 备份

## 需要准备

一个 **OpenAI 兼容**的 API 地址和 Key（OpenAI、Gemini 的 OpenAI 兼容端点、各类中转站都行）。识别模型要能看图，推荐 Gemini Flash 系列（框物品坐标准、便宜）。生图可选，模型要支持 `/images/generations`。

Key 只存在浏览器 localStorage，不经过任何第三方服务器；接口没开 CORS 时请求会经你自己部署的 `/proxy` 函数转一手。

## 部署自己的

```bash
npx wrangler login
npx wrangler pages project create kantu-words --production-branch main
npx wrangler pages deploy . --project-name kantu-words --branch main
```

免费额度够个人用。

## 结构

| 文件 | 管什么 |
|---|---|
| `index.html` | 页面壳 + 样式 |
| `app.js` | 路由、课程列表、设置页、导入导出 |
| `editor.js` | 备课页：传图 / 生图 / 识别 / 改框 |
| `study.js` | 学习页：判对、提示、进度 |
| `ai.js` | 调 AI：拉模型、识图、生图 |
| `tts.js` | 发音：缓存 → `/tts` → 降级 |
| `lib.js` | IndexedDB、设置、小工具 |
| `sw.js` `manifest.json` | PWA |
| `functions/tts.js` | Cloudflare 函数：代连 Edge TTS（浏览器不能自己设那些请求头） |
| `functions/proxy.js` | Cloudflare 函数：给没开 CORS 的接口转一手 |

## 已知

- Edge TTS 是微软给 Edge 浏览器内置的非公开接口，没有 SLA；校验规则偶尔会变，403 了先看 `functions/tts.js` 顶上的版本号和 UA
- 识别偶尔重复 / 漏框，编辑页手动改

## License

MIT
