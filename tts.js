// 发音：先查本地缓存 → 走 /tts（Cloudflare 函数代连 Edge TTS）→ 失败降级浏览器自带朗读
import { db, settings, LANGS } from './lib.js';

// 英语用设置里选的发音人，其他语种用语种表里配好的；拿到 MP3 Blob（导出 Anki 复用）
export async function getAudio(text, lang = 'en') {
  const L = LANGS[lang] || LANGS.en;
  const voice = (lang === 'en' && settings.get().voice) || L.voice;
  const key = voice + '|' + text;
  let blob = await db.audioGet(key);
  if (!blob) {
    const r = await fetch(`/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`);
    if (!r.ok) throw new Error(await r.text());
    blob = await r.blob();
    db.audioPut(key, blob);
  }
  return blob;
}

export async function speak(text, lang = 'en') {
  const L = LANGS[lang] || LANGS.en;
  try {
    const blob = await getAudio(text, lang);
    const url = URL.createObjectURL(blob), a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    await a.play();
  } catch (e) {
    console.warn('Edge TTS 失败，降级系统朗读', e);
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = L.tag;
    speechSynthesis.speak(u);
  }
}
